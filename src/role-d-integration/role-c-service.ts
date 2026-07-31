import type {
  GenerateRoleCForRoleDInput,
  RoleDContentAuditSummary,
  RoleCForRoleDResult,
  RoleDAssessmentItem,
  RoleDGeneratedArtifact,
  RoleDPublicCitation,
  RoleDWorkflowEvent,
} from "./contracts"
import { loadKnowledgeBase } from "../knowledge/loader"
import type { KnowledgeBase } from "../knowledge/types"
import {
  type RagResult,
  type RagResultItem,
} from "../rag/retriever"
import {
  retrieveStructuredEvidenceFromKnowledgeBase,
  type StructuredEvidenceRetrievalPort,
  type StructuredEvidenceRequest,
} from "../rag/structured-evidence"
import { join, resolve } from "node:path"
import {
  adaptLearnerProfile,
  adaptRagResult,
  AtomicFileLearningCycleStore,
  AtomicFileMasteryStateStore,
  AtomicFileSecureArtifactStore,
  buildGenerationSpec,
  contentHash,
  createLocalABContentReviewPort,
  createLocalBPathPlanningPort,
  createRoleCAgents,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  createDockerPythonCodeRunnerFromEnv,
  InMemoryLearningCycleStore,
  InMemoryMasteryStateStore,
  InMemorySecureArtifactStore,
  LearningCycleService,
  ModelBackedRoleCContentProvider,
  modelBackedProviderOptionsFromEnv,
  projectPublicRagEvidencePack,
  createRoleCModelGatewayFromEnv,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  runRecoverableReviewedCPipeline,
  stableId,
  TrustedAssessmentVerifier,
  TrustedCodeLabVerifier,
  type AgentTraceEvent,
  type AssessmentPublicArtifact,
  type ContentReviewResult,
  type ContentReviewPort,
  type CrossArtifactCritic,
  type CitationRef,
  type CodeLabPublicArtifact,
  type ConceptLessonArtifact,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type LearningCyclePublicOutcome,
  type LearningCycleStore,
  type MasteryStateStore,
  type EvidenceRefreshPort,
  type RecoverableReviewedReadyContext,
  type ReviewRecoveryAttempt,
  type ReviewRecoverySummary,
  type RoleCContentProvider,
  type SecureArtifactStore,
  type SubmissionEnvelope,
} from "../role-c-content"

const CONFORMANCE_DIGEST = `sha256:${"d".repeat(64)}`
const defaultInMemoryLearningPersistence: RoleCLearningPersistence = {
  cycleStore: new InMemoryLearningCycleStore(),
  secureStore: new InMemorySecureArtifactStore(),
  masteryStore: new InMemoryMasteryStateStore(),
}

/** Fail-closed convenience entry. Runtime adapters select model or explicit offline mode. */

export async function generateRoleCForRoleD(input: GenerateRoleCForRoleDInput): Promise<RoleCForRoleDResult> {
  return generateRoleCForRoleDWithRuntime(input, {
    providerMode: "unconfigured",
    allowDeterministicFallback: false,
  })
}

export interface RoleCForRoleDRuntimeOptions {
  providerMode?: "deterministic" | "model" | "unconfigured"
  /** UI/production sets false unless offline deterministic mode was selected explicitly. */
  allowDeterministicFallback?: boolean
  env?: Record<string, string | undefined>
  cwd?: string
  runner?: CodeRunner
  /** Test/backend seam; production selects the Provider from providerMode. */
  provider?: RoleCContentProvider
  /** Backend/test seam for a remote or instrumented A/B review adapter. */
  reviewPort?: ContentReviewPort
  /** Optional advisory semantic review; deterministic alignment remains authoritative. */
  critic?: CrossArtifactCritic
  dockerRunnerFactory?: (env?: Record<string, string | undefined>) => Promise<CodeRunner>
  /** Stable server-side directory used to recover C sessions after a process restart. */
  dataDirectory?: string
  /** Test/backend seam for callers that own equivalent durable stores. */
  learningPersistence?: RoleCLearningPersistence
}

export interface RoleCLearningPersistence {
  cycleStore: LearningCycleStore
  secureStore: SecureArtifactStore
  masteryStore: MasteryStateStore
}

/**
 * Creates one single-host durable namespace. Every instance opened on the same
 * directory resolves the same run, secure artifacts, sessions and mastery state.
 */
export function createAtomicRoleCLearningPersistence(
  dataDirectory: string,
): RoleCLearningPersistence {
  if (!dataDirectory.trim()) throw new Error("ROLE_C_RUNTIME_DATA_DIR 不能为空")
  const root = resolve(dataDirectory)
  return {
    cycleStore: new AtomicFileLearningCycleStore({
      root_directory: join(root, "learning-cycle"),
    }),
    secureStore: new AtomicFileSecureArtifactStore({
      root_directory: join(root, "secure-artifacts"),
    }),
    masteryStore: new AtomicFileMasteryStateStore({
      root_directory: join(root, "mastery"),
    }),
  }
}

export async function resolveRoleCCodeRunner(runtime: Pick<RoleCForRoleDRuntimeOptions, "providerMode" | "runner" | "env" | "dockerRunnerFactory">): Promise<CodeRunner> {
  if (runtime.runner) return runtime.runner
  if (runtime.providerMode === "model") {
    return (runtime.dockerRunnerFactory ?? createDockerPythonCodeRunnerFromEnv)(runtime.env ?? process.env)
  }
  return new RoleDConformanceRunner()
}

export async function generateRoleCForRoleDWithRuntime(
  input: GenerateRoleCForRoleDInput,
  runtime: RoleCForRoleDRuntimeOptions,
): Promise<RoleCForRoleDResult> {
  const explicitOfflineMode = runtime.providerMode === "deterministic"
    && runtime.allowDeterministicFallback === true
  if (!runtime.provider
    && runtime.providerMode !== "model"
    && !explicitOfflineMode) {
    const reason = "C 的通用内容生成模型尚未配置。请设置 ROLE_C_PROVIDER_MODE=model、模型接口地址和模型名称；离线金标模式需显式设置 ROLE_C_PROVIDER_MODE=deterministic。"
    return {
      status: "blocked",
      artifacts: [],
      workflow: [{
        id: `${input.runId}-provider-mode-blocked`,
        agent: "role-c-model-provider",
        stage: "模型 Provider 配置",
        status: "blocked",
        summary: reason,
        timestamp: new Date().toISOString(),
      }],
      runId: input.runId,
      reason,
    }
  }
  const knowledgeBase = await loadKnowledgeBase()
  const evidencePack = adaptRagResult(input.ragResult, {
    kb_version: input.kbVersion,
    rag_version: "rule-rag-0.1",
  })
  const profileSnapshot = adaptLearnerProfile(input.profile, {
    profile_version: `${input.runId}-profile-v1`,
    provenance_ref: "role-d:new-learning-plan",
  })
  const pathNode = structuredClone(input.pathNode)

  const runtimeEnv = runtime.env ?? process.env
  let modelGateway: ReturnType<typeof createRoleCModelGatewayFromEnv> | undefined
  try {
    modelGateway = runtime.providerMode === "model"
      ? createRoleCModelGatewayFromEnv(runtimeEnv)
      : undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : "C 的模型 Provider 配置不可用"
    return {
      status: "blocked",
      artifacts: [],
      workflow: [{
        id: `${input.runId}-model-provider-blocked`,
        agent: "role-c-model-provider",
        stage: "模型 Provider 配置",
        status: "blocked",
        summary: reason,
        timestamp: new Date().toISOString(),
      }],
      runId: input.runId,
      reason,
    }
  }
  let runner: CodeRunner
  try {
    runner = await resolveRoleCCodeRunner(runtime)
  } catch (error) {
    const reason = error instanceof Error ? error.message : "C 的 Docker CodeRunner 不可用"
    return {
      status: "blocked",
      artifacts: [],
      workflow: [{
        id: `${input.runId}-docker-runner-blocked`,
        agent: "docker-python-runner",
        stage: "可信代码执行",
        status: "blocked",
        summary: reason,
        timestamp: new Date().toISOString(),
      }],
      runId: input.runId,
      reason,
    }
  }

  const built = buildGenerationSpec({
    run_id: input.runId,
    profile_snapshot: profileSnapshot,
    path_node: pathNode,
    evidence_pack: evidencePack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: modelGateway
        ? modelGateway.model_config_hash
        : "deterministic-role-d-local-reference-v1",
      runner_image_digest: runner.runner_image_digest,
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

  const provider = runtime.provider ?? (modelGateway
    ? new ModelBackedRoleCContentProvider(modelGateway, modelBackedProviderOptionsFromEnv(runtimeEnv))
    : new DeterministicCodeLabContentProvider())
  const agents = createRoleCAgents(provider, {
    code_lab: new TrustedCodeLabVerifier(runner),
    assessment: new TrustedAssessmentVerifier(runner),
  })
  const persistence = resolveRoleCLearningPersistence(runtime)
  const secureStore = persistence.secureStore
  const cycleService = new LearningCycleService({
    cycle_store: persistence.cycleStore,
    secure_store: secureStore,
    mastery_store: persistence.masteryStore,
    code_runner: runner,
  })
  const pipelineInput = { generation_spec: built.spec, evidence_pack: evidencePack }
  let readyContext: RecoverableReviewedReadyContext | undefined
  const pipeline = await runRecoverableReviewedCPipeline(
    pipelineInput,
    agents,
    secureStore,
    {
      review_port: runtime.reviewPort
        ?? createLocalABContentReviewPort({ knowledge_base: knowledgeBase }),
      profile_snapshot: profileSnapshot,
      path_planning_port: createLocalBPathPlanningPort(knowledgeBase),
      evidence_refresh_port: createRoleCRecoveryEvidenceRefreshPort({
        kbVersion: input.kbVersion,
        knowledgeBase,
      }),
      max_external_revisions: 2,
      max_recovery_attempts: 2,
      ...(runtime.critic ? { critic: runtime.critic } : {}),
      async on_ready(context) {
        await cycleService.registerReadyRun({
          pipeline_input: context.pipeline_input,
          pipeline_result: context.pipeline_result,
          profile_snapshot: context.profile_snapshot,
          learner_id_hash: input.profile.learner_id,
        })
        readyContext = context
      },
    },
  )
  const workflow = [
    ...pipeline.trace_events.map(toWorkflowEvent),
    ...recoveryWorkflowEvents(input.runId, pipeline.recovery, pipeline.recovery_history),
  ]
  const audit = reviewAuditSummary(pipeline.review_reports, toRoleDArtifacts(pipeline.public_artifacts))
  const finalReview = pipeline.review_reports.at(-1)
  if (pipeline.status !== "ready" || finalReview?.decision !== "pass") {
    const reviewReason = finalReview
      ? finalReview.artifact_results.flatMap((result) => result.findings.map((finding) => finding.message)).slice(0, 3).join("；")
      : ""
    const pipelineReason = pipeline.blocked_reason
      ? [
          pipeline.blocked_reason.message,
          ...(pipeline.blocked_reason.details ?? []).slice(0, 3),
        ].join("；")
      : pipeline.failure_reason?.message
    return {
      status: pipeline.status === "failed" ? "failed" : "blocked",
      artifacts: [],
      workflow,
      runId: pipeline.generation_spec.run_id,
      reason: pipelineReason || pipeline.recovery.message || reviewReason || "A/B 审核未通过，内容未发布给 D。",
      ...(audit ? { audit } : {}),
      recovery: toRoleDRecovery(pipeline.recovery),
    }
  }
  if (!readyContext) throw new Error("ROLE_C_READY_CONTEXT_MISSING")
  const artifacts = toRoleDArtifacts(pipeline.public_artifacts)
  const finalSpec = readyContext.pipeline_input.generation_spec
  const learningSessionId = `C-${finalSpec.run_id}-SESSION-1`
  const assessment = pipeline.public_artifacts.assessment!
  const requiredItemIds = assessment.payload!.items.map((item) => item.item_id)
  await cycleService.openTrustedPreselectedSession({
    session_id: learningSessionId,
    run_id: finalSpec.run_id,
    authenticated_learner_id_hash: input.profile.learner_id,
    attempt_no: 1,
    required_item_ids: requiredItemIds,
    revealed_hint_levels: Object.fromEntries(requiredItemIds.map((itemId) => [itemId, 0])),
    profile_expectations_by_objective: Object.fromEntries(
      finalSpec.targets.map((target) => [target.objective_id, "weak" as const]),
    ),
    routing_policy: "trusted_preselected_v1",
  })
  return {
    status: "ready",
    artifacts,
    workflow,
    runId: finalSpec.run_id,
    learningSession: {
      sessionId: learningSessionId,
      formId: assessment.payload!.form_id,
      attemptNo: 1,
    },
    ...(audit ? { audit } : {}),
    recovery: toRoleDRecovery(pipeline.recovery),
    finalContext: {
      profileSnapshot: structuredClone(readyContext.profile_snapshot),
      profileVersion: readyContext.profile_snapshot.profile_version,
      pathNode: defineLearningPathNode({
        ...structuredClone(finalSpec.path_node),
        objectives: structuredClone(finalSpec.targets),
        assessment_blueprint: structuredClone(finalSpec.assessment_blueprint),
      }),
      evidencePack: projectPublicRagEvidencePack(
        readyContext.pipeline_input.evidence_pack,
      ),
    },
  }
}

export interface RoleCRecoveryEvidenceRefreshOptions {
  kbVersion: string
  knowledgeBase: KnowledgeBase
  structuredEvidencePort?: StructuredEvidenceRetrievalPort
}

const RECOVERY_SOURCE_BATCH_SIZE = 8

/**
 * Resolves B's fixed recovery path through A's identity-based evidence port.
 * Text retrieval remains reserved for the initial stage, before source IDs are known.
 */
export function createRoleCRecoveryEvidenceRefreshPort(
  options: RoleCRecoveryEvidenceRefreshOptions,
): EvidenceRefreshPort {
  const retrieve = options.structuredEvidencePort
    ? options.structuredEvidencePort.retrieveStructuredEvidence.bind(
        options.structuredEvidencePort,
      )
    : async (request: StructuredEvidenceRequest) =>
        retrieveStructuredEvidenceFromKnowledgeBase(
          request,
          options.knowledgeBase,
        )
  return {
    async refreshEvidence(request) {
      const sourceIds = [...new Set(request.target_source_ids)]
      const requiredFactsBySource = groupRequiredFacts(
        request.required_facts,
        sourceIds,
      )
      const batches = chunk(sourceIds, RECOVERY_SOURCE_BATCH_SIZE)
      const recalled = await Promise.all(batches.map((batch) =>
        retrieve({
          source_ids: batch,
          fact_ids_by_source: Object.fromEntries(batch.flatMap((sourceId) => {
            const factIds = requiredFactsBySource[sourceId]
            return factIds && factIds.length > 0
              ? [[sourceId, factIds]]
              : []
          })),
        })))
      const requested = new Set(sourceIds)
      const mergedBySource = new Map<string, RagResultItem>()
      const missingSources = new Set<string>()
      const missingFactKeys = new Set<string>()
      for (const result of recalled) {
        for (const sourceId of result.missing_source_ids) {
          if (requested.has(sourceId)) missingSources.add(sourceId)
        }
        for (const fact of result.missing_fact_refs) {
          if (requested.has(fact.source_id)) {
            missingFactKeys.add(`${fact.source_id}:${fact.fact_id}`)
          }
        }
        for (const item of result.results) {
          const sourceId = sourceIdOf(item)
          if (requested.has(sourceId) && !mergedBySource.has(sourceId)) {
            mergedBySource.set(sourceId, structuredClone(item))
          }
        }
      }
      for (const sourceId of sourceIds) {
        if (!mergedBySource.has(sourceId)) missingSources.add(sourceId)
        const item = mergedBySource.get(sourceId)
        const availableFacts = new Set(item?.facts.map((fact) =>
          fact.factId ?? fact.fact_id) ?? [])
        for (const factId of requiredFactsBySource[sourceId] ?? []) {
          if (!availableFacts.has(factId)) {
            missingFactKeys.add(`${sourceId}:${factId}`)
          }
        }
      }
      const merged: RagResult = {
        query: `按标识刷新证据：${sourceIds.join("、")}`,
        learnerLevel: request.learner_level,
        topK: Math.max(1, sourceIds.length),
        results: sourceIds.flatMap((sourceId) => {
          if (missingSources.has(sourceId)) return []
          const item = mergedBySource.get(sourceId)
          if (!item) return []
          const filtered = {
            ...item,
            facts: item.facts.filter((fact) =>
              !missingFactKeys.has(
                `${sourceId}:${fact.factId ?? fact.fact_id}`,
              )),
          }
          return [filtered]
        }),
      }
      const evidence = adaptRagResult(merged, {
        kb_version: options.kbVersion,
        rag_version: "structured-evidence-1.0-recovery",
        retrieval_id: stableId("RAG-RECOVERY", {
          request_id: request.request_id,
          source_ids: sourceIds,
          required_facts_by_source: requiredFactsBySource,
          kb_version: options.kbVersion,
        }),
      })
      return {
        ...evidence,
        match_status: missingSources.size === 0 && missingFactKeys.size === 0
          ? "strong"
          : evidence.results.length > 0
            ? "weak"
            : "no_match",
      }
    },
  }
}

function groupRequiredFacts(
  requiredFacts: Array<{ source_id: string; fact_id: string }>,
  sourceIds: string[],
): Record<string, string[]> {
  const requested = new Set(sourceIds)
  const grouped: Record<string, string[]> = {}
  for (const fact of requiredFacts) {
    if (!requested.has(fact.source_id)) continue
    const factIds = grouped[fact.source_id] ?? []
    if (!factIds.includes(fact.fact_id)) factIds.push(fact.fact_id)
    grouped[fact.source_id] = factIds
  }
  return grouped
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function toRoleDRecovery(recovery: ReviewRecoverySummary) {
  return {
    code: recovery.code,
    failedDimensions: [...recovery.failed_dimensions],
    missingPrerequisiteSourceIds: [...recovery.missing_prerequisite_source_ids],
    unknownPrerequisiteRefs: [...recovery.unknown_prerequisite_refs],
    requiredAction: recovery.required_action,
    fixScope: recovery.fix_scope,
    ...(recovery.recommended_level ? { recommendedLevel: recovery.recommended_level } : {}),
    canRecover: recovery.can_recover,
    attempts: recovery.recovery_attempts,
    message: recovery.message,
  }
}

function recoveryWorkflowEvents(
  runId: string,
  recovery: ReviewRecoverySummary,
  history: ReviewRecoveryAttempt[],
): RoleDWorkflowEvent[] {
  if (history.length === 0 && recovery.required_action === "none") return []
  return [{
    id: `${runId}-review-recovery-${history.length}`,
    agent: recovery.fix_scope === "new_spec" ? "B/C recovery-loop" : "A/C recovery-loop",
    stage: "审核恢复",
    status: recovery.code === "READY" ? "completed" : "blocked",
    summary: recovery.message,
    timestamp: "刚刚",
  }]
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

export async function submitRoleCAssessment(
  input: SubmitRoleCAssessmentInput,
  runtime: RoleCForRoleDRuntimeOptions = {},
): Promise<LearningCyclePublicOutcome> {
  const persistence = resolveRoleCLearningPersistence(runtime)
  const runner = await resolveRoleCCodeRunner(runtime)
  const service = new LearningCycleService({
    cycle_store: persistence.cycleStore,
    secure_store: persistence.secureStore,
    mastery_store: persistence.masteryStore,
    code_runner: runner,
  })
  return service.processSubmission({
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

function resolveRoleCLearningPersistence(
  runtime: Pick<RoleCForRoleDRuntimeOptions, "dataDirectory" | "learningPersistence">,
): RoleCLearningPersistence {
  if (runtime.learningPersistence) return runtime.learningPersistence
  if (runtime.dataDirectory) {
    return createAtomicRoleCLearningPersistence(runtime.dataDirectory)
  }
  return defaultInMemoryLearningPersistence
}

function sourceIdOf(item: RagResultItem): string {
  return item.sourceId ?? item.source_id
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
    const factFindings = result.findings.filter((finding) =>
      finding.source === "fact_audit")
    return {
      artifactId: result.artifact_id,
      artifactTitle: artifact?.title ?? result.artifact_id,
      artifactKind: result.artifact_kind === "concept" ? "lesson" as const : result.artifact_kind === "code_lab" ? "lab" as const : "assessment" as const,
      status: result.fact_status,
      checkedClaims: artifact?.citations.length ?? 0,
      conflicts: factFindings.length,
      notes: factFindings.map((finding) => finding.message).slice(0, 3),
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
      revisionHints: final.revision_instructions.filter((instruction) => instruction.source === "teaching_audit").map((instruction) => instruction.proposed_action),
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
  if (event.agent === "concept-tutor") {
    if (event.event_type === "c.agent.started") return "定制讲义生成"
    if (event.event_type === "c.agent.ready") return "定制讲义准备"
    if (event.status === "blocked" || event.status === "failed") return "定制讲义受阻"
    return "定制讲义"
  }
  if (event.agent === "code-lab") return "代码实验"
  if (event.agent === "tiered-evaluator") return "分阶测评"
  return event.event_type === "c.pipeline.ready" ? "C 内容发布" : "C 入口校验"
}

/** Deterministic contract runner used by Role C's reproducible local reference path. */
class RoleDConformanceRunner implements CodeRunner {
  readonly runner_image_digest = CONFORMANCE_DIGEST

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const declaredTests = request.test_suite?.tests.map((entry) => entry.test_id) ?? []
    const testIds = declaredTests.length > 0
      ? declaredTests
      : ["AT-O3-BASIC", "AT-O3-SINGLE", "AT-O3-DECIMAL", "AT-O3-FRACTION"]
    const failed = request.code.includes("return None") || request.code.includes("pass\n")
      ? testIds
      : request.code.includes("total = score")
        ? testIds
        : request.code.includes("scores[:-1]") || request.code.includes("return 80") || request.code.includes("// count")
          ? testIds
          : []
    return {
      status: failed.length === 0 ? "passed" : "failed",
      passed_tests: testIds.length - failed.length,
      total_tests: testIds.length,
      score_ratio: testIds.length === 0 ? 0 : (testIds.length - failed.length) / testIds.length,
      failure_codes: failed.map((testId) => `${testId}:assertion_failed`),
      runner_image_digest: this.runner_image_digest,
    }
  }
}
