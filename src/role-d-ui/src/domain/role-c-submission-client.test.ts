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

  test("accepts a real C grade result whose item results use feedback_code instead of modality/status", async () => {
    const feedback = {
      feedback_id: "DFR-8b92a70b",
      submission_id: "SUB-REAL-1",
      run_id: "RUN-1",
      session_id: "C-SESSION-1",
      learner_id_hash: "learner-1",
      profile_version: "RUN-1-profile-v1",
      path_node_id: "PATH-1",
      form_id: "FORM-1",
      attempt_no: 1,
      round_score: { raw_score: 1, max_score: 5, accuracy: 0.2, evidence_score: 0.5 },
      objective_results: [{ objective_id: "OBJECTIVE-1", raw_score: 1, max_score: 5, accuracy: 0.2, evidence_score: 0.5, misconception_tags: ["code:assertion_failed"] }],
      grade_result: {
        artifact_id: "ART-1",
        payload: {
          item_results: [
            { item_id: "ITEM-1", objective_id: "OBJECTIVE-1", raw_score: 1, max_score: 1, evidence_score: 1, misconception_tags: [], feedback_code: "correct" },
            { item_id: "ITEM-2", objective_id: "OBJECTIVE-1", raw_score: 0, max_score: 4, evidence_score: 0, misconception_tags: ["code:assertion_failed"], feedback_code: "failed" },
          ],
          feedback: { summary: "本次完成 2 题，其中 1 题达到完整要求。" },
        },
      },
      mastery_snapshot: [{ objective_id: "OBJECTIVE-1", mastery: 0.5, evidence_batches: 1, observed_modalities: ["mcq", "code"], revision: 1 }],
      final_decision: {
        action: "remediate",
        basis: "round_accuracy",
        confidence: 0.8,
        reason_codes: ["round_accuracy_below_remediation_threshold"],
        target_objective_ids: ["OBJECTIVE-1"],
        policy_ref: "role-c-round-accuracy-v1",
      },
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "completed", feedback }), { status: 200, headers: { "content-type": "application/json" } })))

    const result = await submitRoleCAssessment(session)

    expect(result.outcome.status).toBe("completed")
    if (result.outcome.status === "completed") {
      expect(result.outcome.feedback.grade_result.payload?.item_results?.[0]?.feedback_code).toBe("correct")
      expect(result.outcome.feedback.grade_result.payload?.item_results?.[1]?.feedback_code).toBe("failed")
    }
  })
})