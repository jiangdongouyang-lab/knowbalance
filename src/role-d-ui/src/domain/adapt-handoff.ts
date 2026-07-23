import type {
  Difficulty,
  LearningArtifactView,
  LearningPathNodeView,
  RetrievalItemView,
  RoleDSession,
  WorkflowEventView,
} from "./types"

type LooseRecord = Record<string, any>

export function adaptHandoff(input: LooseRecord): RoleDSession {
  const profile = input.b_profile ?? input.profile ?? {}
  const provenance = input.b_provenance ?? input.provenance ?? {}
  const rag = input.a_rag_result ?? input.rag_result ?? {}
  const retrievalItems: RetrievalItemView[] = (rag.results ?? []).map(normalizeRetrievalItem)
  const validCitationIds = new Set<string>(retrievalItems.flatMap((item) => item.facts.map((fact) => `${fact.sourceId}-${fact.factId}`)))
  const artifacts = (input.c_artifacts ?? input.artifacts ?? []).map((artifact: LooseRecord) => normalizeArtifact(artifact, validCitationIds))

  return {
    version: 1,
    eventMode: input.eventMode === "live" ? "live" : "demo",
    sessionId: input.session_id ?? input.sessionId ?? `session-${profile.learner_id ?? "anonymous"}`,
    updatedAt: input.updated_at ?? input.updatedAt ?? new Date(0).toISOString(),
    profile: {
      learnerId: profile.learner_id ?? profile.learnerId ?? "anonymous_learner",
      level: normalizeDifficulty(profile.level),
      knownConcepts: profile.known_concepts ?? profile.knownConcepts ?? [],
      weakConcepts: profile.weak_concepts ?? profile.weakConcepts ?? [],
      goal: profile.goal ?? "未提供学习目标",
    },
    conflicts: (provenance.conflicts ?? []).map((conflict: LooseRecord) => ({
      concept: conflict.concept,
      selfClaim: conflict.self_claim ?? conflict.selfClaim,
      objectiveVerdict: conflict.objective_verdict ?? conflict.objectiveVerdict,
      resolution: conflict.resolution,
      rule: conflict.rule,
    })),
    retrieval: {
      query: rag.query ?? "",
      topK: rag.topK ?? rag.top_k ?? rag.results?.length ?? 0,
      items: retrievalItems,
    },
    artifacts,
    evidenceGaps: artifacts.filter((artifact: LearningArtifactView) => artifact.evidenceStatus === "gap").map((artifact: LearningArtifactView) => artifact.id),
    workflow: (input.workflow_events ?? input.workflowEvents ?? []).map(normalizeWorkflowEvent),
    path: (input.learning_path ?? input.learningPath ?? []).map(normalizePathNode),
    decision: {
      next: input.decision?.next ?? "remediate",
      reason: input.decision?.reason ?? "等待测评结果后由决策策略更新。",
    },
    assessmentGraded: input.assessmentGraded === true,
    planSource: input.planSource === "real-ab" ? "real-ab" : "demo",
    planInput: {
      learnerId: input.planInput?.learnerId ?? profile.learner_id ?? profile.learnerId ?? "anonymous_learner",
      educationContext: input.planInput?.educationContext ?? "",
      timeBudget: input.planInput?.timeBudget ?? "",
      knownConcepts: input.planInput?.knownConcepts ?? profile.known_concepts ?? profile.knownConcepts ?? [],
      weakConcepts: input.planInput?.weakConcepts ?? profile.weak_concepts ?? profile.weakConcepts ?? [],
    },
    diagnosis: {
      sourceId: input.diagnosis?.sourceId ?? "K007",
      factId: input.diagnosis?.factId ?? "F001",
      concept: input.diagnosis?.concept ?? "for 循环",
      difficulty: normalizeDifficulty(input.diagnosis?.difficulty ?? "beginner"),
      question: input.diagnosis?.question ?? "for 循环最适合用于什么场景？",
      options: input.diagnosis?.options ?? ["遍历序列", "定义变量", "捕获异常", "导入模块"],
      answer: input.diagnosis?.answer ?? "遍历序列",
    },
    view: {
      currentStage: input.view?.currentStage ?? "onboarding",
      maxUnlockedStage: input.view?.maxUnlockedStage ?? "onboarding",
      activeArtifactKind: input.view?.activeArtifactKind ?? "lesson",
      selectedSourceId: input.view?.selectedSourceId ?? retrievalItems[0]?.sourceId ?? "",
      remediationStarted: input.view?.remediationStarted ?? false,
      goalDraft: input.view?.goalDraft ?? profile.goal ?? "",
      selfRatingDraft: normalizeDifficulty(input.view?.selfRatingDraft ?? profile.level),
      diagnosisAnswer: input.view?.diagnosisAnswer ?? "",
      diagnosisSubmitted: input.view?.diagnosisSubmitted ?? false,
      assessmentAnswers: input.view?.assessmentAnswers ?? {},
      detailDrawer: input.view?.detailDrawer === "agents" || input.view?.detailDrawer === "evidence" ? input.view.detailDrawer : "none",
    },
  }
}

function normalizeRetrievalItem(item: LooseRecord): RetrievalItemView {
  const trace = item.retrievalTrace ?? item.retrieval_trace ?? {}
  const breakdown = trace.scoreBreakdown ?? trace.score_breakdown ?? {}

  return {
    sourceId: item.sourceId ?? item.source_id ?? "UNKNOWN",
    title: item.title ?? "未命名知识点",
    difficulty: normalizeDifficulty(item.difficulty),
    score: item.score ?? 0,
    reason: item.reason ?? "无推荐说明",
    snippet: item.snippet ?? "",
    file: item.file ?? "",
    facts: (item.facts ?? []).map((fact: LooseRecord) => ({
      sourceId: fact.sourceId ?? fact.source_id ?? item.sourceId ?? item.source_id ?? "UNKNOWN",
      factId: fact.factId ?? fact.fact_id ?? "UNKNOWN",
      content: fact.content ?? "",
    })),
    examples: (item.examples ?? []).map((example: LooseRecord | string) => typeof example === "string"
      ? { title: "示例", code: example, explanation: "" }
      : { title: example.title ?? "示例", code: example.code ?? "", explanation: example.explanation ?? "" }),
    practiceTasks: item.practiceTasks ?? item.practice_tasks ?? [],
    quizItems: (item.quizItems ?? item.quiz_items ?? []).map((quiz: LooseRecord | string) => typeof quiz === "string"
      ? { level: 1, question: quiz, answer: "" }
      : { level: quiz.level ?? 1, question: quiz.question ?? "", answer: quiz.answer ?? "" }),
    trace: {
      matchedKeywords: trace.matchedKeywords ?? trace.matched_keywords ?? [],
      matchedFields: trace.matchedFields ?? trace.matched_fields ?? [],
      difficultyMatch: trace.difficultyMatch ?? trace.difficulty_match ?? false,
      scoreBreakdown: {
        keyword: breakdown.keyword ?? 0,
        title: breakdown.title ?? 0,
        facts: breakdown.facts ?? 0,
        practiceTasks: breakdown.practiceTasks ?? breakdown.practice_tasks ?? 0,
        difficulty: breakdown.difficulty ?? 0,
        bonus: breakdown.bonus ?? 0,
      },
    },
  }
}

function normalizeArtifact(artifact: LooseRecord, validCitationIds: Set<string>): LearningArtifactView {
  const citations = (artifact.citations ?? []).map((citation: LooseRecord) => ({
    sourceId: citation.sourceId ?? citation.source_id ?? "UNKNOWN",
    factId: citation.factId ?? citation.fact_id ?? "UNKNOWN",
  }))
  const citationsAreValid = citations.length > 0 && citations.every(
    (citation: { sourceId: string; factId: string }) => validCitationIds.has(`${citation.sourceId}-${citation.factId}`),
  )
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    status: artifact.status ?? "mock",
    content: artifact.content ?? "",
    options: artifact.options ?? [],
    items: (artifact.items ?? []).map((item: LooseRecord) => ({
      id: item.id ?? "",
      tier: item.tier,
      modality: item.modality,
      prompt: item.prompt ?? "",
      options: item.options ?? [],
      ...(item.optionIds || item.option_ids ? { optionIds: item.optionIds ?? item.option_ids } : {}),
      ...(item.starterCode || item.starter_code ? { starterCode: item.starterCode ?? item.starter_code } : {}),
      citations: (item.citations ?? []).map((citation: LooseRecord) => ({
        sourceId: citation.sourceId ?? citation.source_id ?? "UNKNOWN",
        factId: citation.factId ?? citation.fact_id ?? "UNKNOWN",
      })),
    })),
    citations,
    evidenceStatus: citationsAreValid ? "grounded" : "gap",
  }
}

function normalizeWorkflowEvent(event: LooseRecord): WorkflowEventView {
  return {
    id: event.id,
    agent: event.agent,
    stage: event.stage,
    status: event.status,
    summary: event.summary,
    timestamp: event.timestamp,
  }
}

function normalizePathNode(node: LooseRecord): LearningPathNodeView {
  return {
    id: node.id,
    title: node.title,
    difficulty: normalizeDifficulty(node.difficulty),
    status: node.status,
    reason: node.reason,
  }
}

function normalizeDifficulty(value: unknown): Difficulty {
  return value === "basic" || value === "intermediate" || value === "integrated" ? value : "beginner"
}
