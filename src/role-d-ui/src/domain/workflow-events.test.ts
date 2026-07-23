import { describe, expect, test } from "vitest"
import type { RoleDSession, WorkflowEventView } from "./types"
import { applyWorkflowEvent } from "./workflow-events"

const session = {
  version: 1,
  eventMode: "demo",
  sessionId: "session-demo",
  updatedAt: "2026-07-21T00:00:00.000Z",
  profile: { learnerId: "demo", level: "beginner", knownConcepts: [], weakConcepts: [], goal: "学习" },
  conflicts: [],
  retrieval: { query: "", topK: 0, items: [] },
  artifacts: [],
  evidenceGaps: [],
  workflow: [{ id: "event-1", agent: "agent-a", stage: "阶段 A", status: "pending", summary: "等待", timestamp: "--" }],
  path: [],
  decision: { next: "remediate", reason: "继续" },
  planSource: "demo",
  planInput: {
    learnerId: "demo",
    educationContext: "",
    timeBudget: "",
    knownConcepts: [],
    weakConcepts: [],
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
    goalDraft: "学习",
    selfRatingDraft: "beginner",
    diagnosisAnswer: "",
    diagnosisSubmitted: false,
    detailDrawer: "none",
  },
} satisfies RoleDSession

describe("applyWorkflowEvent", () => {
  test("upserts an incoming workflow event and preserves the rest of the session", () => {
    const incoming: WorkflowEventView = {
      id: "event-1",
      agent: "agent-a",
      stage: "阶段 A",
      status: "completed",
      summary: "完成",
      timestamp: "10:00:00",
    }

    const updated = applyWorkflowEvent(session, incoming)

    expect(updated.workflow).toEqual([incoming])
    expect(updated.eventMode).toBe("live")
    expect(updated.updatedAt).not.toBe(session.updatedAt)
    expect(session.workflow[0].status).toBe("pending")
  })
})