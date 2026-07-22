import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  createRoleCAgents,
  defineLearningPathNode,
  detectProfileDrift,
  DeterministicCodeLabContentProvider,
  emitLearningEvidence,
  EvidencePhraseRubricJudge,
  finalizeGradeResult,
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
  type AssessmentSecureArtifact,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type LearningPathNode,
  type SessionState,
  type SubmissionEnvelope,
} from "../src/role-c-content"

const DEMO_DIGEST = `sha256:${"d".repeat(64)}`
const profile = (await Bun.file("examples/learner_loop_weak.json").json()) as LearnerProfile
const rawPath = (await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()) as LearningPathNode
const kb = await loadKnowledgeBase()
const { rag_result: ragResult } = await executeProfileRetrieval(profile)
const evidence = adaptRagResult(ragResult, { kb_version: kb.version, rag_version: "rule-rag-0.1" })
const snapshot = adaptLearnerProfile(profile, { profile_version: "profile-full-demo-v1" })
const path = defineLearningPathNode({
  node_id: rawPath.node_id,
  target_source_ids: rawPath.target_source_ids,
  prerequisite_source_ids: rawPath.prerequisite_source_ids,
  goal: rawPath.goal,
  objectives: rawPath.objectives,
  assessment_blueprint: rawPath.assessment_blueprint,
})
const built = buildGenerationSpec({
  run_id: "RUN-C-FULL-DEMO",
  profile_snapshot: snapshot,
  path_node: path,
  evidence_pack: evidence,
  versions: {
    prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
    model_config_hash: "deterministic-full-reference-v1",
    runner_image_digest: DEMO_DIGEST,
  },
  seed: 42,
})

if (!built.ok) {
  console.log(JSON.stringify({ status: "blocked", stage: "intake", result: built }, null, 2))
  process.exit(0)
}

const runner = new FullDemoConformanceRunner()
const provider = new DeterministicCodeLabContentProvider()
const agents = createRoleCAgents(provider, {
  code_lab: new TrustedCodeLabVerifier(runner),
  assessment: new TrustedAssessmentVerifier(runner),
})
const secureStore = new InMemorySecureArtifactStore()
const traceStore = new InMemoryAgentTraceStore()
const pipeline = await runCPipeline(
  { generation_spec: built.spec, evidence_pack: evidence },
  agents,
  secureStore,
  {
    cache: new InMemoryContentCache(),
    checkpoint_store: new InMemoryPipelineCheckpointStore(),
    trace_store: traceStore,
  },
)

if (pipeline.status !== "ready" || !pipeline.public_artifacts.assessment?.payload) {
  console.log(JSON.stringify({ status: pipeline.status, stage: "content_pipeline", pipeline }, null, 2))
  process.exit(0)
}

const assessmentSecure = await secureStore.get(pipeline.secure_refs[1]!, {
  principal: "role-c-grader",
  run_id: built.spec.run_id,
}) as AssessmentSecureArtifact
const publicAssessment = pipeline.public_artifacts.assessment
const formId = publicAssessment.payload.form_id
const answers: SubmissionEnvelope["answers"] = [
  { item_id: "ITEM-O1-T1-MCQ", selected_option_id: "opt_iterate", hint_level_used: 0 },
  { item_id: "ITEM-O2-T1-TF", selected_option_id: "opt_true", hint_level_used: 0 },
  { item_id: "ITEM-O1-T2-TRACE", text_response: "8", hint_level_used: 0 },
  { item_id: "ITEM-O2-T2-SHORT", text_response: "列表保存一组成绩并保持顺序，程序可逐项处理。", hint_level_used: 0 },
  { item_id: "ITEM-O3-T3-CODE", code_response: "def average_score(scores):\n    total = 0\n    for score in scores:\n        total += score\n    return total / len(scores)", hint_level_used: 0 },
]
const submission: SubmissionEnvelope = {
  schema_version: "1.0",
  submission_id: "SUB-C-FULL-DEMO-01",
  run_id: built.spec.run_id,
  learner_id_hash: "learner-demo-hash",
  form_id: formId,
  attempt_no: 1,
  answers,
}
const session: SessionState = {
  schema_version: "1.0",
  session_id: "SESSION-C-FULL-DEMO",
  run_id: built.spec.run_id,
  learner_id_hash: submission.learner_id_hash,
  current_path_node_id: built.spec.path_node.node_id,
  current_form_id: formId,
  attempt_no: 1,
  required_item_ids: answers.map((answer) => answer.item_id),
  revealed_hint_levels: Object.fromEntries(answers.map((answer) => [answer.item_id, answer.hint_level_used])),
  public_artifact_refs: Object.values(pipeline.public_artifacts).filter(Boolean).map((artifact) => artifact!.artifact_id),
  secure_artifact_refs: [...pipeline.secure_refs],
}
const grade = await gradeSubmission(submission, assessmentSecure, {
  code_runner: runner,
  rubric_judge: new EvidencePhraseRubricJudge(),
  public_artifact: publicAssessment,
  session_state: session,
  expected_path_node_id: built.spec.path_node.node_id,
  assessment_secure_ref: pipeline.secure_refs[1],
})
const gradeArtifact = finalizeGradeResult({
  grade,
  spec: built.spec,
  evidence,
  assessment_secure: assessmentSecure,
  formative: publicAssessment.payload.submission_policy.formative,
})
const learningEvidence = emitLearningEvidence(grade, built.spec, assessmentSecure, {
  learner_id_hash: submission.learner_id_hash,
  attempt_no: submission.attempt_no,
  grader_version: "deterministic-hybrid-grader-1.0.0",
  grade_artifact_id: gradeArtifact.artifact_id,
  hint_levels_by_item: session.revealed_hint_levels,
})
const mastery = await updateMasteryFromEvidence(learningEvidence, new InMemoryMasteryStateStore())
const drift = detectProfileDrift({
  learner_id_hash: submission.learner_id_hash,
  profile_version: snapshot.profile_version,
  observations: mastery.states.map((state) => ({ objective_id: state.objective_id, expected: "weak" as const, mastery: state.mastery })),
})

console.log(JSON.stringify({
  workflow: "B_profile_to_A_evidence_to_C_content_assessment_grade_to_B_mastery",
  status: gradeArtifact.status === "ready" ? "ready" : "blocked",
  runner_mode: "contract_conformance_test_double",
  runner_note: "The demo validates orchestration contracts deterministically; production code execution requires the digest-pinned OCI runner.",
  public_artifacts: {
    concept_lesson: pipeline.public_artifacts.concept_lesson,
    code_lab: pipeline.public_artifacts.code_lab,
    assessment: publicAssessment,
    grade_result: gradeArtifact,
  },
  grading_summary: {
    status: grade.status,
    blocked_reason: grade.blocked_reason,
    unresolved_item_ids: grade.unresolved_item_ids,
    validation_issues: grade.validation_issues,
    boundary_verified: grade.boundary_verified,
  },
  secure_refs: pipeline.secure_refs,
  learning_evidence_to_b: learningEvidence,
  mastery_after_update: mastery,
  profile_drift_suggestion: drift ?? null,
  trace_events: await traceStore.read(built.spec.run_id),
  security_assertion: "Only public artifacts, opaque backend references, learning evidence, and trace metadata are included.",
}, null, 2))

/** Explicitly non-production; it never executes submitted code on the host. */
class FullDemoConformanceRunner implements CodeRunner {
  readonly runner_image_digest = DEMO_DIGEST
  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const declaredTests = request.test_suite?.tests.map((entry) => entry.test_id) ?? []
    const testIds = declaredTests.length > 0
      ? declaredTests
      : ["AT-O3-BASIC", "AT-O3-SINGLE", "AT-O3-DECIMAL", "AT-O3-FRACTION"]
    const failed = request.code.includes("return None") || request.code.includes("pass\n")
      ? testIds
      : request.code.includes("total = score")
        ? testIds
        : request.code.includes("scores[:-1]") || request.code.includes("return 80") || request.code.includes("// count")
          ? testIds
          : []
    return {
      status: failed.length === 0 ? "passed" : "failed",
      passed_tests: testIds.length - failed.length,
      total_tests: testIds.length,
      score_ratio: testIds.length === 0 ? 0 : (testIds.length - failed.length) / testIds.length,
      failure_codes: failed.map((testId) => `${testId}:assertion_failed`),
      runner_image_digest: this.runner_image_digest,
    }
  }
}
