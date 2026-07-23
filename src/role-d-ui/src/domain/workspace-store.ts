import type { Difficulty, RoleDSession } from "./types"
import { isValidRoleDSession } from "./session-store"

const WORKSPACE_KEY = "knowbalance.role-d.workspace"
const LEGACY_SESSION_KEY = "knowbalance.role-d.session"

export interface LocalLearner {
  id: string
  displayName: string
  educationContext: string
  selfRating: Difficulty
  timeBudget: string
  priorLanguages: string[]
  createdAt: string
  updatedAt: string
}

export interface LearningPlanRecord {
  id: string
  userId: string
  title: string
  session: RoleDSession
  createdAt: string
  updatedAt: string
}

export interface LearningWorkspaceState {
  version: 1
  activeUserId: string | null
  activePlanId: string | null
  users: LocalLearner[]
  plans: LearningPlanRecord[]
}

export type CreateLocalLearnerInput = Omit<LocalLearner, "id" | "createdAt" | "updatedAt">
export type AddPlanInput = Pick<LearningPlanRecord, "id" | "title" | "session"> & Partial<Pick<LearningPlanRecord, "createdAt" | "updatedAt">>

export const EMPTY_WORKSPACE: LearningWorkspaceState = { version: 1, activeUserId: null, activePlanId: null, users: [], plans: [] }

export function createLocalLearner(input: CreateLocalLearnerInput, id: string = crypto.randomUUID(), now = new Date().toISOString()): LocalLearner {
  return { ...input, id, createdAt: now, updatedAt: now }
}

export function addPlan(workspace: LearningWorkspaceState, userId: string, input: AddPlanInput, now = new Date().toISOString()): LearningWorkspaceState {
  if (!workspace.users.some((user) => user.id === userId)) throw new Error("计划必须属于已存在的本机用户")
  if (workspace.plans.some((plan) => plan.id === input.id)) throw new Error("学习计划编号重复")
  const plan: LearningPlanRecord = {
    ...input,
    userId,
    session: bindSessionToUser(input.session, userId),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
  return { ...workspace, activeUserId: userId, activePlanId: plan.id, plans: [...workspace.plans, plan] }
}

export function selectPlan(workspace: LearningWorkspaceState, planId: string): LearningWorkspaceState {
  const plan = workspace.plans.find((candidate) => candidate.id === planId)
  if (!plan || plan.userId !== workspace.activeUserId) throw new Error("当前用户没有这个学习计划")
  return { ...workspace, activePlanId: planId }
}

export function switchUser(workspace: LearningWorkspaceState, userId: string): LearningWorkspaceState {
  if (!workspace.users.some((user) => user.id === userId)) throw new Error("本机用户不存在")
  const plans = workspace.plans.filter((plan) => plan.userId === userId)
  const activePlanId = plans.some((plan) => plan.id === workspace.activePlanId)
    ? workspace.activePlanId
    : [...plans].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null
  return { ...workspace, activeUserId: userId, activePlanId }
}

export function deletePlan(workspace: LearningWorkspaceState, planId: string): LearningWorkspaceState {
  const plan = workspace.plans.find((candidate) => candidate.id === planId)
  if (!plan || plan.userId !== workspace.activeUserId) throw new Error("当前用户没有这个学习计划")
  const plans = workspace.plans.filter((candidate) => candidate.id !== planId)
  const remaining = plans.filter((candidate) => candidate.userId === workspace.activeUserId)
  const activePlanId = workspace.activePlanId === planId
    ? [...remaining].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null
    : workspace.activePlanId
  return { ...workspace, plans, activePlanId }
}

export function updateActivePlanSession(workspace: LearningWorkspaceState, session: RoleDSession, now = new Date().toISOString()): LearningWorkspaceState {
  if (!workspace.activePlanId) return workspace
  return {
    ...workspace,
    plans: workspace.plans.map((plan) => plan.id === workspace.activePlanId ? { ...plan, session, updatedAt: now } : plan),
  }
}

export function saveWorkspace(workspace: LearningWorkspaceState): boolean {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace))
    return true
  } catch {
    return false
  }
}

export function loadWorkspace(): LearningWorkspaceState {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY)
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isValidWorkspace(parsed)) return parsed
      } catch {
        // Fall through to the legacy migration path.
      }
      try { localStorage.removeItem(WORKSPACE_KEY) } catch { /* best effort */ }
    }
    return migrateLegacySession()
  } catch {
    try { return migrateLegacySession() } catch { return EMPTY_WORKSPACE }
  }
}

export function isValidWorkspace(value: unknown): value is LearningWorkspaceState {
  return isStructurallyValidWorkspace(value)
    && value.plans.every((plan) => plan.session.profile.learnerId === plan.userId && plan.session.planInput.learnerId === plan.userId)
}

function isStructurallyValidWorkspace(value: unknown): value is LearningWorkspaceState {
  if (!isRecord(value) || value.version !== 1) return false
  if (!(value.activeUserId === null || typeof value.activeUserId === "string")) return false
  if (!(value.activePlanId === null || typeof value.activePlanId === "string")) return false
  if (!Array.isArray(value.users) || !value.users.every(isLocalLearner)) return false
  if (!Array.isArray(value.plans) || !value.plans.every(isLearningPlan)) return false
  const userIds = new Set(value.users.map((user) => user.id))
  if (userIds.size !== value.users.length) return false
  const planIds = new Set(value.plans.map((plan) => plan.id))
  if (planIds.size !== value.plans.length) return false
  if (value.plans.some((plan) => !userIds.has(plan.userId))) return false
  if (value.activeUserId !== null && !userIds.has(value.activeUserId)) return false
  const activePlan = value.activePlanId === null ? undefined : value.plans.find((plan) => plan.id === value.activePlanId)
  return value.activePlanId === null || (activePlan?.userId === value.activeUserId)
}

function migrateLegacySession(): LearningWorkspaceState {
  const raw = localStorage.getItem(LEGACY_SESSION_KEY)
  if (!raw) return EMPTY_WORKSPACE
  try {
    const envelope = JSON.parse(raw) as { version?: unknown; data?: unknown }
    if (envelope.version !== 1 || !isValidRoleDSession(envelope.data)) return EMPTY_WORKSPACE
    const session = envelope.data
    const now = session.updatedAt
    const userId = `migrated-${safeId(session.profile.learnerId)}`
    const user: LocalLearner = {
      id: userId,
      displayName: session.profile.learnerId,
      educationContext: session.planInput.educationContext,
      selfRating: session.view.selfRatingDraft,
      timeBudget: session.planInput.timeBudget,
      priorLanguages: session.planInput.priorLanguages ?? [],
      createdAt: now,
      updatedAt: now,
    }
    const plan: LearningPlanRecord = {
      id: `plan-${safeId(session.sessionId)}`,
      userId,
      title: session.profile.goal,
      session: bindSessionToUser(session, userId),
      createdAt: now,
      updatedAt: now,
    }
    const workspace: LearningWorkspaceState = { version: 1, activeUserId: userId, activePlanId: plan.id, users: [user], plans: [plan] }
    try {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace))
      localStorage.removeItem(LEGACY_SESSION_KEY)
    } catch {
      // Readable legacy progress stays available in memory and remains untouched for a later migration retry.
    }
    return workspace
  } catch {
    return EMPTY_WORKSPACE
  }
}

function isLocalLearner(value: unknown): value is LocalLearner {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.displayName === "string"
    && value.displayName.trim().length > 0
    && typeof value.educationContext === "string"
    && isDifficulty(value.selfRating)
    && typeof value.timeBudget === "string"
    && isStringArray(value.priorLanguages)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
}

function isLearningPlan(value: unknown): value is LearningPlanRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.userId === "string"
    && typeof value.title === "string"
    && value.title.trim().length > 0
    && isValidRoleDSession(value.session)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
}

function isDifficulty(value: unknown): value is Difficulty {
  return value === "beginner" || value === "basic" || value === "intermediate" || value === "integrated"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function bindSessionToUser(session: RoleDSession, userId: string): RoleDSession {
  return {
    ...session,
    profile: { ...session.profile, learnerId: userId },
    planInput: { ...session.planInput, learnerId: userId },
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "local"
}
