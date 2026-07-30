import type {
  GenerateRoleCForRoleDInput,
  RoleDContentAuditSummary,
  RoleCForRoleDResult,
  RoleDAssessmentItem,
  RoleDGeneratedArtifact,
  RoleDPublicCitation,
  RoleDWorkflowEvent,
} from "./contracts"
import {
  defaultRoleDRoleCDeliveryReceiver,
} from "./role-c-delivery-receiver"
import { loadKnowledgeBase } from "../knowledge/loader"
import type { KnowledgeBase, KnowledgeDifficulty } from "../knowledge/types"
import type { RagResultItem } from "../rag/retriever"
import { canonicalizeConcept } from "../role-b-profile/concept-canonicalizer"
import type { LearnerProfile } from "../role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  continueCompletedLearningCycle,
  createLocalABContentReviewPort,
  createRoleCAgents,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  InMemoryLearningCycleStore,
  InMemoryMasteryStateStore,
  InMemorySecureArtifactStore,
  LearningCycleService,
  ModelBackedRoleCContentProvider,
  createRoleCModelGatewayFromEnv,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  deliverLearningSessionToD,
  deliverRoleCToD,
  runReviewedCPipeline,
  stableId,
  TrustedAssessmentVerifier,
  TrustedCodeLabVerifier,
  type AgentTraceEvent,
  type AssessmentBlueprint,
  type AssessmentPublicArtifact,
  type ContentReviewResult,
  type CitationRef,
  type CodeLabPublicArtifact,
  type ConceptLessonArtifact,
  type CodeRunner,
  type ContinueCompletedLearningCycleResult,
  type EvidenceRefreshPort,
  type LearnerProfileSnapshot,
  type LearningCyclePublicOutcome,
  type LearningPathNode,
  type NextRoundAction,
  type NextRoundGenerationVersions,
  type ObservableBehavior,
  type OpenAnchorFirstSessionInput,
  type RagEvidencePack,
  type RegisterReadyRunInput,
  type RoleBLearningProgressPort,
  type RoleBPathPlanningPort,
  type RoleCAgents,
  type RoleCDeliveryAck,
  type RoleDAdaptiveLearningLoopPort,
  type ReviewedCPipelineResult,
  type RunReviewedCPipelineOptions,
  type SecureArtifactStore,
  type SubmissionEnvelope,
} from "../role-c-content"

interface RoleCLearningCycleContext {
  service: LearningCycleService
  reviewed_pipeline: ReviewedCPipelineResult
  role_d_port: RoleDAdaptiveLearningLoopPort
  delivery_target_namespace: string
  agents: RoleCAgents
  secure_store: SecureArtifactStore
  review_options: RunReviewedCPipelineOptions
  profile_snapshot: LearnerProfileSnapshot
}

const roleCLearningCycles = new Map<string, RoleCLearningCycleContext>()

export interface RoleCForRoleDRuntimeOptions {
  providerMode?: "deterministic" | "model"
  env?: Record<string, string | undefined>
  cwd?: string
  /** Required trusted execution boundary; production uses DockerPythonCodeRunner. */
  runner: CodeRunner
  roleDPort?: RoleDAdaptiveLearningLoopPort
  /** Stable receiver identity used by C's adaptive idempotency journal. */
  deliveryTargetNamespace?: string
  learningProgressPort?: RoleBLearningProgressPort
}

export async function generateRoleCForRoleDWithRuntime(
  input: GenerateRoleCForRoleDInput,
  runtime: RoleCForRoleDRuntimeOptions,
): Promise<RoleCForRoleDResult> {
  const knowledgeBase = await loadKnowledgeBase()
  const targets = selectTargets(
    input.ragResult.results,
    knowledgeBase,
    input.profile,
  )
  if (targets.length === 0) {
    return {
      status: "blocked",
      artifacts: [],
      workflow: [],
      runId: input.runId,
      reason: "A 检索结果中没有处于当前画像可学习范围且尚未掌握的目标知识点。",
    }
  }

  const evidencePack = adaptRagResult(input.ragResult, {
    kb_version: input.kbVersion,
    rag_version: "rule-rag-0.1",
  })
  const profileSnapshot = adaptLearnerProfile(input.profile, {
    profile_version: `${input.runId}-profile-v1`,
    provenance_ref: "role-d:new-learning-plan",
  })
  const targetSourceIds = targets.map(sourceIdOf)
  const prerequisiteSourceIds = input.ragResult.results
    .map(sourceIdOf)
    .filter((sourceId) => !targetSourceIds.includes(sourceId))
    .slice(0, 2)
  const pathNode = defineLearningPathNode({
    node_id: `${input.runId}-PATH-${targetSourceIds.join("-")}`,
    target_source_ids: targetSourceIds,
    prerequisite_source_ids: prerequisiteSourceIds,
    goal: input.profile.goal,
    objectives: targets.map((target, index) => ({
      objective_id: `O${index + 1}`,
      source_id: sourceIdOf(target),
      required_fact_ids: [factIdOf(target)],
      observable_behavior: behaviorFor(target, index, targets.length),
      importance: "core" as const,
    })),
    assessment_blueprint: blueprintFor(targets.length),
  })
  const built = buildGenerationSpec({
    run_id: input.runId,
    profile_snapshot: profileSnapshot,
    path_node: pathNode,
    evidence_pack: evidencePack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: runtime.providerMode === "model"
        ? createRoleCModelGatewayFromEnv(runtime.env ?? process.env).model_config_hash
        : "deterministic-role-d-local-reference-v1",
      runner_image_digest: runtime.runner.runner_image_digest,
    },
    seed: 42,
  })
  if (!built.ok) {
    return {
      status: "blocked",
      artifacts: [],
      workflow: [],
      runId: input.runId,
      reason: built.errors.join("；"),
    }
  }

  const runner = runtime.runner
  const provider = runtime.providerMode === "model"
    ? new ModelBackedRoleCContentProvider(createRoleCModelGatewayFromEnv(runtime.env ?? process.env), {
        generation_strategy: "staged",
        max_repair_attempts: 1,
      })
    : new DeterministicCodeLabContentProvider()
  const agents = createRoleCAgents(provider, {
    code_lab: new TrustedCodeLabVerifier(runner),
    assessment: new TrustedAssessmentVerifier(runner),
  })
  const secureStore = new InMemorySecureArtifactStore()
  const pipelineInput = { generation_spec: built.spec, evidence_pack: evidencePack }
  const reviewOptions: RunReviewedCPipelineOptions = {
    review_port: createLocalABContentReviewPort({
      knowledge_base: knowledgeBase,
    }),
    max_external_revisions: 2,
  }
  const pipeline = await runReviewedCPipeline(
    pipelineInput,
    agents,
    secureStore,
    reviewOptions,
  )
  const workflow = pipeline.trace_events.map(toWorkflowEvent)
  const audit = reviewAuditSummary(pipeline.review_reports, toRoleDArtifacts(pipeline.public_artifacts))
  const finalReview = pipeline.review_reports.at(-1)
  if (pipeline.status !== "ready" || finalReview?.decision !== "pass") {
    const reviewReason = finalReview
      ? finalReview.artifact_results.flatMap((result) => result.findings.map((finding) => finding.message)).slice(0, 3).join("；")
      : ""
    return {
      status: pipeline.status === "failed" ? "failed" : "blocked",
      artifacts: [],
      workflow,
      runId: input.runId,
      reason: pipeline.blocked_reason?.message ?? pipeline.failure_reason?.message ?? (reviewReason || "A/B 审核未通过，内容未发布给 D。"),
      ...(audit ? { audit } : {}),
    }
  }
  const artifacts = toRoleDArtifacts(pipeline.public_artifacts)
  const learningSessionId = `C-${input.runId}-SESSION-1`
  const routingRequestId = stableId("ROUTING-D", {
    session_id: learningSessionId,
    run_id: input.runId,
    learner_id_hash: input.profile.learner_id,
  })
  const roleDPort = runtime.roleDPort
    ?? defaultRoleDRoleCDeliveryReceiver
  const deliveryTargetNamespace = roleDDeliveryTargetNamespace(
    roleDPort,
    runtime.deliveryTargetNamespace,
  )
  const cycleService = new LearningCycleService({
    cycle_store: new InMemoryLearningCycleStore(),
    secure_store: secureStore,
    mastery_store: new InMemoryMasteryStateStore(),
    code_runner: runner,
    learning_progress_delivery: runtime.learningProgressPort
      ? {
          mode: "required",
          port: runtime.learningProgressPort,
        }
      : {
          mode: "offline",
          reason: "local_development",
        },
  })
  await cycleService.registerReadyRun({
    pipeline_input: pipelineInput,
    pipeline_result: pipeline,
    profile_snapshot: profileSnapshot,
    learner_id_hash: input.profile.learner_id,
  })
  const assessment = pipeline.public_artifacts.assessment!
  const requiredItemIds = [
    ...assessment.payload!.routing.anchor_item_ids,
  ]
  await cycleService.openAnchorFirstSession({
    routing_request_id: routingRequestId,
    session_id: learningSessionId,
    run_id: input.runId,
    authenticated_learner_id_hash: input.profile.learner_id,
    attempt_no: 1,
    profile_expectations_by_objective: Object.fromEntries(
      built.spec.targets.map((target) => [target.objective_id, "weak" as const]),
    ),
  })
  const reviewedReleaseDelivery = await deliverRoleCToD(
    roleDPort,
    pipeline,
  )
  const learningSessionDelivery = await deliverLearningSessionToD(
    roleDPort,
    pipeline,
    {
      phase: "anchor_pending",
      routing_request_id: routingRequestId,
      session_id: learningSessionId,
      run_id: input.runId,
      form_id: assessment.payload!.form_id,
      attempt_no: 1,
      required_item_ids: requiredItemIds,
    },
  )
  roleCLearningCycles.set(learningSessionId, {
    service: cycleService,
    reviewed_pipeline: pipeline,
    role_d_port: roleDPort,
    delivery_target_namespace: deliveryTargetNamespace,
    agents,
    secure_store: secureStore,
    review_options: reviewOptions,
    profile_snapshot: profileSnapshot,
  })
  return {
    status: "ready",
    artifacts,
    workflow,
    runId: input.runId,
    learningSession: {
      phase: "anchor_pending",
      sessionId: learningSessionId,
      formId: assessment.payload!.form_id,
      attemptNo: 1,
      profileVersion: built.spec.profile_ref.profile_version,
      pathNodeId: built.spec.path_node.node_id,
      targetSourceIds: [...targetSourceIds],
      routingRequestId,
      requiredItemIds,
    },
    deliveryToD: {
      reviewedRelease: reviewedReleaseDelivery,
      learningSession: learningSessionDelivery,
    },
    ...(audit ? { audit } : {}),
  }
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

export interface RouteRoleCAssessmentInput
extends SubmitRoleCAssessmentInput {
  routingRequestId: string
}

export type RouteRoleCAssessmentResult =
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
      deliveryToD: RoleCDeliveryAck
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

export async function routeRoleCAssessment(
  input: RouteRoleCAssessmentInput,
): Promise<RouteRoleCAssessmentResult> {
  const context = roleCLearningCycles.get(input.sessionId)
  if (!context) {
    return {
      status: "blocked",
      routingRequestId: input.routingRequestId,
      issues: ["C 学习会话不存在或服务已重启"],
    }
  }
  const outcome = await context.service.routeAssessmentAnchors({
    routing_request_id: input.routingRequestId,
    session_id: input.sessionId,
    run_id: input.runId,
    authenticated_learner_id_hash: input.learnerId,
    attempt_no: input.attemptNo,
    anchor_submission: {
      schema_version: "1.0",
      submission_id: input.submissionId,
      run_id: input.runId,
      learner_id_hash: input.learnerId,
      form_id: input.formId,
      attempt_no: input.attemptNo,
      answers: input.answers,
    },
    revealed_anchor_hint_levels: Object.fromEntries(
      input.answers.map((answer) => [answer.item_id, 0 as const]),
    ),
  })
  if (outcome.status === "blocked") {
    return {
      status: "blocked",
      routingRequestId: outcome.routing_request_id,
      issues: [...outcome.issues],
    }
  }
  if (outcome.status === "needs_review") {
    return {
      status: "needs_review",
      routingRequestId: outcome.routing_request_id,
      unresolvedItemIds: [...outcome.unresolved_anchor_item_ids],
    }
  }
  const delivery = await deliverLearningSessionToD(
    context.role_d_port,
    context.reviewed_pipeline,
    outcome.learning_session,
  )
  const session = outcome.learning_session
  return {
    status: "routed",
    routingRequestId: outcome.routing_request_id,
    anchorScoreRatio: outcome.anchor_score_ratio,
    routeId: outcome.route_id,
    action: outcome.action,
    requiredItemIds: [...outcome.required_item_ids],
    learningSession: {
      phase: "route_locked",
      routingRequestId: session.routing_request_id,
      sessionId: session.session_id,
      runId: session.run_id,
      formId: session.form_id,
      attemptNo: session.attempt_no,
      routeLockId: session.route_lock_id,
      routeId: session.route_id,
      action: session.action,
      anchorScoreRatio: session.anchor_score_ratio,
      requiredItemIds: [...session.required_item_ids],
    },
    deliveryToD: delivery,
  }
}

export async function submitRoleCAssessment(
  input: SubmitRoleCAssessmentInput,
): Promise<LearningCyclePublicOutcome> {
  const context = roleCLearningCycles.get(input.sessionId)
  if (!context) {
    return {
      status: "blocked",
      submission_id: input.submissionId,
      code: "SESSION_NOT_FOUND",
      message: "C 学习会话不存在或服务已重启，请重新生成学习计划。",
    }
  }
  return context.service.processSubmission({
    session_id: input.sessionId,
    authenticated_learner_id_hash: input.learnerId,
    submission: {
      schema_version: "1.0",
      submission_id: input.submissionId,
      run_id: input.runId,
      learner_id_hash: input.learnerId,
      form_id: input.formId,
      attempt_no: input.attemptNo,
      answers: input.answers,
    },
  })
}

export interface ContinueRoleCAfterSubmissionInput {
  sessionId: string
  submissionId: string
  learnerId: string
  /** Trusted B output for the follow-up; omitted when the profile is unchanged. */
  nextProfileSnapshot?: LearnerProfileSnapshot
  /** Trusted A output for refreshed evidence or an advanced path node. */
  nextEvidencePack?: RagEvidencePack
  /** Trusted B path output; required for an advance decision. */
  nextPathNode?: LearningPathNode
  /** Required only when a reprofile decision has been resolved upstream. */
  nextGenerationAction?: Exclude<NextRoundAction, "reprofile">
  currentGenerationVersions?: NextRoundGenerationVersions
}

export interface ContinueRoleCForRoleDRuntimeOptions {
  evidenceRefreshPort?: EvidenceRefreshPort
  pathPlanningPort?: RoleBPathPlanningPort
  maxRecoveryAttempts?: 0 | 1 | 2
  recoveryPolicyVersion?: string
  recoveryPortVersion?: string
}

type PublishedRoleCContinuationForD =
  Extract<ContinueCompletedLearningCycleResult, { status: "published" }>
  & {
    /** D-ready view of the independently delivered next-round artifacts. */
    role_d_handoff: Extract<RoleCForRoleDResult, { status: "ready" }>
  }

export type ContinueRoleCAfterSubmissionResult =
  | Exclude<
      ContinueCompletedLearningCycleResult,
      { status: "published" }
    >
  | PublishedRoleCContinuationForD
  | {
      status: "blocked"
      stage: "context"
      code: "SESSION_NOT_FOUND"
      issues: string[]
    }

/**
 * Trusted D-backend facade for the adaptive follow-up. The parent profile and
 * run are resolved from the registered C context, and every published next
 * session is registered again so the same route/submit APIs keep working.
 */
export async function continueRoleCAfterSubmission(
  input: ContinueRoleCAfterSubmissionInput,
  runtime: ContinueRoleCForRoleDRuntimeOptions = {},
): Promise<ContinueRoleCAfterSubmissionResult> {
  const context = roleCLearningCycles.get(input.sessionId)
  if (!context) {
    return {
      status: "blocked",
      stage: "context",
      code: "SESSION_NOT_FOUND",
      issues: ["C 学习会话不存在或服务已重启"],
    }
  }

  let registeredRun: RegisterReadyRunInput | undefined
  const lifecycle = {
    prepareNextRoundFromCompletedSubmission:
      context.service.prepareNextRoundFromCompletedSubmission.bind(
        context.service,
      ),
    async registerReadyRun(registration: RegisterReadyRunInput) {
      const result = await context.service.registerReadyRun(registration)
      registeredRun = {
        pipeline_input: structuredClone(registration.pipeline_input),
        pipeline_result: structuredClone(registration.pipeline_result),
        profile_snapshot: structuredClone(registration.profile_snapshot),
        learner_id_hash: registration.learner_id_hash,
      }
      return result
    },
    async openAnchorFirstSession(
      openInput: OpenAnchorFirstSessionInput,
    ) {
      const opened = await context.service.openAnchorFirstSession(openInput)
      if (!registeredRun) {
        throw new Error("ROLE_D_C_NEXT_RUN_REGISTRATION_MISSING")
      }
      roleCLearningCycles.set(openInput.session_id, {
        service: context.service,
        reviewed_pipeline: registeredRun.pipeline_result,
        role_d_port: context.role_d_port,
        delivery_target_namespace: context.delivery_target_namespace,
        agents: context.agents,
        secure_store: context.secure_store,
        review_options: context.review_options,
        profile_snapshot: registeredRun.profile_snapshot,
      })
      return opened
    },
  }
  const result = await continueCompletedLearningCycle({
    session_id: input.sessionId,
    submission_id: input.submissionId,
    authenticated_learner_id_hash: input.learnerId,
    profile_snapshot: structuredClone(context.profile_snapshot),
    ...(input.nextProfileSnapshot
      ? { next_profile_snapshot: structuredClone(input.nextProfileSnapshot) }
      : {}),
    ...(input.nextEvidencePack
      ? { next_evidence_pack: structuredClone(input.nextEvidencePack) }
      : {}),
    ...(input.nextPathNode
      ? { next_path_node: structuredClone(input.nextPathNode) }
      : {}),
    ...(input.nextGenerationAction
      ? { next_generation_action: input.nextGenerationAction }
      : {}),
    ...(input.currentGenerationVersions
      ? {
          current_generation_versions:
            structuredClone(input.currentGenerationVersions),
        }
      : {}),
  }, {
    learning_cycle: lifecycle,
    agents: context.agents,
    secure_store: context.secure_store,
    review_options: context.review_options,
    review_execution_config_version:
      "role-d-c-review-execution-v1",
    recovery_policy_version:
      runtime.recoveryPolicyVersion ?? "role-c-recovery-policy-v1",
    recovery_port_version:
      runtime.recoveryPortVersion ?? "role-d-recovery-ports-v1",
    delivery_target_namespace: context.delivery_target_namespace,
    role_d_port: context.role_d_port,
    ...(runtime.evidenceRefreshPort
      ? { evidence_refresh_port: runtime.evidenceRefreshPort }
      : {}),
    ...(runtime.pathPlanningPort
      ? { path_planning_port: runtime.pathPlanningPort }
      : {}),
    ...(runtime.maxRecoveryAttempts !== undefined
      ? { max_recovery_attempts: runtime.maxRecoveryAttempts }
      : {}),
  })

  if (result.status === "published") {
    const existing = roleCLearningCycles.get(
      result.learning_session.session_id,
    )
    if (!existing) {
      if (!registeredRun) {
        throw new Error("ROLE_D_C_NEXT_RUN_REGISTRATION_MISSING")
      }
      roleCLearningCycles.set(result.learning_session.session_id, {
        service: context.service,
        reviewed_pipeline: registeredRun.pipeline_result,
        role_d_port: context.role_d_port,
        delivery_target_namespace: context.delivery_target_namespace,
        agents: context.agents,
        secure_store: context.secure_store,
        review_options: context.review_options,
        profile_snapshot: registeredRun.profile_snapshot,
      })
    }
    const nextContext = roleCLearningCycles.get(
      result.learning_session.session_id,
    )
    if (!nextContext) {
      throw new Error("ROLE_D_C_NEXT_CONTEXT_MISSING")
    }
    return {
      ...result,
      role_d_handoff: toRoleDNextRoundHandoff(
        nextContext,
        result,
      ),
    }
  }
  return result
}

function toRoleDNextRoundHandoff(
  context: RoleCLearningCycleContext,
  result: Extract<
    ContinueCompletedLearningCycleResult,
    { status: "published" }
  >,
): Extract<RoleCForRoleDResult, { status: "ready" }> {
  const pipeline = context.reviewed_pipeline
  const artifacts = toRoleDArtifacts(pipeline.public_artifacts)
  const audit = reviewAuditSummary(pipeline.review_reports, artifacts)
  const spec = pipeline.generation_spec
  const session = result.learning_session
  if (session.phase !== "anchor_pending") {
    throw new Error("ROLE_D_C_NEXT_SESSION_PHASE_INVALID")
  }
  return {
    status: "ready",
    artifacts,
    workflow: pipeline.trace_events.map(toWorkflowEvent),
    runId: session.run_id,
    learningSession: {
      phase: "anchor_pending",
      sessionId: session.session_id,
      formId: session.form_id,
      attemptNo: session.attempt_no,
      profileVersion: spec.profile_ref.profile_version,
      pathNodeId: spec.path_node.node_id,
      targetSourceIds: [...spec.path_node.target_source_ids],
      routingRequestId: session.routing_request_id,
      requiredItemIds: [...session.required_item_ids],
    },
    deliveryToD: {
      reviewedRelease: result.delivery_to_d.reviewed_release,
      learningSession: result.delivery_to_d.learning_session,
    },
    ...(audit ? { audit } : {}),
  }
}

function selectTargets(
  results: RagResultItem[],
  knowledgeBase: KnowledgeBase,
  profile: LearnerProfile,
): RagResultItem[] {
  const direct = results.filter(hasDirectEvidenceMatch)
  const candidates = direct.length > 0 ? direct : results.filter((item) => item.score > 0)
  if (candidates.length === 0) return []

  const goalSourceIds = conceptSourceIds(
    [profile.goal],
    knowledgeBase,
  )
  const preferredSourceIds = new Set([
    ...conceptSourceIds(profile.weak_concepts, knowledgeBase),
    ...goalSourceIds,
    ...directPrerequisites(goalSourceIds, knowledgeBase),
  ])
  const knownSourceIds = masteredConceptSourceIds(
    profile.known_concepts,
    knowledgeBase,
  )
  const feasibleCandidates = candidates.filter((item) =>
    DIFFICULTY_ORDER[item.difficulty]
      <= DIFFICULTY_ORDER[profile.level] + 1)
  const unmasteredSourceIds = new Set(
    feasibleCandidates
      .map(sourceIdOf)
      .filter((sourceId) => !knownSourceIds.has(sourceId)),
  )
  if (unmasteredSourceIds.size === 0) return []
  const supportingPrerequisiteIds = directPrerequisites(
    unmasteredSourceIds,
    knowledgeBase,
  )
  const eligible = feasibleCandidates.filter((item) => {
    const sourceId = sourceIdOf(item)
    return unmasteredSourceIds.has(sourceId)
      || supportingPrerequisiteIds.has(sourceId)
  })
  const ranked = [
    ...eligible.filter((item) => preferredSourceIds.has(sourceIdOf(item))),
    ...eligible.filter((item) => !preferredSourceIds.has(sourceIdOf(item))),
  ]
  const fallback = ranked.length > 0 ? ranked : candidates
  const maxScore = Math.max(...fallback.map((item) => item.score))
  const threshold = Math.max(10, maxScore * 0.7)
  const thresholdMatches = fallback.filter((item) =>
    preferredSourceIds.has(sourceIdOf(item)) || item.score >= threshold)
  const selected = thresholdMatches.length >= 3
    ? thresholdMatches
    : fallback
  const limited = selected.slice(0, Math.min(3, selected.length))
  return orderTargetsForTeaching(limited, knowledgeBase)
}

function roleDDeliveryTargetNamespace(
  port: RoleDAdaptiveLearningLoopPort,
  explicitNamespace: string | undefined,
): string {
  if (explicitNamespace !== undefined) {
    if (!explicitNamespace.trim()) {
      throw new Error("ROLE_D_C_DELIVERY_TARGET_NAMESPACE_EMPTY")
    }
    return explicitNamespace
  }
  const namespace = (port as { namespace_id?: unknown }).namespace_id
  return typeof namespace === "string" && namespace.trim()
    ? namespace
    : "role-d-injected-delivery-port-v1"
}

function conceptSourceIds(
  concepts: string[],
  knowledgeBase: KnowledgeBase,
): Set<string> {
  return new Set(concepts.flatMap((concept) =>
    canonicalizeConcept(concept, knowledgeBase).sourceIds))
}

function masteredConceptSourceIds(
  concepts: string[],
  knowledgeBase: KnowledgeBase,
): Set<string> {
  const itemsBySourceId = new Map(
    knowledgeBase.items.map((item) => [item.sourceId, item]),
  )
  const mastered = new Set<string>()
  for (const concept of concepts) {
    const candidates = new Set(
      canonicalizeConcept(concept, knowledgeBase).sourceIds
        .filter((sourceId) => itemsBySourceId.has(sourceId)),
    )
    const exactTitleMatches = [...candidates].filter((sourceId) =>
      normalizeKnowledgeLabel(itemsBySourceId.get(sourceId)!.title)
        === normalizeKnowledgeLabel(concept))
    if (exactTitleMatches.length > 0) {
      exactTitleMatches.forEach((sourceId) => mastered.add(sourceId))
      continue
    }
    for (const sourceId of candidates) {
      if (!dependsOnMappedSource(sourceId, candidates, itemsBySourceId)) {
        mastered.add(sourceId)
      }
    }
  }
  return mastered
}

function dependsOnMappedSource(
  sourceId: string,
  candidates: Set<string>,
  itemsBySourceId: Map<string, KnowledgeBase["items"][number]>,
): boolean {
  const visited = new Set<string>()
  const queue = [...(itemsBySourceId.get(sourceId)?.prerequisites ?? [])]
  while (queue.length > 0) {
    const prerequisiteId = queue.shift()!
    if (candidates.has(prerequisiteId)) return true
    if (visited.has(prerequisiteId)) continue
    visited.add(prerequisiteId)
    queue.push(...(
      itemsBySourceId.get(prerequisiteId)?.prerequisites ?? []
    ))
  }
  return false
}

function normalizeKnowledgeLabel(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}

function directPrerequisites(
  roots: Set<string>,
  knowledgeBase: KnowledgeBase,
): Set<string> {
  const prerequisitesBySource = new Map(knowledgeBase.items.map((item) => [
    item.sourceId,
    item.prerequisites,
  ]))
  return new Set([...roots].flatMap((sourceId) =>
    prerequisitesBySource.get(sourceId) ?? []))
}

const DIFFICULTY_ORDER: Record<KnowledgeDifficulty, number> = {
  beginner: 0,
  basic: 1,
  intermediate: 2,
  integrated: 3,
}

/**
 * RAG scores rank relevance, not teaching order. Preserve the selected set but
 * place prerequisites before dependants, then use difficulty/source ID as the
 * deterministic tie-breaker for unrelated nodes.
 */
function orderTargetsForTeaching(
  targets: RagResultItem[],
  knowledgeBase: KnowledgeBase,
): RagResultItem[] {
  const bySourceId = new Map(targets.map((target) => [
    sourceIdOf(target),
    target,
  ]))
  const selectedIds = new Set(bySourceId.keys())
  const prerequisiteMap = new Map(
    knowledgeBase.items.map((item) => [
      item.sourceId,
      item.prerequisites.filter((sourceId) => selectedIds.has(sourceId)),
    ]),
  )
  const remaining = new Set(selectedIds)
  const ordered: RagResultItem[] = []

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((sourceId) =>
        (prerequisiteMap.get(sourceId) ?? []).every((prerequisite) =>
          !remaining.has(prerequisite)))
      .sort((left, right) => {
        const leftTarget = bySourceId.get(left)!
        const rightTarget = bySourceId.get(right)!
        return DIFFICULTY_ORDER[leftTarget.difficulty]
          - DIFFICULTY_ORDER[rightTarget.difficulty]
          || left.localeCompare(right)
      })
    const next = ready[0]
    if (!next) {
      return [
        ...ordered,
        ...[...remaining]
          .map((sourceId) => bySourceId.get(sourceId)!)
          .sort((left, right) =>
            DIFFICULTY_ORDER[left.difficulty]
              - DIFFICULTY_ORDER[right.difficulty]
            || sourceIdOf(left).localeCompare(sourceIdOf(right))),
      ]
    }
    ordered.push(bySourceId.get(next)!)
    remaining.delete(next)
  }
  return ordered
}

function hasDirectEvidenceMatch(item: RagResultItem): boolean {
  const fields = item.retrievalTrace.matchedFields.filter((field) => field !== "difficulty" && field !== "prerequisite")
  const scores = item.retrievalTrace.scoreBreakdown
  return fields.length > 0
    || item.retrievalTrace.matchedKeywords.length > 0
    || scores.keyword > 0
    || scores.title > 0
    || scores.facts > 0
    || scores.practiceTasks > 0
    || scores.bonus > 0
}

function sourceIdOf(item: RagResultItem): string {
  return item.sourceId ?? item.source_id
}

function factIdOf(item: RagResultItem): string {
  const fact = item.facts[0]
  if (!fact) throw new Error(`A 检索目标 ${sourceIdOf(item)} 没有可用事实`)
  return fact.factId ?? fact.fact_id ?? "F001"
}

function behaviorFor(_item: RagResultItem, index: number, count: number): ObservableBehavior {
  if (count === 1) return "recognize"
  if (count === 2) return index === 0 ? "recognize" : "trace"
  return (["recognize", "apply", "create"] as const)[index] ?? "apply"
}

function blueprintFor(targetCount: number): AssessmentBlueprint {
  if (targetCount >= 3) {
    return { tier_1_count: 2, tier_2_count: 2, tier_3_count: 1, required_modalities: ["mcq", "trace", "code"] }
  }
  if (targetCount === 2) {
    return { tier_1_count: 1, tier_2_count: 1, tier_3_count: 0, required_modalities: ["mcq", "trace"] }
  }
  return { tier_1_count: 1, tier_2_count: 0, tier_3_count: 0, required_modalities: ["mcq"] }
}

function reviewAuditSummary(
  reports: ContentReviewResult[],
  artifacts: RoleDGeneratedArtifact[],
): RoleDContentAuditSummary | undefined {
  const final = reports.at(-1)
  if (!final) return undefined
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const factAudits = final.artifact_results.map((result) => {
    const artifact = artifactById.get(result.artifact_id)
    return {
      artifactId: result.artifact_id,
      artifactTitle: artifact?.title ?? result.artifact_id,
      artifactKind: result.artifact_kind === "concept" ? "lesson" as const : result.artifact_kind === "code_lab" ? "lab" as const : "assessment" as const,
      status: result.fact_status,
      checkedClaims: result.findings.filter((finding) => finding.source === "fact_audit").length,
      conflicts: result.findings.filter((finding) => finding.source === "fact_audit").length,
      notes: result.findings.filter((finding) => finding.source === "fact_audit").map((finding) => finding.message).slice(0, 3),
    }
  })
  const factStatus = combineReviewStatuses(final.artifact_results.map((result) => result.fact_status))
  const teachingStatus = combineReviewStatuses(final.artifact_results.map((result) => result.teaching_status))
  return {
    factStatus,
    factAudits,
    teachingAudit: {
      artifactId: "role-c-reviewed-content",
      status: teachingStatus,
      summary: teachingStatus === "pass" ? "B 教学审核通过。" : "B 教学审核未通过。",
      revisionHints: [...new Set(
        final.revision_instructions
          .filter((instruction) => instruction.source === "teaching_audit")
          .map((instruction) => instruction.proposed_action),
      )],
    },
    arbitration: {
      artifactId: "role-c-reviewed-content",
      decision: final.decision,
      revisionRound: final.revision_round,
      maxRevisionRounds: final.max_revision_rounds,
      canRevise: final.decision === "revise" && final.revision_round < final.max_revision_rounds,
      reason: final.decision === "pass"
        ? "A/B 双审核已通过，C 公开产物可以发布给 D。"
        : final.decision === "revise"
          ? "A/B 审核要求 C 修订后重新提交。"
          : "A/B 审核驳回，本轮产物未发布给 D。",
    },
  }
}

function combineReviewStatuses(statuses: Array<"pass" | "revise" | "reject">): "pass" | "revise" | "reject" {
  if (statuses.includes("reject")) return "reject"
  if (statuses.includes("revise")) return "revise"
  return "pass"
}

function toRoleDArtifacts(publicArtifacts: {
  concept_lesson?: ConceptLessonArtifact
  code_lab?: CodeLabPublicArtifact
  assessment?: AssessmentPublicArtifact
}): RoleDGeneratedArtifact[] {
  const concept = publicArtifacts.concept_lesson
  const lab = publicArtifacts.code_lab
  const assessment = publicArtifacts.assessment
  if (!concept?.payload || concept.artifact_type !== "concept_lesson") return []
  if (!lab?.payload || lab.artifact_type !== "code_lab_public") return []
  if (!assessment?.payload || assessment.artifact_type !== "assessment_public") return []

  const assessmentItems: RoleDAssessmentItem[] = assessment.payload.items.map((item) => ({
    id: item.item_id,
    tier: item.tier,
    modality: item.modality,
    prompt: item.prompt,
    options: item.options?.map((option) => `${option.label}. ${option.text}`) ?? [],
    option_ids: item.options?.map((option) => option.option_id) ?? [],
    ...(item.starter_code ? { starter_code: item.starter_code } : {}),
    citations: simplifyCitations(item.citations),
  }))
  return [
    {
      id: concept.artifact_id,
      kind: "lesson",
      title: concept.payload.title,
      status: "real",
      content: renderConceptLesson(concept.payload),
      options: [],
      citations: simplifyCitations(concept.citations),
      items: [],
    },
    {
      id: lab.artifact_id,
      kind: "lab",
      title: lab.payload.title,
      status: "real",
      content: renderCodeLab(lab.payload),
      options: [],
      citations: simplifyCitations(lab.citations),
      items: [],
    },
    {
      id: assessment.artifact_id,
      kind: "assessment",
      title: assessment.payload.title,
      status: "real",
      content: `共 ${assessment.payload.items.length} 道分阶题，覆盖 Tier 1、Tier 2 和 Tier 3。`,
      options: assessmentItems[0]?.options ?? [],
      citations: simplifyCitations(assessment.citations),
      items: assessmentItems,
    },
  ]
}

function renderConceptLesson(payload: NonNullable<ConceptLessonArtifact["payload"]>): string {
  const explanations = payload.explanation_blocks.flatMap((block) => "text" in block ? [block.text] : [])
  const examples = payload.worked_examples.flatMap((block) => block.block_type === "code"
    ? [`${block.caption ?? "示例"}\n${block.code}`]
    : [])
  const misconceptions = payload.misconceptions.map((item) => `常见误区：${item.explanation}`)
  const summaries = payload.summary.flatMap((block) => "text" in block ? [block.text] : [])
  return [...explanations, ...examples, ...misconceptions, ...summaries].join("\n\n")
}

function renderCodeLab(payload: NonNullable<CodeLabPublicArtifact["payload"]>): string {
  const instructions = payload.instructions.flatMap((block) => "text" in block ? [block.text] : [])
  const tests = payload.public_tests.map((test) => `公开测试：${test.description}（${test.expected_behavior}）`)
  return [...instructions, "Starter code:", payload.starter_code, ...tests].join("\n\n")
}

function simplifyCitations(citations: CitationRef[]): RoleDPublicCitation[] {
  return [...new Map(citations.map((citation) => [
    `${citation.source_id}:${citation.fact_id}`,
    { source_id: citation.source_id, fact_id: citation.fact_id },
  ])).values()]
}

function toWorkflowEvent(event: AgentTraceEvent): RoleDWorkflowEvent {
  const status = event.status === "success"
    ? "completed"
    : event.status === "started"
      ? "running"
      : event.status === "blocked" || event.status === "failed"
        ? "blocked"
        : "pending"
  return {
    id: `${event.run_id}-${event.seq}`,
    agent: event.agent ?? "role-c-pipeline",
    stage: stageLabel(event),
    status,
    summary: event.summary ?? event.event_type,
    timestamp: event.occurred_at ?? "刚刚",
  }
}

function stageLabel(event: AgentTraceEvent): string {
  if (event.agent === "concept-tutor") return "定制讲义"
  if (event.agent === "code-lab") return "代码实验"
  if (event.agent === "tiered-evaluator") return "分阶测评"
  return event.event_type === "c.pipeline.ready" ? "C 内容发布" : "C 入口校验"
}
