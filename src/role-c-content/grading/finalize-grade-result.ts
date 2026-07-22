import { finalizeDraft, invalidOutputEnvelope } from "../agents/harness"
import type {
  AssessmentSecureArtifact,
  GradeFeedback,
  GradeResultArtifact,
  GradeResultPayload,
} from "../contracts/artifacts"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import { decideNextAction } from "../mastery/next-action-policy"
import type { SubmissionGrade } from "./grade-submission"
import {
  validateFeedbackContract,
  type GradeFeedbackGenerator,
  type GradeFeedbackGeneratorInput,
} from "./model-feedback-generator"

export interface FinalizeGradeResultInput {
  grade: SubmissionGrade
  spec: GenerationSpec
  evidence: RagEvidencePack
  assessment_secure: AssessmentSecureArtifact
  formative: boolean
}

/** Freezes trusted scores first, then derives public feedback without access to answer keys. */
export function finalizeGradeResult(input: FinalizeGradeResultInput): GradeResultArtifact {
  if (input.grade.status !== "graded" || !input.grade.boundary_verified || !input.assessment_secure.payload) {
    return invalidOutputEnvelope({
      spec: input.spec,
      evidence: input.evidence,
      agent: "tiered-evaluator",
      artifact_type: "grade_result",
      input_refs: [input.assessment_secure.artifact_id, input.grade.submission_id],
      message: input.grade.status === "needs_review"
        ? "评分包含待复核项，不能冻结成绩"
        : !input.grade.boundary_verified
          ? "评分未完成 public policy 与可信 session 边界校验，不能冻结成绩"
          : "评分未完成，不能冻结成绩",
      details: [input.grade.blocked_reason, ...input.grade.unresolved_item_ids].filter((value): value is string => Boolean(value)),
    })
  }

  const frozenScore = Object.freeze({
    submission_id: input.grade.submission_id,
    form_id: input.grade.form_id,
    raw_score: input.grade.raw_score,
    max_score: input.grade.max_score,
    evidence_score: input.grade.evidence_score,
    item_results: structuredClone(input.grade.item_results),
  })
  const sufficientModalities = input.assessment_secure.payload.items.some((item) =>
    (item.modality === "trace" || item.modality === "code")
      && frozenScore.item_results.some((result) => result.item_id === item.item_id && result.grader_confidence >= 0.65),
  )
  const payload: GradeResultPayload = {
    ...frozenScore,
    score_frozen: true,
    recommendation: decideNextAction({ mastery: frozenScore.evidence_score, sufficient_modalities: sufficientModalities }),
    feedback: buildGradeFeedback(frozenScore, input.formative ? "formative" : "summative"),
  }
  return finalizeDraft({
    spec: input.spec,
    evidence: input.evidence,
    agent: "tiered-evaluator",
    artifact_type: "grade_result",
    draft: { payload },
    input_refs: [input.assessment_secure.artifact_id, input.grade.submission_id],
    public_payload: true,
    objective_ids: [...new Set(payload.item_results.map((result) => result.objective_id))],
    answer_key_verified: true,
  })
}

/**
 * Optional personalized wording path. A provider failure or invalid feedback falls
 * back to the deterministic frozen feedback; it can never invalidate or alter scores.
 */
export async function finalizeGradeResultWithFeedback(
  input: FinalizeGradeResultInput,
  generator: GradeFeedbackGenerator,
): Promise<GradeResultArtifact> {
  const baseline = finalizeGradeResult(input)
  if (baseline.status !== "ready" || !baseline.payload) return baseline
  const generatorInput: GradeFeedbackGeneratorInput = {
    mode: input.formative ? "formative" : "summative",
    frozen_score: {
      submission_id: baseline.payload.submission_id,
      form_id: baseline.payload.form_id,
      score_frozen: true,
      raw_score: baseline.payload.raw_score,
      max_score: baseline.payload.max_score,
      evidence_score: baseline.payload.evidence_score,
    },
    recommendation: structuredClone(baseline.payload.recommendation),
    item_results: baseline.payload.item_results.map((item) => ({
      item_id: item.item_id,
      objective_id: item.objective_id,
      raw_score: item.raw_score,
      max_score: item.max_score,
      feedback_code: item.feedback_code,
      misconception_tags: [...item.misconception_tags],
    })),
  }
  let feedback: GradeFeedback
  try {
    feedback = await generator.generate(generatorInput)
    if (validateFeedbackContract(generatorInput, feedback).length > 0) return baseline
  } catch {
    return baseline
  }
  const payload: GradeResultPayload = { ...structuredClone(baseline.payload), feedback }
  return finalizeDraft({
    spec: input.spec,
    evidence: input.evidence,
    agent: "tiered-evaluator",
    artifact_type: "grade_result",
    draft: { payload },
    input_refs: [...baseline.input_refs],
    public_payload: true,
    objective_ids: [...new Set(payload.item_results.map((result) => result.objective_id))],
    answer_key_verified: true,
  })
}

type FrozenScore = Readonly<Pick<GradeResultPayload,
  "submission_id" | "form_id" | "raw_score" | "max_score" | "evidence_score" | "item_results">>

export function buildGradeFeedback(score: FrozenScore, mode: GradeFeedback["mode"]): GradeFeedback {
  const correctCount = score.item_results.filter((item) => item.raw_score === item.max_score).length
  return {
    generated_after_score_freeze: true,
    mode,
    summary: `本次完成 ${score.item_results.length} 题，其中 ${correctCount} 题达到完整要求；证据分为 ${formatPercent(score.evidence_score)}。`,
    item_feedback: score.item_results.map((item) => ({
      item_id: item.item_id,
      feedback_code: item.feedback_code,
      message: feedbackMessage(item.feedback_code, mode, item.misconception_tags, item.raw_score === item.max_score),
      next_step: feedbackNextStep(item.feedback_code, item.objective_id),
    })),
  }
}

function feedbackMessage(code: string, mode: GradeFeedback["mode"], misconceptions: string[], fullScore: boolean): string {
  if (fullScore && (code === "correct" || code === "passed" || code === "rubric_graded")) return "作答已满足当前评分要求。"
  if (code === "rubric_graded") return "回答已完成量规评分，但仍有标准未完全满足。"
  if (code === "unanswered") return "本题尚未作答。"
  if (code === "invalid_numeric") return "提交内容不能解析为要求的数值。"
  if (code === "invalid_unit") return "提交内容缺少要求的单位，或单位与题目不一致。"
  if (code === "outside_tolerance") return "数值结果未落在允许误差范围内，请复核计算过程和单位。"
  if (code === "failed" || code === "timeout") return "代码未通过全部隔离测试，请检查边界输入、返回值和执行复杂度。"
  if (code.startsWith("rubric_")) return "回答的部分评分依据仍不充分，需要补充可核验说明。"
  if (misconceptions.length > 0 && mode === "formative") return "当前选择反映出一个需要回看概念边界的理解点。"
  return mode === "formative" ? "当前作答未达到要求，建议根据提示重新推导。" : "当前作答未达到评分要求。"
}

function feedbackNextStep(code: string, objectiveId: string): string {
  if (code === "correct" || code === "passed" || code === "rubric_graded") return `继续完成目标 ${objectiveId} 的迁移练习。`
  if (code === "timeout") return `针对目标 ${objectiveId} 检查终止条件与复杂度。`
  return `回到目标 ${objectiveId} 的讲解与示例，完成一次同族变式后再测。`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}
