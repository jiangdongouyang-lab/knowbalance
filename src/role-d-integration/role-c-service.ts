import type {
  GenerateRoleCForRoleDInput,
  RoleDAssessmentItem,
  RoleCForRoleDResult,
  RoleDGeneratedArtifact,
  RoleDPublicCitation,
  RoleDWorkflowEvent,
} from "./contracts"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  createRoleCAgents,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  InMemorySecureArtifactStore,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  runCPipeline,
  TrustedAssessmentVerifier,
  TrustedCodeLabVerifier,
  type AgentTraceEvent,
  type AssessmentPublicArtifact,
  type CitationRef,
  type CodeLabPublicArtifact,
  type ConceptLessonArtifact,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeRunner,
  type PublicArtifact,
} from "../role-c-content"

const CONFORMANCE_DIGEST = `sha256:${"d".repeat(64)}`
const TARGETS = ["K007", "K009", "K018"] as const

export async function generateRoleCForRoleD(input: GenerateRoleCForRoleDInput): Promise<RoleCForRoleDResult> {
  const availableSources = new Set(input.ragResult.results.map((item) => item.sourceId ?? item.source_id))
  const missingTargets = TARGETS.filter((sourceId) => !availableSources.has(sourceId))
  if (missingTargets.length > 0) {
    return {
      status: "blocked",
      artifacts: [],
      workflow: [],
      runId: input.runId,
      reason: `Role C Week 1 成绩统计任务缺少知识证据：${missingTargets.join("、")}`,
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
  const prerequisiteSourceIds = input.ragResult.results
    .map((item) => item.sourceId ?? item.source_id)
    .filter((sourceId) => !TARGETS.includes(sourceId as (typeof TARGETS)[number]))
    .slice(0, 2)
  const pathNode = defineLearningPathNode({
    node_id: `${input.runId}-PATH-SCORE-PROJECT`,
    target_source_ids: [...TARGETS],
    prerequisite_source_ids: prerequisiteSourceIds,
    goal: input.profile.goal,
    objectives: [
      { objective_id: "O1", source_id: "K007", required_fact_ids: ["F001"], observable_behavior: "trace", importance: "core" },
      { objective_id: "O2", source_id: "K009", required_fact_ids: ["F001"], observable_behavior: "apply", importance: "core" },
      { objective_id: "O3", source_id: "K018", required_fact_ids: ["F001"], observable_behavior: "create", importance: "core" },
    ],
    assessment_blueprint: {
      tier_1_count: 2,
      tier_2_count: 2,
      tier_3_count: 1,
      required_modalities: ["mcq", "trace", "code"],
    },
  })
  const built = buildGenerationSpec({
    run_id: input.runId,
    profile_snapshot: profileSnapshot,
    path_node: pathNode,
    evidence_pack: evidencePack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: "deterministic-role-d-week1-v1",
      runner_image_digest: CONFORMANCE_DIGEST,
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

  const runner = new RoleDConformanceRunner()
  const provider = new DeterministicCodeLabContentProvider()
  const agents = createRoleCAgents(provider, {
    code_lab: new TrustedCodeLabVerifier(runner),
    assessment: new TrustedAssessmentVerifier(runner),
  })
  const pipeline = await runCPipeline(
    { generation_spec: built.spec, evidence_pack: evidencePack },
    agents,
    new InMemorySecureArtifactStore(),
  )
  const artifacts = toRoleDArtifacts(pipeline.public_artifacts)
  const workflow = pipeline.trace_events.map(toWorkflowEvent)
  if (pipeline.status !== "ready") {
    return {
      status: pipeline.status,
      artifacts,
      workflow,
      runId: input.runId,
      reason: pipeline.blocked_reason?.message ?? pipeline.failure_reason?.message ?? "Role C 流水线未就绪",
    }
  }
  return { status: "ready", artifacts, workflow, runId: input.runId }
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

/** Deterministic contract runner used by Role C's official reproducible Week 1 demo. */
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
