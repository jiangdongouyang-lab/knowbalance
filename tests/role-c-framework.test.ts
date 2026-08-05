import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { retrieveKnowledge } from "../src/rag/retriever"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { LearnerProfile } from "../src/role-b-profile/types"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import { WORKER_DEFINITIONS } from "../src/agents/workers"
import { buildWorkerStubPrompt } from "../src/prompts/worker-stub"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  createRoleCAgents,
  deliverLearningSessionToD,
  deliverReviewRecoveryStatusToD,
  deliverRoleCToD,
  defineLearningPathNode,
  getRoleCModelOutputSchema,
  InMemorySecureArtifactStore,
  runCPipeline,
  runReviewedCPipeline,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  transitionCState,
  validateCitations,
  validatePublicArtifactNoSecrets,
  validateRoleCSchema,
  validateSpecEvidence,
  type ArtifactDraft,
  type AssessmentDraft,
  type CodeLabDraft,
  type ConceptLessonPayload,
  type ContentReviewRequest,
  type ContentReviewResult,
  type LearningPathNode,
  type RagEvidencePack,
  type ReviewRecoveryPublicResult,
  type RoleCLearningSessionDelivery,
  type RoleCLearningSessionHandoff,
  type RoleCReviewRecoveryStatusDelivery,
  type RoleCReviewedReleaseDelivery,
  type RoleCContentProvider,
  type RoleCAgents,
  type GeneratedContentVerifiers,
  type SecureArtifact,
  type SecureArtifactStore,
} from "../src/role-c-content"
import { TestRoleCContentProvider } from "./role-c-test-provider"

const profile: LearnerProfile = {
  learner_id: "demo_loop_weak",
  level: "beginner",
  known_concepts: ["变量", "数据类型", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成一个成绩统计小程序，能遍历一批成绩算平均分",
}

async function buildGoldenContext(): Promise<{
  pack: RagEvidencePack
  path: LearningPathNode
  spec: ReturnType<typeof buildGenerationSpec> & { ok: true }
}> {
  const request = buildRagRequest(profile)
  const rag = await retrieveKnowledge({ query: request.query, learnerLevel: profile.level, topK: request.top_k })
  const kb = await loadKnowledgeBase()
  const pack = adaptRagResult(rag, { kb_version: kb.version, rag_version: "rule-rag-0.1" })
  const rawPath = await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()
  const path = defineLearningPathNode({
    node_id: rawPath.node_id,
    target_source_ids: rawPath.target_source_ids,
    prerequisite_source_ids: rawPath.prerequisite_source_ids,
    goal: rawPath.goal,
    objectives: rawPath.objectives,
    assessment_blueprint: rawPath.assessment_blueprint,
  })
  const snapshot = adaptLearnerProfile(profile, { profile_version: "profile-v1" })
  const spec = buildGenerationSpec({
    run_id: "RUN-C-GOLDEN-001",
    profile_snapshot: snapshot,
    path_node: path,
    evidence_pack: pack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: "provider-not-bound",
    },
    seed: 42,
  })
  if (!spec.ok) throw new Error(spec.errors.join("; "))
  return { pack, path, spec }
}

describe("role C intake contracts", () => {
  test("normalizes A rag_result and builds a frozen K007/K009/K018 GenerationSpec", async () => {
    const { pack, path, spec } = await buildGoldenContext()
    expect(pack.match_status).toBe("strong")
    expect(pack.results.map((item) => item.source_id)).toEqual(expect.arrayContaining(["K007", "K009", "K018"]))
    expect(spec.spec.policies.external_knowledge_allowed).toBe(false)
    expect(spec.spec.targets.map((target) => target.objective_id)).toEqual(["O1", "O2", "O3"])
    expect(spec.spec.evidence_ref).toBe(pack.retrieval_id)
    expect(validateRoleCSchema("learning_path_node.schema.json", path).ok).toBe(true)
  })

  test("blocks no-match and weak-match evidence instead of letting C invent content", async () => {
    const { path } = await buildGoldenContext()
    const snapshot = adaptLearnerProfile(profile, { profile_version: "profile-v1" })
    const noMatch = adaptRagResult({ query: "量子计算", learnerLevel: undefined, topK: 3, results: [] }, {
      kb_version: "0.1.0",
      rag_version: "rule-rag-0.1",
    })
    const noMatchBuild = buildGenerationSpec({
      run_id: "RUN-NO-MATCH",
      profile_snapshot: snapshot,
      path_node: path,
      evidence_pack: noMatch,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(noMatchBuild.ok).toBe(false)
    if (!noMatchBuild.ok && noMatchBuild.code !== "INVALID_INPUT") {
      expect(noMatchBuild.code).toBe("MISSING_EVIDENCE")
      expect(noMatchBuild.gap_request.required_facts).toContainEqual({ source_id: "K007", fact_id: "F001" })
      expect(noMatchBuild.gap_request.required_facts).toContainEqual({ source_id: "K009", fact_id: "F001" })
    }

    const weakRag = await retrieveKnowledge({ query: "银河系天文观测", learnerLevel: "beginner", topK: 5 })
    const weakPack = adaptRagResult(weakRag, { kb_version: "0.1.0", rag_version: "rule-rag-0.1" })
    expect(weakPack.match_status).toBe("weak")
    const weakPath = defineLearningPathNode({
      node_id: "PATH-WEAK",
      target_source_ids: [weakPack.results[0].source_id],
      prerequisite_source_ids: [],
      goal: "测试弱匹配阻塞",
      objectives: [{
        objective_id: "OW",
        source_id: weakPack.results[0].source_id,
        required_fact_ids: [weakPack.results[0].facts[0].fact_id],
        observable_behavior: "recognize",
        importance: "core",
      }],
      assessment_blueprint: {
        tier_1_count: 1,
        tier_2_count: 0,
        tier_3_count: 0,
        required_modalities: ["mcq"],
      },
    })
    const weakBuild = buildGenerationSpec({
      run_id: "RUN-WEAK",
      profile_snapshot: snapshot,
      path_node: weakPath,
      evidence_pack: weakPack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(weakBuild.ok).toBe(false)
    if (!weakBuild.ok) expect(weakBuild.code).toBe("WEAK_EVIDENCE")
  })

  test("trusts A's pack-level match status without reclassifying individual retrieval traces", async () => {
    const { pack, path } = await buildGoldenContext()
    const mixedPack = structuredClone(pack)
    const target = mixedPack.results.find((item) => item.source_id === "K007")!
    target.retrieval_trace.matched_fields = ["difficulty"]
    const built = buildGenerationSpec({
      run_id: "RUN-MIXED-MATCH",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: path,
      evidence_pack: mixedPack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(mixedPack.match_status).toBe("strong")
    expect(built.ok).toBe(true)
  })

  test("rechecks evidence identity and versions without overriding A's match judgment", async () => {
    const { pack, spec } = await buildGoldenContext()
    const replaced = structuredClone(pack)
    replaced.results.find((item) => item.source_id === "K007")!.retrieval_trace.matched_fields = ["difficulty"]
    replaced.kb_version = "kb-replaced-after-spec"
    const report = validateSpecEvidence(spec.spec, replaced)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain("kb_version_mismatch")
    expect(report.issues.map((issue) => issue.code)).toContain("evidence_content_hash_mismatch")
    expect(report.issues.map((issue) => issue.code)).not.toContain("weak_target_source")
  })

  test("requires frozen evidence for every declared prerequisite source", async () => {
    const { pack, path } = await buildGoldenContext()
    const missingPrerequisite = structuredClone(pack)
    missingPrerequisite.results = missingPrerequisite.results.filter(
      (item) => item.source_id !== path.prerequisite_source_ids[0],
    )
    const built = buildGenerationSpec({
      run_id: "RUN-MISSING-PREREQUISITE-EVIDENCE",
      profile_snapshot: adaptLearnerProfile(profile, {
        profile_version: "profile-v1",
      }),
      path_node: path,
      evidence_pack: missingPrerequisite,
      versions: {
        prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
        model_config_hash: "none",
      },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.code).toBe("MISSING_EVIDENCE")
      if (built.code !== "MISSING_EVIDENCE") return
      expect(built.errors).toContain(
        `缺少先修知识点：${path.prerequisite_source_ids[0]}`,
      )
      expect(built.gap_request.target_source_ids).toContain(
        path.prerequisite_source_ids[0],
      )
    }
  })

  test("copies the upstream assessment blueprint verbatim and includes it in spec identity", async () => {
    const { pack, path, spec } = await buildGoldenContext()
    const customPath = structuredClone(path)
    customPath.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 2,
      tier_3_count: 2,
      required_modalities: ["true_false", "short_answer", "code"],
    }
    const built = buildGenerationSpec({
      run_id: "RUN-C-GOLDEN-001",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: customPath,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "provider-not-bound" },
      seed: 42,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.spec.assessment_blueprint).toEqual(customPath.assessment_blueprint)
    expect(built.spec.spec_id).not.toBe(spec.spec.spec_id)
  })

  test("rejects a path node that omits the upstream assessment blueprint", async () => {
    const { pack, path } = await buildGoldenContext()
    const missing = structuredClone(path) as Omit<LearningPathNode, "assessment_blueprint"> & {
      assessment_blueprint?: LearningPathNode["assessment_blueprint"]
    }
    delete missing.assessment_blueprint
    const built = buildGenerationSpec({
      run_id: "RUN-MISSING-BLUEPRINT",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: missing as LearningPathNode,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.code).toBe("INVALID_INPUT")
      expect(built.errors).toContain("path_node.assessment_blueprint 必须由上游下发")
    }
  })

  test("rejects an unsupported or undersized upstream assessment blueprint", async () => {
    const { pack, path } = await buildGoldenContext()
    const invalid = structuredClone(path)
    invalid.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 0,
      tier_3_count: 0,
      required_modalities: ["essay" as "mcq"],
    }
    const built = buildGenerationSpec({
      run_id: "RUN-INVALID-BLUEPRINT",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: invalid,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.code).toBe("INVALID_INPUT")
      expect(built.errors).toEqual(expect.arrayContaining([
        "不支持的 assessment modality：essay",
        "assessment blueprint 总题量不能少于 core objective 数量",
      ]))
    }
  })

  test("rejects a blueprint whose fixed modalities cannot measure every core objective", async () => {
    const { pack, path } = await buildGoldenContext()
    const incompatible = structuredClone(path)
    incompatible.target_source_ids = ["K007"]
    incompatible.prerequisite_source_ids = []
    incompatible.objectives = [{
      objective_id: "O-EXPLAIN",
      source_id: "K007",
      required_fact_ids: ["F001"],
      observable_behavior: "explain",
      importance: "core",
    }]
    incompatible.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 0,
      tier_3_count: 0,
      required_modalities: ["mcq"],
    }
    const built = buildGenerationSpec({
      run_id: "RUN-INCOMPATIBLE-BLUEPRINT",
      profile_snapshot: adaptLearnerProfile(profile, {
        profile_version: "profile-v1",
      }),
      path_node: incompatible,
      evidence_pack: pack,
      versions: {
        prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
        model_config_hash: "none",
      },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.errors).toContain(
        "assessment blueprint 的必选题型和剩余题量无法直接测量全部 core objective",
      )
    }
  })

  test("rejects target source ids that have no corresponding objective", async () => {
    const { pack, path } = await buildGoldenContext()
    const incomplete = structuredClone(path)
    incomplete.objectives = incomplete.objectives.filter(
      (objective) => objective.source_id !== "K009",
    )
    const built = buildGenerationSpec({
      run_id: "RUN-MISSING-TARGET-OBJECTIVE",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: incomplete,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.errors).toContain(
        "target_source_ids 中的每个知识点都必须有 objective：K009",
      )
    }
  })

  test("rejects an assessment blueprint with only Tier 3 items", async () => {
    const { pack, path } = await buildGoldenContext()
    const noAnchor = structuredClone(path)
    noAnchor.assessment_blueprint = {
      tier_1_count: 0,
      tier_2_count: 0,
      tier_3_count: 3,
      required_modalities: ["code"],
    }
    const built = buildGenerationSpec({
      run_id: "RUN-NO-ASSESSMENT-ANCHOR",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: noAnchor,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.errors).toContain(
        "assessment blueprint 至少需要一道 Tier 1 或 Tier 2 锚点题",
      )
    }
  })

  test("validates citations against only the current evidence pack", async () => {
    const { pack } = await buildGoldenContext()
    expect(validateCitations([{ source_id: "K007", fact_id: "F001", relation: "supports" }], pack).ok).toBe(true)
    expect(validateCitations([{ source_id: "K999", fact_id: "F999", relation: "supports" }], pack).ok).toBe(false)
  })
})

describe("role C public/private and orchestration boundaries", () => {
  test("detects nested answer and hidden-test leakage in public output", () => {
    const report = validatePublicArtifactNoSecrets({
      title: "public",
      nested: { answer: "secret", hidden_tests: [{ expected: 1 }] },
    })
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain("public_secure_leak")
  })

  test("rejects illegal state transitions", () => {
    expect(transitionCState("PLANNED", "GENERATING")).toBe("GENERATING")
    expect(() => transitionCState("PLANNED", "READY")).toThrow("非法 C 流水线状态转换")
  })

  test("runs the shell pipeline and returns only secure references", async () => {
    const { pack, spec } = await buildGoldenContext()
    const provider = fixtureProvider()
    const stored: SecureArtifact[] = []
    const store: SecureArtifactStore = {
      async put(artifact, context) {
        return (await this.putBatch([artifact], context))[0]
      },
      async putBatch(artifacts) {
        stored.push(...artifacts)
        return artifacts.map((artifact) => `secure://${artifact.artifact_id}`)
      },
      async get() { throw new Error("not used") },
      async deleteBatch() {},
    }
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(provider, fixtureVerifiers),
      store,
    )
    expect(result.status).toBe("ready")
    expect(result.state).toBe("READY")
    expect(result.secure_refs).toHaveLength(2)
    expect(stored.map((artifact) => artifact.artifact_type)).toEqual(["code_lab_secure", "assessment_secure"])
    expect(JSON.stringify(result.public_artifacts)).not.toContain("reference_solution")
    expect(JSON.stringify(result.public_artifacts)).not.toContain("hidden_tests")
  })

  test("passes one validated next-round focus context to all three Agents", async () => {
    const { pack, spec } = await buildGoldenContext()
    const base = createRoleCAgents(
      fixtureProvider(),
      fixtureVerifiers,
    )
    const seen: NonNullable<Parameters<RoleCAgents["concept_tutor"]["generate"]>[0]["next_round_context"]>[] = []
    const agents: RoleCAgents = {
      concept_tutor: {
        async generate(request) {
          seen.push(structuredClone(request.next_round_context!))
          return base.concept_tutor.generate(request)
        },
      },
      code_lab: {
        async generate(request) {
          seen.push(structuredClone(request.next_round_context!))
          return base.code_lab.generate(request)
        },
      },
      tiered_evaluator: {
        async generate(request) {
          seen.push(structuredClone(request.next_round_context!))
          return base.tiered_evaluator.generate(request)
        },
      },
    }
    const nextRoundContext = {
      request_id: "NXR-FOCUS",
      parent_spec_id: "SPEC-PARENT",
      prior_feedback_ref: "DFR-FOCUS",
      trigger_grade_artifact_id: "ART-GRADE-FOCUS",
      action: "remediate" as const,
      focus_objective_ids: ["O1"],
      reason_codes: ["round_accuracy_below_remediation_threshold"],
    }
    const result = await runCPipeline(
      {
        generation_spec: spec.spec,
        evidence_pack: pack,
        next_round_context: nextRoundContext,
      },
      agents,
      {
        async put(artifact) { return `secure://${artifact.artifact_id}` },
        async putBatch(artifacts) {
          return artifacts.map((artifact) => `secure://${artifact.artifact_id}`)
        },
        async get() { throw new Error("not used") },
        async deleteBatch() {},
      },
    )
    expect(result.status).toBe("ready")
    expect(seen).toHaveLength(3)
    expect(seen.every((context) =>
      JSON.stringify(context) === JSON.stringify(nextRoundContext))).toBe(true)
  })

  test("keeps optional semantic critic findings as nonblocking diagnostics", async () => {
    const { pack, spec } = await buildGoldenContext()
    const baseline = fixtureProvider()
    let assessmentCalls = 0
    const provider: RoleCContentProvider = {
      ...baseline,
      async generateAssessment(request) {
        assessmentCalls += 1
        return baseline.generateAssessment(request)
      },
    }
    let reviews = 0
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(provider, fixtureVerifiers),
      {
        async put(artifact) { return `secure://${artifact.artifact_id}` },
        async putBatch(artifacts) { return artifacts.map((artifact) => `secure://${artifact.artifact_id}`) },
        async get() { throw new Error("not used") },
        async deleteBatch() {},
      },
      {
        critic: {
          async review(input) {
            reviews += 1
            return [{
              objection_id: "OBJ-ONE-REVISION",
              from_agent: "cross-artifact-gate",
              target_artifact_id: input.assessment.artifact_id,
              objective_id: "O2",
              issue_type: "difficulty_mismatch",
              severity: "critical",
              evidence: ["fixture critic request"],
              proposed_action: "重新生成 assessment 并复核",
            }]
          },
        },
      },
    )
    expect(result.status).toBe("ready")
    expect(assessmentCalls).toBe(1)
    expect(reviews).toBe(1)
    expect(result.alignment_report?.objections).toContainEqual(
      expect.objectContaining({
        objection_id: "OBJ-ONE-REVISION",
        severity: "warning",
      }),
    )
    expect(result.trace_events.filter((event) => event.retry_kind === "semantic_revision")).toHaveLength(0)
  })

  test("revises code lab before assessment and passes the revised lab summary downstream", async () => {
    const { pack, spec } = await buildGoldenContext()
    const baseAgents = createRoleCAgents(fixtureProvider(), fixtureVerifiers)
    const events: string[] = []
    let labCalls = 0
    let assessmentCalls = 0
    let revisedAssessmentSummary:
      Parameters<RoleCAgents["tiered_evaluator"]["generate"]>[0]["code_lab_summary"]
    const agents: RoleCAgents = {
      concept_tutor: baseAgents.concept_tutor,
      code_lab: {
        async generate(request) {
          labCalls += 1
          const call = labCalls
          events.push(`lab-${call}-started`)
          const pair = structuredClone(await baseAgents.code_lab.generate(request))
          if (call === 1) {
            pair.public_artifact.quality.execution_verified = false
            pair.secure_artifact.quality.execution_verified = false
          }
          events.push(`lab-${call}-completed`)
          return pair
        },
      },
      tiered_evaluator: {
        async generate(request) {
          assessmentCalls += 1
          const call = assessmentCalls
          events.push(`assessment-${call}-started`)
          if (call === 2) {
            revisedAssessmentSummary = structuredClone(request.code_lab_summary)
          }
          const pair = await baseAgents.tiered_evaluator.generate(request)
          events.push(`assessment-${call}-completed`)
          return pair
        },
      },
    }
    let reviews = 0
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      agents,
      {
        async put(artifact) { return `secure://${artifact.artifact_id}` },
        async putBatch(artifacts) {
          return artifacts.map((artifact) => `secure://${artifact.artifact_id}`)
        },
        async get() { throw new Error("not used") },
        async deleteBatch() {},
      },
      {
        critic: {
          async review(input) {
            reviews += 1
            if (reviews > 1) return []
            return [{
              objection_id: "OBJ-ASSESSMENT-AFTER-LAB",
              from_agent: "cross-artifact-gate",
              target_artifact_id: input.assessment.artifact_id,
              objective_id: "O2",
              issue_type: "difficulty_mismatch",
              severity: "critical",
              evidence: ["assessment must consume the revised lab summary"],
              proposed_action: "先修订实验，再基于新版实验摘要修订测评",
            }]
          },
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(labCalls).toBe(2)
    expect(assessmentCalls).toBe(2)
    expect(events.indexOf("lab-2-completed")).toBeLessThan(
      events.indexOf("assessment-2-started"),
    )
    expect(revisedAssessmentSummary?.execution_verified).toBe(true)
    expect(revisedAssessmentSummary?.lab_id).toBe(
      result.public_artifacts.code_lab?.payload?.lab_id,
    )
  })

  test("returns a typed failure when secure storage is unavailable", async () => {
    const { pack, spec } = await buildGoldenContext()
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(fixtureProvider(), fixtureVerifiers),
      {
        async put() { throw new Error("secure store offline") },
        async putBatch() { throw new Error("secure store offline") },
        async get() { throw new Error("secure store offline") },
        async deleteBatch() {},
      },
    )
    expect(result.status).toBe("failed")
    expect(result.state).toBe("FAILED")
    expect(result.failure_reason?.code).toBe("SECURE_STORE_ERROR")
    expect(result.secure_refs).toEqual([])
  })

  test("does not accept execution or answer verification from the content Provider", async () => {
    const { pack, spec } = await buildGoldenContext()
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(fixtureProvider()),
      {
        async put(artifact) { return `secure://${artifact.artifact_id}` },
        async putBatch(artifacts) { return artifacts.map((artifact) => `secure://${artifact.artifact_id}`) },
        async get() { throw new Error("not used") },
        async deleteBatch() {},
      },
    )
    expect(result.status).toBe("blocked")
    expect(result.blocked_reason?.code).toBe("BLOCKED_EXECUTION_UNVERIFIED")
  })
})

describe("role C published integration assets", () => {
  test("ships parseable schemas for every external C message and core artifact", async () => {
    const files = (await readdir("schemas/role-c-content")).filter((file) => file.endsWith(".schema.json")).sort()
    expect(files).toEqual([
      "agent_trace_event.schema.json",
      "alignment_critic_judgment.schema.json",
      "artifact_envelope.schema.json",
      "assessment_draft.schema.json",
      "assessment_public.schema.json",
      "assessment_secure.schema.json",
      "code_lab_draft.schema.json",
      "code_lab_public.schema.json",
      "code_lab_secure.schema.json",
      "concept_artifact.schema.json",
      "concept_lesson_payload.schema.json",
      "delivery_ack.schema.json",
      "dynamic_feedback_delivery.schema.json",
      "dynamic_feedback_result.schema.json",
      "evidence_gap_request.schema.json",
      "fact_audit_packet.schema.json",
      "generation_spec.schema.json",
      "grade_feedback.schema.json",
      "grade_result.schema.json",
      "learner_profile_snapshot.schema.json",
      "learning_evidence_event.schema.json",
      "learning_path_node.schema.json",
      "learning_progress_delivery.schema.json",
      "learning_session_delivery.schema.json",
      "profile_drift_suggestion.schema.json",
      "rag_evidence_pack.schema.json",
      "review_recovery_result.schema.json",
      "review_recovery_status.schema.json",
      "review_recovery_status_delivery.schema.json",
      "reviewed_release_delivery.schema.json",
      "role_b_path_draft.schema.json",
      "role_b_path_planning_request.schema.json",
      "role_b_path_planning_result.schema.json",
      "rubric_judgment.schema.json",
      "session_state.schema.json",
      "submission.schema.json",
    ])
    for (const file of files) {
      const schema = await Bun.file(join("schemas/role-c-content", file)).json()
      expect(schema.$schema).toContain("json-schema")
      expect(schema.$id).toContain("/schemas/role-c-content/")
      expect(schema.type).toBe("object")
      if ([
        "concept_artifact.schema.json",
        "code_lab_public.schema.json",
        "code_lab_secure.schema.json",
        "assessment_public.schema.json",
        "assessment_secure.schema.json",
        "grade_result.schema.json",
      ].includes(file)) {
        expect(schema.allOf).toEqual([{ $ref: "artifact_envelope.schema.json" }])
      }
    }
    expect(JSON.stringify(getRoleCModelOutputSchema("assessment_draft.schema.json"))).not.toContain("\"$ref\"")
  })

  test("validates B path recovery messages and exposes only a D-safe recovery result", async () => {
    const { path, spec } = await buildGoldenContext()
    const snapshot = adaptLearnerProfile(profile, {
      profile_version: "profile-v1",
    })
    const request = {
      schema_version: "1.0",
      request_id: "BPATH-SCHEMA-001",
      run_id: spec.spec.run_id,
      current_spec_id: spec.spec.spec_id,
      profile_snapshot: snapshot,
      current_path_node: path,
      failed_dimensions: ["prerequisite_coverage"],
      missing_prerequisite_source_ids: ["K006"],
      required_action: "replan_path",
      fix_scope: "new_spec",
      recommended_level: "beginner",
      review_instruction_ids: ["REVIEW-INSTRUCTION-001"],
    }
    expect(validateRoleCSchema(
      "role_b_path_planning_request.schema.json",
      request,
    ).ok).toBe(true)
    expect(validateRoleCSchema(
      "role_b_path_planning_request.schema.json",
      {
        ...request,
        required_action: "request_new_evidence",
      },
    ).ok).toBe(false)

    const readyPlanningResult = {
      status: "ready",
      request_id: request.request_id,
      path_draft: {
        ...structuredClone(path),
        objectives: path.objectives.map((objective) => ({
          ...structuredClone(objective),
          required_fact_ids: [],
        })),
      },
      profile_snapshot: snapshot,
    }
    expect(validateRoleCSchema(
      "role_b_path_planning_result.schema.json",
      readyPlanningResult,
    ).ok).toBe(true)
    expect(validateRoleCSchema(
      "role_b_path_planning_result.schema.json",
      {
        status: "blocked",
        request_id: request.request_id,
        code: "UNSUPPORTED_TARGET",
        reason: "B 无法规划当前目标",
        failed_dimensions: ["UNSUPPORTED_TARGET"],
        missing_prerequisite_source_ids: [],
        can_recover: false,
      },
    ).ok).toBe(true)
    expect(validateRoleCSchema(
      "role_b_path_planning_result.schema.json",
      {
        ...readyPlanningResult,
        code: "BLOCKED",
      },
    ).ok).toBe(false)

    const recoveryResult = {
      schema_version: "1.0",
      result_kind: "review_recovery",
      run_id: "RUN-C-RECOVERY-SCHEMA-001",
      spec_id: "GS-C-RECOVERY-SCHEMA-001",
      pipeline_input_hash: `sha256:${"a".repeat(64)}`,
      generation_spec_hash: `sha256:${"b".repeat(64)}`,
      pipeline_status: "blocked",
      pipeline_state: "BLOCKED",
      review_policy_version: "review-policy-v1",
      recovery: {
        code: "BLOCKED",
        failed_dimensions: ["prerequisite_coverage"],
        missing_prerequisite_source_ids: ["K006"],
        unknown_prerequisite_refs: ["legacy:while-loop"],
        required_action: "replan_path",
        fix_scope: "new_spec",
        can_recover: false,
        recovery_attempts: 1,
        message: "前置知识引用无法解析，已停止发布",
      },
      recovery_history: [{
        attempt_no: 1,
        action: "new_spec",
        input_spec_id: spec.spec.spec_id,
        input_run_id: spec.spec.run_id,
        path_request_id: request.request_id,
      }],
    }
    expect(validateRoleCSchema(
      "review_recovery_status.schema.json",
      recoveryResult.recovery,
    ).ok).toBe(true)
    expect(validateRoleCSchema(
      "review_recovery_result.schema.json",
      recoveryResult,
    ).ok).toBe(true)
    expect(validateRoleCSchema(
      "review_recovery_result.schema.json",
      {
        ...recoveryResult,
        pipeline_status: "ready",
        pipeline_state: "READY",
        recovery: {
          ...recoveryResult.recovery,
          code: "READY",
          unknown_prerequisite_refs: [],
          required_action: "none",
          fix_scope: "none",
          message: "内容已通过完整审核",
        },
      },
    ).ok).toBe(true)

    for (const secretField of [
      "profile_snapshot",
      "evidence_pack",
      "secure_refs",
      "trusted_context",
    ]) {
      expect(validateRoleCSchema(
        "review_recovery_result.schema.json",
        {
          ...recoveryResult,
          [secretField]: {},
        },
      ).ok).toBe(false)
    }
    expect(validateRoleCSchema(
      "review_recovery_status.schema.json",
      {
        ...recoveryResult.recovery,
        unknown_prerequisite_refs: [
          "legacy:while-loop",
          "legacy:while-loop",
        ],
      },
    ).ok).toBe(false)
    expect(validateRoleCSchema(
      "review_recovery_result.schema.json",
      {
        ...recoveryResult,
        pipeline_status: "ready",
        pipeline_state: "READY",
      },
    ).ok).toBe(false)
    expect(validateRoleCSchema(
      "review_recovery_result.schema.json",
      {
        ...recoveryResult,
        pipeline_state: "READY",
      },
    ).ok).toBe(false)

    const terminalResult = structuredClone(
      recoveryResult,
    ) as ReviewRecoveryPublicResult
    const statusDeliveries: RoleCReviewRecoveryStatusDelivery[] = []
    const committed = new Set<string>()
    const statusPort = {
      async publishReviewRecoveryStatus(
        delivery: RoleCReviewRecoveryStatusDelivery,
      ) {
        statusDeliveries.push(structuredClone(delivery))
        const duplicate = committed.has(delivery.delivery_id)
        committed.add(delivery.delivery_id)
        return {
          schema_version: "1.0" as const,
          delivery_kind: "review_recovery_status" as const,
          delivery_id: delivery.delivery_id,
          status: duplicate ? "duplicate" as const : "accepted" as const,
        }
      },
    }
    const firstStatusAck = await deliverReviewRecoveryStatusToD(
      statusPort,
      terminalResult,
    )
    const replayStatusAck = await deliverReviewRecoveryStatusToD(
      statusPort,
      structuredClone(terminalResult),
    )
    expect(firstStatusAck.status).toBe("accepted")
    expect(replayStatusAck.status).toBe("duplicate")
    expect(statusDeliveries).toHaveLength(2)
    expect(statusDeliveries[0]!.delivery_id)
      .toBe(statusDeliveries[1]!.delivery_id)
    expect(validateRoleCSchema(
      "review_recovery_status_delivery.schema.json",
      statusDeliveries[0],
    ).ok).toBe(true)
    expect(JSON.stringify(statusDeliveries[0])).not.toContain("quiz_seeds")

    const readyResult = {
      ...structuredClone(terminalResult),
      pipeline_status: "ready" as const,
      pipeline_state: "READY" as const,
      recovery: {
        ...structuredClone(terminalResult.recovery),
        code: "READY" as const,
        unknown_prerequisite_refs: [],
        required_action: "none" as const,
        fix_scope: "none" as const,
        message: "内容已通过完整审核",
      },
    }
    await expect(deliverReviewRecoveryStatusToD(
      statusPort,
      readyResult,
    )).rejects.toThrow("ROLE_C_D_RECOVERY_STATUS_NOT_TERMINAL")

    let rejectedDeliveryCalls = 0
    await expect(deliverReviewRecoveryStatusToD(
      {
        async publishReviewRecoveryStatus(delivery) {
          rejectedDeliveryCalls += 1
          return {
            schema_version: "1.0",
            delivery_kind: "review_recovery_status",
            delivery_id: delivery.delivery_id,
            status: "accepted",
          }
        },
      },
      {
        ...structuredClone(terminalResult),
        answer: "must-not-leave-c",
      } as unknown as ReviewRecoveryPublicResult,
    )).rejects.toThrow("ROLE_C_OUTBOUND_SCHEMA_INVALID")
    expect(rejectedDeliveryCalls).toBe(0)

    await expect(deliverReviewRecoveryStatusToD(
      {
        async publishReviewRecoveryStatus(delivery) {
          return {
            schema_version: "1.0",
            delivery_kind: "reviewed_release",
            delivery_id: delivery.delivery_id,
            status: "accepted",
          }
        },
      },
      terminalResult,
    )).rejects.toThrow("ROLE_C_D_ACK_KIND_MISMATCH")
  })

  test("delivers reviewed content and a learning session under independent stable identities", async () => {
    const result = await reviewedGoldenResult()
    if (result.status !== "ready" || result.state !== "READY") {
      throw new Error("reviewed fixture must be ready")
    }
    const assessment = result.public_artifacts.assessment
    if (!assessment?.payload) throw new Error("assessment fixture missing")
    const route = assessment.payload.routing.rules[0]!
    const anchors = new Set(assessment.payload.routing.anchor_item_ids)
    const requiredItemIds = assessment.payload.items
      .filter((item) =>
        anchors.has(item.item_id) || route.reveal_tiers.includes(item.tier))
      .map((item) => item.item_id)
    const handoff: RoleCLearningSessionHandoff = {
      phase: "route_locked",
      routing_request_id: "ROUTING-INDEPENDENT-001",
      session_id: "SESSION-INDEPENDENT-001",
      run_id: result.generation_spec.run_id,
      form_id: assessment.payload.form_id,
      attempt_no: 1,
      route_lock_id: "ROUTE-LOCK-INDEPENDENT-001",
      route_id: route.route_id,
      action: route.action,
      anchor_score_ratio: route.min_anchor_score_ratio,
      required_item_ids: requiredItemIds,
    }

    const releases: RoleCReviewedReleaseDelivery[] = []
    const releasePort = {
      async publishReviewedRelease(release: RoleCReviewedReleaseDelivery) {
        releases.push(structuredClone(release))
        return {
          schema_version: "1.0" as const,
          delivery_kind: "reviewed_release" as const,
          delivery_id: release.delivery_id,
          status: releases.length === 1
            ? "accepted" as const
            : "duplicate" as const,
        }
      },
    }
    await deliverRoleCToD(releasePort, result)
    await deliverRoleCToD(releasePort, structuredClone(result))
    expect(releases).toHaveLength(2)
    expect(releases[0]!.delivery_id).toBe(releases[1]!.delivery_id)
    expect("learning_session" in releases[0]!).toBe(false)
    expect("learning_session" in releases[1]!).toBe(false)
    expect(validateRoleCSchema(
      "reviewed_release_delivery.schema.json",
      releases[1],
    ).ok).toBe(true)

    const sessions: RoleCLearningSessionDelivery[] = []
    const committedSessions = new Set<string>()
    const sessionPort = {
      async publishLearningSession(delivery: RoleCLearningSessionDelivery) {
        sessions.push(structuredClone(delivery))
        const duplicate = committedSessions.has(delivery.delivery_id)
        committedSessions.add(delivery.delivery_id)
        return {
          schema_version: "1.0" as const,
          delivery_kind: "learning_session" as const,
          delivery_id: delivery.delivery_id,
          status: duplicate ? "duplicate" as const : "accepted" as const,
        }
      },
    }
    const pendingHandoff: RoleCLearningSessionHandoff = {
      phase: "anchor_pending",
      routing_request_id: "ROUTING-INDEPENDENT-PENDING-001",
      session_id: "SESSION-INDEPENDENT-PENDING-001",
      run_id: result.generation_spec.run_id,
      form_id: assessment.payload.form_id,
      attempt_no: 1,
      required_item_ids: [...assessment.payload.routing.anchor_item_ids],
    }
    expect((await deliverLearningSessionToD(
      sessionPort,
      result,
      pendingHandoff,
    )).status).toBe("accepted")
    const firstSessionAck = await deliverLearningSessionToD(
      sessionPort,
      result,
      handoff,
    )
    const replaySessionAck = await deliverLearningSessionToD(
      sessionPort,
      structuredClone(result),
      {
        ...structuredClone(handoff),
        required_item_ids: [...handoff.required_item_ids].reverse(),
      },
    )
    expect(firstSessionAck.status).toBe("accepted")
    expect(replaySessionAck.status).toBe("duplicate")
    expect(sessions).toHaveLength(3)
    expect(sessions[1]!.delivery_id).toBe(sessions[2]!.delivery_id)
    expect(sessions[0]!.session).toEqual(pendingHandoff)
    expect(sessions[1]!.session).toEqual(handoff)
    expect("artifacts" in sessions[1]!).toBe(false)
    expect(validateRoleCSchema(
      "learning_session_delivery.schema.json",
      sessions[0],
    ).ok).toBe(true)
    expect(validateRoleCSchema(
      "learning_session_delivery.schema.json",
      sessions[1],
    ).ok).toBe(true)

    await expect(deliverLearningSessionToD(
      sessionPort,
      result,
      {
        ...handoff,
        required_item_ids: ["UNKNOWN-ITEM"],
      },
    )).rejects.toThrow("ROLE_C_D_SESSION_ITEMS_MISMATCH")
    await expect(deliverLearningSessionToD(
      sessionPort,
      result,
      {
        ...handoff,
        anchor_score_ratio: route.max_anchor_score_ratio,
      },
    )).rejects.toThrow("ROLE_C_D_SESSION_ROUTE_MISMATCH")
  })

  test("gives all three public workers distinct C-shell role prompts", () => {
    for (const name of ["concept-tutor", "code-lab", "tiered-evaluator"] as const) {
      const definition = WORKER_DEFINITIONS.find((worker) => worker.name === name)!
      const prompt = buildWorkerStubPrompt(definition)
      expect(prompt).toContain(ROLE_C_PROMPT_MANIFEST_VERSION)
      expect(prompt).toContain("generation_spec")
      expect(prompt).toContain("evidence_pack")
      expect(prompt).toContain("rag_result")
      expect(prompt).toContain(`[executed:${name}]`)
    }
    const labPrompt = buildWorkerStubPrompt(WORKER_DEFINITIONS.find((worker) => worker.name === "code-lab")!)
    expect(labPrompt).toContain("reference_solution")
    expect(labPrompt).toContain("BLOCKED_EXECUTION_UNVERIFIED")
  })

  test("indexes every Role C prompt file with the current manifest version", async () => {
    const index = await Bun.file("docs/role_c_prompt_index.md").text()
    expect(index).toContain(ROLE_C_PROMPT_MANIFEST_VERSION)
    for (const file of [
      "common-policy.ts",
      "concept-tutor.v1.ts",
      "code-lab.v1.ts",
      "evaluator-author.v1.ts",
      "staged-authors.v1.ts",
      "evaluator-grader.v1.ts",
      "evaluator-feedback.v1.ts",
      "cross-artifact-critic.v1.ts",
    ]) {
      expect(index).toContain(file)
    }
  })
})

async function reviewedGoldenResult() {
  const { pack, spec } = await buildGoldenContext()
  const policyVersion = "framework-independent-delivery-review-v1"
  return runReviewedCPipeline(
    {
      generation_spec: spec.spec,
      evidence_pack: pack,
    },
    createRoleCAgents(fixtureProvider(), fixtureVerifiers),
    new InMemorySecureArtifactStore(),
    {
      review_port: {
        policy_version: policyVersion,
        async review(request) {
          return passingReviewResult(request, policyVersion)
        },
      },
    },
  )
}

function passingReviewResult(
  request: ContentReviewRequest,
  policyVersion: string,
): ContentReviewResult {
  return {
    run_id: request.run_id,
    pipeline_input_hash: request.pipeline_input_hash,
    generation_spec_hash: request.generation_spec_hash,
    policy_version: policyVersion,
    revision_round: request.revision_round,
    max_revision_rounds: request.max_revision_rounds,
    evidence_hash: request.evidence_hash,
    decision: "pass",
    artifact_results: request.artifacts.map((target) => ({
      artifact_kind: target.kind,
      artifact_id: target.artifact.artifact_id,
      artifact_hash: target.artifact_hash,
      fact_status: "pass",
      teaching_status: "pass",
      decision: "pass",
      can_revise: false,
      findings: [],
      revision_instructions: [],
    })),
    revision_instructions: [],
  }
}

function fixtureProvider(): RoleCContentProvider {
  const provider = new TestRoleCContentProvider()
  return {
    async generateConceptLesson(request) { return provider.generateConceptLesson(request) },
    async generateCodeLab(request) { return provider.generateCodeLab(request) },
    async generateAssessment(request) { return provider.generateAssessment(request) },
  }
}

const fixtureVerifiers: GeneratedContentVerifiers = {
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
