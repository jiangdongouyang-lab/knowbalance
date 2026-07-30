import type { RoleCForRoleDResult } from "../../../role-d-integration/contracts"
import { isRoleCReadyResult } from "./role-c-client"
import {
  fetchRoleCWithTimeout,
  ROLE_C_HTTP_TIMEOUT_MS,
  RoleCHttpTimeoutError,
} from "./role-c-http"
import type { RoleDSession } from "./types"

type RoleCReadyHandoff = Extract<RoleCForRoleDResult, { status: "ready" }>

export const ROLE_C_CONTINUATION_TIMEOUT_MS =
  ROLE_C_HTTP_TIMEOUT_MS

export type RoleCContinuationResult =
  | {
      status: "published"
      handoff: RoleCReadyHandoff
    }
  | {
      status: "awaiting_input" | "blocked" | "failed"
      message: string
    }

export async function continueRoleCAfterSubmission(
  session: RoleDSession,
): Promise<RoleCContinuationResult> {
  const roleC = session.roleC
  const feedback = session.feedback
  if (!roleC
    || !feedback
    || session.assessmentGraded !== true
    || feedback.submissionId.trim().length === 0
    || feedback.learnerId !== session.profile.learnerId
    || feedback.profileVersion !== roleC.profileVersion
    || feedback.pathNodeId !== roleC.pathNodeId) {
    return {
      status: "blocked",
      message: "当前轮次还没有可验证的 C 正式评分，不能继续下一轮。",
    }
  }

  try {
    const response = await fetchRoleCWithTimeout(
      "/api/role-c/continue",
      {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: roleC.learningSessionId,
        submissionId: feedback.submissionId,
        learnerId: session.profile.learnerId,
      }),
      },
      ROLE_C_CONTINUATION_TIMEOUT_MS,
    )
    const payload: unknown = await response.json()
    if (response.ok && isPublishedContinuation(payload, session)) {
      return {
        status: "published",
        handoff: payload.role_d_handoff,
      }
    }
    if (isContinuationTerminal(payload)) {
      return {
        status: payload.status,
        message: continuationMessage(payload),
      }
    }
    return {
      status: "failed",
      message: errorMessage(payload) ?? (
        response.ok
          ? "C 返回了不符合公开合同的下一轮响应。"
          : "C 下一轮服务调用失败，请稍后重试。"
      ),
    }
  } catch (error) {
    if (error instanceof RoleCHttpTimeoutError) {
      return {
        status: "failed",
        message: "准备下一轮等待超时，已保留本轮结果，请检查网络或服务状态后重试。",
      }
    }
    return {
      status: "failed",
      message: error instanceof Error
        ? error.message
        : "C 下一轮服务暂时不可用，请稍后重试。",
    }
  }
}

function isPublishedContinuation(
  value: unknown,
  current: RoleDSession,
): value is {
  status: "published"
  role_d_handoff: RoleCReadyHandoff
} {
  if (!isRecord(value)
    || value.status !== "published"
    || !isRoleCReadyResult(value.role_d_handoff)
    || !isRecord(value.preparation)
    || !isRecord(value.learning_session)
    || !isRecord(value.delivery_to_d)
    || !current.roleC
    || !current.feedback) return false

  const handoff = value.role_d_handoff
  const preparation = value.preparation
  const learningSession = value.learning_session
  const delivery = value.delivery_to_d
  const currentRoleC = current.roleC
  const currentFeedback = current.feedback

  return preparation.status === "generation_ready"
    && preparation.action === currentFeedback.finalDecision.action
    && preparation.prior_feedback_ref === currentFeedback.feedbackId
    && preparation.run_id === handoff.runId
    && preparation.profile_version === handoff.learningSession.profileVersion
    && preparation.path_node_id === handoff.learningSession.pathNodeId
    && handoff.runId !== currentRoleC.runId
    && handoff.learningSession.sessionId !== currentRoleC.learningSessionId
    && learningSession.phase === "anchor_pending"
    && learningSession.session_id === handoff.learningSession.sessionId
    && learningSession.run_id === handoff.runId
    && learningSession.form_id === handoff.learningSession.formId
    && learningSession.attempt_no === handoff.learningSession.attemptNo
    && learningSession.routing_request_id
      === handoff.learningSession.routingRequestId
    && sameStringSet(
      learningSession.required_item_ids,
      handoff.learningSession.requiredItemIds,
    )
    && isRecord(delivery.reviewed_release)
    && sameDeliveryAck(
      delivery.reviewed_release,
      handoff.deliveryToD.reviewedRelease,
      "reviewed_release",
    )
    && isRecord(delivery.learning_session)
    && sameDeliveryAck(
      delivery.learning_session,
      handoff.deliveryToD.learningSession,
      "learning_session",
    )
}

function isContinuationTerminal(
  value: unknown,
): value is Record<string, unknown> & {
  status: "awaiting_input" | "blocked" | "failed"
} {
  return isRecord(value)
    && (value.status === "awaiting_input"
      || value.status === "blocked"
      || value.status === "failed")
}

function continuationMessage(
  value: Record<string, unknown> & {
    status: "awaiting_input" | "blocked" | "failed"
  },
): string {
  if (value.status === "awaiting_input") {
    const preparation = isRecord(value.preparation)
      ? value.preparation
      : undefined
    if (preparation?.status === "awaiting_path_node") {
      return "下一轮需要 A/B 提供新的学习路径与检索证据，请完成上游更新后重试。"
    }
    if (preparation?.status === "reprofile_suggested") {
      return "下一轮需要 B 先完成画像校准，请完成上游更新后重试。"
    }
    return "下一轮仍在等待 A/B 的可信输入，请稍后重试。"
  }

  const issues = [
    ...stringArray(value.issues),
    ...stringArray(
      isRecord(value.preparation)
        ? value.preparation.errors
        : undefined,
    ),
    ...stringArray(
      isRecord(value.generation)
        ? value.generation.issues
        : undefined,
    ),
  ]
  if (issues.length > 0) return issues.join("；")
  return value.status === "blocked"
    ? "C 暂时无法生成下一轮，请保留本轮结果后重试。"
    : "C 生成下一轮失败，请稍后重试。"
}

function sameDeliveryAck(
  value: Record<string, unknown>,
  expected: RoleCReadyHandoff["deliveryToD"]["reviewedRelease"],
  kind: "reviewed_release" | "learning_session",
): boolean {
  return value.schema_version === "1.0"
    && value.delivery_kind === kind
    && value.delivery_id === expected.delivery_id
    && value.status === expected.status
}

function sameStringSet(
  value: unknown,
  expected: string[],
): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every(nonEmpty)
    && new Set(value).size === value.length
    && value.every((entry) => expected.includes(entry))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(nonEmpty) : []
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
