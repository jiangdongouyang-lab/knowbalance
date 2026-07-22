import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  createOciPythonCodeRunnerFromEnv,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  generateCodeLab,
  generateConceptLesson,
  InMemorySecureArtifactStore,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  TrustedCodeLabVerifier,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type LearningPathNode,
} from "../src/role-c-content"

const CONFORMANCE_DIGEST = `sha256:${"c".repeat(64)}`
const useOci = process.argv.includes("--oci")
const runner = useOci ? createOciPythonCodeRunnerFromEnv() : new DemoConformanceRunner()
const profile = (await Bun.file("examples/learner_loop_weak.json").json()) as LearnerProfile
const rawPath = (await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()) as LearningPathNode
const kb = await loadKnowledgeBase()
const { rag_result: ragResult } = await executeProfileRetrieval(profile)
const evidencePack = adaptRagResult(ragResult, { kb_version: kb.version, rag_version: "rule-rag-0.1" })
const profileSnapshot = adaptLearnerProfile(profile, {
  profile_version: "profile-demo-v1",
  provenance_ref: "examples/learner_loop_weak.json",
})
const pathNode = defineLearningPathNode({
  node_id: rawPath.node_id,
  target_source_ids: rawPath.target_source_ids,
  prerequisite_source_ids: rawPath.prerequisite_source_ids,
  goal: rawPath.goal,
  objectives: rawPath.objectives,
  assessment_blueprint: rawPath.assessment_blueprint,
})
const built = buildGenerationSpec({
  run_id: "RUN-C-LAB-DEMO",
  profile_snapshot: profileSnapshot,
  path_node: pathNode,
  evidence_pack: evidencePack,
  versions: {
    prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
    model_config_hash: "deterministic-code-lab-reference-v1",
    runner_image_digest: runner.runner_image_digest,
  },
  seed: 42,
})

let output: Record<string, unknown>
if (!built.ok) {
  output = {
    workflow: "B_profile_to_A_evidence_to_C_verified_code_lab",
    status: "blocked",
    runner_mode: useOci ? "oci" : "contract_conformance_test_double",
    intake: built,
  }
} else {
  const provider = new DeterministicCodeLabContentProvider()
  const concept = await generateConceptLesson(
    { generation_spec: built.spec, evidence_pack: evidencePack },
    provider,
  )
  const pair = concept.status === "ready"
    ? await generateCodeLab(
        { generation_spec: built.spec, evidence_pack: evidencePack, concept_artifact: concept },
        provider,
        new TrustedCodeLabVerifier(runner),
      )
    : undefined
  const store = new InMemorySecureArtifactStore()
  const secureRefs = pair?.secure_artifact.status === "ready"
    ? await store.putBatch(
        [pair.secure_artifact],
        { principal: "role-c-pipeline", run_id: built.spec.run_id },
      )
    : []
  output = {
    workflow: "B_profile_to_A_evidence_to_C_verified_code_lab",
    status: pair?.public_artifact.status === "ready" && secureRefs.length === 1
      ? "code_lab_ready"
      : "blocked",
    runner_mode: useOci ? "oci" : "contract_conformance_test_double",
    production_runner_note: useOci
      ? "digest-pinned OCI runner executed the suite"
      : "This deterministic test double exercises verifier/orchestration contracts; use --oci for real isolated execution.",
    input_refs: {
      profile_id: profileSnapshot.profile_id,
      path_node_id: pathNode.node_id,
      retrieval_id: evidencePack.retrieval_id,
      spec_id: built.spec.spec_id,
      concept_artifact_id: concept.artifact_id,
    },
    evidence_source_ids: evidencePack.results.map((entry) => entry.source_id),
    code_lab_public: pair?.public_artifact,
    secure_refs: secureRefs,
    publication_rule: "D/browser receives code_lab_public and opaque secure_refs only; reference_solution and hidden_tests remain in the backend store.",
  }
}

console.log(JSON.stringify(output, null, 2))

/** Explicitly non-production: deterministic verification responses for the reproducible demo. */
class DemoConformanceRunner implements CodeRunner {
  readonly runner_image_digest = CONFORMANCE_DIGEST

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const testIds = request.test_suite?.tests.map((entry) => entry.test_id) ?? []
    const failedIds = request.code.includes("return None")
      ? testIds
      : request.code.includes("total = score")
        ? ["HT-O1-ALL"]
        : request.code.includes("scores[:-1]")
          ? ["HT-O2-MIXED"]
          : request.code.includes("return 80")
            ? ["HT-O2-SINGLE", "HT-O2-MIXED"]
            : request.code.includes("// count")
              ? ["HT-O3-FRACTION"]
              : []
    return {
      status: failedIds.length === 0 ? "passed" : "failed",
      passed_tests: Math.max(0, testIds.length - failedIds.length),
      total_tests: testIds.length,
      score_ratio: testIds.length === 0 ? 0 : (testIds.length - failedIds.length) / testIds.length,
      failure_codes: failedIds.map((testId) => `${testId}:assertion_failed`),
      runner_image_digest: this.runner_image_digest,
    }
  }
}
