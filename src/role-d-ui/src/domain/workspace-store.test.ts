import { beforeEach, describe, expect, test, vi } from "vitest"
import { adaptHandoff } from "./adapt-handoff"
import { demoHandoff } from "../data/demo-handoff"
import {
  addPlan,
  createLocalLearner,
  deletePlan,
  loadWorkspace,
  saveWorkspace,
  selectPlan,
  switchUser,
  type LearningWorkspaceState,
} from "./workspace-store"

const session = adaptHandoff(demoHandoff)

function learner(name: string) {
  return createLocalLearner({
    displayName: name,
    educationContext: "大二计算机专业",
    selfRating: "basic",
    timeBudget: "每周 4 小时",
    priorLanguages: ["Python"],
  }, `${name}-id`, "2026-07-23T00:00:00.000Z")
}

describe("workspace-store", () => {
  beforeEach(() => localStorage.clear())

  test("starts empty before a local user is created", () => {
    expect(loadWorkspace()).toEqual({ version: 1, activeUserId: null, activePlanId: null, users: [], plans: [] })
  })

  test("keeps plans isolated by local user and resumes the selected checkpoint", () => {
    const alice = learner("Alice")
    const bob = learner("Bob")
    let workspace: LearningWorkspaceState = { version: 1, activeUserId: alice.id, activePlanId: null, users: [alice, bob], plans: [] }
    workspace = addPlan(workspace, alice.id, { id: "plan-a", title: "循环计划", session: { ...session, view: { ...session.view, currentStage: "learning", maxUnlockedStage: "learning" } } })
    workspace = addPlan(workspace, bob.id, { id: "plan-b", title: "函数计划", session: { ...session, sessionId: "session-b", view: { ...session.view, currentStage: "diagnosis", maxUnlockedStage: "diagnosis" } } })

    const bobWorkspace = switchUser(workspace, bob.id)
    expect(bobWorkspace.activePlanId).toBe("plan-b")
    expect(bobWorkspace.plans.filter((plan) => plan.userId === bob.id).map((plan) => plan.title)).toEqual(["函数计划"])
    expect(selectPlan(bobWorkspace, "plan-b").plans.find((plan) => plan.id === "plan-b")?.session.view.currentStage).toBe("diagnosis")
    expect(bobWorkspace.plans.find((plan) => plan.id === "plan-a")?.session.view.currentStage).toBe("learning")
  })

  test("deletes only the selected user's requested plan", () => {
    const alice = learner("Alice")
    let workspace: LearningWorkspaceState = { version: 1, activeUserId: alice.id, activePlanId: null, users: [alice], plans: [] }
    workspace = addPlan(workspace, alice.id, { id: "plan-a", title: "循环计划", session })
    workspace = addPlan(workspace, alice.id, { id: "plan-b", title: "列表计划", session: { ...session, sessionId: "session-b" } })
    workspace = deletePlan(workspace, "plan-b")

    expect(workspace.plans.map((plan) => plan.id)).toEqual(["plan-a"])
    expect(workspace.activePlanId).toBe("plan-a")
  })

  test("rejects selecting or deleting another local user's plan", () => {
    const alice = learner("Alice")
    const bob = learner("Bob")
    let workspace: LearningWorkspaceState = { version: 1, activeUserId: alice.id, activePlanId: null, users: [alice, bob], plans: [] }
    workspace = addPlan(workspace, alice.id, { id: "plan-a", title: "Alice 计划", session })
    workspace = addPlan(workspace, bob.id, { id: "plan-b", title: "Bob 计划", session: { ...session, sessionId: "session-b" } })
    workspace = switchUser(workspace, alice.id)

    expect(() => selectPlan(workspace, "plan-b")).toThrow("当前用户没有这个学习计划")
    expect(() => deletePlan(workspace, "plan-b")).toThrow("当前用户没有这个学习计划")
  })

  test("round-trips only a strictly valid versioned workspace", () => {
    const alice = learner("Alice")
    const workspace = addPlan({ version: 1, activeUserId: alice.id, activePlanId: null, users: [alice], plans: [] }, alice.id, { id: "plan-a", title: "循环计划", session })
    expect(saveWorkspace(workspace)).toBe(true)
    expect(loadWorkspace()).toEqual(workspace)

    localStorage.setItem("knowbalance.role-d.workspace", JSON.stringify({ version: 1, activeUserId: alice.id, activePlanId: "missing", users: [alice], plans: [] }))
    expect(loadWorkspace()).toEqual({ version: 1, activeUserId: null, activePlanId: null, users: [], plans: [] })

    const foreignIdentity = structuredClone(workspace)
    foreignIdentity.plans[0]!.session.profile.learnerId = "another-user"
    localStorage.setItem("knowbalance.role-d.workspace", JSON.stringify(foreignIdentity))
    expect(loadWorkspace()).toEqual({ version: 1, activeUserId: null, activePlanId: null, users: [], plans: [] })
  })

  test("rejects a plan whose outer owner was tampered to another known user", () => {
    const alice = learner("Alice")
    const bob = learner("Bob")
    let workspace: LearningWorkspaceState = { version: 1, activeUserId: bob.id, activePlanId: null, users: [alice, bob], plans: [] }
    workspace = addPlan(workspace, bob.id, { id: "plan-b", title: "Bob 计划", session })
    workspace.plans[0]!.userId = alice.id
    workspace.activeUserId = alice.id
    localStorage.setItem("knowbalance.role-d.workspace", JSON.stringify(workspace))

    expect(loadWorkspace()).toEqual({ version: 1, activeUserId: null, activePlanId: null, users: [], plans: [] })
  })

  test("falls back to valid legacy progress when the workspace JSON is corrupt", () => {
    localStorage.setItem("knowbalance.role-d.workspace", "{broken")
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: session }))

    const workspace = loadWorkspace()

    expect(workspace.users).toHaveLength(1)
    expect(workspace.plans[0]?.session.sessionId).toBe(session.sessionId)
  })

  test("migrates the legacy single session into one local user and one plan", () => {
    const legacy = { ...session, planInput: { ...session.planInput, priorLanguages: undefined } }
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: legacy }))
    const workspace = loadWorkspace()

    expect(workspace.users).toHaveLength(1)
    expect(workspace.plans).toHaveLength(1)
    expect(workspace.activePlanId).toBe(workspace.plans[0]?.id)
    expect(workspace.plans[0]?.session.sessionId).toBe(session.sessionId)
    expect(workspace.users[0]?.priorLanguages).toEqual([])
    expect(localStorage.getItem("knowbalance.role-d.session")).toBeNull()
  })

  test("keeps readable legacy progress available when migration cannot be written", () => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: session }))
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked") })

    const workspace = loadWorkspace()

    expect(workspace.users).toHaveLength(1)
    expect(workspace.plans[0]?.session.sessionId).toBe(session.sessionId)
    expect(localStorage.getItem("knowbalance.role-d.session")).not.toBeNull()
    write.mockRestore()
  })
})
