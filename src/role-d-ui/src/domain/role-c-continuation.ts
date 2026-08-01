import {
  ROLE_C_API_PATHS,
  type ContinueRoleCAfterSubmissionInput,
  type ContinueRoleCForRoleDResult,
  type RoleDWorkflowEvent,
  type RouteRoleCAssessmentAnchorsInput,
  type RouteRoleCAssessmentAnchorsResult,
} from "../../../role-d-integration/contracts"
import type {
  ConceptLessonArtifact,
  CodeLabPublicArtifact,
  AssessmentPublicArtifact,
  RenderBlock,
} from "../../../role-c-content/contracts/artifacts"
import type { CitationRef } from "../../../role-c-content/contracts/common"
import type { RoleCReviewedReleaseDelivery } from "../../../role-c-content/contracts/external-api"
import type { LearningArtifactView } from "./types"

/**
 * D-side client for the official "continue after completed submission" endpoint.
 * C reloads the completed submission and current profile/evidence from its own
 * private store; D only sends stable identities plus optional B-owned context.
 */
export async function continueRoleCAfterSubmission(
  input: ContinueRoleCAfterSubmissionInput,
): Promise<ContinueRoleCForRoleDResult> {
  const response = await fetch(ROLE_C_API_PATHS.continue, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const payload: unknown = await response.json()
  if (response.ok && isPublishedContinuation(payload)) return payload
  if (!response.ok && isBlockedContinuation(payload)) return payload
  if (!response.ok && isAwaitingContinuation(payload)) return payload
  return {
    status: "blocked",
    stage: "configuration",
    reason: "C 返回了不符合公开合同的续轮响应。",
  }
}

function isPublishedContinuation(value: unknown): value is Extract<ContinueRoleCForRoleDResult, { status: "published" }> {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "published"
}

function isAwaitingContinuation(value: unknown): value is Extract<ContinueRoleCForRoleDResult, { status: "awaiting_input" }> {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "awaiting_input"
}

function isBlockedContinuation(value: unknown): value is Extract<ContinueRoleCForRoleDResult, { status: "blocked" | "failed" }> {
  return typeof value === "object" && value !== null
    && ((value as { status?: unknown }).status === "blocked" || (value as { status?: unknown }).status === "failed")
}

/**
 * D-side client for the official anchor routing endpoint. Submits the anchor
 * answers of an anchor_pending session so C can lock the assessment route.
 */
export async function routeRoleCAssessmentAnchors(
  input: RouteRoleCAssessmentAnchorsInput,
): Promise<RouteRoleCAssessmentAnchorsResult> {
  const response = await fetch(ROLE_C_API_PATHS.routeAnchors, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const payload: unknown = await response.json()
  if (response.ok && isRoutedAnchors(payload)) return payload
  if (!response.ok && (isBlockedAnchors(payload) || isReviewAnchors(payload))) return payload
  return {
    status: "blocked",
    routing_request_id: input.routingRequestId,
    issues: ["C 返回了不符合公开合同的锚点路由响应。"],
  }
}

function isRoutedAnchors(value: unknown): value is Extract<RouteRoleCAssessmentAnchorsResult, { status: "routed" }> {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "routed"
}

function isReviewAnchors(value: unknown): value is Extract<RouteRoleCAssessmentAnchorsResult, { status: "needs_review" }> {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "needs_review"
}

function isBlockedAnchors(value: unknown): value is Extract<RouteRoleCAssessmentAnchorsResult, { status: "blocked" }> {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "blocked"
}

/** Converts the published reviewed-release delivery into the learner-facing artifact list. */
export function continuationToRoleDArtifacts(
  delivery: RoleCReviewedReleaseDelivery,
): LearningArtifactView[] {
  const concept = delivery.artifacts.find((entry) => entry.artifact_type === "concept_lesson") as ConceptLessonArtifact | undefined
  const lab = delivery.artifacts.find((entry) => entry.artifact_type === "code_lab_public") as CodeLabPublicArtifact | undefined
  const assessment = delivery.artifacts.find((entry) => entry.artifact_type === "assessment_public") as AssessmentPublicArtifact | undefined
  if (!concept?.payload || !lab?.payload || !assessment?.payload) return []

  const assessmentItems = assessment.payload.items.map((item) => ({
    id: item.item_id,
    tier: item.tier,
    modality: item.modality,
    prompt: item.prompt,
    options: item.options?.map((option) => `${option.label}. ${option.text}`) ?? [],
    optionIds: item.options?.map((option) => option.option_id) ?? [],
    maxScore: item.max_score,
    ...(item.starter_code ? { starterCode: item.starter_code } : {}),
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
      evidenceStatus: "grounded",
      sections: conceptSections(concept.payload),
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
      evidenceStatus: "grounded",
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
      evidenceStatus: "grounded",
    },
  ]
}

/** Converts the published trace events into the learner-facing workflow timeline. */
export function continuationToRoleDWorkflow(
  traceEvents: RoleCReviewedReleaseDelivery["trace_events"],
): RoleDWorkflowEvent[] {
  return traceEvents.map((event) => {
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
  })
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

function conceptSections(payload: NonNullable<ConceptLessonArtifact["payload"]>): NonNullable<LearningArtifactView["sections"]> {
  const blocks = [...payload.prerequisite_bridge, ...payload.explanation_blocks, ...payload.worked_examples, ...payload.summary]
  return [
    ...blocks.flatMap((block) => toRoleDSection(block)),
    ...payload.misconceptions.map((item, index) => ({
      id: `misconception-${index + 1}`,
      title: "常见误区",
      kind: "callout" as const,
      text: item.explanation,
      citations: simplifyCitations(item.citations),
    })),
  ]
}

function toRoleDSection(block: RenderBlock): NonNullable<LearningArtifactView["sections"]> {
  if (block.block_type === "heading") return [{ id: block.block_id, title: block.text, kind: "heading", text: block.text, citations: [] }]
  if (block.block_type === "paragraph") return [{ id: block.block_id, title: block.text.split(/[。！？]/)[0]!.slice(0, 28), kind: "paragraph", text: block.text, citations: simplifyCitations(block.claims.flatMap((claim) => claim.citations)) }]
  if (block.block_type === "code") return [{ id: block.block_id, title: block.caption ?? "代码示例", kind: "code", code: block.code, language: block.language, citations: simplifyCitations(block.claims.flatMap((claim) => claim.citations)) }]
  if (block.block_type === "callout") return [{ id: block.block_id, title: block.title, kind: "callout", text: block.text, citations: simplifyCitations(block.claims.flatMap((claim) => claim.citations)) }]
  if (block.block_type === "comparison") return [{ id: block.block_id, title: block.title, kind: "comparison", text: block.columns.map((column) => `${column.heading}：${column.content}`).join("\n"), citations: simplifyCitations(block.claims.flatMap((claim) => claim.citations)) }]
  return []
}

function renderCodeLab(payload: NonNullable<CodeLabPublicArtifact["payload"]>): string {
  const instructions = payload.instructions.flatMap((block) => "text" in block ? [block.text] : [])
  const tests = payload.public_tests.map((test) => `公开测试：${test.description}（${test.expected_behavior}）`)
  return [...instructions, "Starter code:", payload.starter_code, ...tests].join("\n\n")
}

function simplifyCitations(citations: CitationRef[]): LearningArtifactView["citations"] {
  return [...new Map(citations.map((citation) => [
    `${citation.source_id}:${citation.fact_id}`,
    { sourceId: citation.source_id, factId: citation.fact_id },
  ])).values()]
}

function stageLabel(event: RoleCReviewedReleaseDelivery["trace_events"][number]): string {
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
