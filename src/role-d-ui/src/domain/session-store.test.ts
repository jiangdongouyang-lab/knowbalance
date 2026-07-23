import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { RoleDSession } from "./types"
import { clearSession, loadSession, saveSession } from "./session-store"

const session: RoleDSession = {
  version: 1,
  eventMode: "demo",
  sessionId: "session-demo",
  updatedAt: "2026-07-21T00:00:00.000Z",
  profile: { learnerId: "demo", level: "beginner", knownConcepts: ["变量"], weakConcepts: ["循环"], goal: "学会循环" },
  conflicts: [],
  retrieval: { query: "循环", topK: 0, items: [] },
  artifacts: [],
  evidenceGaps: [],
  workflow: [],
  path: [],
  decision: { next: "remediate", reason: "继续练习" },
  planSource: "demo",
  planInput: {
    learnerId: "demo",
    educationContext: "",
    timeBudget: "",
    knownConcepts: ["变量"],
    weakConcepts: ["循环"],
  },
  diagnosis: {
    sourceId: "K007",
    factId: "F001",
    concept: "for 循环",
    difficulty: "beginner",
    question: "for 循环最适合用于什么场景？",
    options: ["遍历序列", "定义变量"],
    answer: "遍历序列",
  },
  view: {
    currentStage: "onboarding",
    maxUnlockedStage: "onboarding",
    activeArtifactKind: "lesson",
    selectedSourceId: "",
    remediationStarted: false,
    goalDraft: "学会循环",
    selfRatingDraft: "beginner",
    diagnosisAnswer: "",
    diagnosisSubmitted: false,
    detailDrawer: "none",
  },
}

describe("session-store", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  test("round-trips a versioned Role D session", () => {
    expect(saveSession(session)).toBe(true)
    expect(loadSession()).toEqual(session)
  })

  test("reports browser storage failures instead of claiming the session was saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("blocked") })
    expect(saveSession(session)).toBe(false)
  })

  test("falls back safely when browser storage cannot be read or cleared", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => { throw new DOMException("blocked") })
    expect(loadSession()).toBeNull()

    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => { throw new DOMException("blocked") })
    expect(clearSession()).toBe(false)
  })

  test("returns null and removes corrupt or unsupported state", () => {
    localStorage.setItem("knowbalance.role-d.session", "not-json")
    expect(loadSession()).toBeNull()
    expect(localStorage.getItem("knowbalance.role-d.session")).toBeNull()

    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 99, data: session }))
    expect(loadSession()).toBeNull()
    expect(localStorage.getItem("knowbalance.role-d.session")).toBeNull()
  })

  test("rejects a versioned envelope whose session shape is incomplete", () => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: { version: 1, sessionId: "broken" },
    }))

    expect(loadSession()).toBeNull()
    expect(localStorage.getItem("knowbalance.role-d.session")).toBeNull()
  })

  test("rejects unsupported persisted guided stages", () => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: { ...session, view: { ...session.view, currentStage: "dashboard" } },
    }))

    expect(loadSession()).toBeNull()
  })

  test("rejects malformed persisted new-plan diagnosis fields", () => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: {
        ...session,
        planSource: "real-ab",
        diagnosis: { ...session.diagnosis, options: [{ label: "not-a-string" }] },
      },
    }))
    expect(loadSession()).toBeNull()

    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: {
        ...session,
        planSource: "real-ab",
        diagnosis: { ...session.diagnosis, difficulty: "expert" },
      },
    }))
    expect(loadSession()).toBeNull()
  })

  test("rejects malformed persisted profile and retrieval items", () => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: { ...session, profile: { ...session.profile, knownConcepts: [{ injected: true }] } },
    }))
    expect(loadSession()).toBeNull()

    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: { ...session, profile: { ...session.profile, level: "expert" } },
    }))
    expect(loadSession()).toBeNull()

    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: { ...session, retrieval: { ...session.retrieval, items: [null] } },
    }))
    expect(loadSession()).toBeNull()
  })

  test("rejects stale or malformed persisted learning artifacts", () => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({
      version: 1,
      data: {
        ...session,
        artifacts: [{
          id: "stale",
          kind: "assessment",
          title: "旧测评",
          status: "mock",
          content: "旧内容",
          citations: [],
          evidenceStatus: "gap",
        }],
      },
    }))
    expect(loadSession()).toBeNull()
  })

  test.each([
    ["retrieval fact", {
      ...session,
      retrieval: {
        query: "循环",
        topK: 1,
        items: [{
          sourceId: "K007",
          title: "for 循环",
          difficulty: "beginner",
          score: 1,
          reason: "命中",
          snippet: "片段",
          file: "K007.md",
          facts: [null],
          examples: [],
          practiceTasks: [],
          quizItems: [],
          trace: { matchedKeywords: [], matchedFields: [], difficultyMatch: true, scoreBreakdown: { keyword: 1, title: 0, facts: 0, practiceTasks: 0, difficulty: 0, bonus: 0 } },
        }],
      },
    }],
    ["artifact citation", {
      ...session,
      artifacts: [{ id: "a", kind: "lesson", title: "讲义", status: "mock", content: "内容", options: [], citations: [null], evidenceStatus: "gap" }],
    }],
    ["workflow event", { ...session, workflow: [null] }],
    ["path node", { ...session, path: [{ id: "K007", title: "循环", difficulty: "expert", status: "current", reason: "原因" }] }],
    ["view enum", { ...session, view: { ...session.view, activeArtifactKind: "video" } }],
    ["stale selected source", { ...session, view: { ...session.view, selectedSourceId: "K404" } }],
    ["decision enum", { ...session, decision: { next: "guess", reason: "原因" } }],
    ["real plan diagnosis reference", { ...session, planSource: "real-ab" }],
    ["grounded artifact reference", {
      ...session,
      artifacts: [{ id: "a", kind: "lesson", title: "讲义", status: "mock", content: "内容", options: [], citations: [{ sourceId: "K404", factId: "F404" }], evidenceStatus: "grounded" }],
    }],
  ])("rejects malformed nested %s state", (_label, malformed) => {
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: malformed }))
    expect(loadSession()).toBeNull()
  })

  test("clears saved progress", () => {
    saveSession(session)
    clearSession()
    expect(loadSession()).toBeNull()
  })

  test("rejects a nested Role C assessment citation outside the current retrieval facts", () => {
    const invalid = structuredClone(session)
    invalid.artifacts = [{
      id: "assessment",
      kind: "assessment",
      title: "分阶测评",
      status: "real",
      content: "公开题面",
      options: [],
      citations: [{ sourceId: "K007", factId: "F001" }],
      evidenceStatus: "grounded",
      items: [{
        id: "I1",
        tier: 1,
        modality: "mcq",
        prompt: "题目",
        options: ["A"],
        citations: [{ sourceId: "MISSING", factId: "F404" }],
      }],
    }]
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: invalid }))

    expect(loadSession()).toBeNull()
  })

  test("rejects assessment answers that do not reference a published item option", () => {
    const invalid = structuredClone(session)
    invalid.artifacts = [{
      id: "assessment",
      kind: "assessment",
      title: "分阶测评",
      status: "real",
      content: "公开题面",
      options: ["A. 遍历序列"],
      citations: [],
      evidenceStatus: "gap",
      items: [{
        id: "I1",
        tier: 1,
        modality: "mcq",
        prompt: "题目",
        options: ["A. 遍历序列"],
        optionIds: ["OPT-A"],
        citations: [],
      }],
    }]
    invalid.view.assessmentAnswers = { I1: "OPT-MISSING" }
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: invalid }))

    expect(loadSession()).toBeNull()
  })

  test("rejects a submitted assessment whose dynamic item set is incomplete", () => {
    const invalid = structuredClone(session)
    invalid.artifacts = [{
      id: "assessment",
      kind: "assessment",
      title: "动态分阶测评",
      status: "real",
      content: "公开题面",
      options: [],
      citations: [],
      evidenceStatus: "gap",
      items: [
        { id: "trace-item", tier: 2, modality: "trace", prompt: "追踪变量", options: [], citations: [] },
        { id: "code-item", tier: 3, modality: "code", prompt: "补全代码", options: [], starterCode: "def solve():\n    pass", citations: [] },
      ],
    }]
    invalid.view.assessmentAnswers = { "trace-item": "变量最终为 3" }
    invalid.view.assessmentSubmitted = true
    localStorage.setItem("knowbalance.role-d.session", JSON.stringify({ version: 1, data: invalid }))

    expect(loadSession()).toBeNull()
  })
})
