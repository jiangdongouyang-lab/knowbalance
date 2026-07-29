import type { RagResult } from "../rag/retriever"
import type { LearnerProfile } from "../role-b-profile/types"

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
        sessionId: string
        formId: string
        attemptNo: number
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
