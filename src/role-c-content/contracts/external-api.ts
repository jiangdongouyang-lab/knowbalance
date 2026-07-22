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
import type { EvidenceRefreshPort, FactAuditPort } from "./evidence-pack"
import { validatePublicArtifactNoSecrets } from "../validators/public-secure-leak-validator"
import { validateRoleCSchema, type RoleCSchemaFile } from "../validators/runtime-schema-validator"

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

/** Transport-neutral integration ports; HTTP/OpenCode/MCP adapters can implement these contracts. */
export interface RoleAContentEvidencePort extends EvidenceRefreshPort, FactAuditPort {}

export interface RoleBLearningProgressPort {
  consumeLearningEvidence(events: LearningEvidenceEvent[]): Promise<void>
  consumeProfileDriftSuggestion(suggestion: ProfileDriftSuggestion): Promise<void>
}

export interface RoleDPublicDeliveryPort {
  publishArtifacts(runId: string, artifacts: PublicArtifact[]): Promise<void>
  publishTrace(events: AgentTraceEvent[]): Promise<void>
}

export async function deliverRoleCToB(
  port: RoleBLearningProgressPort,
  events: LearningEvidenceEvent[],
  drift?: ProfileDriftSuggestion,
): Promise<void> {
  for (const event of events) assertOutboundSchema("learning_evidence_event.schema.json", event)
  if (drift) assertOutboundSchema("profile_drift_suggestion.schema.json", drift)
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new Error("ROLE_C_B_DELIVERY_DUPLICATE_EVENT")
  }
  const learnerProfiles = new Set(events.map((event) => `${event.learner_id_hash}\u0000${event.profile_version}`))
  if (learnerProfiles.size > 1) throw new Error("ROLE_C_B_DELIVERY_MIXED_PROFILE_BATCH")
  if (drift && events.some((event) =>
    event.learner_id_hash !== drift.learner_id_hash || event.profile_version !== drift.profile_version)) {
    throw new Error("ROLE_C_B_DELIVERY_DRIFT_PROFILE_MISMATCH")
  }
  if (events.length > 0) await port.consumeLearningEvidence(structuredClone(events))
  if (drift) await port.consumeProfileDriftSuggestion(structuredClone(drift))
}

export async function deliverRoleCToD(
  port: RoleDPublicDeliveryPort,
  runId: string,
  artifacts: PublicArtifact[],
  trace: AgentTraceEvent[],
): Promise<void> {
  if (!runId.trim()) throw new Error("ROLE_C_D_DELIVERY_RUN_EMPTY")
  if (new Set(artifacts.map((artifact) => artifact.artifact_id)).size !== artifacts.length) {
    throw new Error("ROLE_C_D_DELIVERY_DUPLICATE_ARTIFACT")
  }
  for (const artifact of artifacts) {
    if (artifact.run_id !== runId) throw new Error("ROLE_C_D_DELIVERY_RUN_MISMATCH")
    const schema = publicArtifactSchema(artifact.artifact_type)
    assertOutboundSchema(schema, artifact)
    const leak = validatePublicArtifactNoSecrets(artifact)
    if (!leak.ok) throw new Error(`ROLE_C_D_DELIVERY_SECRET_LEAK:${leak.issues.map((issue) => issue.path).join(",")}`)
  }
  let lastSeq = 0
  for (const event of trace) {
    if (event.run_id !== runId) throw new Error("ROLE_C_D_TRACE_RUN_MISMATCH")
    if (event.seq <= lastSeq) throw new Error("ROLE_C_D_TRACE_NOT_STRICTLY_ORDERED")
    lastSeq = event.seq
    assertOutboundSchema("agent_trace_event.schema.json", event)
  }
  await port.publishArtifacts(runId, structuredClone(artifacts))
  await port.publishTrace(structuredClone(trace))
}

function publicArtifactSchema(artifactType: PublicArtifact["artifact_type"]): RoleCSchemaFile {
  if (artifactType === "concept_lesson") return "concept_artifact.schema.json"
  if (artifactType === "code_lab_public") return "code_lab_public.schema.json"
  if (artifactType === "assessment_public") return "assessment_public.schema.json"
  if (artifactType === "grade_result") return "grade_result.schema.json"
  throw new Error(`ROLE_C_D_DELIVERY_PRIVATE_ARTIFACT:${String(artifactType)}`)
}

function assertOutboundSchema(schema: RoleCSchemaFile, value: unknown): void {
  const report = validateRoleCSchema(schema, value)
  if (!report.ok) throw new Error(`ROLE_C_OUTBOUND_SCHEMA_INVALID:${schema}:${report.issues.map((issue) => issue.path).join(",")}`)
}
