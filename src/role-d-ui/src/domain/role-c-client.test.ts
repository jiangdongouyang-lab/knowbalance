import { afterEach, describe, expect, test, vi } from "vitest"
import { requestRoleCContent } from "./role-c-client"
import { ROLE_C_HTTP_TIMEOUT_MS } from "./role-c-http"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Role C generation HTTP boundary", () => {
  test("blocks a truncated ready response before it reaches the D session adapter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "ready",
      runId: "RUN-1",
      artifacts: [],
      workflow: [],
      learningSession: {
        phase: "anchor_pending",
        sessionId: "SESSION-1",
        formId: "FORM-1",
        attemptNo: 1,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })))

    const result = await requestRoleCContent({
      profile: {
        learner_id: "learner-1",
        level: "beginner",
        known_concepts: [],
        weak_concepts: ["循环"],
        goal: "学习循环",
      },
      ragResult: { query: "循环", topK: 0, results: [] },
      kbVersion: "kb-v1",
      runId: "RUN-1",
    })

    expect(result).toMatchObject({
      status: "failed",
      runId: "RUN-1",
      reason: "Role C 返回内容不符合公开合同",
    })
  })

  test("aborts a generation request that exceeds the shared HTTP deadline", async () => {
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

    const pending = requestRoleCContent({
      profile: {
        learner_id: "learner-1",
        level: "beginner",
        known_concepts: [],
        weak_concepts: ["循环"],
        goal: "学习循环",
      },
      ragResult: { query: "循环", topK: 0, results: [] },
      kbVersion: "kb-v1",
      runId: "RUN-TIMEOUT",
    })
    await vi.advanceTimersByTimeAsync(ROLE_C_HTTP_TIMEOUT_MS)

    await expect(pending).resolves.toMatchObject({
      status: "failed",
      runId: "RUN-TIMEOUT",
      reason: "生成学习内容等待超时，请检查网络或服务状态后重试",
    })
    expect(requestSignal?.aborted).toBe(true)
  })
})
