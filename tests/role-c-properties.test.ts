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
  deliverRoleCToD,
  DeterministicCodeLabContentProvider,
  EvidencePhraseRubricJudge,
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
  type RagEvidencePack,
  type RoleCContentProvider,
  type SubmissionEnvelope,
  type TieredEvaluatorRequest,
} from "../src/role-c-content"

const DIGEST = `sha256:${"e".repeat(64)}`
const profile: LearnerProfile = {
  learner_id: "property-learner",
  level: "beginner",
  known_concepts: ["变量"],
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

describe("role C transport-neutral delivery guards", () => {
  test("rejects duplicate B evidence events before invoking the transport", async () => {
    const event = evidenceEvent("E-DUP", "I1", 1, "mcq")
    let calls = 0
    await expect(deliverRoleCToB({
      async consumeLearningEvidence() { calls += 1 },
      async consumeProfileDriftSuggestion() { calls += 1 },
    }, [event, structuredClone(event)])).rejects.toThrow("DUPLICATE_EVENT")
    expect(calls).toBe(0)
  })

  test("rejects out-of-order D trace events before invoking the transport", async () => {
    let calls = 0
    const trace = [2, 1].map((seq) => ({
      schema_version: "1.0" as const,
      seq,
      event_type: "c.pipeline.ready" as const,
      run_id: "RUN-DELIVERY",
      status: "success" as const,
      input_refs: [],
      summary: "ready",
    }))
    await expect(deliverRoleCToD({
      async publishArtifacts() { calls += 1 },
      async publishTrace() { calls += 1 },
    }, "RUN-DELIVERY", [], trace)).rejects.toThrow("NOT_STRICTLY_ORDERED")
    expect(calls).toBe(0)
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
    provenance: { artifact_id: "GRADE-ONE", item_id: itemId, grader_version: "g" },
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
