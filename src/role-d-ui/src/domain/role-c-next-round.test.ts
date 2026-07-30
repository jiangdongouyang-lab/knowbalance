import { afterEach, describe, expect, test, vi } from "vitest"
import type { RoleCForRoleDResult } from "../../../role-d-integration/contracts"
import {
  completedRoleDSession,
  nextRoundHandoff,
} from "../test/role-c-next-round-fixtures"
import {
  applyRoleCNextRoundHandoff,
  completedRoleCRoundIdentity,
} from "./adapt-handoff"
import { applyRoleCRoutingOutcome } from "./role-c-submission"
import {
  routeRoleCAssessment,
  submitRoleCAssessment,
} from "./role-c-submission-client"

type ReadyHandoff = Extract<RoleCForRoleDResult, { status: "ready" }>

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Role D next-round handoff", () => {
  test("replaces the C learning session, resets learner input, and reuses route/submit", async () => {
    const current = completedRoleDSession()
    const identity = completedRoleCRoundIdentity(current)!
    const next = applyRoleCNextRoundHandoff(
      current,
      identity,
      nextRoundHandoff,
      "2026-07-31T00:00:00.000Z",
    )

    expect(next.sessionId).toBe(current.sessionId)
    expect(next.roleC).toMatchObject({
      runId: "RUN-NEXT",
      learningSessionId: "C-SESSION-NEXT",
      formId: "FORM-NEXT",
      routing: {
        phase: "anchor_pending",
        routingRequestId: "ROUTING-NEXT",
        requiredItemIds: ["NEXT-I1"],
      },
    })
    expect(next.artifacts.map((artifact) => artifact.id)).toEqual([
      "LESSON-NEXT",
      "LAB-NEXT",
      "ASSESSMENT-NEXT",
    ])
    expect(next.feedback).toBeUndefined()
    expect(next.assessmentGraded).toBe(false)
    expect(next.view).toMatchObject({
      currentStage: "learning",
      activeArtifactKind: "lesson",
      assessmentAnswers: {},
      assessmentSubmitted: false,
      assessmentStatus: "idle",
    })

    const requests: Array<{
      url: string
      body: Record<string, unknown>
    }> = []
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      if (url.endsWith("/route")) {
        return jsonResponse({
          status: "routed",
          routingRequestId: "ROUTING-NEXT",
          anchorScoreRatio: 1,
          routeId: "ROUTE-NEXT",
          action: "reinforce",
          requiredItemIds: ["NEXT-I1"],
          learningSession: {
            phase: "route_locked",
            routingRequestId: "ROUTING-NEXT",
            sessionId: "C-SESSION-NEXT",
            runId: "RUN-NEXT",
            formId: "FORM-NEXT",
            attemptNo: 1,
            routeLockId: "LOCK-NEXT",
            routeId: "ROUTE-NEXT",
            action: "reinforce",
            anchorScoreRatio: 1,
            requiredItemIds: ["NEXT-I1"],
          },
        }, 200)
      }
      return jsonResponse({
        status: "blocked",
        submission_id: body.submissionId,
        code: "TEST_STOP_AFTER_BOUNDARY",
        message: "已验证下一轮正式提交边界。",
      }, 422)
    }))

    const answered = {
      ...next,
      view: {
        ...next.view,
        assessmentAnswers: { "NEXT-I1": "opt_iterate" },
      },
    }
    const routed = await routeRoleCAssessment(answered)
    expect(routed.outcome.status).toBe("routed")
    const locked = applyRoleCRoutingOutcome(answered, routed.outcome)
    const submitted = await submitRoleCAssessment(locked)

    expect(submitted.outcome).toMatchObject({
      status: "blocked",
      code: "TEST_STOP_AFTER_BOUNDARY",
    })
    expect(requests.map((request) => request.url)).toEqual([
      "/api/role-c/route",
      "/api/role-c/submit",
    ])
    expect(requests.map((request) => ({
      sessionId: request.body.sessionId,
      runId: request.body.runId,
      formId: request.body.formId,
    }))).toEqual([
      {
        sessionId: "C-SESSION-NEXT",
        runId: "RUN-NEXT",
        formId: "FORM-NEXT",
      },
      {
        sessionId: "C-SESSION-NEXT",
        runId: "RUN-NEXT",
        formId: "FORM-NEXT",
      },
    ])
  })

  test("marks citations outside the current A retrieval as explicit evidence gaps", () => {
    const current = completedRoleDSession()
    const identity = completedRoleCRoundIdentity(current)!
    const external = structuredClone(nextRoundHandoff) as ReadyHandoff
    external.learningSession.targetSourceIds = ["K999"]
    external.artifacts[0]!.citations = [{
      source_id: "K999",
      fact_id: "F001",
    }]

    const next = applyRoleCNextRoundHandoff(
      current,
      identity,
      external,
    )

    expect(next.artifacts.find((artifact) =>
      artifact.id === "LESSON-NEXT")?.evidenceStatus).toBe("gap")
    expect(next.evidenceGaps).toContain("LESSON-NEXT")
    expect(next.view.selectedSourceId).toBe("K007")
    expect(next.path.find((node) => node.id === "K007")?.status)
      .toBe("upcoming")
    expect(next.path.find((node) => node.id === "K999"))
      .toMatchObject({
        status: "current",
        title: "下一轮循环讲义",
      })
  })

  test("ignores a handoff when the completed round identity has gone stale", () => {
    const current = completedRoleDSession()
    const identity = completedRoleCRoundIdentity(current)!
    const advancedLocally = {
      ...current,
      roleC: {
        ...current.roleC!,
        runId: "RUN-ALREADY-REPLACED",
      },
    }

    const result = applyRoleCNextRoundHandoff(
      advancedLocally,
      identity,
      nextRoundHandoff,
    )

    expect(result).toBe(advancedLocally)
    expect(result.roleC?.runId).toBe("RUN-ALREADY-REPLACED")
  })
})

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}
