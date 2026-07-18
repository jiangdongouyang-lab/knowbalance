import type {
  AssessmentPublicArtifact,
  CodeLabPublicArtifact,
  ConceptLessonArtifact,
} from "../contracts/artifacts"
import type { GenerationSpec } from "../contracts/generation-spec"

export interface AlignmentObjection {
  objection_id: string
  from_agent: "concept-tutor" | "code-lab" | "tiered-evaluator" | "cross-artifact-gate"
  target_artifact_id: string
  objective_id: string
  issue_type:
    | "unsupported_claim"
    | "unmeasurable_objective"
    | "missing_prerequisite"
    | "difficulty_mismatch"
    | "unexecutable_task"
    | "answer_key_conflict"
    | "missing_instruction"
    | "missing_practice"
    | "missing_assessment"
  severity: "warning" | "critical"
  evidence: string[]
  proposed_action: string
}

export interface AlignmentReport {
  ok: boolean
  alignment_score: number
  objections: AlignmentObjection[]
}

export function validateCrossArtifactAlignment(input: {
  spec: GenerationSpec
  concept: ConceptLessonArtifact
  lab: CodeLabPublicArtifact
  assessment: AssessmentPublicArtifact
}): AlignmentReport {
  const objections: AlignmentObjection[] = []
  const conceptIds = new Set(input.concept.payload?.objective_ids ?? [])
  const labIds = new Set(input.lab.payload?.objective_ids ?? [])
  const assessmentIds = new Set(input.assessment.payload?.objective_ids ?? [])
  const coreTargets = input.spec.targets.filter((target) => target.importance === "core")

  for (const target of coreTargets) {
    if (!conceptIds.has(target.objective_id)) {
      objections.push(objection(input.concept.artifact_id, target.objective_id, "missing_instruction"))
    }
    if (!labIds.has(target.objective_id)) {
      objections.push(objection(input.lab.artifact_id, target.objective_id, "missing_practice"))
    }
    if (!assessmentIds.has(target.objective_id)) {
      objections.push(objection(input.assessment.artifact_id, target.objective_id, "missing_assessment"))
    }
  }

  const denominator = Math.max(1, coreTargets.length * 3)
  const alignmentScore = Math.max(0, (denominator - objections.length) / denominator)
  return {
    ok: objections.every((entry) => entry.severity !== "critical"),
    alignment_score: alignmentScore,
    objections,
  }
}

function objection(
  artifactId: string,
  objectiveId: string,
  issueType: "missing_instruction" | "missing_practice" | "missing_assessment",
): AlignmentObjection {
  return {
    objection_id: `OBJ-${artifactId}-${objectiveId}-${issueType}`,
    from_agent: "cross-artifact-gate",
    target_artifact_id: artifactId,
    objective_id: objectiveId,
    issue_type: issueType,
    severity: "critical",
    evidence: [objectiveId],
    proposed_action: "仅修订缺失该 objective 的产物；最多修订一次",
  }
}
