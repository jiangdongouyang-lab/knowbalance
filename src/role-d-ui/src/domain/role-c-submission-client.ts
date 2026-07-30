import type { RoleDSession } from "./types"
import {
  buildRoleCSubmissionAnswers,
  buildRoleCSubmissionId,
  type RoleCRoutingOutcome,
  type RoleCSubmissionOutcome,
} from "./role-c-submission"
import {
  fetchRoleCWithTimeout,
  RoleCHttpTimeoutError,
} from "./role-c-http"

export interface RoleCSubmissionRequest {
  sessionId: string
  runId: string
  learnerId: string
  formId: string
  attemptNo: number
  submissionId: string
  answers: ReturnType<typeof buildRoleCSubmissionAnswers>
}

export interface RoleCSubmissionResult {
  submissionId: string
  outcome: RoleCSubmissionOutcome
}

export interface RoleCRoutingResult {
  outcome: RoleCRoutingOutcome
}

export async function routeRoleCAssessment(
  session: RoleDSession,
): Promise<RoleCRoutingResult> {
  const roleC = session.roleC
  const routing = roleC?.routing
  if (!roleC || routing?.phase !== "anchor_pending") {
    return {
      outcome: {
        status: "blocked",
        routingRequestId: routing?.routingRequestId ?? "",
        issues: ["当前学习计划没有待确认的 C 锚点路线。"],
      },
    }
  }

  const answers = buildRoleCSubmissionAnswers(session)
  if (!sameStringSet(
    answers.map((answer) => answer.item_id),
    routing.requiredItemIds,
  ) || answers.some((answer) => !hasNonEmptyResponse(answer))) {
    return {
      outcome: {
        status: "blocked",
        routingRequestId: routing.routingRequestId,
        issues: ["请先完成当前开放的锚点题。"],
      },
    }
  }
  const request: RoleCSubmissionRequest & { routingRequestId: string } = {
    sessionId: roleC.learningSessionId,
    runId: roleC.runId,
    learnerId: session.profile.learnerId,
    formId: roleC.formId,
    attemptNo: roleC.attemptNo,
    submissionId: `ANCHOR-${routing.routingRequestId}`,
    routingRequestId: routing.routingRequestId,
    answers,
  }
  try {
    const response = await fetchRoleCWithTimeout(
      "/api/role-c/route",
      {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      },
    )
    const payload: unknown = await response.json()
    if (isRoleCRoutingOutcome(payload, session)) {
      return { outcome: payload }
    }
    return {
      outcome: {
        status: "blocked",
        routingRequestId: routing.routingRequestId,
        issues: [
          errorMessage(payload) ?? (
            response.ok
              ? "C 返回了不符合公开合同的路由响应。"
              : "C 锚点路由服务调用失败。"
          ),
        ],
      },
    }
  } catch (error) {
    return {
      outcome: {
        status: "blocked",
        routingRequestId: routing.routingRequestId,
        issues: [
          error instanceof RoleCHttpTimeoutError
            ? "确认测评路线等待超时，请检查网络或服务状态后重试。"
            : error instanceof Error
              ? error.message
              : "C 锚点路由服务不可用。",
        ],
      },
    }
  }
}

export async function submitRoleCAssessment(session: RoleDSession): Promise<RoleCSubmissionResult> {
  if (!session.roleC) {
    return {
      submissionId: "",
      outcome: { status: "blocked", submission_id: "", code: "ROLE_C_SESSION_MISSING", message: "当前学习计划没有 C 正式学习会话。" },
    }
  }
  if (session.roleC.routing?.phase === "anchor_pending") {
    return {
      submissionId: "",
      outcome: {
        status: "blocked",
        submission_id: "",
        code: "ANCHOR_ROUTING_REQUIRED",
        message: "请先完成锚点题并确认本轮测评路线。",
      },
    }
  }
  const answers = buildRoleCSubmissionAnswers(session)
  const submissionId = buildRoleCSubmissionId(session, answers)
  const request: RoleCSubmissionRequest = {
    sessionId: session.roleC.learningSessionId,
    runId: session.roleC.runId,
    learnerId: session.profile.learnerId,
    formId: session.roleC.formId,
    attemptNo: session.roleC.attemptNo,
    submissionId,
    answers,
  }
  try {
    const response = await fetchRoleCWithTimeout(
      "/api/role-c/submit",
      {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      },
    )
    const payload: unknown = await response.json()
    if (isRoleCSubmissionOutcome(payload, session, submissionId)) {
      return { submissionId, outcome: payload }
    }
    return {
      submissionId,
      outcome: {
        status: "blocked",
        submission_id: submissionId,
        code: "ROLE_C_RESPONSE_INVALID",
        message: errorMessage(payload) ?? "C 返回了不符合公开合同的评分响应",
      },
    }
  } catch (error) {
    return {
      submissionId,
      outcome: {
        status: "blocked",
        submission_id: submissionId,
        code: "ROLE_C_SUBMISSION_UNAVAILABLE",
        message: error instanceof RoleCHttpTimeoutError
          ? "提交测评等待超时，答案已保留，请检查网络或服务状态后重试"
          : error instanceof Error
            ? error.message
            : "C 正式评分服务不可用",
      },
    }
  }
}

function isRoleCRoutingOutcome(
  value: unknown,
  session: RoleDSession,
): value is RoleCRoutingOutcome {
  const routing = session.roleC?.routing
  if (!isRecord(value)
    || routing?.phase !== "anchor_pending"
    || value.routingRequestId !== routing.routingRequestId
    || typeof value.status !== "string") return false
  if (value.status === "blocked") {
    return Array.isArray(value.issues) && value.issues.every(nonEmpty)
  }
  if (value.status === "needs_review") {
    return Array.isArray(value.unresolvedItemIds)
      && value.unresolvedItemIds.every(nonEmpty)
  }
  if (value.status !== "routed"
    || !finiteRatio(value.anchorScoreRatio)
    || !nonEmpty(value.routeId)
    || !isRouteAction(value.action)
    || !isUniqueStringArray(value.requiredItemIds)
    || !isRecord(value.learningSession)) return false
  const next = value.learningSession
  const publicItemIds = new Set(
    session.artifacts.find((artifact) => artifact.kind === "assessment")
      ?.items?.map((item) => item.id) ?? [],
  )
  if (!isUniqueStringArray(next.requiredItemIds)) return false
  const nextRequiredItemIds = next.requiredItemIds
  return next.phase === "route_locked"
    && next.routingRequestId === routing.routingRequestId
    && next.sessionId === session.roleC?.learningSessionId
    && next.runId === session.roleC?.runId
    && next.formId === session.roleC?.formId
    && next.attemptNo === session.roleC?.attemptNo
    && nonEmpty(next.routeLockId)
    && next.routeId === value.routeId
    && next.action === value.action
    && next.anchorScoreRatio === value.anchorScoreRatio
    && sameStringSet(value.requiredItemIds, nextRequiredItemIds)
    && routing.requiredItemIds.every((itemId) => nextRequiredItemIds.includes(itemId))
    && nextRequiredItemIds.every((itemId) => publicItemIds.has(itemId))
}

function isRoleCSubmissionOutcome(
  value: unknown,
  session: RoleDSession,
  expectedSubmissionId: string,
): value is RoleCSubmissionOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false
  if (value.status === "blocked") {
    return value.submission_id === expectedSubmissionId
      && nonEmpty(value.code)
      && typeof value.message === "string"
  }
  if (value.status === "needs_review") {
    return value.submission_id === expectedSubmissionId
      && Array.isArray(value.unresolved_item_ids)
      && value.unresolved_item_ids.every(nonEmpty)
  }
  return value.status === "completed"
    && isRoleCFeedback(value.feedback, session, expectedSubmissionId)
}

function isRoleCFeedback(
  value: unknown,
  session: RoleDSession,
  expectedSubmissionId: string,
): boolean {
  const publicItemIds = new Set(
    session.artifacts.find((artifact) => artifact.kind === "assessment")
      ?.items?.map((item) => item.id) ?? [],
  )
  const requiredItemIds = session.roleC?.routing?.requiredItemIds
    ?? [...publicItemIds]
  if (!isRecord(value)
    || value.schema_version !== "1.0"
    || !nonEmpty(value.feedback_id)
    || value.submission_id !== expectedSubmissionId
    || value.run_id !== session.roleC?.runId
    || value.session_id !== session.roleC?.learningSessionId
    || value.learner_id_hash !== session.profile.learnerId
    || !nonEmpty(value.profile_version)
    || !nonEmpty(value.path_node_id)
    || (session.roleC?.profileVersion !== undefined
      && value.profile_version !== session.roleC.profileVersion)
    || (session.roleC?.pathNodeId !== undefined
      && value.path_node_id !== session.roleC.pathNodeId)
    || value.form_id !== session.roleC?.formId
    || value.attempt_no !== session.roleC?.attemptNo
    || !isScore(value.round_score)
    || !Array.isArray(value.objective_results)
    || value.objective_results.length === 0
    || !value.objective_results.every(isObjectiveResult)
    || !hasUniqueField(value.objective_results, "objective_id")
    || !Array.isArray(value.mastery_snapshot)
    || !value.mastery_snapshot.every(isMasteryState)
    || !hasUniqueField(value.mastery_snapshot, "objective_id")
    || !isFinalDecision(value.final_decision)
    || !isGradeResult(
      value.grade_result,
      value,
      publicItemIds,
      requiredItemIds,
    )) return false
  return true
}

function isGradeResult(
  value: unknown,
  feedback: Record<string, unknown>,
  publicItemIds: Set<string>,
  requiredItemIds: string[],
): boolean {
  if (!isRecord(value)
    || value.schema_version !== "1.0"
    || value.run_id !== feedback.run_id
    || !nonEmpty(value.artifact_id)
    || value.artifact_type !== "grade_result"
    || value.agent !== "tiered-evaluator"
    || value.status !== "ready"
    || !isArtifactVersions(value.versions, feedback.profile_version)
    || !Number.isInteger(value.seed)
    || !isStringArray(value.input_refs)
    || !Array.isArray(value.citations)
    || !value.citations.every(isCitation)
    || !isArtifactQuality(value.quality)
    || !nonEmpty(value.trace_ref)
    || !isRecord(value.payload)) return false

  const payload = value.payload
  if (payload.submission_id !== feedback.submission_id
    || payload.form_id !== feedback.form_id
    || payload.score_frozen !== true
    || !finiteNonNegative(payload.raw_score)
    || !finitePositive(payload.max_score)
    || !finiteRatio(payload.evidence_score)
    || !isRecord(feedback.round_score)
    || !sameNumber(payload.raw_score, feedback.round_score.raw_score)
    || !sameNumber(payload.max_score, feedback.round_score.max_score)
    || !sameNumber(payload.evidence_score, feedback.round_score.evidence_score)
    || !Array.isArray(payload.item_results)
    || !payload.item_results.every((item) =>
      isItemResult(item, publicItemIds))
    || !hasUniqueField(payload.item_results, "item_id")
    || !sameNumber(
      payload.raw_score,
      sumNumericField(payload.item_results, "raw_score"),
    )
    || !sameNumber(
      payload.max_score,
      sumNumericField(payload.item_results, "max_score"),
    )
    || !sameStringSet(
      payload.item_results.map((item) =>
        (item as Record<string, unknown>).item_id as string),
      requiredItemIds,
    )
    || !isRecord(payload.recommendation)
    || !isRecord(feedback.final_decision)
    || payload.recommendation.action !== feedback.final_decision.action
    || !sameNumber(
      payload.recommendation.confidence,
      feedback.final_decision.confidence,
    )
    || !isNonEmptyUniqueStringArray(payload.recommendation.reason_codes)
    || !isNonEmptyUniqueStringArray(feedback.final_decision.reason_codes)
    || !sameStringSet(
      payload.recommendation.reason_codes,
      feedback.final_decision.reason_codes,
    )
    || !isGradeFeedback(payload.feedback, requiredItemIds)) return false
  return true
}

function isArtifactVersions(
  value: unknown,
  expectedProfileVersion: unknown,
): boolean {
  return isRecord(value)
    && value.profile_version === expectedProfileVersion
    && nonEmpty(value.kb_version)
    && nonEmpty(value.rag_version)
    && nonEmpty(value.prompt_version)
    && nonEmpty(value.model_config_hash)
    && value.schema_version === "1.0"
    && (value.runner_image_digest === undefined
      || (typeof value.runner_image_digest === "string"
        && /^sha256:[a-f0-9]{64}$/.test(value.runner_image_digest)))
}

function isArtifactQuality(value: unknown): boolean {
  return isRecord(value)
    && typeof value.schema_ok === "boolean"
    && finiteRatio(value.citation_coverage)
    && finiteRatio(value.objective_coverage)
    && finiteRatio(value.alignment_score)
    && (value.execution_verified === undefined
      || typeof value.execution_verified === "boolean")
    && (value.answer_key_verified === undefined
      || typeof value.answer_key_verified === "boolean")
}

function isCitation(value: unknown): boolean {
  return isRecord(value)
    && typeof value.source_id === "string"
    && /^K[0-9]{3}$/.test(value.source_id)
    && typeof value.fact_id === "string"
    && /^F[0-9]{3}$/.test(value.fact_id)
    && ["supports", "derived_from", "prerequisite"].includes(
      String(value.relation),
    )
}

function isRubricResult(value: unknown): boolean {
  return isRecord(value)
    && nonEmpty(value.criterion_id)
    && ["met", "unmet", "uncertain"].includes(String(value.status))
    && finiteNonNegative(value.awarded_score)
    && finiteRatio(value.confidence)
    && (value.evidence_excerpt === undefined
      || typeof value.evidence_excerpt === "string")
}

function isGradeFeedback(
  value: unknown,
  requiredItemIds: string[],
): boolean {
  if (!isRecord(value)
    || value.generated_after_score_freeze !== true
    || (value.mode !== "formative" && value.mode !== "summative")
    || !nonEmpty(value.summary)
    || !Array.isArray(value.item_feedback)
    || !value.item_feedback.every((item) =>
      isRecord(item)
      && nonEmpty(item.item_id)
      && nonEmpty(item.feedback_code)
      && nonEmpty(item.message)
      && nonEmpty(item.next_step))
    || !hasUniqueField(value.item_feedback, "item_id")) return false
  return sameStringSet(
    value.item_feedback.map((item) =>
      (item as Record<string, unknown>).item_id as string),
    requiredItemIds,
  )
}

function isItemResult(
  value: unknown,
  publicItemIds: Set<string>,
): boolean {
  return isRecord(value)
    && nonEmpty(value.item_id)
    && publicItemIds.has(value.item_id)
    && nonEmpty(value.objective_id)
    && nonEmpty(value.feedback_code)
    && finiteNonNegative(value.raw_score)
    && finitePositive(value.max_score)
    && finiteRatio(value.evidence_score)
    && finiteRatio(value.grader_confidence)
    && finiteRatio(value.hint_factor)
    && finiteRatio(value.repeat_factor)
    && Number(value.raw_score) <= Number(value.max_score)
    && Array.isArray(value.misconception_tags)
    && value.misconception_tags.every(nonEmpty)
    && new Set(value.misconception_tags).size === value.misconception_tags.length
    && (value.rubric_results === undefined
      || (Array.isArray(value.rubric_results)
        && value.rubric_results.every(isRubricResult)))
}

function isScore(value: unknown): boolean {
  if (!isRecord(value)) return false
  return finiteNonNegative(value.raw_score)
    && finitePositive(value.max_score)
    && finiteRatio(value.accuracy)
    && finiteRatio(value.evidence_score)
    && Number(value.raw_score) <= Number(value.max_score)
    && sameNumber(
      value.accuracy,
      Number(value.raw_score) / Number(value.max_score),
    )
}

function isObjectiveResult(value: unknown): boolean {
  return isRecord(value)
    && nonEmpty(value.objective_id)
    && finiteNonNegative(value.raw_score)
    && finitePositive(value.max_score)
    && finiteRatio(value.accuracy)
    && finiteRatio(value.evidence_score)
    && Number(value.raw_score) <= Number(value.max_score)
    && sameNumber(
      value.accuracy,
      Number(value.raw_score) / Number(value.max_score),
    )
    && Array.isArray(value.misconception_tags)
    && value.misconception_tags.every(nonEmpty)
    && new Set(value.misconception_tags).size === value.misconception_tags.length
}

function isMasteryState(value: unknown): boolean {
  return isRecord(value)
    && nonEmpty(value.objective_id)
    && finiteRatio(value.mastery)
    && Number.isInteger(value.evidence_batches)
    && Number(value.evidence_batches) >= 0
    && Array.isArray(value.observed_modalities)
    && value.observed_modalities.every((entry) =>
      ["mcq", "true_false", "trace", "short_answer", "code"].includes(
        String(entry),
      ))
    && new Set(value.observed_modalities).size
      === value.observed_modalities.length
    && Number.isInteger(value.revision)
    && Number(value.revision) >= 0
}

function isFinalDecision(value: unknown): boolean {
  return isRecord(value)
    && ["remediate", "reinforce", "advance", "reprofile"].includes(String(value.action))
    && (value.basis === "round_accuracy" || value.basis === "profile_drift")
    && finiteRatio(value.confidence)
    && isNonEmptyUniqueStringArray(value.reason_codes)
    && isUniqueStringArrayAllowEmpty(value.target_objective_ids)
    && nonEmpty(value.policy_ref)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function finitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function finiteRatio(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function isRouteAction(value: unknown): value is "remediate" | "reinforce" | "advance" {
  return value === "remediate" || value === "reinforce" || value === "advance"
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmpty)
    && new Set(value).size === value.length
}

function isNonEmptyUniqueStringArray(value: unknown): value is string[] {
  return isUniqueStringArray(value)
}

function isUniqueStringArrayAllowEmpty(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
}

function hasUniqueField(
  values: unknown[],
  field: string,
): boolean {
  const fields = values.map((value) =>
    isRecord(value) ? value[field] : undefined)
  return fields.every(nonEmpty)
    && new Set(fields).size === fields.length
}

function sumNumericField(
  values: unknown[],
  field: string,
): number {
  return values.reduce<number>((sum, value) =>
    sum + Number(isRecord(value) ? value[field] : 0), 0)
}

function sameNumber(left: unknown, right: unknown): boolean {
  return typeof left === "number"
    && typeof right === "number"
    && Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= 1e-6
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((entry) => right.includes(entry))
}

function hasNonEmptyResponse(
  answer: RoleCSubmissionRequest["answers"][number],
): boolean {
  const values = [
    "selected_option_id" in answer ? answer.selected_option_id : undefined,
    "text_response" in answer ? answer.text_response : undefined,
    "code_response" in answer ? answer.code_response : undefined,
  ]
  return values
    .some((value) => typeof value === "string" && value.trim().length > 0)
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined
}
