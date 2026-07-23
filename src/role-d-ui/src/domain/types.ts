export type Difficulty = "beginner" | "basic" | "intermediate" | "integrated"
export type WorkflowStatus = "pending" | "running" | "completed" | "review" | "blocked"
export type ArtifactKind = "lesson" | "lab" | "assessment"
export type ArtifactStatus = "real" | "mock"
export type GuidedStage = "onboarding" | "diagnosis" | "profile" | "plan" | "learning" | "feedback"

export interface LearnerProfileView {
  learnerId: string
  level: Difficulty
  knownConcepts: string[]
  weakConcepts: string[]
  goal: string
}

export interface ProfileConflictView {
  concept: string
  selfClaim: "known" | "weak"
  objectiveVerdict: string
  resolution: "known" | "weak"
  rule: string
}

export interface RetrievalFactView {
  sourceId: string
  factId: string
  content: string
}

export interface ScoreBreakdownView {
  keyword: number
  title: number
  facts: number
  practiceTasks: number
  difficulty: number
  bonus: number
}

export interface RetrievalItemView {
  sourceId: string
  title: string
  difficulty: Difficulty
  score: number
  reason: string
  snippet: string
  file: string
  facts: RetrievalFactView[]
  examples: Array<{ title: string; code: string; explanation: string }>
  practiceTasks: string[]
  quizItems: Array<{ level: number; question: string; answer: string }>
  trace: {
    matchedKeywords: string[]
    matchedFields: string[]
    difficultyMatch: boolean
    scoreBreakdown: ScoreBreakdownView
  }
}

export interface CitationView {
  sourceId: string
  factId: string
}

export interface LearningArtifactView {
  id: string
  kind: ArtifactKind
  title: string
  status: ArtifactStatus
  content: string
  options: string[]
  items?: Array<{
    id: string
    tier: 1 | 2 | 3
    modality: "mcq" | "true_false" | "trace" | "short_answer" | "code"
    prompt: string
    options: string[]
    starterCode?: string
    citations: CitationView[]
  }>
  citations: CitationView[]
  evidenceStatus: "grounded" | "gap"
}

export interface WorkflowEventView {
  id: string
  agent: string
  stage: string
  status: WorkflowStatus
  summary: string
  timestamp: string
}

export interface LearningPathNodeView {
  id: string
  title: string
  difficulty: Difficulty
  status: "completed" | "current" | "upcoming"
  reason: string
}

export interface RoleDSession {
  version: 1
  eventMode: "demo" | "live"
  sessionId: string
  updatedAt: string
  profile: LearnerProfileView
  conflicts: ProfileConflictView[]
  retrieval: {
    query: string
    topK: number
    items: RetrievalItemView[]
  }
  artifacts: LearningArtifactView[]
  evidenceGaps: string[]
  workflow: WorkflowEventView[]
  path: LearningPathNodeView[]
  decision: {
    next: "remediate" | "consolidate" | "advance" | "reprofile"
    reason: string
  }
  assessmentGraded?: boolean
  planSource: "demo" | "real-ab"
  planInput: {
    learnerId: string
    educationContext: string
    timeBudget: string
    knownConcepts: string[]
    weakConcepts: string[]
  }
  diagnosis: {
    sourceId: string
    factId: string
    concept: string
    difficulty: Difficulty
    question: string
    options: string[]
    answer: string
  }
  view: {
    currentStage: GuidedStage
    maxUnlockedStage: GuidedStage
    activeArtifactKind: ArtifactKind
    selectedSourceId: string
    remediationStarted: boolean
    goalDraft: string
    selfRatingDraft: Difficulty
    diagnosisAnswer: string
    diagnosisSubmitted: boolean
    detailDrawer: "none" | "agents" | "evidence"
  }
}
