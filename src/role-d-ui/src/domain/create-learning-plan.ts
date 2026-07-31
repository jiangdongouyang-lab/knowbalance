import { loadKnowledgeBase } from "../../../knowledge/loader"
import type { KnowledgeBase, KnowledgeDifficulty, KnowledgeItem, KnowledgeQuizItem } from "../../../knowledge/types"
import { executeProfileRetrieval } from "../../../role-b-profile/rag-bridge"
import { synthesizeProfile } from "../../../role-b-profile/profile-synthesizer"
import type { BackgroundEvidence, ObjectiveDiagnosisEvidence, SelfAssessmentEvidence } from "../../../role-b-profile/types"
import type { RagResult, RagResultItem } from "../../../rag/retriever"
import type { RoleCForRoleDResult } from "../../../role-d-integration/contracts"
import { adaptHandoff } from "./adapt-handoff"
import { requestRoleCContent } from "./role-c-client"
import type { RoleDSession } from "./types"

export interface NewLearningPlanInput {
  learnerId: string
  educationContext: string
  timeBudget: string
  selfRating: KnowledgeDifficulty
  priorLanguages?: string[]
  knownConcepts: string[]
  weakConcepts: string[]
  goal: string
}

export interface PlanDiagnosis {
  items: PlanDiagnosisItem[]
  sourceId: string
  factId: string
  concept: string
  difficulty: KnowledgeDifficulty
  question: string
  options: string[]
  answer: string
}

export interface PlanDiagnosisItem {
  id: string
  sourceId: string
  factId: string
  concept: string
  difficulty: KnowledgeDifficulty
  question: string
  options: string[]
  answer: string
}

export interface CreatedLearningPlan {
  source: "real-ab"
  input: NewLearningPlanInput
  diagnosis: PlanDiagnosis
  session: RoleDSession
}

export type RoleCRequester = (input: Parameters<typeof requestRoleCContent>[0]) => Promise<RoleCForRoleDResult>

export async function createLearningPlan(input: NewLearningPlanInput, requestRoleC: RoleCRequester = requestRoleCContent): Promise<CreatedLearningPlan> {
  const knowledgeBase = await loadKnowledgeBase()
  const evidence = buildEvidence(input, [])
  const synthesis = synthesizeProfile({ ...evidence, knowledgeBase })
  const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)
  const diagnosisRagResult = expandDiagnosisEvidence(ragResult, knowledgeBase)
  const diagnosis = selectDiagnosis(diagnosisRagResult, knowledgeBase)
  const sessionId = `session-${input.learnerId}-${Date.now()}`
  const roleC = await requestRoleC({
    profile: synthesis.profile,
    ragResult,
    kbVersion: knowledgeBase.version,
    runId: `RUN-${sessionId}`,
  })
  const session = buildSession(input, synthesis, diagnosisRagResult, diagnosis, roleC, sessionId)
  return { source: "real-ab", input, diagnosis, session }
}

export async function evaluatePlanDiagnosis(plan: CreatedLearningPlan, answers: Record<string, string> | string, requestRoleC: RoleCRequester = requestRoleCContent): Promise<CreatedLearningPlan> {
  const firstId = plan.diagnosis.items[0]?.id ?? "legacy"
  const answerMap = typeof answers === "string" ? { [firstId]: answers } : answers
  const objectiveItems: ObjectiveDiagnosisEvidence["items"] = plan.diagnosis.items.map((item) => {
    const learnerAnswer = answerMap[item.id] ?? ""
    return {
      source_id: item.sourceId,
      fact_id: item.factId,
      question: item.question,
      learner_answer: learnerAnswer,
      verdict: normalize(learnerAnswer) === normalize(item.answer) ? "correct" : "incorrect",
      concept: item.concept,
      difficulty: item.difficulty,
    }
  })
  const knowledgeBase = await loadKnowledgeBase()
  const evidence = buildEvidence(plan.input, objectiveItems)
  const synthesis = synthesizeProfile({ ...evidence, knowledgeBase })
  const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)
  const diagnosisRagResult = expandDiagnosisEvidence(ragResult, knowledgeBase)
  const roleC = await requestRoleC({
    profile: synthesis.profile,
    ragResult,
    kbVersion: knowledgeBase.version,
    runId: `RUN-${plan.session.sessionId}-diagnosed`,
  })
  const session = buildSession(plan.input, synthesis, diagnosisRagResult, plan.diagnosis, roleC, plan.session.sessionId)
  session.view.diagnosisAnswers = answerMap
  session.view.diagnosisAnswer = answerMap[firstId] ?? ""
  session.view.diagnosisSubmitted = true
  return { ...plan, session }
}

function buildEvidence(input: NewLearningPlanInput, items: ObjectiveDiagnosisEvidence["items"]): {
  background: BackgroundEvidence
  selfAssessment: SelfAssessmentEvidence
  objectiveDiagnosis: ObjectiveDiagnosisEvidence
} {
  return {
    background: {
      evidence_type: "background",
      learner_id: input.learnerId,
      education_context: input.educationContext || null,
      prior_languages: input.priorLanguages ?? [],
      prior_topics: input.knownConcepts,
      goal_raw: input.goal,
      time_budget: input.timeBudget || null,
      quotes: [],
    },
    selfAssessment: {
      evidence_type: "self_assessment",
      self_rating: input.selfRating,
      claimed_known: input.knownConcepts,
      claimed_weak: input.weakConcepts,
      quotes: [],
    },
    objectiveDiagnosis: {
      evidence_type: "objective_diagnosis",
      items,
      quotes: [],
    },
  }
}

function expandDiagnosisEvidence(ragResult: RagResult, knowledgeBase: KnowledgeBase): RagResult {
  const byId = new Map(knowledgeBase.items.map((item) => [item.sourceId, item]))
  const targetText = extractDiagnosisTargetText(ragResult.query)
  const anchors = ragResult.results.filter((item) => {
    if (!hasSemanticMatch(item)) return false
    if (targetText.length === 0) return true
    const knowledge = byId.get(item.sourceId)
    return Boolean(knowledge && knowledgeMatchesTarget(knowledge, targetText))
  })
  if (anchors.length === 0) throw new Error("A 检索结果中没有语义相关的可诊断知识点，请换一个知识库支持的学习目标")
  const included = new Set(anchors.map((item) => item.sourceId))
  const expanded = [...anchors]
  const queue = anchors.flatMap((item) => byId.get(item.sourceId)?.prerequisites ?? [])

  while (queue.length > 0 && expanded.length < 10) {
    const sourceId = queue.shift()!
    if (included.has(sourceId)) continue
    const item = byId.get(sourceId)
    if (!item) continue
    included.add(sourceId)
    expanded.push(toPrerequisiteResult(item))
    queue.push(...item.prerequisites)
  }

  return { ...ragResult, topK: expanded.length, results: expanded }
}

function toPrerequisiteResult(item: KnowledgeItem): RagResultItem {
  const scoreBreakdown = { keyword: 0, title: 0, facts: 0, practiceTasks: 0, difficulty: 0, bonus: 0 }
  return {
    sourceId: item.sourceId,
    source_id: item.sourceId,
    title: item.title,
    difficulty: item.difficulty,
    score: 0,
    reason: "由 A 命中知识点的 prerequisites 关系补充，用于客观诊断前置基础。",
    snippet: item.snippet,
    facts: item.facts,
    examples: item.examples,
    practiceTasks: item.practiceTasks,
    quizItems: item.quizItems,
    file: item.file,
    retrievalTrace: {
      matchedKeywords: [],
      matchedFields: ["prerequisite"],
      difficultyMatch: true,
      scoreBreakdown,
    },
    retrieval_trace: {
      matched_keywords: [],
      matched_fields: ["prerequisite"],
      difficulty_match: true,
      score_breakdown: scoreBreakdown,
    },
  }
}

function hasSemanticMatch(item: RagResultItem): boolean {
  const semanticFields = item.retrievalTrace.matchedFields.filter((field) => field !== "difficulty")
  const scores = item.retrievalTrace.scoreBreakdown
  return item.retrievalTrace.matchedKeywords.length > 0
    || semanticFields.length > 0
    || scores.keyword > 0
    || scores.title > 0
    || scores.facts > 0
    || scores.practiceTasks > 0
    || scores.bonus > 0
}

const MAX_DIAGNOSIS_ITEMS = 5

type DiagnosisCandidate = Pick<RagResultItem, "sourceId" | "title" | "difficulty" | "quizItems">

function selectDiagnosis(ragResult: RagResult, knowledgeBase: KnowledgeBase): PlanDiagnosis {
  const items: PlanDiagnosisItem[] = []
  const usedQuizKeys = new Set<string>()
  const supplemental = supplementalDiagnosisCandidates(ragResult.results, knowledgeBase)

  const targetMatches = ragResult.results.filter((item) => hasDiagnosisTargetMatch(item, ragResult.query, knowledgeBase))
  const focusedTarget = targetMatches.length === 1 ? targetMatches[0] : undefined
  if (focusedTarget) {
    addDiagnosisCandidates(items, [focusedTarget], usedQuizKeys, "all")
    if (items.length === 0) throw new Error("A 精确命中的知识点没有可直接作答的选择题，请让 A 补充该知识点的 quizItems")
  }
  if (items.length > 0) return { ...items[0]!, items }
  addDiagnosisCandidates(items, ragResult.results, usedQuizKeys, "one-per-source")
  if (items.length === 0) {
    addDiagnosisCandidates(items, supplemental, usedQuizKeys, "one-per-source")
  }

  if (items.length > 0) return { ...items[0]!, items }
  throw new Error("A 检索结果中没有可直接作答的知识库选择题，请补充已学或薄弱知识后重试")
}

function hasDiagnosisTargetMatch(item: RagResultItem, query: string, knowledgeBase: KnowledgeBase): boolean {
  const targetText = extractDiagnosisTargetText(query)
  if (targetText.length === 0) return hasDirectTargetMatch(item)
  const knowledge = knowledgeBase.items.find((candidate) => candidate.sourceId === item.sourceId)
  if (!knowledge) return hasDirectTargetMatch(item)
  return knowledgeMatchesTarget(knowledge, targetText)
}

function extractDiagnosisTargetText(query: string): string {
  return query
    .split("；")
    .filter((part) => part.startsWith("薄弱点：") || part.startsWith("学习目标："))
    .map((part) => part.replace(/^[^：]+：/, "").trim())
    .filter((part) => part.length > 0 && part !== "无")
    .join("；")
}

function knowledgeMatchesTarget(item: KnowledgeItem, targetText: string): boolean {
  const target = normalize(targetText)
  return [
    item.title,
    ...item.keywords,
    item.snippet,
    ...item.facts.map((fact) => fact.content),
    ...item.practiceTasks,
    ...item.quizItems.map((quiz) => quiz.question),
  ].some((value) => {
    const candidate = normalize(value)
    return candidate.length >= 2 && (target.includes(candidate) || candidate.includes(target))
  })
}

function addDiagnosisCandidates(items: PlanDiagnosisItem[], candidates: DiagnosisCandidate[], usedQuizKeys: Set<string>, mode: "all" | "one-per-source"): void {
  for (const item of candidates) {
    for (const quiz of item.quizItems.filter((candidate) => candidate.options && candidate.options.length > 1)) {
      const quizKey = `${quiz.sourceId}:${quiz.factId}:${quiz.question}`
      if (usedQuizKeys.has(quizKey)) continue
      items.push(normalizeDiagnosis(item, quiz, items.length))
      usedQuizKeys.add(quizKey)
      if (mode === "one-per-source") break
      if (items.length === MAX_DIAGNOSIS_ITEMS) break
    }
    if (items.length === MAX_DIAGNOSIS_ITEMS) break
  }
}

function hasDirectTargetMatch(item: RagResultItem): boolean {
  const directFields = item.retrievalTrace.matchedFields.filter((field) => field !== "difficulty" && field !== "prerequisite")
  const scores = item.retrievalTrace.scoreBreakdown
  return item.retrievalTrace.matchedKeywords.length > 0 || directFields.length > 0 || scores.keyword > 0 || scores.title > 0 || scores.facts > 0 || scores.practiceTasks > 0 || scores.bonus > 0
}

function supplementalDiagnosisCandidates(ragItems: RagResultItem[], knowledgeBase: KnowledgeBase): DiagnosisCandidate[] {
  const byId = new Map(knowledgeBase.items.map((item) => [item.sourceId, item]))
  const dependents = new Map<string, string[]>()
  for (const item of knowledgeBase.items) {
    for (const prerequisite of item.prerequisites) {
      dependents.set(prerequisite, [...(dependents.get(prerequisite) ?? []), item.sourceId])
    }
  }

  const ordered: DiagnosisCandidate[] = []
  const visited = new Set<string>()
  const queue = ragItems.map((item) => item.sourceId)
  while (queue.length > 0 && visited.size < knowledgeBase.items.length) {
    const sourceId = queue.shift()!
    if (visited.has(sourceId)) continue
    visited.add(sourceId)
    const item = byId.get(sourceId)
    if (!item) continue
    ordered.push(item)
    queue.push(...item.prerequisites, ...(dependents.get(sourceId) ?? []))
  }
  return ordered
}

function normalizeDiagnosis(item: DiagnosisCandidate, quiz: KnowledgeQuizItem, index: number): PlanDiagnosisItem {
  return {
    id: `${quiz.sourceId}-${quiz.factId}-${index + 1}`,
    sourceId: quiz.sourceId,
    factId: quiz.factId,
    concept: item.title,
    difficulty: item.difficulty,
    question: quiz.question,
    options: quiz.options ?? [],
    answer: quiz.answer,
  }
}

function buildSession(
  input: NewLearningPlanInput,
  synthesis: ReturnType<typeof synthesizeProfile>,
  ragResult: RagResult,
  diagnosis: PlanDiagnosis,
  roleC: RoleCForRoleDResult,
  sessionId = `session-${input.learnerId}-${Date.now()}`,
): RoleDSession {
  const path = buildPath(ragResult, synthesis.provenance.concepts)
  const artifacts = roleC.artifacts
  const roleCWorkflow = roleC.workflow.length > 0
    ? roleC.workflow
    : [{
        id: `${roleC.runId}-blocked`,
        agent: "role-c-pipeline",
        stage: "个性化资源",
        status: "blocked" as const,
        summary: "reason" in roleC ? roleC.reason : "Role C 未返回公开产物。",
        timestamp: new Date().toISOString(),
      }]
  return adaptHandoff({
    eventMode: "demo",
    planSource: "real-ab",
    planInput: input,
    diagnosis,
    session_id: sessionId,
    updated_at: new Date().toISOString(),
    b_profile: synthesis.profile,
    b_provenance: synthesis.provenance,
    a_rag_result: ragResult,
    learning_path: path,
    workflow_events: [
      { id: "ab-background", agent: "input-normalizer", stage: "输入标准化", status: "completed", summary: `已整理${input.educationContext || "学习者"}的目标与时间预算。`, timestamp: "刚刚" },
      { id: "ab-profile", agent: "synthesizeProfile()", stage: "B 画像合成", status: "completed", summary: `B 本地函数已生成 ${synthesis.profile.level} 画像。`, timestamp: "刚刚" },
      { id: "ab-rag", agent: "executeProfileRetrieval()", stage: "A 知识检索", status: "completed", summary: `A 本地检索器已返回 ${ragResult.results.length} 个候选知识点。`, timestamp: "刚刚" },
      ...roleCWorkflow,
      ...auditWorkflowEvents(roleC),
    ],
    c_artifacts: artifacts,
    ...(roleC.audit ? { audit: roleC.audit } : {}),
    ...(roleC.status === "ready" && roleC.learningSession ? {
      roleC: {
        runId: roleC.runId,
        learningSessionId: roleC.learningSession.sessionId,
        formId: roleC.learningSession.formId,
        attemptNo: roleC.learningSession.attemptNo,
      },
    } : {}),
    assessmentGraded: false,
    decision: { next: "remediate", reason: `等待完成 ${diagnosis.concept} 的客观诊断后更新决策。` },
    view: {
      currentStage: "diagnosis",
      maxUnlockedStage: "diagnosis",
      activeArtifactKind: "lesson",
      selectedSourceId: ragResult.results[0]?.sourceId ?? "",
      remediationStarted: false,
      goalDraft: input.goal,
      selfRatingDraft: input.selfRating,
      diagnosisAnswer: "",
      diagnosisAnswers: {},
      diagnosisSubmitted: false,
      assessmentAnswers: {},
      assessmentSubmitted: false,
      assessmentStatus: "idle",
      assessmentMessage: "",
      detailDrawer: "none",
    },
  })
}

function auditWorkflowEvents(roleC: RoleCForRoleDResult): RoleDSession["workflow"] {
  if (!roleC.audit) return []
  return [
    {
      id: `${roleC.runId}-fact-audit`,
      agent: "auditGeneratedContent()",
      stage: "A 事实审核",
      status: auditStatusToWorkflow(roleC.audit.factStatus),
      summary: `A 已检查 ${roleC.audit.factAudits.reduce((sum, item) => sum + item.checkedClaims, 0)} 条内容声明，冲突 ${roleC.audit.factAudits.reduce((sum, item) => sum + item.conflicts, 0)} 个。`,
      timestamp: "刚刚",
    },
    {
      id: `${roleC.runId}-teaching-audit`,
      agent: "auditTeaching()",
      stage: "B 教学审核",
      status: auditStatusToWorkflow(roleC.audit.teachingAudit.status),
      summary: roleC.audit.teachingAudit.summary,
      timestamp: "刚刚",
    },
    {
      id: `${roleC.runId}-arbitration`,
      agent: "arbitrate()",
      stage: "B 仲裁",
      status: auditStatusToWorkflow(roleC.audit.arbitration.decision),
      summary: roleC.audit.arbitration.reason,
      timestamp: "刚刚",
    },
  ]
}

function auditStatusToWorkflow(status: "pass" | "revise" | "reject"): RoleDSession["workflow"][number]["status"] {
  if (status === "pass") return "completed"
  if (status === "revise") return "review"
  return "blocked"
}

function buildPath(
  ragResult: RagResult,
  concepts: ReturnType<typeof synthesizeProfile>["provenance"]["concepts"],
) {
  let currentAssigned = false
  const nodes = ragResult.results.slice(0, 5).map((item): RoleDSession["path"][number] => {
    const conceptEvidence = concepts.find((concept) =>
      concept.matched_source_ids.includes(item.sourceId)
      && normalize(concept.concept) === normalize(item.title))
    const completed = conceptEvidence?.bucket === "known"
    const status = completed ? "completed" : currentAssigned ? "upcoming" : "current"
    if (status === "current") currentAssigned = true
    return {
      id: item.sourceId,
      title: item.title,
      difficulty: item.difficulty,
      status,
      reason: completed
        ? "B 画像将其标记为已掌握。"
        : conceptEvidence?.bucket === "weak"
          ? conceptEvidence.source === "objective"
            ? "客观诊断答错，B 画像将其标记为待补强。"
            : "B 画像将其标记为待补强。"
          : item.reason,
    }
  })
  const order: Record<RoleDSession["path"][number]["status"], number> = { completed: 0, current: 1, upcoming: 2 }
  return nodes.sort((left, right) => order[left.status] - order[right.status])
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
