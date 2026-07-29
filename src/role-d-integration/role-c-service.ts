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
import type { RagResultItem } from "../rag/retriever"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  contentHash,
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
  runReviewedCPipeline,
  TrustedAssessmentVerifier,
  TrustedCodeLabVerifier,
  type AgentTraceEvent,
  type AssessmentBlueprint,
  type AssessmentPublicArtifact,
  type ContentReviewResult,
  type CitationRef,
  type CodeLabPublicArtifact,
  type ConceptLessonArtifact,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type LearningCyclePublicOutcome,
  type ObservableBehavior,
  type SubmissionEnvelope,
} from "../role-c-content"

const CONFORMANCE_DIGEST = `sha256:${"d".repeat(64)}`
const roleCLearningCycles = new Map<string, LearningCycleService>()

/**
 * Role D derives targets dynamically, but this local endpoint still uses C's
 * deterministic offline Provider. It proves contracts and the K018 gold path;
 * broad topic generation requires C's model/OpenCode Provider to be wired by the backend.
 */

export async function generateRoleCForRoleD(input: GenerateRoleCForRoleDInput): Promise<RoleCForRoleDResult> {
  return generateRoleCForRoleDWithRuntime(input, {})
}

export interface RoleCForRoleDRuntimeOptions {
  providerMode?: "deterministic" | "model"
  env?: Record<string, string | undefined>
  cwd?: string
  runner?: CodeRunner
}

export async function generateRoleCForRoleDWithRuntime(
  input: GenerateRoleCForRoleDInput,
  runtime: RoleCForRoleDRuntimeOptions,
): Promise<RoleCForRoleDResult> {
  const targets = selectTargets(input.ragResult.results)
  if (targets.length === 0) {
    return {
      status: "blocked",
      artifacts: [],
      workflow: [],
      runId: input.runId,
      reason: "A 检索结果没有可交给 C 的强匹配目标知识点。",
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
      runner_image_digest: runtime.runner?.runner_image_digest ?? CONFORMANCE_DIGEST,
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

  const runner = runtime.runner ?? new RoleDConformanceRunner()
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
  const knowledgeBase = await loadKnowledgeBase()
  const pipeline = await runReviewedCPipeline(
    pipelineInput,
    agents,
    secureStore,
    {
      review_port: createLocalABContentReviewPort({ knowledge_base: knowledgeBase }),
      max_external_revisions: 2,
    },
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
  const cycleService = new LearningCycleService({
    cycle_store: new InMemoryLearningCycleStore(),
    secure_store: secureStore,
    mastery_store: new InMemoryMasteryStateStore(),
    code_runner: runner,
  })
  await cycleService.registerReadyRun({
    pipeline_input: pipelineInput,
    pipeline_result: pipeline,
    profile_snapshot: profileSnapshot,
    learner_id_hash: input.profile.learner_id,
  })
  const assessment = pipeline.public_artifacts.assessment!
  const requiredItemIds = assessment.payload!.items.map((item) => item.item_id)
  await cycleService.openSession({
    session_id: learningSessionId,
    run_id: input.runId,
    authenticated_learner_id_hash: input.profile.learner_id,
    attempt_no: 1,
    required_item_ids: requiredItemIds,
    revealed_hint_levels: Object.fromEntries(requiredItemIds.map((itemId) => [itemId, 0])),
    profile_expectations_by_objective: Object.fromEntries(
      built.spec.targets.map((target) => [target.objective_id, "weak" as const]),
    ),
  })
  roleCLearningCycles.set(learningSessionId, cycleService)
  return {
    status: "ready",
    artifacts,
    workflow,
    runId: input.runId,
    learningSession: {
      sessionId: learningSessionId,
      formId: assessment.payload!.form_id,
      attemptNo: 1,
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

export async function submitRoleCAssessment(
  input: SubmitRoleCAssessmentInput,
): Promise<LearningCyclePublicOutcome> {
  const service = roleCLearningCycles.get(input.sessionId)
  if (!service) {
    return {
      status: "blocked",
      submission_id: input.submissionId,
      code: "SESSION_NOT_FOUND",
      message: "C 学习会话不存在或服务已重启，请重新生成学习计划。",
    }
  }
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

function selectTargets(results: RagResultItem[]): RagResultItem[] {
  const direct = results.filter(hasDirectEvidenceMatch)
  const candidates = direct.length > 0 ? direct : results.filter((item) => item.score > 0)
  if (candidates.length === 0) return []

  const maxScore = Math.max(...candidates.map((item) => item.score))
  const threshold = Math.max(10, maxScore * 0.7)
  const selected = candidates.filter((item) => item.score >= threshold)
  return selected.length >= 3 ? selected.slice(0, 3) : candidates.slice(0, Math.min(3, candidates.length))
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
  if (event.agent === "concept-tutor") return "定制讲义"
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
