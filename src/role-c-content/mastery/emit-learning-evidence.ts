import type { AssessmentSecureArtifact } from "../contracts/artifacts"
import { C_SCHEMA_VERSION, stableId } from "../contracts/common"
import type { LearningEvidenceEvent } from "../contracts/learning-evidence-event"
import type { GenerationSpec } from "../contracts/generation-spec"
import type { SubmissionGrade } from "../grading/grade-submission"
import { decideNextAction } from "./next-action-policy"

export interface EmitLearningEvidenceContext {
  learner_id_hash: string
  attempt_no: number
  grader_version: string
  grade_artifact_id: string
  hint_levels_by_item?: Record<string, 0 | 1 | 2 | 3>
  profile_conflict_count_by_objective?: Record<string, number>
}

export function emitLearningEvidence(
  grade: SubmissionGrade,
  spec: GenerationSpec,
  secureArtifact: AssessmentSecureArtifact,
  context: EmitLearningEvidenceContext,
): LearningEvidenceEvent[] {
  // Only a fully graded submission may influence B's formal profile/path decisions.
  if (grade.status !== "graded" || !grade.boundary_verified || secureArtifact.status !== "ready"
    || secureArtifact.quality.answer_key_verified !== true || !secureArtifact.payload) return []
  const secureItems = new Map(secureArtifact.payload.items.map((item) => [item.item_id, item]))
  const targets = new Map(spec.targets.map((target) => [target.objective_id, target]))
  const objectiveResults = new Map<string, typeof grade.item_results>()
  for (const result of grade.item_results) {
    const bucket = objectiveResults.get(result.objective_id) ?? []
    bucket.push(result)
    objectiveResults.set(result.objective_id, bucket)
  }
  const recommendations = new Map([...objectiveResults.entries()].map(([objectiveId, results]) => {
    const evidence = results.reduce((sum, result) => sum + result.evidence_score, 0) / results.length
    const sufficientModalities = results.some((result) => {
      const modality = secureItems.get(result.item_id)?.modality
      return modality === "code" || modality === "trace"
    })
    return [objectiveId, decideNextAction({
      mastery: evidence,
      sufficient_modalities: sufficientModalities,
      profile_conflict_count: context.profile_conflict_count_by_objective?.[objectiveId],
    })] as const
  }))

  return grade.item_results.flatMap((result) => {
    const item = secureItems.get(result.item_id)
    const target = targets.get(result.objective_id)
    if (!item || !target) return []
    const recommendation = recommendations.get(result.objective_id)!
    return [{
      schema_version: C_SCHEMA_VERSION,
      event_id: stableId("LEE", {
        submission_id: grade.submission_id,
        item_id: result.item_id,
        attempt_no: context.attempt_no,
      }),
      learner_id_hash: context.learner_id_hash,
      profile_version: spec.profile_ref.profile_version,
      path_node_id: spec.path_node.node_id,
      objective_id: result.objective_id,
      source_id: target.source_id,
      evidence: {
        modality: item.modality,
        raw_score: result.raw_score,
        evidence_score: result.evidence_score,
        grader_confidence: result.grader_confidence,
        hint_level: context.hint_levels_by_item?.[result.item_id] ?? 0,
        attempt_no: context.attempt_no,
      },
      misconceptions: [...result.misconception_tags],
      recommendation,
      provenance: {
        artifact_id: context.grade_artifact_id,
        item_id: result.item_id,
        grader_version: context.grader_version,
      },
    }]
  })
}
