import type {
  AssessmentPublicArtifact,
  CodeLabPublicArtifact,
  ConceptLessonArtifact,
  GradeResultArtifact,
  SessionState,
  SubmissionEnvelope,
} from "./artifacts"
import type { EvidenceGapRequest, FactAuditPacket, RagEvidencePack } from "./evidence-pack"
import type { AgentTraceEvent, LearningEvidenceEvent, ProfileDriftSuggestion } from "./learning-evidence-event"
import type { LearnerProfileSnapshot, LearningPathNode } from "./profile-adapter"

/** Artifacts that D may render or return to a learner-facing client. */
export type PublicArtifact =
  | ConceptLessonArtifact
  | CodeLabPublicArtifact
  | AssessmentPublicArtifact
  | GradeResultArtifact

export type GradeReportPublic = GradeResultArtifact

/** Complete inbound message inventory for Role C's current framework boundary. */
export interface RoleCInboundMessages {
  from_a: RagEvidencePack
  from_b: LearnerProfileSnapshot | LearningPathNode
  from_d: SessionState | SubmissionEnvelope
}

/** Complete outbound message inventory. Secure artifacts are deliberately not part of this public API. */
export interface RoleCOutboundMessages {
  to_a: EvidenceGapRequest | FactAuditPacket
  to_b: LearningEvidenceEvent | ProfileDriftSuggestion
  to_d: PublicArtifact | AgentTraceEvent | GradeReportPublic
}
