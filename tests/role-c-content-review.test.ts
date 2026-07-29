import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { retrieveKnowledge } from "../src/rag/retriever"
import type { LearnerProfile } from "../src/role-b-profile/types"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  createRoleCAgents,
  defineLearningPathNode,
  deliverRoleCToD,
  DeterministicCodeLabContentProvider,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  type CPipelineInput,
  type GeneratedContentVerifiers,
  type RoleCAgents,
  type RoleCDeliveryAck,
  type RoleCReviewedReleaseDelivery,
  type SecureArtifact,
  type SecureArtifactStore,
} from "../src/role-c-content"
import { contentHash } from "../src/role-c-content/contracts/common"
import {
  InMemorySecureArtifactStore,
} from "../src/role-c-content/security/secure-artifact-store"
import {
  extractReviewBlocks,
} from "../src/role-c-content/review/extract-review-blocks"
import {
  createLocalABContentReviewPort,
  ragEvidencePackToRagResult,
} from "../src/role-c-content/review/local-ab-review-port"
import { runReviewedCPipeline } from "../src/role-c-content/review/run-reviewed-pipeline"
import type {
  ContentReviewFinding,
  ContentReviewPort,
  ContentReviewRequest,
  ContentReviewResult,
  ContentRevisionInstruction,
} from "../src/role-c-content/review/types"

const profile: LearnerProfile = {
  learner_id: "review-learner",
  level: "beginner",
  known_concepts: ["变量", "数据类型", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成一个成绩统计小程序，能遍历一批成绩算平均分",
}

const verifiers: GeneratedContentVerifiers = {
  code_lab: {
    async verifyCodeLab() {
      return { execution_verified: true, issues: [] }
    },
  },
  assessment: {
    async verifyAssessment() {
      return { answer_key_verified: true, issues: [] }
    },
  },
}

describe("Role C content review extraction and adapters", () => {
  test("extracts all three public artifact families without answer-bearing fields", async () => {
    const context = await goldenContext()
    let requestSeen: ContentReviewRequest | undefined
    const store = recordingStore()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      store.store,
      {
        review_port: {
          policy_version: "capture-v1",
          async review(request) {
            requestSeen = request
            return reviewResult(request, "pass", "capture-v1")
          },
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(requestSeen).toBeDefined()
    const targets = requestSeen!.artifacts
    const conceptBlocks = extractReviewBlocks(targets[0])
    const labBlocks = extractReviewBlocks(targets[1])
    const assessmentBlocks = extractReviewBlocks(targets[2])
    expect(conceptBlocks.length).toBeGreaterThan(0)
    expect(labBlocks.some((block) => block.locator.field === "public_test")).toBe(true)
    expect(assessmentBlocks.filter(
      (block) => block.locator.field === "assessment_item",
    )).toHaveLength(targets[2].artifact.payload!.items.length)
    expect(assessmentBlocks.some((block) => block.locator.field === "option")).toBe(true)
    expect(assessmentBlocks.some((block) => block.locator.field === "starter_code")).toBe(true)
    const serialized = JSON.stringify([...conceptBlocks, ...labBlocks, ...assessmentBlocks])
    expect(serialized).not.toContain("hidden_tests")
    expect(serialized).not.toContain("reference_solution")
    expect(serialized).not.toContain("correct_option_id")
    expect(serialized).toContain("为什么累计总分时还需要记录元素数量")
    expect(serialized).toContain("从网络安装新的第三方包")
    expect(JSON.stringify(requestSeen!.evidence_pack)).not.toContain("\"quiz_seeds\"")
    expect(JSON.stringify(requestSeen!.evidence_pack)).not.toContain("\"answer\"")
  })

  test("reconstructs A RagResult from the frozen pack without copying quiz answers", async () => {
    const context = await goldenContext()
    const rag = ragEvidencePackToRagResult(context.input.evidence_pack)
    expect(rag.query).toBe(context.input.evidence_pack.query)
    expect(rag.results.map((item) => item.source_id))
      .toEqual(context.input.evidence_pack.results.map((item) => item.source_id))
    expect(rag.results.flatMap((item) => item.facts).map((fact) => fact.content))
      .toEqual(context.input.evidence_pack.results.flatMap((item) => item.facts).map((fact) => fact.content))
    expect(rag.results.every((item) => item.quizItems.length === 0)).toBe(true)
  })

  test("runs the local A/B adapter for concept, code-lab, and assessment", async () => {
    const context = await goldenContext()
    const kb = await loadKnowledgeBase()
    let candidateRequest: ContentReviewRequest | undefined
    await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      {
        review_port: {
          policy_version: "capture-local-input",
          async review(request) {
            candidateRequest = request
            return reviewResult(request, "pass", "capture-local-input")
          },
        },
      },
    )
    const local = createLocalABContentReviewPort({ knowledge_base: kb })
    const report = await local.review(candidateRequest!)
    expect(report.artifact_results.map((entry) => entry.artifact_kind))
      .toEqual(["concept", "code_lab", "assessment"])
    expect(report.artifact_results.every((entry) => entry.fact_status === "pass")).toBe(true)
    expect(report.decision).toBe("reject")
    expect(report.revision_instructions.some(
      (instruction) => instruction.code === "difficulty_alignment"
        && instruction.fix_scope === "new_spec",
    )).toBe(true)
    expect(report.artifact_results.every((entry) => entry.findings.every(
      (finding) => finding.artifact_id === entry.artifact_id,
    ))).toBe(true)
  })

  test("audits learner-visible render text even when its separate claim stays valid", async () => {
    const context = await goldenContext()
    const kb = await loadKnowledgeBase()
    let captured: ContentReviewRequest | undefined
    await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      {
        review_port: {
          policy_version: "capture-render-review-v1",
          async review(request) {
            captured = request
            return reviewResult(request, "pass", this.policy_version)
          },
        },
      },
    )
    const forged = structuredClone(captured!)
    const concept = forged.artifacts[0].artifact
    const paragraph = concept.payload?.explanation_blocks.find(
      (block) => block.block_type === "paragraph",
    )
    if (!paragraph || paragraph.block_type !== "paragraph") {
      throw new Error("fixture paragraph missing")
    }
    paragraph.text = "该段展示正文故意改成了与冻结证据无关的结论。"
    forged.artifacts[0].artifact_hash = contentHash(concept)

    const report = await createLocalABContentReviewPort({
      knowledge_base: kb,
    }).review(forged)
    const conceptResult = report.artifact_results.find(
      (result) => result.artifact_kind === "concept",
    )
    expect(conceptResult?.fact_status).not.toBe("pass")
    expect(conceptResult?.findings.some(
      (finding) => finding.locator?.field === "render_content",
    )).toBe(true)
  })

  test("accepts personalized render wording when its visible fact remains grounded", async () => {
    const context = await goldenContext()
    const kb = await loadKnowledgeBase()
    let captured: ContentReviewRequest | undefined
    await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      {
        review_port: {
          policy_version: "capture-grounded-render-v1",
          async review(request) {
            captured = request
            return reviewResult(request, "pass", this.policy_version)
          },
        },
      },
    )
    const personalized = structuredClone(captured!)
    const concept = personalized.artifacts[0].artifact
    const paragraph = concept.payload?.explanation_blocks.find(
      (block) => block.block_type === "paragraph",
    )
    if (!paragraph || paragraph.block_type !== "paragraph" || paragraph.claims.length === 0) {
      throw new Error("fixture grounded paragraph missing")
    }
    paragraph.text = `${paragraph.claims[0]!.text}。结合成绩统计目标，可以逐项观察循环中的变量变化。`
    personalized.artifacts[0].artifact_hash = contentHash(concept)

    const report = await createLocalABContentReviewPort({
      knowledge_base: kb,
    }).review(personalized)
    const conceptResult = report.artifact_results.find(
      (result) => result.artifact_kind === "concept",
    )
    expect(conceptResult?.fact_status).toBe("pass")
    expect(conceptResult?.findings.some(
      (finding) => finding.locator?.field === "render_content",
    )).toBe(false)
  })
})

describe("runReviewedCPipeline publication gate", () => {
  test("publishes an A/B-aligned bundle through the real local adapters", async () => {
    const alignedProfile: LearnerProfile = {
      ...profile,
      level: "integrated",
      known_concepts: [...profile.known_concepts, "函数定义与调用"],
    }
    const context = await goldenContext(alignedProfile)
    const kb = await loadKnowledgeBase()
    const destination = recordingStore()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      {
        review_port: createLocalABContentReviewPort({ knowledge_base: kb }),
      },
    )
    expect(result.status).toBe("ready")
    expect(result.review_reports).toHaveLength(1)
    expect(result.review_reports[0]?.decision).toBe("pass")
    expect(result.review_reports[0]?.artifact_results.every(
      (entry) => entry.fact_status === "pass" && entry.teaching_status === "pass",
    )).toBe(true)
    expect(destination.batchWrites).toBe(1)

    const delivered = {
      run_id: "",
      delivery_id: "",
      artifact_ids: [] as string[],
      trace_count: 0,
    }
    const ack = await deliverRoleCToD({
      async publishReviewedRelease(release) {
        delivered.run_id = release.run_id
        delivered.delivery_id = release.delivery_id
        delivered.artifact_ids = release.artifacts.map((artifact) => artifact.artifact_id)
        delivered.trace_count = release.trace_events.length
        return deliveryAck(release)
      },
    }, result)
    expect(delivered.run_id).toBe(result.generation_spec.run_id)
    expect(delivered.delivery_id).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(delivered.artifact_ids).toEqual([
      result.public_artifacts.concept_lesson!.artifact_id,
      result.public_artifacts.code_lab!.artifact_id,
      result.public_artifacts.assessment!.artifact_id,
    ])
    expect(delivered.trace_count).toBe(result.trace_events.length)
    expect(ack).toEqual({
      schema_version: "1.0",
      delivery_kind: "reviewed_release",
      delivery_id: delivered.delivery_id,
      status: "accepted",
    })
  })

  test("uses one stable reviewed-release envelope and accepts a duplicate acknowledgement", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      { review_port: fixedPort("pass") },
    )
    const received: RoleCReviewedReleaseDelivery[] = []
    const committed = new Set<string>()
    const port = {
      async publishReviewedRelease(release: RoleCReviewedReleaseDelivery) {
        received.push(structuredClone(release))
        const status = committed.has(release.delivery_id) ? "duplicate" as const : "accepted" as const
        committed.add(release.delivery_id)
        return deliveryAck(release, status)
      },
    }

    const first = await deliverRoleCToD(port, result)
    const replay = await deliverRoleCToD(port, structuredClone(result))

    expect(received).toHaveLength(2)
    expect(received[0]!.delivery_id).toBe(received[1]!.delivery_id)
    expect(received[0]!.artifacts).toHaveLength(3)
    expect([...received[0]!.trace_events]).toEqual(result.trace_events)
    expect(first.status).toBe("accepted")
    expect(replay.status).toBe("duplicate")
  })

  test("keeps reviewed-release identity stable when only trace telemetry changes", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      { review_port: fixedPort("pass") },
    )
    const received: RoleCReviewedReleaseDelivery[] = []
    const port = {
      async publishReviewedRelease(release: RoleCReviewedReleaseDelivery) {
        received.push(structuredClone(release))
        return deliveryAck(release, received.length === 1 ? "accepted" : "duplicate")
      },
    }
    await deliverRoleCToD(port, result)

    const replayedExecution = structuredClone(result)
    replayedExecution.trace_events.forEach((event) => {
      event.seq += 100
      event.occurred_at = "2099-01-01T00:00:00.000Z"
      event.duration_ms = (event.duration_ms ?? 0) + 999
    })
    await deliverRoleCToD(port, replayedExecution)

    expect(received).toHaveLength(2)
    expect(received[0]!.delivery_id).toBe(received[1]!.delivery_id)
    expect(received[0]!.trace_events).not.toEqual(received[1]!.trace_events)
  })

  test("binds the final review evidence hash to the frozen GenerationSpec", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      { review_port: fixedPort("pass") },
    )
    const forged = structuredClone(result)
    forged.review_reports.at(-1)!.evidence_hash = `sha256:${"0".repeat(64)}`
    let deliveryCalls = 0
    await expect(deliverRoleCToD({
      async publishReviewedRelease(release) {
        deliveryCalls += 1
        return deliveryAck(release)
      },
    }, forged)).rejects.toThrow("REVIEW_CONTEXT_MISMATCH")
    expect(deliveryCalls).toBe(0)
  })

  test("rejects a D acknowledgement for another delivery", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      { review_port: fixedPort("pass") },
    )
    await expect(deliverRoleCToD({
      async publishReviewedRelease(release) {
        return {
          ...deliveryAck(release),
          delivery_id: `sha256:${"0".repeat(64)}`,
        }
      },
    }, result)).rejects.toThrow("ROLE_C_D_ACK_ID_MISMATCH")
  })

  test("atomically commits the secure pair only after all reviews pass", async () => {
    const context = await goldenContext()
    const destination = recordingStore()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      { review_port: fixedPort("pass") },
    )

    expect(result.status).toBe("ready")
    expect(result.review_reports).toHaveLength(1)
    expect(result.review_reports[0]!.decision).toBe("pass")
    expect(destination.batchWrites).toBe(1)
    expect(destination.artifacts.map((artifact) => artifact.artifact_type).sort())
      .toEqual(["assessment_secure", "code_lab_secure"])
    expect(result.secure_refs).toHaveLength(2)
  })

  test("removes the committed secure batch when post-commit reads fail", async () => {
    const context = await goldenContext()
    const destination = postCommitFaultStore("get_throws")
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      { review_port: fixedPort("pass") },
    )

    expect(result.status).toBe("failed")
    expect(result.failure_reason?.code).toBe("SECURE_STORE_ERROR")
    expect(destination.refs).toHaveLength(2)
    expect(destination.deleteCalls).toBe(1)
    for (const ref of destination.refs) {
      await expect(destination.backend.get(ref, {
        principal: "role-c-pipeline",
        run_id: context.input.generation_spec.run_id,
      })).rejects.toThrow()
    }
  })

  test("removes the committed secure batch when its read-back pair fails assertion", async () => {
    const context = await goldenContext()
    const destination = postCommitFaultStore("invalid_pair")
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      { review_port: fixedPort("pass") },
    )

    expect(result.status).toBe("failed")
    expect(result.failure_reason?.code).toBe("SECURE_STORE_ERROR")
    expect(destination.refs).toHaveLength(2)
    expect(destination.deleteCalls).toBe(1)
    for (const ref of destination.refs) {
      await expect(destination.backend.get(ref, {
        principal: "role-c-pipeline",
        run_id: context.input.generation_spec.run_id,
      })).rejects.toThrow()
    }
  })

  test("rejects publication without writing either secure artifact", async () => {
    const context = await goldenContext()
    const destination = recordingStore()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      { review_port: fixedPort("reject") },
    )

    expect(result.status).toBe("blocked")
    expect(result.secure_refs).toEqual([])
    expect(result.review_reports.at(-1)?.decision).toBe("reject")
    expect(destination.batchWrites).toBe(0)
    expect(destination.artifacts).toEqual([])
    expect(result.trace_events.at(-1)?.event_type).toBe("c.pipeline.blocked")

    let deliveryCalls = 0
    await expect(deliverRoleCToD({
      async publishReviewedRelease(release) {
        deliveryCalls += 1
        return deliveryAck(release)
      },
    }, result)).rejects.toThrow("PIPELINE_NOT_READY")
    expect(deliveryCalls).toBe(0)
  })

  test("rejects a forged last-review artifact ID before invoking D", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      { review_port: fixedPort("pass") },
    )
    const forged = structuredClone(result)
    forged.review_reports.at(-1)!.artifact_results[0]!.artifact_id = "ART-FORGED"
    let deliveryCalls = 0
    await expect(deliverRoleCToD({
      async publishReviewedRelease(release) {
        deliveryCalls += 1
        return deliveryAck(release)
      },
    }, forged)).rejects.toThrow("REVIEW_ARTIFACT_MISMATCH")
    expect(deliveryCalls).toBe(0)
  })

  test("rejects a failed reviewed pipeline before invoking D", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      {
        review_port: {
          policy_version: "unavailable-review-v1",
          async review() {
            throw new Error("review unavailable")
          },
        },
      },
    )
    expect(result.status).toBe("failed")
    let deliveryCalls = 0
    await expect(deliverRoleCToD({
      async publishReviewedRelease(release) {
        deliveryCalls += 1
        return deliveryAck(release)
      },
    }, result)).rejects.toThrow("PIPELINE_NOT_READY")
    expect(deliveryCalls).toBe(0)
  })

  test("rejects a pass review that still carries an unresolved finding", async () => {
    const context = await goldenContext()
    const destination = recordingStore()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      {
        review_port: {
          policy_version: "invalid-pass-finding-v1",
          async review(request) {
            const passed = reviewResult(request, "pass", this.policy_version)
            passed.artifact_results[0]!.findings = [
              revisionFor(request, request.artifacts[0].artifact.artifact_id),
            ]
            return passed
          },
        },
      },
    )
    expect(result.status).toBe("failed")
    expect(result.failure_reason?.code).toBe("PROVIDER_ERROR")
    expect(destination.batchWrites).toBe(0)
  })

  test("keeps trace ordering validation behind the reviewed release gate", async () => {
    const context = await goldenContext()
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      new InMemorySecureArtifactStore(),
      { review_port: fixedPort("pass") },
    )
    const outOfOrder = structuredClone(result)
    const firstSeq = outOfOrder.trace_events[0]!.seq
    outOfOrder.trace_events[0]!.seq = outOfOrder.trace_events[1]!.seq
    outOfOrder.trace_events[1]!.seq = firstSeq
    let deliveryCalls = 0
    await expect(deliverRoleCToD({
      async publishReviewedRelease(release) {
        deliveryCalls += 1
        return deliveryAck(release)
      },
    }, outOfOrder)).rejects.toThrow("NOT_STRICTLY_ORDERED")
    expect(deliveryCalls).toBe(0)
  })

  test("allows at most two external revisions and reuses one frozen evidence object", async () => {
    const context = await goldenContext()
    const destination = recordingStore()
    const evidenceObjects: unknown[] = []
    const evidenceHashes: string[] = []
    let calls = 0
    let conceptCalls = 0
    const countedAgents: RoleCAgents = {
      ...context.agents,
      concept_tutor: {
        async generate(request) {
          conceptCalls += 1
          return context.agents.concept_tutor.generate(request)
        },
      },
    }
    const port: ContentReviewPort = {
      policy_version: "two-revisions-v1",
      async review(request) {
        evidenceObjects.push(request.evidence_pack)
        evidenceHashes.push(contentHash(request.evidence_pack))
        const decision = calls < 2 ? "revise" : "pass"
        calls += 1
        return reviewResult(request, decision, this.policy_version)
      },
    }
    const result = await runReviewedCPipeline(
      context.input,
      countedAgents,
      destination.store,
      { review_port: port, max_external_revisions: 2 },
    )

    expect(result.status).toBe("ready")
    expect(result.review_reports.map((report) => report.revision_round)).toEqual([0, 1, 2])
    expect(new Set(evidenceObjects).size).toBe(1)
    expect(new Set(evidenceHashes).size).toBe(1)
    expect(evidenceHashes[0]).not.toBe(contentHash(context.input.evidence_pack))
    expect(Object.isFrozen(evidenceObjects[0])).toBe(true)
    expect(conceptCalls).toBe(3)
    expect(destination.batchWrites).toBe(1)
  })

  test("blocks after the second revision when the third review still requests changes", async () => {
    const context = await goldenContext()
    const destination = recordingStore()
    let reviewCalls = 0
    const port: ContentReviewPort = {
      policy_version: "always-revise-v1",
      async review(request) {
        reviewCalls += 1
        return reviewResult(request, "revise", this.policy_version)
      },
    }
    const result = await runReviewedCPipeline(
      context.input,
      context.agents,
      destination.store,
      { review_port: port, max_external_revisions: 2 },
    )

    expect(result.status).toBe("blocked")
    expect(result.review_reports.map((report) => report.revision_round)).toEqual([0, 1, 2])
    expect(reviewCalls).toBe(3)
    expect(destination.batchWrites).toBe(0)
  })
})

async function goldenContext(
  learnerProfile: LearnerProfile = profile,
): Promise<{ input: CPipelineInput; agents: RoleCAgents }> {
  const request = buildRagRequest(learnerProfile)
  const rag = await retrieveKnowledge({
    query: request.query,
    learnerLevel: learnerProfile.level,
    topK: request.top_k,
  })
  const kb = await loadKnowledgeBase()
  const evidence = adaptRagResult(rag, {
    kb_version: kb.version,
    rag_version: "rule-rag-0.1",
  })
  const rawPath = await Bun.file(
    "examples/role-c-content/learning_path_node_score_project.json",
  ).json()
  const path = defineLearningPathNode({
    node_id: rawPath.node_id,
    target_source_ids: rawPath.target_source_ids,
    prerequisite_source_ids: rawPath.prerequisite_source_ids,
    goal: rawPath.goal,
    objectives: rawPath.objectives,
    assessment_blueprint: rawPath.assessment_blueprint,
  })
  const built = buildGenerationSpec({
    run_id: "RUN-C-REVIEW-001",
    profile_snapshot: adaptLearnerProfile(learnerProfile, { profile_version: "profile-review-v1" }),
    path_node: path,
    evidence_pack: evidence,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: "deterministic-review-provider",
    },
    seed: 42,
  })
  if (!built.ok) throw new Error(built.errors.join("; "))
  return {
    input: { generation_spec: built.spec, evidence_pack: evidence },
    agents: createRoleCAgents(new DeterministicCodeLabContentProvider(), verifiers),
  }
}

function fixedPort(decision: "pass" | "reject"): ContentReviewPort {
  return {
    policy_version: `fixed-${decision}-v1`,
    async review(request) {
      return reviewResult(request, decision, this.policy_version)
    },
  }
}

function deliveryAck(
  delivery: Pick<RoleCReviewedReleaseDelivery, "delivery_kind" | "delivery_id">,
  status: RoleCDeliveryAck["status"] = "accepted",
): RoleCDeliveryAck {
  return {
    schema_version: "1.0",
    delivery_kind: delivery.delivery_kind,
    delivery_id: delivery.delivery_id,
    status,
  }
}

function reviewResult(
  request: ContentReviewRequest,
  decision: "pass" | "revise" | "reject",
  policyVersion: string,
): ContentReviewResult {
  const effectiveDecision = decision === "revise" && request.revision_round >= 2
    ? "reject"
    : decision
  const revision = decision === "revise"
    ? revisionFor(request, request.artifacts[0].artifact.artifact_id)
    : undefined
  return {
    run_id: request.run_id,
    pipeline_input_hash: request.pipeline_input_hash,
    generation_spec_hash: request.generation_spec_hash,
    policy_version: policyVersion,
    revision_round: request.revision_round,
    max_revision_rounds: request.max_revision_rounds,
    evidence_hash: request.evidence_hash,
    decision: effectiveDecision,
    artifact_results: request.artifacts.map((target, index) => {
      const artifactDecision = index === 0 ? effectiveDecision : "pass"
      return {
        artifact_kind: target.kind,
        artifact_id: target.artifact.artifact_id,
        artifact_hash: target.artifact_hash,
        fact_status: index === 0 ? decision : "pass",
        teaching_status: "pass" as const,
        decision: artifactDecision,
        can_revise: artifactDecision === "revise",
        findings: revision && index === 0 ? [revision] : [],
        revision_instructions: revision && index === 0 ? [revision] : [],
      }
    }),
    revision_instructions: revision ? [revision] : [],
  }
}

function revisionFor(
  request: ContentReviewRequest,
  artifactId: string,
): ContentRevisionInstruction {
  const finding: ContentReviewFinding = {
    source: "fact_audit",
    code: "missing_citation",
    artifact_kind: "concept",
    artifact_id: artifactId,
    message: "测试修订意见",
    proposed_action: "使用冻结证据重写该讲解",
    fix_scope: "artifact",
    evidence_refs: [request.evidence_pack.retrieval_id],
  }
  return {
    ...finding,
    instruction_id: `REV-${request.revision_round}`,
    target_agent: "concept-tutor",
    target_artifact_id: artifactId,
    objective_id: request.generation_spec.targets[0]!.objective_id,
  }
}

function recordingStore(): {
  store: SecureArtifactStore
  readonly batchWrites: number
  readonly artifacts: SecureArtifact[]
} {
  const inner = new InMemorySecureArtifactStore()
  let writes = 0
  const artifacts: SecureArtifact[] = []
  return {
    store: {
      namespace_id: inner.namespace_id,
      put: inner.put.bind(inner),
      async putBatch(batch, context) {
        writes += 1
        artifacts.push(...structuredClone(batch))
        return inner.putBatch(batch, context)
      },
      get: inner.get.bind(inner),
      deleteBatch: inner.deleteBatch.bind(inner),
    },
    get batchWrites() { return writes },
    get artifacts() { return artifacts },
  }
}

function postCommitFaultStore(mode: "get_throws" | "invalid_pair"): {
  store: SecureArtifactStore
  backend: InMemorySecureArtifactStore
  readonly refs: string[]
  readonly deleteCalls: number
} {
  const backend = new InMemorySecureArtifactStore()
  let committedRefs: string[] = []
  let deletes = 0
  return {
    backend,
    store: {
      namespace_id: backend.namespace_id,
      put: backend.put.bind(backend),
      async putBatch(artifacts, context) {
        committedRefs = await backend.putBatch(artifacts, context)
        return [...committedRefs]
      },
      async get(ref, context) {
        const artifact = await backend.get(ref, context)
        if (mode === "get_throws") throw new Error("post-commit read failed")
        return {
          ...artifact,
          artifact_type: "code_lab_secure",
        } as SecureArtifact
      },
      async deleteBatch(refs, context) {
        deletes += 1
        await backend.deleteBatch(refs, context)
      },
    },
    get refs() { return [...committedRefs] },
    get deleteCalls() { return deletes },
  }
}
