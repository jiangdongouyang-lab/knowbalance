import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  DeterministicConceptContentProvider,
  defineLearningPathNode,
  generateConceptLesson,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  type LearningPathNode,
} from "../src/role-c-content"

const profile = (await Bun.file("examples/learner_loop_weak.json").json()) as LearnerProfile
const rawPath = (await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()) as LearningPathNode
const kb = await loadKnowledgeBase()
const { rag_request: ragRequest, rag_result: ragResult } = await executeProfileRetrieval(profile)

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
const evidencePack = adaptRagResult(ragResult, {
  kb_version: kb.version,
  rag_version: "rule-rag-0.1",
})
const specResult = buildGenerationSpec({
  run_id: "RUN-C-CONTRACT-DEMO",
  profile_snapshot: profileSnapshot,
  path_node: pathNode,
  evidence_pack: evidencePack,
  versions: {
    prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
    model_config_hash: "deterministic-concept-reference-v1",
  },
  seed: 42,
})

const conceptArtifact = specResult.ok
  ? await generateConceptLesson(
      { generation_spec: specResult.spec, evidence_pack: evidencePack },
      new DeterministicConceptContentProvider(),
    )
  : undefined

console.log(JSON.stringify({
  workflow: "B_profile_and_path_to_A_evidence_to_C_verified_concept_lesson",
  status: conceptArtifact?.status === "ready" ? "concept_lesson_ready" : "blocked",
  b_to_a_rag_request: ragRequest,
  b_to_c_profile_snapshot: profileSnapshot,
  b_to_c_learning_path_node: pathNode,
  a_to_c_evidence_pack: evidencePack,
  c_intake_result: specResult,
  c_concept_artifact: conceptArtifact,
  publication_rule: "Only public artifacts go to D/browser; secure artifacts are persisted server-side and exposed by opaque ref only.",
}, null, 2))
