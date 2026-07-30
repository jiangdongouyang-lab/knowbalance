import type { RagResult } from "../rag/retriever"
import type { LearnerProfile } from "../role-b-profile/types"
import type { RoleCDeliveryAck } from "../role-c-content"

export interface RoleDPublicCitation {
  source_id: string
  fact_id: string
}

export interface RoleDAssessmentItem {
  id: string
  tier: 1 | 2 | 3
  modality: "mcq" | "true_false" | "trace" | "short_answer" | "code"
  prompt: string
  options: string[]
  option_ids: string[]
  starter_code?: string
  citations: RoleDPublicCitation[]
}

export interface RoleDGeneratedArtifact {
  id: string
  kind: "lesson" | "lab" | "assessment"
  title: string
  status: "real"
  content: string
  options: string[]
  citations: RoleDPublicCitation[]
  items: RoleDAssessmentItem[]
}

export interface RoleDWorkflowEvent {
  id: string
  agent: string
  stage: string
  status: "pending" | "running" | "completed" | "review" | "blocked"
  summary: string
  timestamp: string
}

export type RoleDAuditStatus = "pass" | "revise" | "reject"

export interface RoleDFactAuditSummary {
  artifactId: string
  artifactTitle: string
  artifactKind: "lesson" | "lab" | "assessment"
  status: RoleDAuditStatus
  checkedClaims: number
  conflicts: number
  notes: string[]
}

export interface RoleDTeachingAuditSummary {
  artifactId: string
  status: RoleDAuditStatus
  summary: string
  revisionHints: string[]
}

export interface RoleDArbitrationSummary {
  artifactId: string
  decision: RoleDAuditStatus
  revisionRound: number
  maxRevisionRounds: number
  canRevise: boolean
  reason: string
}

export interface RoleDContentAuditSummary {
  factStatus: RoleDAuditStatus
  factAudits: RoleDFactAuditSummary[]
  teachingAudit: RoleDTeachingAuditSummary
  arbitration: RoleDArbitrationSummary
}

export type RoleCForRoleDResult =
  | {
      status: "ready"
      artifacts: RoleDGeneratedArtifact[]
      workflow: RoleDWorkflowEvent[]
      runId: string
      learningSession: {
        phase: "anchor_pending"
        sessionId: string
        formId: string
        attemptNo: number
        profileVersion: string
        pathNodeId: string
        targetSourceIds: string[]
        routingRequestId: string
        requiredItemIds: string[]
      }
      deliveryToD: {
        reviewedRelease: RoleCDeliveryAck
        learningSession: RoleCDeliveryAck
      }
      audit?: RoleDContentAuditSummary
    }
  | {
      status: "blocked" | "failed"
      artifacts: RoleDGeneratedArtifact[]
      workflow: RoleDWorkflowEvent[]
      runId: string
      reason: string
      audit?: RoleDContentAuditSummary
    }

export interface GenerateRoleCForRoleDInput {
  profile: LearnerProfile
  ragResult: RagResult
  kbVersion: string
  runId: string
}

export interface RoleCContinuationHttpRequest {
  sessionId: string
  submissionId: string
  learnerId: string
}

const ROLE_C_CONTINUATION_HTTP_KEYS = new Set([
  "sessionId",
  "submissionId",
  "learnerId",
])

export function isRoleCContinuationHttpRequest(
  value: unknown,
): value is RoleCContinuationHttpRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(
    (key) => !ROLE_C_CONTINUATION_HTTP_KEYS.has(key),
  )) return false
  return isNonEmptyIdentity(record.sessionId)
    && isNonEmptyIdentity(record.submissionId)
    && isNonEmptyIdentity(record.learnerId)
}

function isNonEmptyIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}
