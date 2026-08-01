import type { RagResult } from "../rag/retriever"
import type { LearnerProfile } from "../role-b-profile/types"
import type {
  AssessmentAnchorRoutingOutcome,
  ContinueCompletedLearningCycleResult,
  LearnerProfileSnapshot,
  LearningPathNode,
  ProfileDriftSuggestion,
  PublicRagEvidencePack,
  RoleCLearningSessionDelivery,
  RoleCReviewedReleaseDelivery,
  RoleCReviewRecoveryStatusDelivery,
  SubmissionEnvelope,
} from "../role-c-content"

export const ROLE_C_API_PATHS = {
  generate: "/api/role-c/generate",
  submit: "/api/role-c/submit",
  continue: "/api/role-c/continue",
  routeAnchors: "/api/role-c/route-anchors",
} as const

export type RoleCApiPath = typeof ROLE_C_API_PATHS[keyof typeof ROLE_C_API_PATHS]

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

export interface RoleDReviewRecoverySummary {
  code: "READY" | "BLOCKED" | "UNSUPPORTED_TARGET"
  failedDimensions: string[]
  missingPrerequisiteSourceIds: string[]
  unknownPrerequisiteRefs: string[]
  requiredAction: "adjust_content" | "request_new_evidence" | "replan_path" | "reprofile_learner" | "none"
  fixScope: "artifact" | "new_evidence" | "new_spec" | "none"
  recommendedLevel?: LearnerProfile["level"]
  canRecover: boolean
  attempts: number
  message: string
}

export interface RoleDFinalContentContext {
  /** Final answer-free profile selected by the recoverable C pipeline. */
  profileSnapshot: LearnerProfileSnapshot
  profileVersion: string
  pathNode: LearningPathNode
  evidencePack: PublicRagEvidencePack
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
      recovery?: RoleDReviewRecoverySummary
      finalContext: RoleDFinalContentContext
    }
  | {
      status: "blocked" | "failed"
      artifacts: RoleDGeneratedArtifact[]
      workflow: RoleDWorkflowEvent[]
      runId: string
      reason: string
      audit?: RoleDContentAuditSummary
      recovery?: RoleDReviewRecoverySummary
    }

export interface GenerateRoleCForRoleDInput {
  profile: LearnerProfile
  ragResult: RagResult
  kbVersion: string
  runId: string
  /** Formal B path consumed verbatim by C. */
  pathNode: LearningPathNode
}

export interface SubmitRoleCAssessmentInput {
  sessionId: string
  runId: string
  learnerId: string
  formId: string
  attemptNo: number
  submissionId: string
  answers: SubmissionEnvelope["answers"]
}

/**
 * D sends only stable identities plus optional B-owned next context. C reloads
 * the completed submission and current profile/evidence from its private store.
 * Evidence for a new B path is refreshed through A on the server.
 */
export interface ContinueRoleCAfterSubmissionInput {
  sessionId: string
  submissionId: string
  learnerId: string
  nextPathNode?: LearningPathNode
  nextProfileSnapshot?: LearnerProfileSnapshot
  nextGenerationAction?: "remediate" | "reinforce" | "advance"
}

export type ContinueRoleCForRoleDResult =
  | {
      status: "published"
      continuation: Extract<
        ContinueCompletedLearningCycleResult,
        { status: "published" }
      >
      reviewedRelease: RoleCReviewedReleaseDelivery
      learningSession: RoleCLearningSessionDelivery
      finalContext: RoleDFinalContentContext
    }
  | {
      status: "awaiting_input"
      action: "advance" | "reprofile"
      requestId: string
      requiredInputs: Array<
        "nextPathNode" | "nextProfileSnapshot" | "nextGenerationAction"
      >
      profileDriftSuggestion?: ProfileDriftSuggestion
    }
  | {
      status: "blocked" | "failed"
      stage: "configuration" | "preparation" | "generation_review"
      reason: string
      continuation?: Extract<
        ContinueCompletedLearningCycleResult,
        { status: "blocked" | "failed" }
      >
      recoveryStatus?: RoleCReviewRecoveryStatusDelivery
    }

export interface RouteRoleCAssessmentAnchorsInput {
  routingRequestId: string
  sessionId: string
  runId: string
  learnerId: string
  formId: string
  attemptNo: number
  submissionId: string
  answers: SubmissionEnvelope["answers"]
}

export type RouteRoleCAssessmentAnchorsResult = AssessmentAnchorRoutingOutcome
