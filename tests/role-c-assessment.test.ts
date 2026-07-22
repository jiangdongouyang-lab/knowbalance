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
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  generateAssessment,
  generateConceptLesson,
  gradeSubmission,
  ModelBackedRoleCContentProvider,
  OpenCodeRoleCContentProvider,
  routeAssessmentFromAnchors,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  TrustedAssessmentVerifier,
  validateAssessmentDraftStructure,
  validateRoleCSchema,
  type AssessmentDraft,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type GenerationSpec,
  type ModelGateway,
  type RagEvidencePack,
  type SessionState,
  type SubmissionEnvelope,
  type TieredEvaluatorRequest,
} from "../src/role-c-content"

const RUNNER_DIGEST = `sha256:${"b".repeat(64)}`
const profile: LearnerProfile = {
  learner_id: "assessment_phase_three",
  level: "beginner",
  known_concepts: ["变量", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成成绩统计分阶测评",
}

async function buildContext(modelConfigHash = "deterministic-code-lab-reference-v1", seed = 42): Promise<{
  pack: RagEvidencePack
  spec: GenerationSpec
  request: TieredEvaluatorRequest
  provider: DeterministicCodeLabContentProvider
}> {
  const ragRequest = buildRagRequest(profile)
  const rag = await retrieveKnowledge({ query: ragRequest.query, learnerLevel: profile.level, topK: 5 })
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
  const built = buildGenerationSpec({
    run_id: `RUN-C-ASSESS-${seed}`,
    profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-assessment-v1" }),
    path_node: path,
    evidence_pack: pack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: modelConfigHash,
      runner_image_digest: RUNNER_DIGEST,
    },
    seed,
  })
  if (!built.ok) throw new Error(built.errors.join("；"))
  const provider = new DeterministicCodeLabContentProvider()
  const concept = await generateConceptLesson({ generation_spec: built.spec, evidence_pack: pack }, provider)
  if (concept.status !== "ready") throw new Error(concept.blocked_reason?.message)
  return {
    pack,
    spec: built.spec,
    request: { generation_spec: built.spec, evidence_pack: pack, concept_artifact: concept },
    provider,
  }
}

describe("role C phase-three trusted assessment Author", () => {
  test("publishes a blueprint-aligned public/secure assessment after independent verification", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateAssessment(request, provider, new TrustedAssessmentVerifier(new AssessmentFixtureRunner()))
    expect(pair.public_artifact.status).toBe("ready")
    expect(pair.secure_artifact.status).toBe("ready")
    expect(pair.public_artifact.quality).toMatchObject({
      schema_ok: true,
      objective_coverage: 1,
      answer_key_verified: true,
      verified_item_count: 5,
      verified_test_count: 4,
    })
    expect(pair.public_artifact.payload?.items.map((item) => item.tier)).toEqual([1, 1, 2, 2, 3])
    expect(JSON.stringify(pair.public_artifact)).not.toContain("correct_option_id")
    expect(JSON.stringify(pair.public_artifact)).not.toContain("answer_spec")
    expect(pair.secure_artifact.payload?.code_test_suites).toHaveLength(1)
  })

  test("rejects nested shape, blueprint and option-diagnostic errors", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateAssessment(request)
    const invalidShape = structuredClone(draft) as unknown as Record<string, any>
    delete invalidShape.public_draft.payload.items[0].family_id
    expect(validateRoleCSchema("assessment_draft.schema.json", invalidShape).ok).toBe(false)

    const invalidSemantics = structuredClone(draft)
    invalidSemantics.public_draft.payload.items[0].tier = 2
    invalidSemantics.secure_draft.payload.items[0].tier = 2
    delete invalidSemantics.secure_draft.payload.items[0].misconception_by_option.opt_import
    const report = validateAssessmentDraftStructure(request, invalidSemantics)
    expect(report.ok).toBe(false)
    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "blueprint_tier_count",
      "incomplete_misconception_map",
    ]))
  })

  test("rejects ambiguous answer semantics, duplicate variants and orphan code suites", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateAssessment(request)
    const invalid = structuredClone(draft)
    const firstSpec = invalid.secure_draft.payload.items[0]!.answer_spec
    if (firstSpec.kind === "exact_set") firstSpec.accepted.push("opt_import")
    invalid.public_draft.payload.items[1]!.family_id = invalid.public_draft.payload.items[0]!.family_id
    invalid.public_draft.payload.items[1]!.variant_id = invalid.public_draft.payload.items[0]!.variant_id
    const orphanSuite = structuredClone(invalid.secure_draft.payload.code_test_suites[0]!)
    orphanSuite.test_suite_id = "TS-ORPHAN"
    invalid.secure_draft.payload.code_test_suites.push(orphanSuite)
    const report = validateAssessmentDraftStructure(request, invalid)
    expect(report.ok).toBe(false)
    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "choice_answer_spec_mismatch",
      "duplicate_family_variant",
      "orphan_code_suite",
    ]))
  })

  test("does not let an accepting custom verifier bypass deterministic Author gates", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateAssessment(request)
    delete (draft.public_draft.payload.items[0] as any).family_id
    provider.generateAssessment = async () => draft
    const pair = await generateAssessment(request, provider, {
      async verifyAssessment() { return { answer_key_verified: true, issues: [] } },
    })
    expect(pair.public_artifact.status).toBe("blocked")
    expect(pair.public_artifact.blocked_reason?.code).toBe("BLOCKED_INVALID_OUTPUT")
  })

  test("applies anchor routing deterministically at exact interval boundaries", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateAssessment(request, provider, new TrustedAssessmentVerifier(new AssessmentFixtureRunner()))
    const artifact = pair.public_artifact
    const atForty = routeAssessmentFromAnchors(artifact, [
      { item_id: "ITEM-O1-T1-MCQ", raw_score: 1 },
      { item_id: "ITEM-O2-T1-TF", raw_score: 0.6 },
      { item_id: "ITEM-O1-T2-TRACE", raw_score: 0 },
    ])
    const atEighty = routeAssessmentFromAnchors(artifact, [
      { item_id: "ITEM-O1-T1-MCQ", raw_score: 1 },
      { item_id: "ITEM-O2-T1-TF", raw_score: 1 },
      { item_id: "ITEM-O1-T2-TRACE", raw_score: 1.2 },
    ])
    expect(atForty).toMatchObject({ ok: true, anchor_score_ratio: 0.4, action: "reinforce" })
    expect(atEighty).toMatchObject({ ok: true, anchor_score_ratio: 0.8, action: "advance" })
    if (atEighty.ok) expect(atEighty.required_item_ids).toHaveLength(5)
  })

  test("rejects a D session whose required item set cannot come from any routing rule", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateAssessment(request, provider, new TrustedAssessmentVerifier(new AssessmentFixtureRunner()))
    if (!pair.public_artifact.payload || !pair.secure_artifact.payload) throw new Error("assessment fixture not ready")
    const submission: SubmissionEnvelope = {
      schema_version: "1.0",
      submission_id: "SUB-ILLEGAL-ROUTE",
      run_id: request.generation_spec.run_id,
      learner_id_hash: "learner-route-hash",
      form_id: pair.public_artifact.payload.form_id,
      attempt_no: 1,
      answers: [{ item_id: pair.public_artifact.payload.routing.anchor_item_ids[0]!, selected_option_id: "opt_iterate", hint_level_used: 0 }],
    }
    const session: SessionState = {
      schema_version: "1.0",
      session_id: "SESSION-ILLEGAL-ROUTE",
      run_id: submission.run_id,
      learner_id_hash: submission.learner_id_hash,
      current_path_node_id: request.generation_spec.path_node.node_id,
      current_form_id: submission.form_id,
      attempt_no: 1,
      required_item_ids: [submission.answers[0]!.item_id],
      revealed_hint_levels: { [submission.answers[0]!.item_id]: 0 },
      public_artifact_refs: [pair.public_artifact.artifact_id],
      secure_artifact_refs: ["secure://role-c/v1/assessment-route"],
    }
    const grade = await gradeSubmission(submission, pair.secure_artifact, {
      public_artifact: pair.public_artifact,
      session_state: session,
      expected_path_node_id: request.generation_spec.path_node.node_id,
      assessment_secure_ref: "secure://role-c/v1/assessment-route",
    })
    expect(grade.status).toBe("blocked")
    expect(grade.validation_issues?.join(" ")).toContain("不是 assessment 路由策略允许的题集")
  })

  test("keeps answer-bearing quiz seeds and learner identity out of Author model context", async () => {
    const { request } = await buildContext()
    const injected = structuredClone(request)
    injected.evidence_pack.results[0].quiz_seeds[0].answer = "PRIVATE_ANSWER"
    const serialized = JSON.stringify(buildAssessmentAuthorModelInput(injected))
    expect(serialized).not.toContain("PRIVATE_ANSWER")
    expect(serialized).not.toContain(profile.learner_id)
    expect(serialized).not.toContain("quiz_seeds")
  })

  test("keeps answer semantics stable while seed deterministically changes option order", async () => {
    const first = await buildContext("deterministic-code-lab-reference-v1", 42)
    const again = await buildContext("deterministic-code-lab-reference-v1", 42)
    const changed = await buildContext("deterministic-code-lab-reference-v1", 43)
    const a = await first.provider.generateAssessment(first.request)
    const b = await again.provider.generateAssessment(again.request)
    const c = await changed.provider.generateAssessment(changed.request)
    expect(a).toEqual(b)
    expect(a.secure_draft.payload.items[0].correct_option_id).toBe(c.secure_draft.payload.items[0].correct_option_id)
    expect(a.public_draft.payload.items[0].options).not.toEqual(c.public_draft.payload.items[0].options)
  })

  test("blocks the entire assessment when a code reference is not independently executable", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateAssessment(request, provider, new TrustedAssessmentVerifier(new AssessmentFixtureRunner(true)))
    expect(pair.public_artifact.status).toBe("blocked")
    expect(pair.public_artifact.blocked_reason?.code).toBe("BLOCKED_ANSWER_KEY_UNVERIFIED")
  })

  test("repairs one invalid model Draft and adapts OpenCode provider_draft", async () => {
    const gateway = new SequenceGateway("ASSESS-MODEL-HASH")
    const { request, provider } = await buildContext(gateway.model_config_hash)
    const valid = await provider.generateAssessment(request)
    gateway.outputs.push({}, valid)
    const repaired = await new ModelBackedRoleCContentProvider(gateway, {
      generation_strategy: "monolithic",
    }).generateAssessment(request)
    expect(repaired.public_draft.payload.form_id).toBe(valid.public_draft.payload.form_id)
    expect(gateway.requests).toHaveLength(2)

    const adapter = new OpenCodeRoleCContentProvider({
      async invoke(input) {
        if (input.worker !== "tiered-evaluator") throw new Error("unexpected worker")
        return { status: "completed", provider_draft: valid }
      },
    })
    expect((await adapter.generateAssessment(request)).secure_draft.payload.form_id).toBe(valid.secure_draft.payload.form_id)
  })
})

class AssessmentFixtureRunner implements CodeRunner {
  readonly runner_image_digest = RUNNER_DIGEST
  constructor(private readonly failReference = false) {}

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const total = request.test_suite?.tests.length ?? 0
    if (this.failReference) {
      return { status: "failed", passed_tests: 0, total_tests: total, score_ratio: 0, failure_codes: ["AT-O3-BASIC:assertion_failed"], runner_image_digest: RUNNER_DIGEST }
    }
    return { status: "passed", passed_tests: total, total_tests: total, score_ratio: 1, failure_codes: [], runner_image_digest: RUNNER_DIGEST }
  }
}

class SequenceGateway implements ModelGateway {
  readonly model_id = "sequence-assessment-model"
  readonly outputs: unknown[] = []
  readonly requests: Array<{ input: unknown }> = []
  constructor(readonly model_config_hash: string) {}
  async generateStructured<T>(request: { input: unknown }): Promise<T> {
    this.requests.push({ input: request.input })
    return structuredClone(this.outputs.shift()) as T
  }
}
