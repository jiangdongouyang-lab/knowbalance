import { afterEach, describe, expect, test } from "bun:test"
import {
  continueRoleCAfterSubmission as continueRoleCAfterSubmissionService,
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessment as routeRoleCAssessmentService,
  submitRoleCAssessment as submitRoleCAssessmentService,
} from "../src/role-d-integration/role-c-service"
import {
  createLearningPlan,
} from "../src/role-d-ui/src/domain/create-learning-plan"
import {
  applyRoleCNextRoundHandoff,
  completedRoleCRoundIdentity,
} from "../src/role-d-ui/src/domain/adapt-handoff"
import {
  continueRoleCAfterSubmission,
} from "../src/role-d-ui/src/domain/role-c-continuation-client"
import {
  applyRoleCRoutingOutcome,
  applyRoleCSubmissionOutcome,
} from "../src/role-d-ui/src/domain/role-c-submission"
import {
  routeRoleCAssessment,
  submitRoleCAssessment,
} from "../src/role-d-ui/src/domain/role-c-submission-client"
import type {
  RoleDSession,
} from "../src/role-d-ui/src/domain/types"
import { RoleCTestRunner } from "./helpers/role-c-test-runner"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("D HTTP client and actual C contract", () => {
  test("accepts C feedback, installs its next handoff, and submits the second round", async () => {
    const plan = await createLearningPlan({
      learnerId: "student-d-client-contract",
      educationContext: "大二非计算机专业",
      timeBudget: "每周 4 小时",
      selfRating: "intermediate",
      knownConcepts: ["变量", "列表", "函数", "基本数据类型"],
      weakConcepts: ["循环综合应用", "项目组织"],
      goal: "完成成绩统计程序",
    }, (input) => generateRoleCForRoleDWithRuntime(input, {
      providerMode: "deterministic",
      runner: new RoleCTestRunner(),
    }))
    const assessment = plan.session.artifacts.find((artifact) =>
      artifact.kind === "assessment")
    if (!assessment) throw new Error("TEST_ASSESSMENT_MISSING")
    const anchorIds = new Set(
      plan.session.roleC?.routing?.requiredItemIds ?? [],
    )
    const pending: RoleDSession = {
      ...plan.session,
      view: {
        ...plan.session.view,
        assessmentAnswers: Object.fromEntries(
          (assessment.items ?? [])
            .filter((item) => anchorIds.has(item.id))
            .map((item) => [item.id, answerFor(item)]),
        ),
      },
    }
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as never
      const result = String(url).includes("/continue")
        ? await continueRoleCAfterSubmissionService(body)
        : String(url).includes("/route")
        ? await routeRoleCAssessmentService(body)
        : await submitRoleCAssessmentService(body)
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const routed = await routeRoleCAssessment(pending)
    expect(routed.outcome.status).toBe("routed")
    const locked = applyRoleCRoutingOutcome(pending, routed.outcome)
    const required = new Set(
      locked.roleC?.routing?.requiredItemIds ?? [],
    )
    const readyToSubmit: RoleDSession = {
      ...locked,
      view: {
        ...locked.view,
        assessmentAnswers: Object.fromEntries(
          (assessment.items ?? [])
            .filter((item) => required.has(item.id))
            .map((item) => [
              item.id,
              locked.view.assessmentAnswers?.[item.id]
                ?? answerFor(item, false),
            ]),
        ),
      },
    }

    const completed = await submitRoleCAssessment(readyToSubmit)

    expect(completed.outcome).toMatchObject({ status: "completed" })
    const graded = applyRoleCSubmissionOutcome(
      readyToSubmit,
      completed.submissionId,
      completed.outcome,
    )
    expect(graded).toMatchObject({
      assessmentGraded: true,
      decision: { next: "reinforce" },
    })

    const continued = await continueRoleCAfterSubmission(graded)
    expect(continued).toMatchObject({
      status: "published",
      handoff: {
        learningSession: { phase: "anchor_pending" },
      },
    })
    if (continued.status !== "published") return
    const second = applyRoleCNextRoundHandoff(
      graded,
      completedRoleCRoundIdentity(graded)!,
      continued.handoff,
    )
    expect(second).toMatchObject({
      assessmentGraded: false,
      roleC: {
        runId: continued.handoff.runId,
        learningSessionId: continued.handoff.learningSession.sessionId,
        routing: { phase: "anchor_pending" },
      },
      view: {
        currentStage: "learning",
        assessmentAnswers: {},
      },
    })

    const secondAssessment = second.artifacts.find((artifact) =>
      artifact.kind === "assessment")
    if (!secondAssessment) throw new Error("TEST_NEXT_ASSESSMENT_MISSING")
    const secondAnchorIds = new Set(
      second.roleC?.routing?.requiredItemIds ?? [],
    )
    const secondPending: RoleDSession = {
      ...second,
      view: {
        ...second.view,
        assessmentAnswers: Object.fromEntries(
          (secondAssessment.items ?? [])
            .filter((item) => secondAnchorIds.has(item.id))
            .map((item) => [item.id, answerFor(item)]),
        ),
      },
    }
    const secondRoute = await routeRoleCAssessment(secondPending)
    expect(secondRoute.outcome.status).toBe("routed")
    const secondLocked = applyRoleCRoutingOutcome(
      secondPending,
      secondRoute.outcome,
    )
    const secondRequired = new Set(
      secondLocked.roleC?.routing?.requiredItemIds ?? [],
    )
    const secondReady: RoleDSession = {
      ...secondLocked,
      view: {
        ...secondLocked.view,
        assessmentAnswers: Object.fromEntries(
          (secondAssessment.items ?? [])
            .filter((item) => secondRequired.has(item.id))
            .map((item) => [
              item.id,
              secondLocked.view.assessmentAnswers?.[item.id]
                ?? answerFor(item),
            ]),
        ),
      },
    }
    const secondCompleted = await submitRoleCAssessment(secondReady)

    expect(secondCompleted.outcome).toMatchObject({ status: "completed" })
  })
})

function answerFor(
  item: NonNullable<
    RoleDSession["artifacts"][number]["items"]
  >[number],
  correctCode = true,
): string {
  if (item.modality === "mcq") {
    const index = item.options.findIndex((option) =>
      option.includes("依次处理"))
    return item.optionIds?.[index >= 0 ? index : 0]
      ?? item.options[0]
      ?? "A"
  }
  if (item.modality === "true_false") {
    const index = item.options.findIndex((option) =>
      option.includes("正确"))
    return item.optionIds?.[index >= 0 ? index : 0]
      ?? item.options[0]
      ?? "A"
  }
  if (item.modality === "trace") return "6"
  if (item.modality === "short_answer") {
    return "列表按顺序保存多项成绩，并可使用循环逐项处理。"
  }
  return correctCode
    ? "def average_score(scores):\n    return sum(scores) / len(scores)"
    : "def average_score(scores):\n    return None"
}
