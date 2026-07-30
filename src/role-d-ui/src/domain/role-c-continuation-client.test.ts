import { afterEach, describe, expect, test, vi } from "vitest"
import {
  completedRoleDSession,
  publishedContinuationResponse,
} from "../test/role-c-next-round-fixtures"
import {
  continueRoleCAfterSubmission,
  ROLE_C_CONTINUATION_TIMEOUT_MS,
} from "./role-c-continuation-client"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Role C continuation HTTP boundary", () => {
  test("accepts a bound published handoff and sends only the completed round identity", async () => {
    const requests: Array<Record<string, unknown>> = []
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("/api/role-c/continue")
      requests.push(JSON.parse(String(init?.body)))
      return jsonResponse(publishedContinuationResponse(), 200)
    }))

    const result = await continueRoleCAfterSubmission(
      completedRoleDSession(),
    )

    expect(requests).toEqual([{
      sessionId: "C-SESSION-CURRENT",
      submissionId: "SUBMISSION-CURRENT",
      learnerId: "learner-1",
    }])
    expect(result).toMatchObject({
      status: "published",
      handoff: {
        runId: "RUN-NEXT",
        learningSession: {
          phase: "anchor_pending",
          sessionId: "C-SESSION-NEXT",
        },
      },
    })
  })

  test("keeps awaiting A/B input and an expired C context as understandable retry states", async () => {
    const responses = [
      {
        status: "awaiting_input",
        preparation: {
          status: "awaiting_path_node",
          action: "advance",
          required_inputs: ["next_path_node", "next_evidence_pack"],
        },
      },
      {
        status: "blocked",
        stage: "context",
        code: "SESSION_NOT_FOUND",
        issues: ["C 学习会话不存在或服务已重启"],
      },
    ]
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(responses.shift(), responses.length === 1 ? 200 : 422)))

    const awaiting = await continueRoleCAfterSubmission(
      completedRoleDSession(),
    )
    const expired = await continueRoleCAfterSubmission(
      completedRoleDSession(),
    )

    expect(awaiting).toEqual({
      status: "awaiting_input",
      message: "下一轮需要 A/B 提供新的学习路径与检索证据，请完成上游更新后重试。",
    })
    expect(expired).toEqual({
      status: "blocked",
      message: "C 学习会话不存在或服务已重启",
    })
  })

  test("rejects a published response bound to another feedback without exposing its handoff", async () => {
    const stale = publishedContinuationResponse()
    stale.preparation.prior_feedback_ref = "FEEDBACK-ANOTHER-ROUND"
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(stale, 200)))

    const result = await continueRoleCAfterSubmission(
      completedRoleDSession(),
    )

    expect(result).toEqual({
      status: "failed",
      message: "C 返回了不符合公开合同的下一轮响应。",
    })
    expect(result).not.toHaveProperty("handoff")
  })

  test("rejects malformed nested public artifacts before the session adapter runs", async () => {
    const malformed = publishedContinuationResponse()
    malformed.role_d_handoff.artifacts[0]!.citations =
      [null as never]
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(malformed, 200)))

    const result = await continueRoleCAfterSubmission(
      completedRoleDSession(),
    )

    expect(result).toEqual({
      status: "failed",
      message: "C 返回了不符合公开合同的下一轮响应。",
    })
  })

  test("aborts a hung continuation request and returns a friendly retry message", async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal("fetch", vi.fn((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined
      requestSignal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted")
        error.name = "AbortError"
        reject(error)
      }, { once: true })
    })))

    const pending = continueRoleCAfterSubmission(
      completedRoleDSession(),
    )
    await vi.advanceTimersByTimeAsync(ROLE_C_CONTINUATION_TIMEOUT_MS)

    await expect(pending).resolves.toEqual({
      status: "failed",
      message: "准备下一轮等待超时，已保留本轮结果，请检查网络或服务状态后重试。",
    })
    expect(requestSignal?.aborted).toBe(true)
  })
})

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}
