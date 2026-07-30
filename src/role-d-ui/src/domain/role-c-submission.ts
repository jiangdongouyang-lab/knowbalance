import type { DynamicFeedbackResult } from "../../../role-c-content"
import type { RoleDSession, RoleCDecisionView, RoleCFeedbackView } from "./types"

type AssessmentItem = NonNullable<RoleDSession["artifacts"][number]["items"]>[number]

export type RoleCFeedbackPayload = DynamicFeedbackResult

export type RoleCSubmissionOutcome =
  | { status: "completed"; feedback: RoleCFeedbackPayload }
  | { status: "needs_review"; submission_id: string; unresolved_item_ids: string[] }
  | { status: "blocked"; submission_id: string; code: string; message: string }

export type RoleCRoutingOutcome =
  | {
      status: "routed"
      routingRequestId: string
      anchorScoreRatio: number
      routeId: string
      action: "remediate" | "reinforce" | "advance"
      requiredItemIds: string[]
      learningSession: {
        phase: "route_locked"
        routingRequestId: string
        sessionId: string
        runId: string
        formId: string
        attemptNo: number
        routeLockId: string
        routeId: string
        action: "remediate" | "reinforce" | "advance"
        anchorScoreRatio: number
        requiredItemIds: string[]
      }
    }
  | {
      status: "needs_review"
      routingRequestId: string
      unresolvedItemIds: string[]
    }
  | {
      status: "blocked"
      routingRequestId: string
      issues: string[]
    }

export function buildRoleCSubmissionAnswers(session: RoleDSession) {
  const assessment = session.artifacts.find((artifact) => artifact.kind === "assessment")
  const answers = session.view.assessmentAnswers ?? {}
  const required = session.roleC?.routing
    ? new Set(session.roleC.routing.requiredItemIds)
    : undefined
  return (assessment?.items ?? [])
    .filter((item) => required?.has(item.id) ?? true)
    .map((item) => toSubmissionAnswer(item, answers[item.id] ?? ""))
}

export function buildRoleCSubmissionId(
  session: RoleDSession,
  answers = buildRoleCSubmissionAnswers(session),
): string {
  if (!session.roleC) return ""
  return `SUB-${session.roleC.learningSessionId}-${session.roleC.attemptNo}-${submissionFingerprint(answers)}`
}

export function applyRoleCRoutingOutcome(
  session: RoleDSession,
  outcome: RoleCRoutingOutcome,
): RoleDSession {
  if (session.roleC?.routing?.phase === "route_locked") {
    // A late duplicate or failure from the old routing request cannot replace
    // a route lock that has already been persisted.
    return session
  }
  if (outcome.status === "blocked") {
    return {
      ...session,
      assessmentGraded: false,
      view: {
        ...session.view,
        assessmentSubmitted: false,
        assessmentStatus: "blocked",
        assessmentMessage: outcome.issues.join("；") || "C 无法确定本轮测评路线。",
      },
    }
  }
  if (outcome.status === "needs_review") {
    return {
      ...session,
      assessmentGraded: false,
      view: {
        ...session.view,
        assessmentSubmitted: true,
        assessmentStatus: "needs_review",
        assessmentMessage: `锚点题中有 ${outcome.unresolvedItemIds.length} 道需要进一步审核。`,
      },
    }
  }
  if (!matchesRoutingContext(session, outcome)) {
    return {
      ...session,
      assessmentGraded: false,
      view: {
        ...session.view,
        assessmentSubmitted: false,
        assessmentStatus: "blocked",
        assessmentMessage: "C 路由响应身份不匹配，未开放后续题目。",
      },
    }
  }

  const required = new Set(outcome.learningSession.requiredItemIds)
  const anchorItemIds = session.roleC!.routing!.requiredItemIds
  const assessmentAnswers = Object.fromEntries(
    Object.entries(session.view.assessmentAnswers ?? {})
      .filter(([itemId]) => required.has(itemId)),
  )
  return {
    ...session,
    assessmentGraded: false,
    roleC: {
      ...session.roleC!,
      routing: {
        phase: "route_locked",
        routingRequestId: outcome.learningSession.routingRequestId,
        routeLockId: outcome.learningSession.routeLockId,
        routeId: outcome.learningSession.routeId,
        action: outcome.learningSession.action,
        anchorScoreRatio: outcome.learningSession.anchorScoreRatio,
        anchorItemIds: [...anchorItemIds],
        requiredItemIds: [...outcome.learningSession.requiredItemIds],
      },
    },
    view: {
      ...session.view,
      assessmentAnswers,
      assessmentSubmitted: false,
      assessmentStatus: "idle",
      assessmentMessage: `锚点结果已确认，当前路线需要完成 ${required.size} 道题。`,
    },
  }
}

export function applyRoleCSubmissionOutcome(
  session: RoleDSession,
  expectedSubmissionId: string,
  outcome: RoleCSubmissionOutcome,
): RoleDSession {
  if (session.assessmentGraded === true
    && session.feedback?.submissionId === expectedSubmissionId) {
    return session
  }
  if (expectedSubmissionId !== buildRoleCSubmissionId(session)) {
    return rejectMismatchedSubmission(session)
  }
  if (outcome.status !== "completed"
    && outcome.submission_id !== expectedSubmissionId) {
    return rejectMismatchedSubmission(session)
  }
  if (outcome.status === "blocked") {
    return {
      ...session,
      assessmentGraded: false,
      view: {
        ...session.view,
        assessmentSubmitted: true,
        assessmentStatus: "blocked",
        assessmentMessage: outcome.message,
      },
    }
  }
  if (outcome.status === "needs_review") {
    return {
      ...session,
      assessmentGraded: false,
      view: {
        ...session.view,
        assessmentSubmitted: true,
        assessmentStatus: "needs_review",
        assessmentMessage: `C 已接收提交，${outcome.unresolved_item_ids.length} 道题需要进一步审核。`,
      },
    }
  }

  if (!matchesSubmissionContext(session, expectedSubmissionId, outcome.feedback)) {
    return rejectMismatchedSubmission(session)
  }
  const feedback = normalizeFeedback(outcome.feedback, session)
  return {
    ...session,
    assessmentGraded: true,
    feedback,
    decision: {
      next: feedback.finalDecision.action,
      reason: feedback.feedbackSummary || feedback.finalDecision.reasonCodes.join("；"),
    },
    path: updatePath(
      session.path,
      feedback.finalDecision.action,
      session.roleC?.targetSourceIds,
    ),
    view: {
      ...session.view,
      assessmentSubmitted: true,
      assessmentStatus: "completed",
      assessmentMessage: feedback.feedbackSummary,
    },
  }
}

function matchesSubmissionContext(
  session: RoleDSession,
  expectedSubmissionId: string,
  feedback: RoleCFeedbackPayload,
): boolean {
  return Boolean(session.roleC)
    && feedback.submission_id === expectedSubmissionId
    && feedback.run_id === session.roleC?.runId
    && feedback.session_id === session.roleC?.learningSessionId
    && feedback.learner_id_hash === session.profile.learnerId
    && (session.roleC?.profileVersion === undefined
      || feedback.profile_version === session.roleC.profileVersion)
    && (session.roleC?.pathNodeId === undefined
      || feedback.path_node_id === session.roleC.pathNodeId)
    && feedback.form_id === session.roleC?.formId
    && feedback.attempt_no === session.roleC?.attemptNo
}

function rejectMismatchedSubmission(session: RoleDSession): RoleDSession {
  return {
    ...session,
    assessmentGraded: false,
    feedback: undefined,
    decision: {
      next: "remediate",
      reason: "C 评分响应身份不匹配，已拒绝写入当前计划。",
    },
    view: {
      ...session.view,
      assessmentSubmitted: true,
      assessmentStatus: "blocked",
      assessmentMessage: "C 评分响应身份不匹配，未更新当前计划。",
    },
  }
}

function matchesRoutingContext(
  session: RoleDSession,
  outcome: Extract<RoleCRoutingOutcome, { status: "routed" }>,
): boolean {
  const roleC = session.roleC
  const current = roleC?.routing
  const next = outcome.learningSession
  return Boolean(roleC)
    && current?.phase === "anchor_pending"
    && current.routingRequestId === outcome.routingRequestId
    && outcome.routingRequestId === next.routingRequestId
    && roleC?.learningSessionId === next.sessionId
    && roleC?.runId === next.runId
    && roleC?.formId === next.formId
    && roleC?.attemptNo === next.attemptNo
    && outcome.routeId === next.routeId
    && outcome.action === next.action
    && outcome.anchorScoreRatio === next.anchorScoreRatio
    && sameStringSet(outcome.requiredItemIds, next.requiredItemIds)
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((entry) => right.includes(entry))
}

function toSubmissionAnswer(item: AssessmentItem, answer: string) {
  const base = { item_id: item.id, hint_level_used: 0 as const }
  if (item.modality === "mcq" || item.modality === "true_false") {
    return { ...base, selected_option_id: answer }
  }
  if (item.modality === "code") return { ...base, code_response: answer }
  return { ...base, text_response: answer }
}

function submissionFingerprint(
  answers: ReturnType<typeof buildRoleCSubmissionAnswers>,
): string {
  const input = JSON.stringify(answers)
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`
}

function normalizeFeedback(
  feedback: RoleCFeedbackPayload,
  session: RoleDSession,
): RoleCFeedbackView {
  const assessmentItemById = new Map(
    session.artifacts
      .find((artifact) => artifact.kind === "assessment")
      ?.items?.map((item) => [item.id, item]) ?? [],
  )
  return {
    feedbackId: feedback.feedback_id,
    submissionId: feedback.submission_id,
    learnerId: feedback.learner_id_hash,
    profileVersion: feedback.profile_version,
    pathNodeId: feedback.path_node_id,
    roundScore: {
      rawScore: feedback.round_score.raw_score,
      maxScore: feedback.round_score.max_score,
      accuracy: feedback.round_score.accuracy,
      evidenceScore: feedback.round_score.evidence_score,
    },
    objectiveResults: feedback.objective_results.map((result) => ({
      objectiveId: result.objective_id,
      rawScore: result.raw_score,
      maxScore: result.max_score,
      accuracy: result.accuracy,
      evidenceScore: result.evidence_score,
      misconceptionTags: [...result.misconception_tags],
    })),
    itemResults: (feedback.grade_result.payload?.item_results ?? []).flatMap((result) => {
      const publicItem = assessmentItemById.get(result.item_id)
      if (!publicItem) return []
      return [{
        itemId: result.item_id,
        objectiveId: result.objective_id,
        modality: publicItem.modality,
        status: result.feedback_code,
        rawScore: result.raw_score,
        maxScore: result.max_score,
        evidenceScore: result.evidence_score,
        misconceptionTags: [...result.misconception_tags],
      }]
    }),
    masterySnapshot: feedback.mastery_snapshot.map((state) => ({
      objectiveId: state.objective_id,
      mastery: state.mastery,
      evidenceBatches: state.evidence_batches,
      observedModalities: [...state.observed_modalities],
      revision: state.revision,
    })),
    finalDecision: {
      action: feedback.final_decision.action,
      basis: feedback.final_decision.basis,
      confidence: feedback.final_decision.confidence,
      reasonCodes: [...feedback.final_decision.reason_codes],
      targetObjectiveIds: [...feedback.final_decision.target_objective_ids],
      policyRef: feedback.final_decision.policy_ref,
    },
    feedbackSummary: feedback.grade_result.payload?.feedback.summary
      ?? "C 已完成正式评分和动态决策。",
  }
}

function updatePath(
  path: RoleDSession["path"],
  decision: RoleCDecisionView,
  targetSourceIds: string[] | undefined,
): RoleDSession["path"] {
  if (decision !== "advance") return path
  const targets = new Set(targetSourceIds ?? [])
  if (targets.size === 0) return path
  return path.map((node) => {
    if (targets.has(node.id)) {
      return {
        ...node,
        status: "completed" as const,
        reason: "C 正式评分达到进阶阈值。",
      }
    }
    return node
  })
}
