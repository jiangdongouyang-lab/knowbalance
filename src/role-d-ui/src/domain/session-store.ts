import type { RoleDSession } from "./types"
import { isAssessmentAnswerValid, isAssessmentComplete } from "./assessment-responses"
import { diagnosisItems } from "./diagnosis"
import { isGuidedStage } from "./guided-flow"

const STORAGE_KEY = "knowbalance.role-d.session"

interface SessionEnvelope {
  version: 1
  data: RoleDSession
}

export function saveSession(session: RoleDSession): boolean {
  try {
    const envelope: SessionEnvelope = { version: 1, data: session }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
    return true
  } catch {
    return false
  }
}

export function loadSession(): RoleDSession | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const envelope = JSON.parse(raw) as Partial<SessionEnvelope>
    if (envelope.version !== 1 || !isValidRoleDSession(envelope.data)) {
      clearSession()
      return null
    }
    return envelope.data
  } catch {
    clearSession()
    return null
  }
}

export function clearSession(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

export function isValidRoleDSession(value: unknown): value is RoleDSession {
  if (!isRecord(value) || value.version !== 1) return false
  const profile = value.profile
  const retrieval = value.retrieval
  const decision = value.decision
  const planInput = value.planInput
  const diagnosis = value.diagnosis
  const view = value.view
  const structurallyValid = (value.eventMode === "demo" || value.eventMode === "live")
    && typeof value.sessionId === "string"
    && typeof value.updatedAt === "string"
    && isRecord(profile)
    && typeof profile.learnerId === "string"
    && isDifficulty(profile.level)
    && isStringArray(profile.knownConcepts)
    && isStringArray(profile.weakConcepts)
    && typeof profile.goal === "string"
    && isRecord(retrieval)
    && typeof retrieval.query === "string"
    && typeof retrieval.topK === "number"
    && Array.isArray(retrieval.items)
    && retrieval.items.every(isRetrievalItem)
    && Array.isArray(value.conflicts)
    && value.conflicts.every(isProfileConflict)
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isLearningArtifact)
    && Array.isArray(value.evidenceGaps)
    && Array.isArray(value.workflow)
    && value.workflow.every(isWorkflowEvent)
    && Array.isArray(value.path)
    && value.path.every(isPathNode)
    && isRecord(decision)
    && isDecision(decision.next)
    && typeof decision.reason === "string"
    && (value.planSource === "demo" || value.planSource === "real-ab")
    && isRecord(planInput)
    && typeof planInput.learnerId === "string"
    && typeof planInput.educationContext === "string"
    && typeof planInput.timeBudget === "string"
    && (planInput.priorLanguages === undefined || isStringArray(planInput.priorLanguages))
    && isStringArray(planInput.knownConcepts)
    && isStringArray(planInput.weakConcepts)
    && isRecord(diagnosis)
    && typeof diagnosis.sourceId === "string"
    && typeof diagnosis.factId === "string"
    && typeof diagnosis.concept === "string"
    && isDifficulty(diagnosis.difficulty)
    && typeof diagnosis.question === "string"
    && isStringArray(diagnosis.options)
    && typeof diagnosis.answer === "string"
    && (diagnosis.items === undefined || (Array.isArray(diagnosis.items) && diagnosis.items.length > 0 && diagnosis.items.every(isDiagnosisItem)))
    && isRecord(view)
    && isGuidedStage(view.currentStage)
    && isGuidedStage(view.maxUnlockedStage)
    && isArtifactKind(view.activeArtifactKind)
    && typeof view.selectedSourceId === "string"
    && typeof view.remediationStarted === "boolean"
    && typeof view.goalDraft === "string"
    && isDifficulty(view.selfRatingDraft)
    && typeof view.diagnosisAnswer === "string"
    && (view.diagnosisAnswers === undefined || isStringRecord(view.diagnosisAnswers))
    && typeof view.diagnosisSubmitted === "boolean"
    && (view.assessmentAnswers === undefined || isStringRecord(view.assessmentAnswers))
    && (view.assessmentSubmitted === undefined || typeof view.assessmentSubmitted === "boolean")
    && value.assessmentGraded !== true
    && (view.detailDrawer === "none" || view.detailDrawer === "agents" || view.detailDrawer === "evidence")

  return structurallyValid && hasValidReferences(value as unknown as RoleDSession)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string")
}

function isDifficulty(value: unknown): boolean {
  return value === "beginner" || value === "basic" || value === "intermediate" || value === "integrated"
}

function isRetrievalItem(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.sourceId === "string"
    && typeof value.title === "string"
    && isDifficulty(value.difficulty)
    && typeof value.score === "number"
    && typeof value.reason === "string"
    && typeof value.snippet === "string"
    && typeof value.file === "string"
    && Array.isArray(value.facts)
    && value.facts.every(isRetrievalFact)
    && Array.isArray(value.examples)
    && value.examples.every(isExample)
    && isStringArray(value.practiceTasks)
    && Array.isArray(value.quizItems)
    && value.quizItems.every(isQuizItem)
    && isTrace(value.trace)
}

function isLearningArtifact(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.id === "string"
    && (value.kind === "lesson" || value.kind === "lab" || value.kind === "assessment")
    && typeof value.title === "string"
    && (value.status === "real" || value.status === "mock")
    && typeof value.content === "string"
    && isStringArray(value.options)
    && (value.items === undefined || (Array.isArray(value.items) && value.items.every(isAssessmentItem)))
    && Array.isArray(value.citations)
    && value.citations.every(isCitation)
    && (value.evidenceStatus === "grounded" || value.evidenceStatus === "gap")
}

function isAssessmentItem(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.tier === 1 || value.tier === 2 || value.tier === 3)
    && (value.modality === "mcq" || value.modality === "true_false" || value.modality === "trace" || value.modality === "short_answer" || value.modality === "code")
    && typeof value.prompt === "string"
    && isStringArray(value.options)
    && (value.optionIds === undefined || (isStringArray(value.optionIds) && value.optionIds.length === value.options.length))
    && (value.starterCode === undefined || typeof value.starterCode === "string")
    && Array.isArray(value.citations)
    && value.citations.every(isCitation)
}

function isDiagnosisItem(value: unknown): boolean {
  if (!isRecord(value) || !isStringArray(value.options)) return false
  const optionSet = new Set(value.options)
  return typeof value.id === "string"
    && value.id.length > 0
    && typeof value.sourceId === "string"
    && typeof value.factId === "string"
    && typeof value.concept === "string"
    && isDifficulty(value.difficulty)
    && typeof value.question === "string"
    && value.options.length > 1
    && optionSet.size === value.options.length
    && typeof value.answer === "string"
    && optionSet.has(value.answer)
}

function isRetrievalFact(value: unknown): boolean {
  return isRecord(value)
    && typeof value.sourceId === "string"
    && typeof value.factId === "string"
    && typeof value.content === "string"
}

function isExample(value: unknown): boolean {
  return isRecord(value)
    && typeof value.title === "string"
    && typeof value.code === "string"
    && typeof value.explanation === "string"
}

function isQuizItem(value: unknown): boolean {
  return isRecord(value)
    && typeof value.level === "number"
    && typeof value.question === "string"
    && typeof value.answer === "string"
}

function isTrace(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.scoreBreakdown)) return false
  const breakdown = value.scoreBreakdown
  return isStringArray(value.matchedKeywords)
    && isStringArray(value.matchedFields)
    && typeof value.difficultyMatch === "boolean"
    && ["keyword", "title", "facts", "practiceTasks", "difficulty", "bonus"].every((key) => typeof breakdown[key] === "number")
}

function isCitation(value: unknown): boolean {
  return isRecord(value) && typeof value.sourceId === "string" && typeof value.factId === "string"
}

function isProfileConflict(value: unknown): boolean {
  return isRecord(value)
    && typeof value.concept === "string"
    && (value.selfClaim === "known" || value.selfClaim === "weak")
    && typeof value.objectiveVerdict === "string"
    && (value.resolution === "known" || value.resolution === "weak")
    && typeof value.rule === "string"
}

function isWorkflowEvent(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.agent === "string"
    && typeof value.stage === "string"
    && (value.status === "pending" || value.status === "running" || value.status === "completed" || value.status === "review" || value.status === "blocked")
    && typeof value.summary === "string"
    && typeof value.timestamp === "string"
}

function isPathNode(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && isDifficulty(value.difficulty)
    && (value.status === "completed" || value.status === "current" || value.status === "upcoming")
    && typeof value.reason === "string"
}

function isArtifactKind(value: unknown): boolean {
  return value === "lesson" || value === "lab" || value === "assessment"
}

function isDecision(value: unknown): boolean {
  return value === "remediate" || value === "consolidate" || value === "advance" || value === "reprofile"
}

function hasValidReferences(session: RoleDSession): boolean {
  const sourceIds = new Set(session.retrieval.items.map((item) => item.sourceId))
  const factIds = new Set(session.retrieval.items.flatMap((item) => item.facts.map((fact) => `${fact.sourceId}-${fact.factId}`)))
  const selectedSourceIsValid = session.view.selectedSourceId === "" || sourceIds.has(session.view.selectedSourceId)
  const currentDiagnosisItems = diagnosisItems(session.diagnosis)
  const diagnosisIds = new Set(currentDiagnosisItems.map((item) => item.id))
  const firstDiagnosis = currentDiagnosisItems[0]
  const legacyAliasIsValid = !session.diagnosis.items?.length || (firstDiagnosis
    && session.diagnosis.sourceId === firstDiagnosis.sourceId
    && session.diagnosis.factId === firstDiagnosis.factId
    && session.diagnosis.concept === firstDiagnosis.concept
    && session.diagnosis.difficulty === firstDiagnosis.difficulty
    && session.diagnosis.question === firstDiagnosis.question
    && session.diagnosis.answer === firstDiagnosis.answer
    && session.diagnosis.options.length === firstDiagnosis.options.length
    && session.diagnosis.options.every((option, index) => option === firstDiagnosis.options[index]))
  const diagnosisIsValid = diagnosisIds.size === currentDiagnosisItems.length
    && Boolean(legacyAliasIsValid)
    && (session.planSource === "demo" || currentDiagnosisItems.every((item) => factIds.has(`${item.sourceId}-${item.factId}`)))
  const storedDiagnosisAnswers = session.view.diagnosisAnswers ?? {}
  const effectiveDiagnosisAnswers = Object.keys(storedDiagnosisAnswers).length > 0
    ? storedDiagnosisAnswers
    : session.view.diagnosisAnswer && currentDiagnosisItems[0]
      ? { [currentDiagnosisItems[0].id]: session.view.diagnosisAnswer }
      : {}
  const diagnosisAnswersAreValid = Object.entries(effectiveDiagnosisAnswers).every(([itemId, answer]) => {
    const item = currentDiagnosisItems.find((candidate) => candidate.id === itemId)
    return Boolean(item?.options.includes(answer))
  })
  const diagnosisSubmissionIsValid = !session.view.diagnosisSubmitted
    || currentDiagnosisItems.every((item) => item.options.includes(effectiveDiagnosisAnswers[item.id] ?? ""))
  const citationsAreValid = session.artifacts.every((artifact) => artifact.evidenceStatus !== "grounded"
    || (artifact.citations.length > 0
      && artifact.citations.every((citation) => factIds.has(`${citation.sourceId}-${citation.factId}`))
      && (artifact.items ?? []).every((item) => item.citations.length > 0
        && item.citations.every((citation) => factIds.has(`${citation.sourceId}-${citation.factId}`)))))
  const assessmentItems = session.artifacts.flatMap((artifact) => artifact.kind === "assessment" ? artifact.items ?? [] : [])
  const itemById = new Map(assessmentItems.map((item) => [item.id, item]))
  const answers = session.view.assessmentAnswers ?? {}
  const answersAreValid = Object.entries(answers).every(([itemId, answer]) => {
    const item = itemById.get(itemId)
    return item ? isAssessmentAnswerValid(item, answer) : false
  })
  const submissionIsValid = session.view.assessmentSubmitted !== true || isAssessmentComplete(assessmentItems, answers)
  return selectedSourceIsValid && diagnosisIsValid && diagnosisAnswersAreValid && diagnosisSubmissionIsValid && citationsAreValid && answersAreValid && submissionIsValid
}
