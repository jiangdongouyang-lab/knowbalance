import type {
  AssessmentPublicArtifact,
  CodeLabPublicArtifact,
  ConceptLessonArtifact,
  GradeResultArtifact,
  SubmissionEnvelope,
} from "./artifacts"
import type {
  EvidenceGapRequest,
  EvidenceRefreshPort,
  FactAuditPacket,
  FactAuditPort,
  RagEvidencePack,
} from "./evidence-pack"
import type { AgentTraceEvent, LearningEvidenceEvent, ProfileDriftSuggestion } from "./learning-evidence-event"
import type { LearnerProfileSnapshot, LearningPathNode } from "./profile-adapter"
import type { DynamicFeedbackResult } from "./dynamic-feedback"
import type { ReviewedCPipelineResult } from "../review/types"
import { C_SCHEMA_VERSION, contentHash, type SchemaVersion } from "./common"
import { assertReviewedReadyPipeline } from "../review/validate-reviewed-release"
import { validatePublicArtifactNoSecrets } from "../validators/public-secure-leak-validator"
import { validateRoleCSchema, type RoleCSchemaFile } from "../validators/runtime-schema-validator"

/** Artifacts that D may render or return to a learner-facing client. */
export type PublicArtifact =
  | ConceptLessonArtifact
  | CodeLabPublicArtifact
  | AssessmentPublicArtifact
  | GradeResultArtifact

/** Complete inbound message inventory for Role C's current framework boundary. */
export interface RoleCInboundMessages {
  from_a: RagEvidencePack
  from_b: LearnerProfileSnapshot | LearningPathNode
  from_d: SubmissionEnvelope
}

/** Complete outbound message inventory. Secure artifacts are deliberately not part of this public API. */
export interface RoleCOutboundMessages {
  to_a: EvidenceGapRequest | FactAuditPacket
  to_b: RoleCLearningProgressDelivery
  to_d: RoleCReviewedReleaseDelivery | RoleCDynamicFeedbackDelivery
}

/** Transport-neutral integration ports; HTTP/OpenCode/MCP adapters can implement these contracts. */
export interface RoleAContentEvidencePort extends EvidenceRefreshPort, FactAuditPort {}

export interface RoleBLearningProgressPort {
  /**
   * Commits one same-learner progress batch. The receiver uses `delivery_id` as
   * its idempotency key and returns `duplicate` after an earlier commit.
   */
  publishLearningProgress(
    delivery: RoleCLearningProgressDelivery,
  ): Promise<RoleCDeliveryAck>
}

export type RoleCDeliveryKind =
  | "learning_progress"
  | "reviewed_release"
  | "dynamic_feedback"
export type RoleCDeliveryStatus = "accepted" | "duplicate"

/**
 * The recipient acknowledges the exact delivery ID it accepted and returns
 * `duplicate` when the same delivery was committed previously.
 */
export interface RoleCDeliveryAck {
  schema_version: SchemaVersion
  delivery_kind: RoleCDeliveryKind
  delivery_id: string
  status: RoleCDeliveryStatus
}

export interface RoleCReviewedReleaseDelivery {
  schema_version: SchemaVersion
  delivery_kind: "reviewed_release"
  delivery_id: string
  run_id: string
  pipeline_input_hash: string
  generation_spec_hash: string
  review_policy_version: string
  final_review_hash: string
  artifacts: [
    ConceptLessonArtifact,
    CodeLabPublicArtifact,
    AssessmentPublicArtifact,
  ]
  trace_events: [AgentTraceEvent, ...AgentTraceEvent[]]
}

export interface RoleCDynamicFeedbackDelivery {
  schema_version: SchemaVersion
  delivery_kind: "dynamic_feedback"
  delivery_id: string
  feedback: DynamicFeedbackResult
}

interface RoleCLearningProgressDeliveryBase {
  schema_version: SchemaVersion
  delivery_kind: "learning_progress"
  delivery_id: string
  learner_id_hash: string
  profile_version: string
}

export type RoleCLearningProgressDelivery =
  | RoleCLearningProgressDeliveryBase & {
    evidence_events: [LearningEvidenceEvent, ...LearningEvidenceEvent[]]
    profile_drift_suggestion?: ProfileDriftSuggestion
  }
  | RoleCLearningProgressDeliveryBase & {
    evidence_events: []
    profile_drift_suggestion: ProfileDriftSuggestion
  }

export interface RoleDPublicDeliveryPort {
  /**
   * Commits the reviewed artifacts and their trace as one idempotent receiver unit.
   * The receiver uses `delivery_id` as its idempotency key.
   */
  publishReviewedRelease(
    release: RoleCReviewedReleaseDelivery,
  ): Promise<RoleCDeliveryAck>
}

export interface RoleDDynamicFeedbackPort {
  /**
   * Commits one feedback result. Repeating the same envelope returns `duplicate`.
   */
  publishDynamicFeedback(
    delivery: RoleCDynamicFeedbackDelivery,
  ): Promise<RoleCDeliveryAck>
}

export async function deliverRoleCToB(
  port: RoleBLearningProgressPort,
  events: LearningEvidenceEvent[],
  drift?: ProfileDriftSuggestion,
): Promise<RoleCDeliveryAck> {
  if (events.length === 0 && drift === undefined) {
    throw new Error("ROLE_C_B_DELIVERY_EMPTY")
  }
  for (const event of events) {
    assertOutboundSchema("learning_evidence_event.schema.json", event)
    assertNoOutboundSecrets("ROLE_C_B_DELIVERY_SECRET_LEAK", event)
  }
  if (drift) {
    assertOutboundSchema("profile_drift_suggestion.schema.json", drift)
    assertNoOutboundSecrets("ROLE_C_B_DELIVERY_SECRET_LEAK", drift)
  }
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new Error("ROLE_C_B_DELIVERY_DUPLICATE_EVENT")
  }
  const learnerProfiles = new Set(events.map((event) => `${event.learner_id_hash}\u0000${event.profile_version}`))
  if (learnerProfiles.size > 1) throw new Error("ROLE_C_B_DELIVERY_MIXED_PROFILE_BATCH")
  if (drift && events.some((event) =>
    event.learner_id_hash !== drift.learner_id_hash || event.profile_version !== drift.profile_version)) {
    throw new Error("ROLE_C_B_DELIVERY_DRIFT_PROFILE_MISMATCH")
  }
  const identitySource = events[0] ?? drift!
  const base = {
    schema_version: C_SCHEMA_VERSION,
    delivery_kind: "learning_progress" as const,
    learner_id_hash: identitySource.learner_id_hash,
    profile_version: identitySource.profile_version,
  }
  const sortedEvents = structuredClone(events).sort(
    (left, right) => left.event_id < right.event_id
      ? -1
      : left.event_id > right.event_id
        ? 1
        : 0,
  )
  const body = sortedEvents.length > 0
    ? {
      ...base,
      evidence_events: sortedEvents as [LearningEvidenceEvent, ...LearningEvidenceEvent[]],
      ...(drift ? { profile_drift_suggestion: structuredClone(drift) } : {}),
    }
    : {
      ...base,
      evidence_events: [] as [],
      profile_drift_suggestion: structuredClone(drift!),
    }
  const delivery: RoleCLearningProgressDelivery = {
    ...body,
    delivery_id: contentHash(body),
  }
  assertOutboundSchema("learning_progress_delivery.schema.json", delivery)
  assertNoOutboundSecrets("ROLE_C_B_DELIVERY_SECRET_LEAK", delivery)
  const ack = await port.publishLearningProgress(structuredClone(delivery))
  return assertDeliveryAck(ack, delivery, "ROLE_C_B")
}

export async function deliverRoleCToD(
  port: RoleDPublicDeliveryPort,
  pipeline: ReviewedCPipelineResult,
): Promise<RoleCDeliveryAck> {
  const release = reviewedRelease(pipeline)
  return publishReviewedReleaseToD(port, pipeline, release)
}

function reviewedRelease(pipeline: ReviewedCPipelineResult): {
  run_id: string
  artifacts: [ConceptLessonArtifact, CodeLabPublicArtifact, AssessmentPublicArtifact]
} {
  return assertReviewedReadyPipeline(pipeline, {
    error_prefix: "ROLE_C_D_DELIVERY",
  })
}

/**
 * Low-level transport primitive. It is deliberately private so public callers cannot
 * publish an arbitrary artifact array without passing the reviewed release gate.
 */
async function publishReviewedReleaseToD(
  port: RoleDPublicDeliveryPort,
  pipeline: ReviewedCPipelineResult,
  reviewed: {
    run_id: string
    artifacts: [ConceptLessonArtifact, CodeLabPublicArtifact, AssessmentPublicArtifact]
  },
): Promise<RoleCDeliveryAck> {
  const runId = reviewed.run_id
  const artifacts = reviewed.artifacts
  const trace = pipeline.trace_events
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
    const leak = validatePublicArtifactNoSecrets(event)
    if (!leak.ok) throw new Error("ROLE_C_D_TRACE_SECRET_LEAK")
  }
  const finalReview = pipeline.review_reports.at(-1)
  if (!finalReview) throw new Error("ROLE_C_D_DELIVERY_REVIEW_MISSING")
  const traceEvents = structuredClone(trace) as [AgentTraceEvent, ...AgentTraceEvent[]]
  const body = {
    schema_version: C_SCHEMA_VERSION,
    delivery_kind: "reviewed_release" as const,
    run_id: runId,
    pipeline_input_hash: pipeline.pipeline_input_hash,
    generation_spec_hash: pipeline.generation_spec_hash,
    review_policy_version: pipeline.review_policy_version,
    final_review_hash: contentHash(finalReview),
    artifacts: structuredClone(artifacts),
    trace_events: traceEvents,
  }
  const delivery: RoleCReviewedReleaseDelivery = {
    ...body,
    delivery_id: contentHash(reviewedReleaseDeliveryIdentity(body)),
  }
  assertOutboundSchema("reviewed_release_delivery.schema.json", delivery)
  const ack = await port.publishReviewedRelease(structuredClone(delivery))
  return assertDeliveryAck(ack, delivery, "ROLE_C_D")
}

function reviewedReleaseDeliveryIdentity(
  release: Omit<RoleCReviewedReleaseDelivery, "delivery_id">,
): unknown {
  const semanticTrace = release.trace_events.map((event) =>
    Object.fromEntries(Object.entries(event).filter(([key]) =>
      !["seq", "occurred_at", "duration_ms"].includes(key))))
  return {
    schema_version: release.schema_version,
    delivery_kind: release.delivery_kind,
    run_id: release.run_id,
    pipeline_input_hash: release.pipeline_input_hash,
    generation_spec_hash: release.generation_spec_hash,
    review_policy_version: release.review_policy_version,
    final_review_hash: release.final_review_hash,
    artifact_hashes: release.artifacts.map((artifact) => contentHash(artifact)),
    trace_semantic_hash: contentHash(semanticTrace),
  }
}

export async function deliverDynamicFeedbackToD(
  port: RoleDDynamicFeedbackPort,
  feedback: DynamicFeedbackResult,
): Promise<RoleCDeliveryAck> {
  assertOutboundSchema("dynamic_feedback_result.schema.json", feedback)
  const leak = validatePublicArtifactNoSecrets(feedback)
  if (!leak.ok) {
    throw new Error(`ROLE_C_D_FEEDBACK_SECRET_LEAK:${leak.issues.map((issue) => issue.path).join(",")}`)
  }
  const body = {
    schema_version: C_SCHEMA_VERSION,
    delivery_kind: "dynamic_feedback" as const,
    feedback: structuredClone(feedback),
  }
  const delivery: RoleCDynamicFeedbackDelivery = {
    ...body,
    delivery_id: contentHash(body),
  }
  assertOutboundSchema("dynamic_feedback_delivery.schema.json", delivery)
  const ack = await port.publishDynamicFeedback(structuredClone(delivery))
  return assertDeliveryAck(ack, delivery, "ROLE_C_D")
}

function assertDeliveryAck(
  ack: RoleCDeliveryAck,
  delivery: Pick<
    RoleCLearningProgressDelivery | RoleCReviewedReleaseDelivery | RoleCDynamicFeedbackDelivery,
    "delivery_kind" | "delivery_id"
  >,
  errorPrefix: "ROLE_C_B" | "ROLE_C_D",
): RoleCDeliveryAck {
  const report = validateRoleCSchema("delivery_ack.schema.json", ack)
  if (!report.ok) {
    throw new Error(`${errorPrefix}_ACK_SCHEMA_INVALID:${report.issues.map((issue) => issue.path).join(",")}`)
  }
  if (ack.delivery_kind !== delivery.delivery_kind) {
    throw new Error(`${errorPrefix}_ACK_KIND_MISMATCH`)
  }
  if (ack.delivery_id !== delivery.delivery_id) {
    throw new Error(`${errorPrefix}_ACK_ID_MISMATCH`)
  }
  return structuredClone(ack)
}

function assertNoOutboundSecrets(errorCode: string, value: unknown): void {
  const leak = validatePublicArtifactNoSecrets(value)
  if (!leak.ok) {
    throw new Error(`${errorCode}:${leak.issues.map((issue) => issue.path).join(",")}`)
  }
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
