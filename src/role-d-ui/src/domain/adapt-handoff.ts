import type {
  Difficulty,
  LearningArtifactView,
  LearningPathNodeView,
  RetrievalItemView,
  RoleDSession,
  WorkflowEventView,
} from "./types"
import type { RoleCForRoleDResult } from "../../../role-d-integration/contracts"

type LooseRecord = Record<string, any>
type RoleCReadyHandoff = Extract<RoleCForRoleDResult, { status: "ready" }>

export interface CompletedRoleCRoundIdentity {
  sessionId: string
  runId: string
  learningSessionId: string
  feedbackId: string
  submissionId: string
}

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
    ...(input.audit ? { audit: normalizeAudit(input.audit) } : {}),
    ...(input.roleC ? { roleC: normalizeRoleCSession(input.roleC) } : {}),
    ...(input.feedback ? { feedback: input.feedback } : {}),
    evidenceGaps: artifacts.filter((artifact: LearningArtifactView) => artifact.evidenceStatus === "gap").map((artifact: LearningArtifactView) => artifact.id),
    workflow: (input.workflow_events ?? input.workflowEvents ?? []).map(normalizeWorkflowEvent),
    path: (input.learning_path ?? input.learningPath ?? []).map(normalizePathNode),
    decision: {
      next: input.decision?.next ?? "remediate",
      reason: input.decision?.reason ?? "等待测评结果后由决策策略更新。",
    },
    assessmentGraded: input.assessmentGraded === true && Boolean(input.feedback),
    planSource: input.planSource === "real-ab" ? "real-ab" : "demo",
    planInput: {
      learnerId: input.planInput?.learnerId ?? profile.learner_id ?? profile.learnerId ?? "anonymous_learner",
      educationContext: input.planInput?.educationContext ?? "",
      timeBudget: input.planInput?.timeBudget ?? "",
      priorLanguages: input.planInput?.priorLanguages ?? [],
      knownConcepts: input.planInput?.knownConcepts ?? profile.known_concepts ?? profile.knownConcepts ?? [],
      weakConcepts: input.planInput?.weakConcepts ?? profile.weak_concepts ?? profile.weakConcepts ?? [],
    },
    diagnosis: {
      items: input.diagnosis?.items?.map((item: LooseRecord, index: number) => ({
        id: item.id ?? `${item.sourceId ?? item.source_id ?? "UNKNOWN"}-${item.factId ?? item.fact_id ?? "UNKNOWN"}-${index + 1}`,
        sourceId: item.sourceId ?? item.source_id ?? "UNKNOWN",
        factId: item.factId ?? item.fact_id ?? "UNKNOWN",
        concept: item.concept ?? "未提供诊断知识点",
        difficulty: normalizeDifficulty(item.difficulty ?? "beginner"),
        question: item.question ?? "",
        options: item.options ?? [],
        answer: item.answer ?? "",
      })),
      sourceId: input.diagnosis?.sourceId ?? "UNKNOWN",
      factId: input.diagnosis?.factId ?? "UNKNOWN",
      concept: input.diagnosis?.concept ?? "未提供诊断知识点",
      difficulty: normalizeDifficulty(input.diagnosis?.difficulty ?? "beginner"),
      question: input.diagnosis?.question ?? "",
      options: input.diagnosis?.options ?? [],
      answer: input.diagnosis?.answer ?? "",
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
      diagnosisAnswers: input.view?.diagnosisAnswers ?? (input.view?.diagnosisAnswer ? { [`${input.diagnosis?.sourceId ?? "UNKNOWN"}-${input.diagnosis?.factId ?? "UNKNOWN"}-1`]: input.view.diagnosisAnswer } : {}),
      diagnosisSubmitted: input.view?.diagnosisSubmitted ?? false,
      assessmentAnswers: input.view?.assessmentAnswers ?? {},
      assessmentSubmitted: input.view?.assessmentSubmitted ?? false,
      assessmentStatus: input.view?.assessmentStatus ?? "idle",
      assessmentMessage: input.view?.assessmentMessage ?? "",
      detailDrawer: input.view?.detailDrawer === "agents" || input.view?.detailDrawer === "evidence" ? input.view.detailDrawer : "none",
    },
  }
}

export function completedRoleCRoundIdentity(
  session: RoleDSession,
): CompletedRoleCRoundIdentity | undefined {
  if (session.assessmentGraded !== true
    || !session.roleC
    || !session.feedback) return undefined
  return {
    sessionId: session.sessionId,
    runId: session.roleC.runId,
    learningSessionId: session.roleC.learningSessionId,
    feedbackId: session.feedback.feedbackId,
    submissionId: session.feedback.submissionId,
  }
}

export function matchesCompletedRoleCRound(
  session: RoleDSession,
  expected: CompletedRoleCRoundIdentity,
): boolean {
  const current = completedRoleCRoundIdentity(session)
  return current !== undefined
    && current.sessionId === expected.sessionId
    && current.runId === expected.runId
    && current.learningSessionId === expected.learningSessionId
    && current.feedbackId === expected.feedbackId
    && current.submissionId === expected.submissionId
}

export function applyRoleCNextRoundHandoff(
  session: RoleDSession,
  expected: CompletedRoleCRoundIdentity,
  handoff: RoleCReadyHandoff,
  now = new Date().toISOString(),
): RoleDSession {
  if (!matchesCompletedRoleCRound(session, expected)) return session

  const validCitationIds = new Set<string>(
    session.retrieval.items.flatMap((item) =>
      item.facts.map((fact) => `${fact.sourceId}-${fact.factId}`)),
  )
  const artifacts = handoff.artifacts.map((artifact) =>
    normalizeArtifact(artifact, validCitationIds))
  const nextWorkflow = handoff.workflow.map(normalizeWorkflowEvent)
  const workflowIds = new Set(nextWorkflow.map((event) => event.id))
  const retrievableSourceIds = new Set(
    session.retrieval.items.map((item) => item.sourceId),
  )
  const selectedSourceId = handoff.learningSession.targetSourceIds
    .find((sourceId) => retrievableSourceIds.has(sourceId))
    ?? artifacts.flatMap((artifact) => artifact.citations)
      .find((citation) =>
        retrievableSourceIds.has(citation.sourceId))?.sourceId
    ?? (retrievableSourceIds.has(session.view.selectedSourceId)
      ? session.view.selectedSourceId
      : session.retrieval.items[0]?.sourceId ?? "")

  return {
    ...session,
    updatedAt: now,
    artifacts,
    audit: handoff.audit ? normalizeAudit(handoff.audit) : undefined,
    roleC: {
      runId: handoff.runId,
      learningSessionId: handoff.learningSession.sessionId,
      formId: handoff.learningSession.formId,
      attemptNo: handoff.learningSession.attemptNo,
      profileVersion: handoff.learningSession.profileVersion,
      pathNodeId: handoff.learningSession.pathNodeId,
      targetSourceIds: [...handoff.learningSession.targetSourceIds],
      routing: {
        phase: "anchor_pending",
        routingRequestId: handoff.learningSession.routingRequestId,
        requiredItemIds: [...handoff.learningSession.requiredItemIds],
      },
    },
    feedback: undefined,
    assessmentGraded: false,
    evidenceGaps: artifacts
      .filter((artifact) => artifact.evidenceStatus === "gap")
      .map((artifact) => artifact.id),
    path: installNextRoundPath(
      session.path,
      handoff.learningSession.targetSourceIds,
      artifacts,
      session.profile.level,
    ),
    workflow: [
      ...session.workflow.filter((event) => !workflowIds.has(event.id)),
      ...nextWorkflow,
    ],
    decision: {
      next: "remediate",
      reason: "下一轮已就绪，等待完成本轮测评后由 C 更新动态决策。",
    },
    view: {
      ...session.view,
      currentStage: "learning",
      activeArtifactKind: "lesson",
      selectedSourceId,
      remediationStarted: false,
      assessmentAnswers: {},
      assessmentSubmitted: false,
      assessmentStatus: "idle",
      assessmentMessage: "",
      detailDrawer: "none",
    },
  }
}

function installNextRoundPath(
  path: LearningPathNodeView[],
  targetSourceIds: string[],
  artifacts: LearningArtifactView[],
  difficulty: Difficulty,
): LearningPathNodeView[] {
  const uniqueTargets = [...new Set(
    targetSourceIds.filter((sourceId) => sourceId.trim() !== ""),
  )]
  if (uniqueTargets.length === 0) return path
  const targetSet = new Set(uniqueTargets)
  const existingCurrent = path.find((node) =>
    targetSet.has(node.id) && node.status !== "completed")
  const currentId = existingCurrent?.id
    ?? uniqueTargets.find((sourceId) =>
      !path.some((node) =>
        node.id === sourceId && node.status === "completed"))
    ?? uniqueTargets[0]!
  const next = path.map((node) => {
    if (node.status === "completed") return node
    if (node.id === currentId) {
      return {
        ...node,
        status: "current" as const,
        reason: "B 的下一轮路径已由 C 发布并进入当前学习节点。",
      }
    }
    if (node.status === "current") {
      return { ...node, status: "upcoming" as const }
    }
    return node
  })
  const knownIds = new Set(next.map((node) => node.id))
  const lessonTitle = artifacts.find((artifact) =>
    artifact.kind === "lesson")?.title
  for (const sourceId of uniqueTargets) {
    if (knownIds.has(sourceId)) continue
    next.push({
      id: sourceId,
      title: sourceId === currentId && lessonTitle
        ? lessonTitle
        : sourceId,
      difficulty,
      status: sourceId === currentId ? "current" : "upcoming",
      reason: sourceId === currentId
        ? "B 的下一轮路径已由 C 发布并进入当前学习节点。"
        : "B 的下一轮路径已发布，等待进入该节点。",
    })
  }
  return next
}

function normalizeRoleCSession(value: LooseRecord) {
  const routing = value.routing ?? (
    value.routingRequestId || value.routing_request_id
      ? value
      : undefined
  )
  return {
    runId: value.runId ?? value.run_id ?? "",
    learningSessionId: value.learningSessionId ?? value.learning_session_id ?? value.sessionId ?? value.session_id ?? "",
    formId: value.formId ?? value.form_id ?? "",
    attemptNo: value.attemptNo ?? value.attempt_no ?? 1,
    ...(value.profileVersion || value.profile_version ? {
      profileVersion: value.profileVersion ?? value.profile_version,
    } : {}),
    ...(value.pathNodeId || value.path_node_id ? {
      pathNodeId: value.pathNodeId ?? value.path_node_id,
    } : {}),
    ...(value.targetSourceIds || value.target_source_ids ? {
      targetSourceIds: value.targetSourceIds ?? value.target_source_ids,
    } : {}),
    ...(routing ? {
      routing: normalizeRoleCRouting(routing),
    } : {}),
  }
}

function normalizeRoleCRouting(value: LooseRecord) {
  const phase = value.phase === "route_locked"
    ? "route_locked" as const
    : "anchor_pending" as const
  if (phase === "anchor_pending") {
    return {
      phase,
      routingRequestId: value.routingRequestId ?? value.routing_request_id ?? "",
      requiredItemIds: value.requiredItemIds ?? value.required_item_ids ?? [],
    }
  }
  return {
    phase,
    routingRequestId: value.routingRequestId ?? value.routing_request_id ?? "",
    routeLockId: value.routeLockId ?? value.route_lock_id ?? "",
    routeId: value.routeId ?? value.route_id ?? "",
    action: value.action ?? "reinforce",
    anchorScoreRatio: value.anchorScoreRatio ?? value.anchor_score_ratio ?? 0,
    ...(value.anchorItemIds || value.anchor_item_ids ? {
      anchorItemIds: value.anchorItemIds ?? value.anchor_item_ids,
    } : {}),
    requiredItemIds: value.requiredItemIds ?? value.required_item_ids ?? [],
  }
}

function normalizeAudit(audit: LooseRecord) {
  return {
    factStatus: normalizeAuditStatus(audit.factStatus ?? audit.fact_status),
    factAudits: (audit.factAudits ?? audit.fact_audits ?? []).map((item: LooseRecord) => ({
      artifactId: item.artifactId ?? item.artifact_id ?? "",
      artifactTitle: item.artifactTitle ?? item.artifact_title ?? "未命名内容",
      artifactKind: normalizeArtifactKind(item.artifactKind ?? item.artifact_kind),
      status: normalizeAuditStatus(item.status),
      checkedClaims: item.checkedClaims ?? item.checked_claims ?? 0,
      conflicts: item.conflicts ?? 0,
      notes: item.notes ?? [],
    })),
    teachingAudit: {
      artifactId: audit.teachingAudit?.artifactId ?? audit.teaching_audit?.artifact_id ?? "",
      status: normalizeAuditStatus(audit.teachingAudit?.status ?? audit.teaching_audit?.status),
      summary: audit.teachingAudit?.summary ?? audit.teaching_audit?.summary ?? "教学审核未返回摘要。",
      revisionHints: audit.teachingAudit?.revisionHints ?? audit.teaching_audit?.revision_hints ?? [],
    },
    arbitration: {
      artifactId: audit.arbitration?.artifactId ?? audit.arbitration?.artifact_id ?? "",
      decision: normalizeAuditStatus(audit.arbitration?.decision),
      revisionRound: audit.arbitration?.revisionRound ?? audit.arbitration?.revision_round ?? 0,
      maxRevisionRounds: audit.arbitration?.maxRevisionRounds ?? audit.arbitration?.max_revision_rounds ?? 2,
      canRevise: audit.arbitration?.canRevise ?? audit.arbitration?.can_revise ?? false,
      reason: audit.arbitration?.reason ?? "仲裁未返回说明。",
    },
  }
}

function normalizeAuditStatus(value: unknown): "pass" | "revise" | "reject" {
  return value === "pass" || value === "revise" || value === "reject" ? value : "revise"
}

function normalizeArtifactKind(value: unknown): "lesson" | "lab" | "assessment" {
  return value === "lesson" || value === "lab" || value === "assessment" ? value : "lesson"
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
