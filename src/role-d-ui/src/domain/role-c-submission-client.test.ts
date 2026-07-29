import { afterEach, describe, expect, test, vi } from "vitest"
import type { RoleDSession } from "./types"
import { submitRoleCAssessment } from "./role-c-submission-client"

const session = {
  version: 1,
  eventMode: "live",
  sessionId: "session-d-1",
  updatedAt: "2026-07-29T00:00:00.000Z",
  profile: { learnerId: "learner-1", level: "integrated", knownConcepts: [], weakConcepts: [], goal: "完成成绩统计" },
  conflicts: [], retrieval: { query: "", topK: 0, items: [] }, artifacts: [], evidenceGaps: [], workflow: [], path: [],
  decision: { next: "remediate", reason: "等待评分" }, assessmentGraded: false,
  roleC: { runId: "RUN-1", learningSessionId: "C-SESSION-1", formId: "FORM-1", attemptNo: 1 },
  planSource: "real-ab", planInput: { learnerId: "learner-1", educationContext: "", timeBudget: "", knownConcepts: [], weakConcepts: [] },
  diagnosis: { sourceId: "UNKNOWN", factId: "UNKNOWN", concept: "", difficulty: "beginner", question: "", options: [], answer: "" },
  view: { currentStage: "learning", maxUnlockedStage: "feedback", activeArtifactKind: "assessment", selectedSourceId: "", remediationStarted: false, goalDraft: "", selfRatingDraft: "integrated", diagnosisAnswer: "", diagnosisSubmitted: false, assessmentAnswers: {}, assessmentSubmitted: false, assessmentStatus: "idle", detailDrawer: "none" },
} satisfies RoleDSession

afterEach(() => vi.restoreAllMocks())

describe("Role C submission HTTP boundary", () => {
  test("rejects a completed response that does not satisfy the public C feedback contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      feedback: { feedback_id: "DFR-BROKEN", submission_id: "SUB-BROKEN" },
    }), { status: 200, headers: { "content-type": "application/json" } })))

    const result = await submitRoleCAssessment(session)

    expect(result.outcome.status).toBe("blocked")
    if (result.outcome.status === "blocked") expect(result.outcome.code).toBe("ROLE_C_RESPONSE_INVALID")
  })
})