import { afterEach, describe, expect, test, vi } from "vitest"
import { ROLE_C_HTTP_TIMEOUT_MS } from "./role-c-http"
import type { RoleDSession } from "./types"
import { routeRoleCAssessment, submitRoleCAssessment } from "./role-c-submission-client"

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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

  test("routes only the current anchor set before allowing the formal submission", async () => {
    const routedSession: RoleDSession = {
      ...session,
      artifacts: [{
        id: "ASSESSMENT-1",
        kind: "assessment",
        title: "分阶测评",
        status: "real",
        content: "公开题面",
        options: [],
        citations: [],
        evidenceStatus: "gap",
        items: [
          { id: "I1", tier: 1, modality: "mcq", prompt: "题 1", options: ["A", "B"], optionIds: ["A", "B"], citations: [] },
          { id: "I2", tier: 1, modality: "true_false", prompt: "题 2", options: ["T", "F"], optionIds: ["T", "F"], citations: [] },
          { id: "I3", tier: 2, modality: "short_answer", prompt: "题 3", options: [], citations: [] },
        ],
      }],
      roleC: {
        ...session.roleC!,
        profileVersion: "RUN-1-profile-v1",
        pathNodeId: "RUN-1-PATH-I1",
        targetSourceIds: ["I1"],
        routing: {
          phase: "anchor_pending",
          routingRequestId: "ROUTING-1",
          requiredItemIds: ["I1", "I2"],
        },
      },
      view: {
        ...session.view,
        assessmentAnswers: { I1: "A", I2: "T", I3: "不应提前发送" },
      },
    }
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>
      requests.push({ url: String(input), body })
      return new Response(JSON.stringify({
        status: "routed",
        routingRequestId: "ROUTING-1",
        anchorScoreRatio: 0.75,
        routeId: "ROUTE-1",
        action: "reinforce",
        requiredItemIds: ["I1", "I2", "I3"],
        learningSession: {
          phase: "route_locked",
          routingRequestId: "ROUTING-1",
          sessionId: "C-SESSION-1",
          runId: "RUN-1",
          formId: "FORM-1",
          attemptNo: 1,
          routeLockId: "LOCK-1",
          routeId: "ROUTE-1",
          action: "reinforce",
          anchorScoreRatio: 0.75,
          requiredItemIds: ["I1", "I2", "I3"],
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }))

    const result = await routeRoleCAssessment(routedSession)

    expect(result.outcome.status).toBe("routed")
    expect(requests[0]?.url).toBe("/api/role-c/route")
    expect(requests[0]?.body.submissionId).toBe("ANCHOR-ROUTING-1")
    expect(requests[0]?.body.answers.map((answer: { item_id: string }) => answer.item_id))
      .toEqual(["I1", "I2"])
  })

  test("accepts C grade items and derives their modality from the public assessment", async () => {
    const lockedSession: RoleDSession = {
      ...session,
      artifacts: [{
        id: "ASSESSMENT-1",
        kind: "assessment",
        title: "分阶测评",
        status: "real",
        content: "公开题面",
        options: [],
        citations: [],
        evidenceStatus: "gap",
        items: [
          { id: "I1", tier: 1, modality: "mcq", prompt: "题 1", options: ["A", "B"], optionIds: ["A", "B"], citations: [] },
        ],
      }],
      roleC: {
        ...session.roleC!,
        routing: {
          phase: "route_locked",
          routingRequestId: "ROUTING-1",
          routeLockId: "LOCK-1",
          routeId: "ROUTE-1",
          action: "advance",
          anchorScoreRatio: 1,
          requiredItemIds: ["I1"],
        },
      },
      view: { ...session.view, assessmentAnswers: { I1: "A" } },
    }
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { submissionId: string }
      return new Response(JSON.stringify({
        status: "completed",
        feedback: {
          schema_version: "1.0",
          feedback_id: "DFR-1",
          submission_id: body.submissionId,
          run_id: "RUN-1",
          session_id: "C-SESSION-1",
          learner_id_hash: "learner-1",
          profile_version: "RUN-1-profile-v1",
          path_node_id: "RUN-1-PATH-I1",
          form_id: "FORM-1",
          attempt_no: 1,
          round_score: { raw_score: 1, max_score: 1, accuracy: 1, evidence_score: 0.8 },
          objective_results: [{
            objective_id: "O1",
            raw_score: 1,
            max_score: 1,
            accuracy: 1,
            evidence_score: 0.8,
            misconception_tags: [],
          }],
          mastery_snapshot: [],
          final_decision: {
            action: "advance",
            basis: "round_accuracy",
            confidence: 0.8,
            reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
            target_objective_ids: [],
            policy_ref: "role-c-round-accuracy-v1",
          },
          grade_result: {
            schema_version: "1.0",
            run_id: "RUN-1",
            artifact_id: "GRADE-1",
            artifact_type: "grade_result",
            agent: "tiered-evaluator",
            status: "ready",
            versions: {
              profile_version: "RUN-1-profile-v1",
              kb_version: "kb-v1",
              rag_version: "rag-v1",
              prompt_version: "prompt-v1",
              model_config_hash: "model-v1",
              schema_version: "1.0",
            },
            seed: 1,
            input_refs: [body.submissionId],
            citations: [],
            quality: {
              schema_ok: true,
              citation_coverage: 1,
              objective_coverage: 1,
              alignment_score: 1,
              answer_key_verified: true,
            },
            payload: {
              submission_id: body.submissionId,
              form_id: "FORM-1",
              score_frozen: true,
              raw_score: 1,
              max_score: 1,
              evidence_score: 0.8,
              item_results: [{
                item_id: "I1",
                objective_id: "O1",
                raw_score: 1,
                max_score: 1,
                evidence_score: 0.8,
                grader_confidence: 1,
                hint_factor: 1,
                repeat_factor: 1,
                misconception_tags: [],
                feedback_code: "correct",
              }],
              recommendation: {
                action: "advance",
                confidence: 0.8,
                reason_codes: [
                  "round_accuracy_at_or_above_advancement_threshold",
                ],
              },
              feedback: {
                generated_after_score_freeze: true,
                mode: "formative",
                summary: "本轮达到进阶标准。",
                item_feedback: [{
                  item_id: "I1",
                  feedback_code: "correct",
                  message: "回答正确。",
                  next_step: "继续下一节点。",
                }],
              },
            },
            trace_ref: "TRACE-GRADE-1",
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }))

    const result = await submitRoleCAssessment(lockedSession)

    expect(result.outcome.status).toBe("completed")
  })

  test("rejects a truncated GradeResult and a blocked response from another submission", async () => {
    const lockedSession: RoleDSession = {
      ...session,
      artifacts: [{
        id: "ASSESSMENT-1",
        kind: "assessment",
        title: "分阶测评",
        status: "real",
        content: "公开题面",
        options: [],
        citations: [],
        evidenceStatus: "gap",
        items: [
          { id: "I1", tier: 1, modality: "mcq", prompt: "题 1", options: ["A", "B"], optionIds: ["A", "B"], citations: [] },
        ],
      }],
      roleC: {
        ...session.roleC!,
        routing: {
          phase: "route_locked",
          routingRequestId: "ROUTING-1",
          routeLockId: "LOCK-1",
          routeId: "ROUTE-1",
          action: "advance",
          anchorScoreRatio: 1,
          requiredItemIds: ["I1"],
        },
      },
      view: { ...session.view, assessmentAnswers: { I1: "A" } },
    }
    let requestCount = 0
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { submissionId: string }
      requestCount += 1
      return new Response(JSON.stringify(requestCount === 1
        ? {
            status: "completed",
            feedback: {
              schema_version: "1.0",
              feedback_id: "DFR-TRUNCATED",
              submission_id: body.submissionId,
              run_id: "RUN-1",
              session_id: "C-SESSION-1",
              learner_id_hash: "learner-1",
              profile_version: "RUN-1-profile-v1",
              path_node_id: "RUN-1-PATH-I1",
              form_id: "FORM-1",
              attempt_no: 1,
              round_score: { raw_score: 1, max_score: 1, accuracy: 1, evidence_score: 1 },
              objective_results: [{
                objective_id: "O1",
                raw_score: 1,
                max_score: 1,
                accuracy: 1,
                evidence_score: 1,
                misconception_tags: [],
              }],
              mastery_snapshot: [],
              final_decision: {
                action: "advance",
                basis: "round_accuracy",
                confidence: 1,
                reason_codes: ["advance"],
                target_objective_ids: [],
                policy_ref: "role-c-round-accuracy-v1",
              },
              grade_result: {
                artifact_id: "GRADE-TRUNCATED",
                payload: null,
              },
            },
          }
        : {
            status: "blocked",
            submission_id: "SUB-OLD",
            code: "TEMPORARY_UNAVAILABLE",
            message: "旧请求失败",
          }), { status: 200, headers: { "content-type": "application/json" } })
    }))

    const truncated = await submitRoleCAssessment(lockedSession)
    const foreignBlocked = await submitRoleCAssessment(lockedSession)

    expect(truncated.outcome).toMatchObject({
      status: "blocked",
      code: "ROLE_C_RESPONSE_INVALID",
    })
    expect(foreignBlocked.outcome).toMatchObject({
      status: "blocked",
      code: "ROLE_C_RESPONSE_INVALID",
    })
  })

  test("uses a content-stable final submission id so an uncertain response can be retried", async () => {
    const lockedSession: RoleDSession = {
      ...session,
      artifacts: [{
        id: "ASSESSMENT-1",
        kind: "assessment",
        title: "分阶测评",
        status: "real",
        content: "公开题面",
        options: [],
        citations: [],
        evidenceStatus: "gap",
        items: [
          { id: "I1", tier: 1, modality: "mcq", prompt: "题 1", options: ["A", "B"], optionIds: ["A", "B"], citations: [] },
        ],
      }],
      roleC: {
        ...session.roleC!,
        routing: {
          phase: "route_locked",
          routingRequestId: "ROUTING-1",
          routeLockId: "LOCK-1",
          routeId: "ROUTE-1",
          action: "reinforce",
          anchorScoreRatio: 0.75,
          requiredItemIds: ["I1"],
        },
      },
      view: { ...session.view, assessmentAnswers: { I1: "A" } },
    }
    const submissionIds: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { submissionId: string }
      submissionIds.push(body.submissionId)
      return new Response(JSON.stringify({
        status: "blocked",
        submission_id: body.submissionId,
        code: "TEMPORARY_UNAVAILABLE",
        message: "请重试",
      }), { status: 503, headers: { "content-type": "application/json" } })
    }))

    await submitRoleCAssessment(lockedSession)
    await submitRoleCAssessment(structuredClone(lockedSession))
    await submitRoleCAssessment({
      ...lockedSession,
      view: { ...lockedSession.view, assessmentAnswers: { I1: "B" } },
    })

    expect(submissionIds[0]).toBe(submissionIds[1])
    expect(submissionIds[2]).not.toBe(submissionIds[0])
  })

  test("aborts hung route and submit requests while preserving retryable state", async () => {
    vi.useFakeTimers()
    const requestSignals: AbortSignal[] = []
    vi.stubGlobal("fetch", vi.fn((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error("signal missing"))
      requestSignals.push(signal)
      signal.addEventListener("abort", () => {
        const error = new Error("The operation was aborted")
        error.name = "AbortError"
        reject(error)
      }, { once: true })
    })))
    const assessment = {
      id: "ASSESSMENT-TIMEOUT",
      kind: "assessment" as const,
      title: "分阶测评",
      status: "real" as const,
      content: "公开题面",
      options: [],
      citations: [],
      evidenceStatus: "gap" as const,
      items: [{
        id: "I1",
        tier: 1 as const,
        modality: "mcq" as const,
        prompt: "题 1",
        options: ["A", "B"],
        optionIds: ["A", "B"],
        citations: [],
      }],
    }
    const anchorPending: RoleDSession = {
      ...session,
      artifacts: [assessment],
      roleC: {
        ...session.roleC!,
        routing: {
          phase: "anchor_pending",
          routingRequestId: "ROUTING-TIMEOUT",
          requiredItemIds: ["I1"],
        },
      },
      view: {
        ...session.view,
        assessmentAnswers: { I1: "A" },
      },
    }
    const routePending = routeRoleCAssessment(anchorPending)
    await vi.advanceTimersByTimeAsync(ROLE_C_HTTP_TIMEOUT_MS)
    await expect(routePending).resolves.toMatchObject({
      outcome: {
        status: "blocked",
        issues: [
          "确认测评路线等待超时，请检查网络或服务状态后重试。",
        ],
      },
    })

    const routeLocked: RoleDSession = {
      ...anchorPending,
      roleC: {
        ...anchorPending.roleC!,
        routing: {
          phase: "route_locked",
          routingRequestId: "ROUTING-TIMEOUT",
          routeLockId: "LOCK-TIMEOUT",
          routeId: "ROUTE-TIMEOUT",
          action: "reinforce",
          anchorScoreRatio: 0.5,
          requiredItemIds: ["I1"],
        },
      },
    }
    const submitPending = submitRoleCAssessment(routeLocked)
    await vi.advanceTimersByTimeAsync(ROLE_C_HTTP_TIMEOUT_MS)
    await expect(submitPending).resolves.toMatchObject({
      outcome: {
        status: "blocked",
        code: "ROLE_C_SUBMISSION_UNAVAILABLE",
        message:
          "提交测评等待超时，答案已保留，请检查网络或服务状态后重试",
      },
    })
    expect(requestSignals).toHaveLength(2)
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true)
  })

})
