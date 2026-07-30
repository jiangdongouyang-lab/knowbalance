import {
  continueCompletedLearningCycle,
  deliverReviewRecoveryStatusToD,
  deliverRoleCToD,
  roleCToDDeliveryIdentityHash,
  runRecoverableReviewedCPipeline,
  toReviewRecoveryPublicResult,
  validateLearningSessionHandoff,
  validatePublicArtifactNoSecrets,
  validateRoleCSchema,
  type ContinueCompletedLearningCycleDependencies,
  type ContinueCompletedLearningCycleResult,
  type CPipelineInput,
  type PrepareNextRoundFromCompletedSubmissionInput,
  type ReviewRecoveryPublicResult,
  type RoleCAgents,
  type RoleCDeliveryAck,
  type RoleCLearningSessionDelivery,
  type RoleCReviewRecoveryStatusDelivery,
  type RoleCReviewedReleaseDelivery,
  type RoleDAdaptiveLearningLoopPort,
  type RunRecoverableReviewedPipelineOptions,
  type SecureArtifactStore,
} from "../role-c-content"

type RoleDReceivedDelivery =
  | RoleCReviewedReleaseDelivery
  | RoleCReviewRecoveryStatusDelivery
  | RoleCLearningSessionDelivery

export interface RoleDRoleCDeliverySnapshot {
  reviewed_releases: RoleCReviewedReleaseDelivery[]
  review_recovery_statuses: RoleCReviewRecoveryStatusDelivery[]
  learning_sessions: RoleCLearningSessionDelivery[]
}

/**
 * Process-local Role D receiver for C's three independent public deliveries.
 *
 * The delivery ID is the idempotency key. Payloads are validated again on the
 * receiver side before the first commit and before a duplicate is acknowledged.
 */
export class RoleDRoleCDeliveryReceiver
implements RoleDAdaptiveLearningLoopPort {
  readonly namespace_id: string

  private readonly committedKinds = new Map<
    string,
    RoleDReceivedDelivery["delivery_kind"]
  >()
  private readonly committedPayloadIdentities = new Map<string, string>()
  private readonly terminalKindByRun = new Map<
    string,
    "reviewed_release" | "review_recovery_status"
  >()
  private readonly reviewedReleases = new Map<
    string,
    RoleCReviewedReleaseDelivery
  >()
  private readonly reviewedReleaseIdByRun = new Map<string, string>()
  private readonly recoveryStatuses = new Map<
    string,
    RoleCReviewRecoveryStatusDelivery
  >()
  private readonly recoveryStatusIdByRun = new Map<string, string>()
  private readonly learningSessions = new Map<
    string,
    RoleCLearningSessionDelivery
  >()
  private readonly latestLearningSessionIdBySession = new Map<string, string>()

  constructor(namespaceId = "role-d-role-c-receiver-v1") {
    if (!namespaceId.trim()) {
      throw new Error("ROLE_D_C_RECEIVER_NAMESPACE_EMPTY")
    }
    this.namespace_id = namespaceId
  }

  async publishReviewedRelease(
    delivery: RoleCReviewedReleaseDelivery,
  ): Promise<RoleCDeliveryAck> {
    assertSafeDelivery(
      "reviewed_release_delivery.schema.json",
      delivery,
    )
    const duplicate = this.duplicateAck(delivery)
    if (duplicate) return duplicate

    this.assertRunTerminalKind(delivery.run_id, "reviewed_release")
    const existingId = this.reviewedReleaseIdByRun.get(delivery.run_id)
    if (existingId && existingId !== delivery.delivery_id) {
      throw new Error("ROLE_D_C_REVIEWED_RELEASE_RUN_CONFLICT")
    }
    const frozen = structuredClone(delivery)
    this.reviewedReleases.set(delivery.delivery_id, frozen)
    this.reviewedReleaseIdByRun.set(delivery.run_id, delivery.delivery_id)
    this.terminalKindByRun.set(delivery.run_id, "reviewed_release")
    return this.commitAck(delivery)
  }

  async publishReviewRecoveryStatus(
    delivery: RoleCReviewRecoveryStatusDelivery,
  ): Promise<RoleCDeliveryAck> {
    assertSafeDelivery(
      "review_recovery_status_delivery.schema.json",
      delivery,
    )
    const duplicate = this.duplicateAck(delivery)
    if (duplicate) return duplicate

    this.assertRunTerminalKind(
      delivery.result.run_id,
      "review_recovery_status",
    )
    const existingId = this.recoveryStatusIdByRun.get(delivery.result.run_id)
    if (existingId && existingId !== delivery.delivery_id) {
      throw new Error("ROLE_D_C_RECOVERY_STATUS_RUN_CONFLICT")
    }
    const frozen = structuredClone(delivery)
    this.recoveryStatuses.set(delivery.delivery_id, frozen)
    this.recoveryStatusIdByRun.set(
      delivery.result.run_id,
      delivery.delivery_id,
    )
    this.terminalKindByRun.set(
      delivery.result.run_id,
      "review_recovery_status",
    )
    return this.commitAck(delivery)
  }

  async publishLearningSession(
    delivery: RoleCLearningSessionDelivery,
  ): Promise<RoleCDeliveryAck> {
    assertSafeDelivery("learning_session_delivery.schema.json", delivery)
    const duplicate = this.duplicateAck(delivery)
    if (duplicate) return duplicate

    const incomingSession = delivery.session
    const session = incomingSession
    const terminalKind = this.terminalKindByRun.get(session.run_id)
    if (terminalKind === "review_recovery_status") {
      throw new Error("ROLE_D_C_LEARNING_SESSION_AFTER_RECOVERY")
    }
    if (terminalKind !== "reviewed_release") {
      throw new Error("ROLE_D_C_REVIEWED_RELEASE_REQUIRED")
    }
    const reviewedReleaseId = this.reviewedReleaseIdByRun.get(
      session.run_id,
    )
    const reviewedRelease = reviewedReleaseId
      ? this.reviewedReleases.get(reviewedReleaseId)
      : undefined
    if (!reviewedRelease) {
      throw new Error("ROLE_D_C_REVIEWED_RELEASE_REQUIRED")
    }
    const assessment = reviewedRelease?.artifacts.find(
      (artifact) => artifact.artifact_type === "assessment_public",
    )
    if (!assessment?.payload
      || assessment.payload.form_id !== session.form_id) {
      throw new Error("ROLE_D_C_LEARNING_SESSION_FORM_CONFLICT")
    }
    const normalizedSession = validateLearningSessionHandoff(
      session,
      {
        run_id: reviewedRelease.run_id,
        artifacts: reviewedRelease.artifacts,
      },
    )
    const normalizedDelivery: RoleCLearningSessionDelivery = {
      ...structuredClone(delivery),
      session: normalizedSession,
    }
    if (
      roleCToDDeliveryIdentityHash(normalizedDelivery)
        !== delivery.delivery_id
    ) {
      throw new Error("ROLE_D_C_LEARNING_SESSION_NON_CANONICAL")
    }
    const existingId = this.latestLearningSessionIdBySession.get(
      session.session_id,
    )
    const existing = existingId
      ? this.learningSessions.get(existingId)
      : undefined
    if (!existing && session.phase !== "anchor_pending") {
      throw new Error("ROLE_D_C_LEARNING_SESSION_OUT_OF_ORDER")
    }
    if (existing) assertSessionTransition(existing, normalizedDelivery)

    const frozen = structuredClone(normalizedDelivery)
    this.learningSessions.set(delivery.delivery_id, frozen)
    this.latestLearningSessionIdBySession.set(
      session.session_id,
      delivery.delivery_id,
    )
    return this.commitAck(delivery)
  }

  getReviewedRelease(
    runId: string,
  ): RoleCReviewedReleaseDelivery | undefined {
    const deliveryId = this.reviewedReleaseIdByRun.get(runId)
    const delivery = deliveryId
      ? this.reviewedReleases.get(deliveryId)
      : undefined
    return delivery ? structuredClone(delivery) : undefined
  }

  getReviewRecoveryStatus(
    runId: string,
  ): RoleCReviewRecoveryStatusDelivery | undefined {
    const deliveryId = this.recoveryStatusIdByRun.get(runId)
    const delivery = deliveryId
      ? this.recoveryStatuses.get(deliveryId)
      : undefined
    return delivery ? structuredClone(delivery) : undefined
  }

  getLearningSession(
    sessionId: string,
  ): RoleCLearningSessionDelivery | undefined {
    const deliveryId = this.latestLearningSessionIdBySession.get(sessionId)
    const delivery = deliveryId
      ? this.learningSessions.get(deliveryId)
      : undefined
    return delivery ? structuredClone(delivery) : undefined
  }

  snapshot(): RoleDRoleCDeliverySnapshot {
    return {
      reviewed_releases: [...this.reviewedReleases.values()].map(
        (delivery) => structuredClone(delivery),
      ),
      review_recovery_statuses: [...this.recoveryStatuses.values()].map(
        (delivery) => structuredClone(delivery),
      ),
      learning_sessions: [...this.learningSessions.values()].map(
        (delivery) => structuredClone(delivery),
      ),
    }
  }

  private duplicateAck(
    delivery: RoleDReceivedDelivery,
  ): RoleCDeliveryAck | undefined {
    const existingKind = this.committedKinds.get(delivery.delivery_id)
    if (!existingKind) return undefined
    if (existingKind !== delivery.delivery_kind) {
      throw new Error("ROLE_D_C_DELIVERY_ID_KIND_CONFLICT")
    }
    const payloadIdentity = roleCToDDeliveryIdentityHash(delivery)
    if (this.committedPayloadIdentities.get(delivery.delivery_id)
      !== payloadIdentity) {
      throw new Error("ROLE_D_C_DELIVERY_ID_PAYLOAD_CONFLICT")
    }
    return deliveryAck(delivery, "duplicate")
  }

  private commitAck(delivery: RoleDReceivedDelivery): RoleCDeliveryAck {
    this.committedKinds.set(delivery.delivery_id, delivery.delivery_kind)
    this.committedPayloadIdentities.set(
      delivery.delivery_id,
      roleCToDDeliveryIdentityHash(delivery),
    )
    return deliveryAck(delivery, "accepted")
  }

  private assertRunTerminalKind(
    runId: string,
    nextKind: "reviewed_release" | "review_recovery_status",
  ): void {
    const existingKind = this.terminalKindByRun.get(runId)
    if (existingKind && existingKind !== nextKind) {
      throw new Error("ROLE_D_C_RUN_TERMINAL_CONFLICT")
    }
  }
}

export const defaultRoleDRoleCDeliveryReceiver =
  new RoleDRoleCDeliveryReceiver()

export interface RunRecoverableRoleCForRoleDResult {
  result: ReviewRecoveryPublicResult
  delivery_to_d: RoleCDeliveryAck
}

/** Trusted backend composition for C's recoverable review entry. */
export async function runRecoverableRoleCForRoleD(
  pipelineInput: CPipelineInput,
  agents: RoleCAgents,
  secureStore: SecureArtifactStore,
  options: RunRecoverableReviewedPipelineOptions,
  receiver: RoleDRoleCDeliveryReceiver =
    defaultRoleDRoleCDeliveryReceiver,
): Promise<RunRecoverableRoleCForRoleDResult> {
  const pipeline = await runRecoverableReviewedCPipeline(
    pipelineInput,
    agents,
    secureStore,
    options,
  )
  const publicResult = toReviewRecoveryPublicResult(pipeline)
  const delivery = pipeline.status === "ready" && pipeline.state === "READY"
    ? await deliverRoleCToD(receiver, pipeline)
    : await deliverReviewRecoveryStatusToD(
        receiver,
        publicResult,
      )
  return {
    result: publicResult,
    delivery_to_d: delivery,
  }
}

export type ContinueRoleCForRoleDDependencies = Omit<
  ContinueCompletedLearningCycleDependencies,
  "role_d_port" | "delivery_target_namespace"
> & {
  role_d_receiver?: RoleDRoleCDeliveryReceiver
  delivery_target_namespace?: string
}

/** Trusted backend composition for C's completed-cycle adaptive entry. */
export async function continueRoleCAdaptiveLearningCycleForRoleD(
  input: PrepareNextRoundFromCompletedSubmissionInput,
  dependencies: ContinueRoleCForRoleDDependencies,
): Promise<ContinueCompletedLearningCycleResult> {
  const {
    role_d_receiver: receiver =
      defaultRoleDRoleCDeliveryReceiver,
    delivery_target_namespace: targetNamespace =
      receiver.namespace_id,
    ...roleCDependencies
  } = dependencies
  return continueCompletedLearningCycle(input, {
    ...roleCDependencies,
    role_d_port: receiver,
    delivery_target_namespace: targetNamespace,
  })
}

function assertSafeDelivery(
  schema:
    | "reviewed_release_delivery.schema.json"
    | "review_recovery_status_delivery.schema.json"
    | "learning_session_delivery.schema.json",
  delivery: RoleDReceivedDelivery,
): void {
  const report = validateRoleCSchema(schema, delivery)
  if (!report.ok) {
    throw new Error(
      `ROLE_D_C_DELIVERY_SCHEMA_INVALID:${report.issues
        .map((issue) => issue.path)
        .join(",")}`,
    )
  }
  const leak = validatePublicArtifactNoSecrets(delivery)
  if (!leak.ok) {
    throw new Error(
      `ROLE_D_C_DELIVERY_SECRET_REJECTED:${leak.issues
        .map((issue) => issue.path)
        .join(",")}`,
    )
  }
  if (roleCToDDeliveryIdentityHash(delivery) !== delivery.delivery_id) {
    throw new Error("ROLE_D_C_DELIVERY_IDENTITY_MISMATCH")
  }
}

function assertSessionTransition(
  previous: RoleCLearningSessionDelivery,
  next: RoleCLearningSessionDelivery,
): void {
  const before = previous.session
  const after = next.session
  if (before.routing_request_id !== after.routing_request_id
    || before.run_id !== after.run_id
    || before.form_id !== after.form_id
    || before.attempt_no !== after.attempt_no) {
    throw new Error("ROLE_D_C_LEARNING_SESSION_IDENTITY_CONFLICT")
  }
  if (before.phase === "route_locked") {
    throw new Error("ROLE_D_C_LEARNING_SESSION_ROUTE_CONFLICT")
  }
  if (after.phase !== "route_locked") {
    throw new Error("ROLE_D_C_LEARNING_SESSION_PHASE_CONFLICT")
  }
}

function deliveryAck(
  delivery: RoleDReceivedDelivery,
  status: RoleCDeliveryAck["status"],
): RoleCDeliveryAck {
  return {
    schema_version: "1.0",
    delivery_kind: delivery.delivery_kind,
    delivery_id: delivery.delivery_id,
    status,
  }
}
