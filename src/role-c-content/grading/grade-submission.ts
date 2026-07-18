import type {
  AnswerSpec,
  AssessmentSecureArtifact,
  GradeItemResult,
  SubmissionAnswer,
  SubmissionEnvelope,
} from "../contracts/artifacts"
import type { CodeRunner } from "../security/code-runner"

export interface SubmissionGrade {
  status: "graded" | "needs_review" | "blocked"
  submission_id: string
  form_id: string
  raw_score: number
  max_score: number
  item_results: GradeItemResult[]
  unresolved_item_ids: string[]
  blocked_reason?: string
}

export async function gradeSubmission(
  submission: SubmissionEnvelope,
  secureArtifact: AssessmentSecureArtifact,
  codeRunner?: CodeRunner,
): Promise<SubmissionGrade> {
  if (secureArtifact.status !== "ready" || !secureArtifact.payload) {
    return blockedGrade(submission, "assessment_secure 未就绪")
  }
  if (submission.form_id !== secureArtifact.payload.form_id) {
    return blockedGrade(submission, "submission.form_id 与 assessment_secure 不一致")
  }

  const answers = new Map(submission.answers.map((answer) => [answer.item_id, answer]))
  const results: GradeItemResult[] = []
  const unresolved: string[] = []
  const blocked: string[] = []

  for (const item of secureArtifact.payload.items) {
    const answer = answers.get(item.item_id)
    const decision = await gradeOne(answer, item.answer_spec, item.max_score, codeRunner)
    if (decision.status !== "graded") unresolved.push(item.item_id)
    if (decision.status === "blocked") blocked.push(item.item_id)
    results.push({
      item_id: item.item_id,
      objective_id: item.objective_id,
      raw_score: decision.score,
      evidence_score: decision.max_score === 0 ? 0 : decision.score / decision.max_score,
      grader_confidence: decision.confidence,
      misconception_tags: [],
      feedback_code: decision.feedback_code,
    })
  }

  return {
    status: blocked.length > 0 ? "blocked" : unresolved.length === 0 ? "graded" : "needs_review",
    submission_id: submission.submission_id,
    form_id: submission.form_id,
    raw_score: results.reduce((sum, result) => sum + result.raw_score, 0),
    max_score: secureArtifact.payload.items.reduce((sum, item) => sum + item.max_score, 0),
    item_results: results,
    unresolved_item_ids: unresolved,
    blocked_reason: blocked.length > 0 ? `以下题目缺少可信评分能力：${blocked.join("、")}` : undefined,
  }
}

interface GradeDecision {
  status: "graded" | "needs_review" | "blocked"
  score: number
  max_score: number
  confidence: number
  feedback_code: string
}

async function gradeOne(
  answer: SubmissionAnswer | undefined,
  spec: AnswerSpec,
  maxScore: number,
  codeRunner?: CodeRunner,
): Promise<GradeDecision> {
  if (!answer) return { status: "graded", score: 0, max_score: maxScore, confidence: 1, feedback_code: "unanswered" }

  if (spec.kind === "exact_set") {
    const raw = answer.selected_option_id ?? answer.text_response ?? ""
    const normalized = normalizeText(raw, spec.normalization)
    const accepted = spec.accepted.map((value) => normalizeText(value, spec.normalization))
    const correct = accepted.includes(normalized)
    return { status: "graded", score: correct ? maxScore : 0, max_score: maxScore, confidence: 1, feedback_code: correct ? "correct" : "incorrect" }
  }

  if (spec.kind === "numeric") {
    const parsed = Number((answer.text_response ?? "").trim())
    if (!Number.isFinite(parsed)) {
      return { status: "graded", score: 0, max_score: maxScore, confidence: 1, feedback_code: "invalid_numeric" }
    }
    const tolerance = Math.max(spec.abs_tolerance, Math.abs(spec.target) * spec.rel_tolerance)
    const correct = Math.abs(parsed - spec.target) <= tolerance
    return { status: "graded", score: correct ? maxScore : 0, max_score: maxScore, confidence: 1, feedback_code: correct ? "correct" : "outside_tolerance" }
  }

  if (spec.kind === "code") {
    if (!codeRunner || !answer.code_response) {
      return { status: "blocked", score: 0, max_score: maxScore, confidence: 0, feedback_code: "code_runner_unavailable" }
    }
    const result = await codeRunner.execute({
      language: "python",
      code: answer.code_response,
      test_suite_id: spec.test_suite_id,
      timeout_ms: 2000,
      memory_mb: 128,
      max_output_bytes: 20000,
      network_allowed: false,
    })
    return {
      status: result.status === "runner_error" ? "blocked" : "graded",
      score: maxScore * result.score_ratio,
      max_score: maxScore,
      confidence: result.status === "runner_error" ? 0 : 1,
      feedback_code: result.status,
    }
  }

  return {
    status: "needs_review",
    score: 0,
    max_score: maxScore,
    confidence: 0,
    feedback_code: "concept_rubric_requires_hybrid_grader",
  }
}

function normalizeText(value: string, operations: Extract<AnswerSpec, { kind: "exact_set" }>["normalization"]): string {
  let output = value
  for (const operation of operations) {
    if (operation === "trim") output = output.trim()
    if (operation === "casefold") output = output.toLocaleLowerCase()
    if (operation === "unicode") output = output.normalize("NFKC")
    if (operation === "collapse_whitespace") output = output.replace(/\s+/g, " ")
  }
  return output
}

function blockedGrade(submission: SubmissionEnvelope, reason: string): SubmissionGrade {
  return {
    status: "blocked",
    submission_id: submission.submission_id,
    form_id: submission.form_id,
    raw_score: 0,
    max_score: 0,
    item_results: [],
    unresolved_item_ids: [],
    blocked_reason: reason,
  }
}
