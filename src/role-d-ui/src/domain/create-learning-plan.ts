import { loadKnowledgeBase } from "../../../knowledge/loader"
import type { KnowledgeDifficulty, KnowledgeQuizItem } from "../../../knowledge/types"
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
  knownConcepts: string[]
  weakConcepts: string[]
  goal: string
}

export interface PlanDiagnosis {
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
  const diagnosis = selectDiagnosis(ragResult)
  const sessionId = `session-${input.learnerId}-${Date.now()}`
  const roleC = await requestRoleC({
    profile: synthesis.profile,
    ragResult,
    kbVersion: knowledgeBase.version,
    runId: `RUN-${sessionId}`,
  })
  const session = buildSession(input, synthesis, ragResult, diagnosis, roleC, sessionId)
  return { source: "real-ab", input, diagnosis, session }
}

export async function evaluatePlanDiagnosis(plan: CreatedLearningPlan, answer: string, requestRoleC: RoleCRequester = requestRoleCContent): Promise<CreatedLearningPlan> {
  const verdict = normalize(answer) === normalize(plan.diagnosis.answer) ? "correct" : "incorrect"
  const objectiveItems: ObjectiveDiagnosisEvidence["items"] = [{
    source_id: plan.diagnosis.sourceId,
    fact_id: plan.diagnosis.factId,
    question: plan.diagnosis.question,
    learner_answer: answer,
    verdict,
    concept: plan.diagnosis.concept,
    difficulty: plan.diagnosis.difficulty,
  }]
  const knowledgeBase = await loadKnowledgeBase()
  const evidence = buildEvidence(plan.input, objectiveItems)
  const synthesis = synthesizeProfile({ ...evidence, knowledgeBase })
  const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)
  const roleC = await requestRoleC({
    profile: synthesis.profile,
    ragResult,
    kbVersion: knowledgeBase.version,
    runId: `RUN-${plan.session.sessionId}-diagnosed`,
  })
  const session = buildSession(plan.input, synthesis, ragResult, plan.diagnosis, roleC, plan.session.sessionId)
  session.view.diagnosisAnswer = answer
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
      prior_languages: ["Python"],
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

function selectDiagnosis(ragResult: RagResult): PlanDiagnosis {
  for (const item of ragResult.results) {
    const quiz = item.quizItems.find((candidate) => candidate.options && candidate.options.length > 1)
    if (quiz) return normalizeDiagnosis(item, quiz)
  }
  throw new Error("A 检索结果中没有可直接作答的知识库选择题，请补充已学或薄弱知识后重试")
}

function normalizeDiagnosis(item: RagResultItem, quiz: KnowledgeQuizItem): PlanDiagnosis {
  return {
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
  const knownSourceIds = new Set(synthesis.provenance.concepts
    .filter((concept) => concept.bucket === "known")
    .flatMap((concept) => concept.matched_source_ids))
  const path = buildPath(ragResult, knownSourceIds)
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
    eventMode: roleC.status === "ready" ? "live" : "demo",
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
    ],
    c_artifacts: artifacts,
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
      diagnosisSubmitted: false,
      detailDrawer: "none",
    },
  })
}

function buildPath(ragResult: RagResult, knownSourceIds: Set<string>) {
  let currentAssigned = false
  const nodes = ragResult.results.slice(0, 5).map((item): RoleDSession["path"][number] => {
    const completed = knownSourceIds.has(item.sourceId)
    const status = completed ? "completed" : currentAssigned ? "upcoming" : "current"
    if (status === "current") currentAssigned = true
    return {
      id: item.sourceId,
      title: item.title,
      difficulty: item.difficulty,
      status,
      reason: completed ? "B 画像将其标记为已掌握。" : item.reason,
    }
  })
  const order: Record<RoleDSession["path"][number]["status"], number> = { completed: 0, current: 1, upcoming: 2 }
  return nodes.sort((left, right) => order[left.status] - order[right.status])
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
