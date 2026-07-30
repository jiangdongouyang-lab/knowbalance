import type { RagResult } from "../../../rag/retriever"
import type { LearnerProfile } from "../../../role-b-profile/types"
import type { RoleCForRoleDResult } from "../../../role-d-integration/contracts"
import {
  fetchRoleCWithTimeout,
  RoleCHttpTimeoutError,
} from "./role-c-http"

export interface RoleCContentRequest {
  profile: LearnerProfile
  ragResult: RagResult
  kbVersion: string
  runId: string
}

export async function requestRoleCContent(input: RoleCContentRequest): Promise<RoleCForRoleDResult> {
  try {
    const response = await fetchRoleCWithTimeout(
      "/api/role-c/generate",
      {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      },
    )
    const payload: unknown = await response.json()
    if (isRoleCReadyResult(payload, input.runId)
      || isTerminalResult(payload, input.runId)) return payload
    if (!response.ok) {
      return blocked(
        input.runId,
        "failed",
        errorMessage(payload) ?? "Role C 服务调用失败",
      )
    }
    return blocked(input.runId, "failed", "Role C 返回内容不符合公开合同")
  } catch (error) {
    return blocked(
      input.runId,
      "failed",
      error instanceof RoleCHttpTimeoutError
        ? "生成学习内容等待超时，请检查网络或服务状态后重试"
        : error instanceof Error
          ? error.message
          : "Role C 服务不可用",
    )
  }
}

function blocked(runId: string, status: "blocked" | "failed", reason: string): RoleCForRoleDResult {
  return { status, artifacts: [], workflow: [], runId, reason }
}

export function isRoleCReadyResult(
  value: unknown,
  expectedRunId?: string,
): value is Extract<RoleCForRoleDResult, { status: "ready" }> {
  if (!isRecord(value)
    || value.status !== "ready"
    || !nonEmpty(value.runId)
    || (expectedRunId !== undefined && value.runId !== expectedRunId)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.workflow)
    || !isRecord(value.learningSession)
    || !isRecord(value.deliveryToD)) return false
  const session = value.learningSession
  const kinds = value.artifacts.flatMap((artifact) =>
    isRecord(artifact) && typeof artifact.kind === "string"
      ? [artifact.kind]
      : [])
  const assessment = value.artifacts.find((artifact) =>
    isRecord(artifact) && artifact.kind === "assessment")
  const publicItemIds = new Set(
    isRecord(assessment) && Array.isArray(assessment.items)
      ? assessment.items.flatMap((item) =>
          isRecord(item) && nonEmpty(item.id) ? [item.id] : [])
      : [],
  )
  const artifactIds = value.artifacts.flatMap((artifact) =>
    isRecord(artifact) && nonEmpty(artifact.id) ? [artifact.id] : [])
  return value.artifacts.length === 3
    && value.artifacts.every(isPublicArtifact)
    && artifactIds.length === value.artifacts.length
    && new Set(artifactIds).size === artifactIds.length
    && new Set(kinds).size === 3
    && ["lesson", "lab", "assessment"].every((kind) => kinds.includes(kind))
    && value.workflow.every(isPublicWorkflowEvent)
    && (value.audit === undefined || isPublicAudit(value.audit))
    && session.phase === "anchor_pending"
    && nonEmpty(session.sessionId)
    && nonEmpty(session.formId)
    && Number.isSafeInteger(session.attemptNo)
    && Number(session.attemptNo) >= 1
    && nonEmpty(session.profileVersion)
    && nonEmpty(session.pathNodeId)
    && isNonEmptyUniqueStringArray(session.targetSourceIds)
    && isNonEmptyUniqueStringArray(session.requiredItemIds)
    && session.requiredItemIds.every((itemId) =>
      publicItemIds.has(itemId))
    && nonEmpty(session.routingRequestId)
    && isDeliveryAck(value.deliveryToD.reviewedRelease)
    && isDeliveryAck(value.deliveryToD.learningSession)
}

function isTerminalResult(
  value: unknown,
  expectedRunId: string,
): value is Extract<
  RoleCForRoleDResult,
  { status: "blocked" | "failed" }
> {
  return isRecord(value)
    && (value.status === "blocked" || value.status === "failed")
    && value.runId === expectedRunId
    && Array.isArray(value.artifacts)
    && Array.isArray(value.workflow)
    && typeof value.reason === "string"
}

function isPublicArtifact(value: unknown): boolean {
  if (!isRecord(value)
    || !nonEmpty(value.id)
    || !["lesson", "lab", "assessment"].includes(String(value.kind))
    || value.status !== "real"
    || typeof value.title !== "string"
    || typeof value.content !== "string"
    || !isStringArray(value.options)
    || !Array.isArray(value.citations)
    || !value.citations.every(isPublicCitation)
    || !Array.isArray(value.items)
    || !value.items.every(isPublicAssessmentItem)) return false
  const itemIds = value.items.flatMap((item) =>
    isRecord(item) && nonEmpty(item.id) ? [item.id] : [])
  return itemIds.length === value.items.length
    && new Set(itemIds).size === itemIds.length
    && (value.kind !== "assessment" || value.items.length > 0)
}

function isPublicAssessmentItem(value: unknown): boolean {
  if (!isRecord(value)
    || !nonEmpty(value.id)
    || (value.tier !== 1 && value.tier !== 2 && value.tier !== 3)
    || !["mcq", "true_false", "trace", "short_answer", "code"]
      .includes(String(value.modality))
    || typeof value.prompt !== "string"
    || !isStringArray(value.options)
    || !Array.isArray(value.citations)
    || !value.citations.every(isPublicCitation)
    || (value.starter_code !== undefined
      && typeof value.starter_code !== "string")) return false
  return value.option_ids === undefined
    || (isStringArray(value.option_ids)
      && value.option_ids.length === value.options.length
      && new Set(value.option_ids).size === value.option_ids.length)
}

function isPublicCitation(value: unknown): boolean {
  return isRecord(value)
    && nonEmpty(value.source_id)
    && nonEmpty(value.fact_id)
}

function isPublicWorkflowEvent(value: unknown): boolean {
  return isRecord(value)
    && nonEmpty(value.id)
    && nonEmpty(value.agent)
    && typeof value.stage === "string"
    && ["pending", "running", "completed", "review", "blocked"]
      .includes(String(value.status))
    && typeof value.summary === "string"
    && typeof value.timestamp === "string"
}

function isPublicAudit(value: unknown): boolean {
  if (!isRecord(value)
    || !isAuditStatus(value.factStatus)
    || !Array.isArray(value.factAudits)
    || !value.factAudits.every(isPublicFactAudit)
    || !isRecord(value.teachingAudit)
    || !isRecord(value.arbitration)) return false
  const teaching = value.teachingAudit
  const arbitration = value.arbitration
  return typeof teaching.artifactId === "string"
    && isAuditStatus(teaching.status)
    && typeof teaching.summary === "string"
    && isStringArray(teaching.revisionHints)
    && typeof arbitration.artifactId === "string"
    && isAuditStatus(arbitration.decision)
    && Number.isSafeInteger(arbitration.revisionRound)
    && Number.isSafeInteger(arbitration.maxRevisionRounds)
    && typeof arbitration.canRevise === "boolean"
    && typeof arbitration.reason === "string"
}

function isPublicFactAudit(value: unknown): boolean {
  return isRecord(value)
    && typeof value.artifactId === "string"
    && typeof value.artifactTitle === "string"
    && ["lesson", "lab", "assessment"].includes(
      String(value.artifactKind),
    )
    && isAuditStatus(value.status)
    && Number.isSafeInteger(value.checkedClaims)
    && Number(value.checkedClaims) >= 0
    && Number.isSafeInteger(value.conflicts)
    && Number(value.conflicts) >= 0
    && isStringArray(value.notes)
}

function isAuditStatus(value: unknown): boolean {
  return value === "pass" || value === "revise" || value === "reject"
}

function isDeliveryAck(value: unknown): boolean {
  return isRecord(value)
    && value.schema_version === "1.0"
    && ["reviewed_release", "learning_session"].includes(
      String(value.delivery_kind),
    )
    && nonEmpty(value.delivery_id)
    && (value.status === "accepted" || value.status === "duplicate")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isNonEmptyUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmpty)
    && new Set(value).size === value.length
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : undefined
}
