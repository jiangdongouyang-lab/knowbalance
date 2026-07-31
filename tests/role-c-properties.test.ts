import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { retrieveKnowledge } from "../src/rag/retriever"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildAssessmentAuthorModelInput,
  buildGenerationSpec,
  createRoleCAgents,
  defineLearningPathNode,
  detectEvidenceConflicts,
  deliverRoleCToB,
  DeterministicCodeLabContentProvider,
  EvidencePhraseRubricJudge,
  executeTrustedReferenceWithRetry,
  executeWithRunnerRetry,
  generateConceptLesson,
  gradeSubmission,
  InMemoryAgentTraceStore,
  InMemoryContentCache,
  InMemoryMasteryStateStore,
  InMemoryPipelineCheckpointStore,
  InMemorySecureArtifactStore,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  runCPipeline,
  TrustedAssessmentVerifier,
  TrustedCodeLabVerifier,
  updateMasteryFromEvidence,
  validatePublicArtifactNoSecrets,
  type AssessmentSecureArtifact,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type GenerationSpec,
  type LearningEvidenceEvent,
  type ObjectiveMasteryState,
  type ProfileDriftSuggestion,
  type RagEvidencePack,
  type RoleCDeliveryAck,
  type RoleCLearningProgressDelivery,
  type RoleCContentProvider,
  type SubmissionEnvelope,
  type TieredEvaluatorRequest,
} from "../src/role-c-content"

const DIGEST = `sha256:${"e".repeat(64)}`
const profile: LearnerProfile = {
  learner_id: "property-learner",
  level: "beginner",
  known_concepts: ["变量", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成成绩统计程序",
}

async function golden(seed = 42): Promise<{
  spec: GenerationSpec
  evidence: RagEvidencePack
  request: TieredEvaluatorRequest
  provider: DeterministicCodeLabContentProvider
}> {
  const rag = await retrieveKnowledge({ query: buildRagRequest(profile).query, learnerLevel: profile.level, topK: 5 })
  const kb = await loadKnowledgeBase()
  const evidence = adaptRagResult(rag, { kb_version: kb.version, rag_version: "rule-rag-0.1" })
  const raw = await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()
  const path = defineLearningPathNode({
    node_id: raw.node_id,
    target_source_ids: raw.target_source_ids,
    prerequisite_source_ids: raw.prerequisite_source_ids,
    goal: raw.goal,
    objectives: raw.objectives,
    assessment_blueprint: raw.assessment_blueprint,
  })
  const built = buildGenerationSpec({
    run_id: `RUN-PROPERTY-${seed}`,
    profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-property-v1" }),
    path_node: path,
    evidence_pack: evidence,
    versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "deterministic-full-reference-v1", runner_image_digest: DIGEST },
    seed,
  })
  if (!built.ok) throw new Error(built.errors.join(";"))
  const provider = new DeterministicCodeLabContentProvider()
  const concept = await generateConceptLesson({ generation_spec: built.spec, evidence_pack: evidence }, provider)
  if (concept.status !== "ready") throw new Error("concept fixture unavailable")
  return { spec: built.spec, evidence, provider, request: { generation_spec: built.spec, evidence_pack: evidence, concept_artifact: concept } }
}

describe("role C eleven contract properties", () => {
  test("P01 identical input and seed reproduce the same assessment", async () => {
    const context = await golden(42)
    expect(await context.provider.generateAssessment(context.request)).toEqual(await context.provider.generateAssessment(context.request))
  })

  test("P02 learner adaptation cannot change frozen answer semantics", async () => {
    const context = await golden(42)
    const changed = structuredClone(context.request)
    changed.generation_spec.learner_adaptation.level = "integrated"
    changed.generation_spec.learner_adaptation.scaffold_level = 0
    changed.generation_spec.learner_adaptation.weak_concepts = []
    const first = await context.provider.generateAssessment(context.request)
    const second = await context.provider.generateAssessment(changed)
    expect(second.secure_draft.payload.items.map((item) => item.answer_spec)).toEqual(
      first.secure_draft.payload.items.map((item) => item.answer_spec),
    )
    expect(JSON.stringify(buildAssessmentAuthorModelInput(changed))).not.toContain(profile.learner_id)
  })

  test("P03 deleting a required citation blocks publication", async () => {
    const context = await golden()
    const provider = context.provider as RoleCContentProvider
    const baseline = provider.generateConceptLesson.bind(provider)
    provider.generateConceptLesson = async (request) => {
      const draft = await baseline(request)
      const block = draft.payload.explanation_blocks[0]
      if (block && "claims" in block) block.claims[0]!.citations = []
      return draft
    }
    const artifact = await generateConceptLesson({ generation_spec: context.spec, evidence_pack: context.evidence }, provider)
    expect(artifact.status).toBe("blocked")
  })

  test("P04 any nested answer-bearing public key is rejected", () => {
    expect(validatePublicArtifactNoSecrets({ section: [{ nested: { correct_option_id: "opt-a" } }] }).ok).toBe(false)
  })

  test("P05 duplicate, unknown, or cross-run submissions never grade", async () => {
    const secure = oneItemSecure()
    const submission = oneItemSubmission()
    submission.answers.push({ ...submission.answers[0]! })
    submission.run_id = "RUN-OTHER"
    const grade = await gradeSubmission(submission, secure)
    expect(grade.status).toBe("blocked")
    expect(grade.validation_issues?.join(" ")).toContain("重复")
    expect(grade.validation_issues?.join(" ")).toContain("run_id")
  })

  test("P06 hints and repeated exposure can only lower evidence weight", async () => {
    const secure = oneItemSecure()
    const plain = await gradeSubmission(oneItemSubmission(), secure)
    const hintedSubmission = oneItemSubmission()
    hintedSubmission.answers[0]!.hint_level_used = 2
    const hinted = await gradeSubmission(hintedSubmission, secure, { repeat_exposure_by_item: { I1: 3 } })
    expect(plain.item_results[0]!.raw_score).toBe(hinted.item_results[0]!.raw_score)
    expect(hinted.item_results[0]!.evidence_score).toBeLessThan(plain.item_results[0]!.evidence_score)
  })

  test("P07 uncertain rubric criteria trigger needs_review instead of guessed score", async () => {
    const secure = oneItemSecure({
      kind: "concept_rubric",
      criteria: [{ criterion_id: "C1", description: "说明顺序", weight: 1, required_evidence: ["顺序", "逐项"] }],
      contradictions: [],
    }, "short_answer")
    const submission = oneItemSubmission({ text_response: "列表有顺序" })
    const grade = await gradeSubmission(submission, secure, { rubric_judge: new EvidencePhraseRubricJudge() })
    expect(grade.status).toBe("needs_review")
    expect(grade.item_results[0]!.rubric_results?.[0]?.status).toBe("uncertain")
  })

  test("P08 runner_error retries are bounded and learner failures are not retried", async () => {
    let calls = 0
    const runner: CodeRunner = {
      runner_image_digest: DIGEST,
      async execute() {
        calls += 1
        return { status: calls < 3 ? "runner_error" : "passed", passed_tests: 1, total_tests: 1, score_ratio: calls < 3 ? 0 : 1, failure_codes: [], runner_image_digest: DIGEST }
      },
    }
    expect((await executeWithRunnerRetry(runner, codeRequest(), 2)).tool_attempts).toBe(3)
    calls = 0
    runner.execute = async () => {
      calls += 1
      return { status: "failed", passed_tests: 0, total_tests: 1, score_ratio: 0, failure_codes: ["assertion"], runner_image_digest: DIGEST }
    }
    await executeWithRunnerRetry(runner, codeRequest(), 2)
    expect(calls).toBe(1)
    calls = 0
    await executeWithRunnerRetry(runner, codeRequest(), Number.NaN)
    expect(calls).toBe(1)
  })

  test("P08 trusted reference retries a transient container timeout", async () => {
    let calls = 0
    const runner: CodeRunner = {
      runner_image_digest: DIGEST,
      async execute() {
        calls += 1
        return calls === 1
          ? {
              status: "timeout",
              passed_tests: 0,
              total_tests: 1,
              score_ratio: 0,
              failure_codes: ["execution_timeout"],
              runner_image_digest: DIGEST,
            }
          : {
              status: "passed",
              passed_tests: 1,
              total_tests: 1,
              score_ratio: 1,
              failure_codes: [],
              runner_image_digest: DIGEST,
            }
      },
    }
    const result = await executeTrustedReferenceWithRetry(runner, codeRequest(), 1)
    expect(result.status).toBe("passed")
    expect(result.tool_attempts).toBe(2)
  })

  test("P09 Beta updates aggregate one artifact batch per objective and stay bounded", async () => {
    const events = [evidenceEvent("E1", "I1", 1, "mcq"), evidenceEvent("E2", "I2", 0, "trace")]
    const store = new InMemoryMasteryStateStore()
    const result = await updateMasteryFromEvidence(events, store)
    expect(result.states).toHaveLength(1)
    expect(result.states[0]!.evidence_batches).toBe(1)
    expect(result.states[0]!.mastery).toBeGreaterThanOrEqual(0)
    expect(result.states[0]!.mastery).toBeLessThanOrEqual(1)
    const replay = await updateMasteryFromEvidence(events, store)
    expect(replay.states[0]!.evidence_batches).toBe(1)
    expect(replay.states[0]!.revision).toBe(result.states[0]!.revision)
  })

  test("P10 conflicting fact identities generate audit packets and block trust", async () => {
    const context = await golden()
    const conflict = structuredClone(context.evidence)
    conflict.results.push(structuredClone(conflict.results[0]!))
    conflict.results.at(-1)!.facts[0]!.content = "与原事实相反的内容"
    const report = detectEvidenceConflicts(conflict, context.spec.run_id)
    expect(report.ok).toBe(false)
    expect(report.audit_packets.some((packet) => packet.issue === "conflicting_support")).toBe(true)
    let sent = 0
    const pipeline = await runCPipeline(
      { generation_spec: context.spec, evidence_pack: conflict },
      createRoleCAgents(context.provider),
      new InMemorySecureArtifactStore(),
      { fact_audit_port: { async sendFactAudits(packets) { sent = packets.length } } },
    )
    expect(pipeline.blocked_reason?.code).toBe("BLOCKED_EVIDENCE_CONFLICT")
    expect(sent).toBeGreaterThan(0)
  })

  test("P11 checkpoint resumes after store failure and cache deduplicates the ready retry", async () => {
    const context = await golden()
    const calls = { concept: 0, lab: 0, assessment: 0 }
    const provider: RoleCContentProvider = {
      async generateConceptLesson(request) { calls.concept += 1; return context.provider.generateConceptLesson(request) },
      async generateCodeLab(request) { calls.lab += 1; return context.provider.generateCodeLab(request) },
      async generateAssessment(request) { calls.assessment += 1; return context.provider.generateAssessment(request) },
    }
    const runner = new PassingContractRunner()
    const agents = createRoleCAgents(provider, { code_lab: new TrustedCodeLabVerifier(runner), assessment: new TrustedAssessmentVerifier(runner) })
    const backend = new InMemorySecureArtifactStore()
    let storeCalls = 0
    const store = {
      namespace_id: backend.namespace_id,
      put: backend.put.bind(backend),
      async putBatch(artifacts: Parameters<typeof backend.putBatch>[0], storeContext: Parameters<typeof backend.putBatch>[1]) {
        storeCalls += 1
        if (storeCalls === 1) throw new Error("temporary store failure")
        return backend.putBatch(artifacts, storeContext)
      },
      get: backend.get.bind(backend),
      deleteBatch: backend.deleteBatch.bind(backend),
    }
    const checkpoint = new InMemoryPipelineCheckpointStore()
    const cache = new InMemoryContentCache<Awaited<ReturnType<typeof runCPipeline>>>()
    const trace = new InMemoryAgentTraceStore()
    const options = { checkpoint_store: checkpoint, cache, trace_store: trace }
    expect((await runCPipeline({ generation_spec: context.spec, evidence_pack: context.evidence }, agents, store, options)).status).toBe("failed")
    const callsAfterFailure = { ...calls }
    expect((await runCPipeline({ generation_spec: context.spec, evidence_pack: context.evidence }, agents, store, options)).status).toBe("ready")
    expect(calls).toEqual(callsAfterFailure)
    const callsAfterReady = { ...calls }
    expect((await runCPipeline({ generation_spec: context.spec, evidence_pack: context.evidence }, agents, store, options)).status).toBe("ready")
    expect(calls).toEqual(callsAfterReady)
    const events = await trace.read(context.spec.run_id)
    expect(events.some((event) => event.retry_kind === "resume")).toBe(true)
  })
})

describe("role C in-memory mastery revision guards", () => {
  test("save and saveBatch reject revision jumps without partial writes", async () => {
    const store = new InMemoryMasteryStateStore()
    await expect(store.save(masterySnapshot("O1", 2), 0))
      .rejects.toThrow("MASTERY_REVISION_STEP_INVALID")
    expect(await store.load("learner", "p", "O1")).toBeUndefined()

    const valid = masterySnapshot("O1", 1)
    const jumping = masterySnapshot("O2", 2)
    await expect(store.saveBatch([
      { state: valid, expected_revision: 0 },
      { state: jumping, expected_revision: 0 },
    ])).rejects.toThrow("MASTERY_REVISION_STEP_INVALID")
    expect(await store.load("learner", "p", "O1")).toBeUndefined()
    expect(await store.load("learner", "p", "O2")).toBeUndefined()

    await store.save(valid, 0)
    await expect(store.save(masterySnapshot("O1", 3), 1))
      .rejects.toThrow("MASTERY_REVISION_STEP_INVALID")
    expect(await store.load("learner", "p", "O1")).toEqual(valid)
  })

  test("folds multiple evidence batches into one strict CAS revision", async () => {
    const first = evidenceEvent("E-MASTERY-1", "I1", 1, "mcq")
    const second = evidenceEvent("E-MASTERY-2", "I2", 0, "trace")
    first.provenance.idempotency_key = `sha256:${"1".repeat(64)}`
    second.provenance.idempotency_key = `sha256:${"2".repeat(64)}`
    const store = new InMemoryMasteryStateStore()

    const result = await updateMasteryFromEvidence([first, second], store)

    expect(result.states[0]).toMatchObject({
      evidence_batches: 2,
      revision: 1,
    })
    expect(result.states[0]!.processed_artifact_ids).toHaveLength(2)
    expect((await store.load("learner", "p", "O1"))?.revision).toBe(1)
  })
})

describe("role C pipeline single-flight", () => {
  test("coalesces concurrent cache misses for the same input and secure-store namespace", async () => {
    const context = await golden()
    const calls = { concept: 0, lab: 0, assessment: 0 }
    let releaseConcept!: () => void
    let signalConceptStarted!: () => void
    const conceptGate = new Promise<void>((resolve) => { releaseConcept = resolve })
    const conceptStarted = new Promise<void>((resolve) => { signalConceptStarted = resolve })
    const provider: RoleCContentProvider = {
      async generateConceptLesson(request) {
        calls.concept += 1
        signalConceptStarted()
        await conceptGate
        return context.provider.generateConceptLesson(request)
      },
      async generateCodeLab(request) {
        calls.lab += 1
        return context.provider.generateCodeLab(request)
      },
      async generateAssessment(request) {
        calls.assessment += 1
        return context.provider.generateAssessment(request)
      },
    }
    const runner = new PassingContractRunner()
    const agents = createRoleCAgents(provider, {
      code_lab: new TrustedCodeLabVerifier(runner),
      assessment: new TrustedAssessmentVerifier(runner),
    })
    const secureStore = new InMemorySecureArtifactStore()
    const cache = new InMemoryContentCache<Awaited<ReturnType<typeof runCPipeline>>>()
    const input = { generation_spec: context.spec, evidence_pack: context.evidence }

    const first = runCPipeline(input, agents, secureStore, { cache })
    await conceptStarted
    const duplicate = runCPipeline(input, agents, secureStore, { cache })
    releaseConcept()
    const [left, right] = await Promise.all([first, duplicate])

    expect(left.status).toBe("ready")
    expect(right).toEqual(left)
    expect(calls).toEqual({ concept: 1, lab: 1, assessment: 1 })
    expect(left.secure_refs).toEqual(right.secure_refs)
  })

  test("releases a failed flight so the same input can be retried", async () => {
    const context = await golden()
    let conceptCalls = 0
    const provider: RoleCContentProvider = {
      async generateConceptLesson(request) {
        conceptCalls += 1
        if (conceptCalls === 1) {
          throw new Error("PRIVATE_TRANSIENT_PROVIDER_DETAIL")
        }
        return context.provider.generateConceptLesson(request)
      },
      generateCodeLab: (request) => context.provider.generateCodeLab(request),
      generateAssessment: (request) => context.provider.generateAssessment(request),
    }
    const runner = new PassingContractRunner()
    const agents = createRoleCAgents(provider, {
      code_lab: new TrustedCodeLabVerifier(runner),
      assessment: new TrustedAssessmentVerifier(runner),
    })
    const secureStore = new InMemorySecureArtifactStore()
    const cache = new InMemoryContentCache<Awaited<ReturnType<typeof runCPipeline>>>()
    const input = { generation_spec: context.spec, evidence_pack: context.evidence }

    const failed = await runCPipeline(input, agents, secureStore, { cache })
    const retried = await runCPipeline(input, agents, secureStore, { cache })

    expect(failed.status).toBe("failed")
    expect(failed.failure_reason?.code).toBe("PROVIDER_ERROR")
    expect(JSON.stringify(failed))
      .not.toContain("PRIVATE_TRANSIENT_PROVIDER_DETAIL")
    expect(retried.status).toBe("ready")
    expect(conceptCalls).toBe(2)
  })

  test("does not merge calls that use different execution dependencies", async () => {
    const context = await golden()
    let conceptCalls = 0
    let startedCount = 0
    let releaseConcept!: () => void
    let signalBothStarted!: () => void
    const conceptGate = new Promise<void>((resolve) => { releaseConcept = resolve })
    const bothStarted = new Promise<void>((resolve) => { signalBothStarted = resolve })
    const createAgents = () => {
      const provider: RoleCContentProvider = {
        async generateConceptLesson(request) {
          conceptCalls += 1
          startedCount += 1
          if (startedCount === 2) signalBothStarted()
          await conceptGate
          return context.provider.generateConceptLesson(request)
        },
        generateCodeLab: (request) => context.provider.generateCodeLab(request),
        generateAssessment: (request) => context.provider.generateAssessment(request),
      }
      const runner = new PassingContractRunner()
      return createRoleCAgents(provider, {
        code_lab: new TrustedCodeLabVerifier(runner),
        assessment: new TrustedAssessmentVerifier(runner),
      })
    }
    const secureStore = new InMemorySecureArtifactStore()
    const input = { generation_spec: context.spec, evidence_pack: context.evidence }

    const first = runCPipeline(input, createAgents(), secureStore)
    const second = runCPipeline(input, createAgents(), secureStore)
    await bothStarted
    releaseConcept()
    const [left, right] = await Promise.all([first, second])

    expect(left.status).toBe("ready")
    expect(right.status).toBe("ready")
    expect(conceptCalls).toBe(2)
    expect(left.secure_refs).not.toEqual(right.secure_refs)
  })
})

describe("role C transport-neutral delivery guards", () => {
  test("publishes one stable same-learner B envelope and accepts a duplicate acknowledgement", async () => {
    const firstEvent = evidenceEvent("E-1", "I1", 1, "mcq")
    const secondEvent = evidenceEvent("E-2", "I2", 0, "trace")
    const drift = profileDriftSuggestion()
    const received: RoleCLearningProgressDelivery[] = []
    const committed = new Set<string>()
    const port = {
      async publishLearningProgress(delivery: RoleCLearningProgressDelivery) {
        received.push(structuredClone(delivery))
        const status = committed.has(delivery.delivery_id) ? "duplicate" as const : "accepted" as const
        committed.add(delivery.delivery_id)
        return learningProgressAck(delivery, status)
      },
    }

    const first = await deliverRoleCToB(port, [secondEvent, firstEvent], drift)
    const replay = await deliverRoleCToB(
      port,
      [structuredClone(firstEvent), structuredClone(secondEvent)],
      structuredClone(drift),
    )

    expect(received).toHaveLength(2)
    expect(received[0]!.delivery_id).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(received[0]!.delivery_id).toBe(received[1]!.delivery_id)
    expect(received[0]!.evidence_events.map((event) => event.event_id)).toEqual(["E-1", "E-2"])
    expect(received[0]!.profile_drift_suggestion).toEqual(drift)
    expect(first.status).toBe("accepted")
    expect(replay.status).toBe("duplicate")
  })

  test("defines a drift-only delivery and rejects a fully empty B delivery", async () => {
    let calls = 0
    const port = {
      async publishLearningProgress(delivery: RoleCLearningProgressDelivery) {
        calls += 1
        return learningProgressAck(delivery)
      },
    }
    const ack = await deliverRoleCToB(port, [], profileDriftSuggestion())
    expect(ack.status).toBe("accepted")
    expect(calls).toBe(1)

    await expect(deliverRoleCToB(port, [])).rejects.toThrow("ROLE_C_B_DELIVERY_EMPTY")
    expect(calls).toBe(1)
  })

  test("rejects duplicate B evidence events before invoking the transport", async () => {
    const event = evidenceEvent("E-DUP", "I1", 1, "mcq")
    let calls = 0
    await expect(deliverRoleCToB({
      async publishLearningProgress(delivery) {
        calls += 1
        return learningProgressAck(delivery)
      },
    }, [event, structuredClone(event)])).rejects.toThrow("DUPLICATE_EVENT")
    expect(calls).toBe(0)
  })

  test("rejects malformed, mixed-profile, and secret-bearing B batches before transport", async () => {
    let calls = 0
    const port = {
      async publishLearningProgress(delivery: RoleCLearningProgressDelivery) {
        calls += 1
        return learningProgressAck(delivery)
      },
    }

    const malformed = evidenceEvent("E-BAD-SCHEMA", "I1", 1, "mcq")
    malformed.source_id = "not-a-source"
    await expect(deliverRoleCToB(port, [malformed]))
      .rejects.toThrow("ROLE_C_OUTBOUND_SCHEMA_INVALID")

    const wrongProfile = evidenceEvent("E-WRONG-PROFILE", "I2", 1, "mcq")
    wrongProfile.profile_version = "another-profile"
    await expect(deliverRoleCToB(port, [
      evidenceEvent("E-GOOD", "I1", 1, "mcq"),
      wrongProfile,
    ])).rejects.toThrow("MIXED_PROFILE_BATCH")

    await expect(deliverRoleCToB(
      port,
      [evidenceEvent("E-DRIFT-MISMATCH", "I1", 1, "mcq")],
      profileDriftSuggestion("learner", "another-profile"),
    )).rejects.toThrow("DRIFT_PROFILE_MISMATCH")

    const secretBearing = evidenceEvent("E-SECRET", "I1", 1, "mcq")
    secretBearing.misconceptions = ["secure://role-c/private-answer"]
    await expect(deliverRoleCToB(port, [secretBearing]))
      .rejects.toThrow("ROLE_C_B_DELIVERY_SECRET_LEAK")
    expect(calls).toBe(0)
  })

  test("rejects a B acknowledgement for another delivery", async () => {
    await expect(deliverRoleCToB({
      async publishLearningProgress(delivery) {
        return {
          ...learningProgressAck(delivery),
          delivery_id: `sha256:${"0".repeat(64)}`,
        }
      },
    }, [evidenceEvent("E-ACK", "I1", 1, "mcq")]))
      .rejects.toThrow("ROLE_C_B_ACK_ID_MISMATCH")
  })
})

function oneItemSecure(answerSpec: any = { kind: "exact_set", accepted: ["opt_correct"], normalization: ["trim"] }, modality: any = "mcq"): AssessmentSecureArtifact {
  return {
    schema_version: "1.0", run_id: "RUN-ONE", artifact_id: "ART-ONE", artifact_type: "assessment_secure", agent: "tiered-evaluator", status: "ready",
    versions: { profile_version: "p", kb_version: "k", rag_version: "r", prompt_version: "q", model_config_hash: "m", schema_version: "1.0" },
    seed: 1, input_refs: [], citations: [], quality: { schema_ok: true, citation_coverage: 1, objective_coverage: 1, alignment_score: 1, answer_key_verified: true }, trace_ref: "T",
    payload: {
      form_id: "FORM-ONE", option_order_seed: 1, code_test_suites: [],
      objective_coverage: [{ objective_id: "O1", item_ids: ["I1"], answer_kinds: [answerSpec.kind] }],
      items: [{ item_id: "I1", objective_id: "O1", tier: 1, modality, max_score: 1, answer_spec: answerSpec, ...(answerSpec.kind === "exact_set" ? { correct_option_id: "opt_correct" } : {}), misconception_by_option: {}, evidence_weight: 1 }],
    },
  }
}

function oneItemSubmission(response: Partial<SubmissionEnvelope["answers"][number]> = { selected_option_id: "opt_correct" }): SubmissionEnvelope {
  return { schema_version: "1.0", submission_id: "SUB-ONE", run_id: "RUN-ONE", learner_id_hash: "learner", form_id: "FORM-ONE", attempt_no: 1, answers: [{ item_id: "I1", hint_level_used: 0, ...response }] }
}

function codeRequest(): CodeExecutionRequest {
  return { language: "python", code: "pass", test_suite_id: "TS", timeout_ms: 1000, memory_mb: 64, max_output_bytes: 1000, network_allowed: false }
}

function evidenceEvent(eventId: string, itemId: string, score: number, modality: LearningEvidenceEvent["evidence"]["modality"]): LearningEvidenceEvent {
  return {
    schema_version: "1.0", event_id: eventId, learner_id_hash: "learner", profile_version: "p", path_node_id: "path", objective_id: "O1", source_id: "K007",
    evidence: { modality, raw_score: score, evidence_score: score, grader_confidence: 1, hint_level: 0, attempt_no: 1 }, misconceptions: [],
    recommendation: { action: "reinforce", confidence: 0.7, reason_codes: ["fixture"] },
    provenance: {
      artifact_id: "GRADE-ONE",
      idempotency_key: `sha256:${"1".repeat(64)}`,
      item_id: itemId,
      grader_version: "g",
    },
  }
}

function masterySnapshot(objectiveId: string, revision: number): ObjectiveMasteryState {
  const alpha = 1 + revision
  const beta = 1
  return {
    schema_version: "1.0",
    learner_id_hash: "learner",
    profile_version: "p",
    objective_id: objectiveId,
    alpha,
    beta,
    mastery: Math.round((alpha / (alpha + beta)) * 1_000_000) / 1_000_000,
    evidence_batches: revision,
    observed_modalities: ["mcq"],
    processed_artifact_ids: Array.from(
      { length: revision },
      (_, index) => `BATCH-${index + 1}`,
    ),
    last_action: "reinforce",
    revision,
  }
}

function profileDriftSuggestion(
  learnerIdHash = "learner",
  profileVersion = "p",
): ProfileDriftSuggestion {
  return {
    schema_version: "1.0",
    suggestion_id: "PDS-PROPERTY-1",
    learner_id_hash: learnerIdHash,
    profile_version: profileVersion,
    conflicting_objective_ids: ["O1"],
    reason_codes: ["repeated_profile_evidence_conflict"],
    confidence: 0.9,
    action: "reprofile",
  }
}

function learningProgressAck(
  delivery: Pick<RoleCLearningProgressDelivery, "delivery_kind" | "delivery_id">,
  status: RoleCDeliveryAck["status"] = "accepted",
): RoleCDeliveryAck {
  return {
    schema_version: "1.0",
    delivery_kind: delivery.delivery_kind,
    delivery_id: delivery.delivery_id,
    status,
  }
}

class PassingContractRunner implements CodeRunner {
  readonly runner_image_digest = DIGEST
  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const tests = request.test_suite?.tests.map((test) => test.test_id) ?? []
    const mutation = request.code.includes("return None") || request.code.includes("total = score") || request.code.includes("scores[:-1]") || request.code.includes("return 80") || request.code.includes("// count")
    return { status: mutation ? "failed" : "passed", passed_tests: mutation ? 0 : tests.length, total_tests: tests.length, score_ratio: mutation ? 0 : 1, failure_codes: mutation ? tests.map((id) => `${id}:assertion_failed`) : [], runner_image_digest: DIGEST }
  }
}
