import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import { RoleBLearningProgressAdapter } from "../src/role-b-profile/teaching-audit"
import type { LearnerProfile } from "../src/role-b-profile/types"
import { RoleDRoleCDeliveryReceiver } from "../src/role-d-integration/role-c-delivery-receiver"
import {
  continueRoleCAfterSubmission,
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessment,
  submitRoleCAssessment,
} from "../src/role-d-integration/role-c-service"
import { RoleCTestRunner } from "./helpers/role-c-test-runner"

describe("B/A/C/D adaptive team flow", () => {
  test("runs a completed round into B's updated profile and a routable second round", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const profile: LearnerProfile = {
      learner_id: "student-team-adaptive-001",
      level: "intermediate",
      known_concepts: ["变量", "列表", "函数", "基本数据类型"],
      weak_concepts: ["循环综合应用", "项目组织"],
      goal: "完成成绩统计程序",
    }
    const runId = "RUN-TEAM-ADAPTIVE-001"
    const { rag_result: ragResult } =
      await executeProfileRetrieval(profile)
    const roleB = new RoleBLearningProgressAdapter({
      knowledgeBase,
      learners: [{
        learnerIdHash: profile.learner_id,
        currentProfile: profile,
        profileVersion: `${runId}-profile-v1`,
        profileRevision: 1,
      }],
    })
    const roleD = new FailOnceOnNextReleaseReceiver(
      "role-d-team-adaptive-test",
    )

    const generated = await generateRoleCForRoleDWithRuntime({
      profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId,
    }, {
      runner: new RoleCTestRunner(),
      roleDPort: roleD,
      learningProgressPort: roleB,
    })
    expect(generated.status).toBe("ready")
    if (generated.status !== "ready") return
    expect(generated.learningSession).toMatchObject({
      phase: "anchor_pending",
      requiredItemIds: anchorAnswers().map((answer) => answer.item_id),
    })

    const firstIdentity = {
      sessionId: generated.learningSession.sessionId,
      runId: generated.runId,
      learnerId: profile.learner_id,
      formId: generated.learningSession.formId,
      attemptNo: generated.learningSession.attemptNo,
    }
    const firstRoute = await routeRoleCAssessment({
      ...firstIdentity,
      routingRequestId: generated.learningSession.routingRequestId,
      submissionId: "SUB-TEAM-ANCHORS-1",
      answers: anchorAnswers(),
    })
    expect(firstRoute).toMatchObject({
      status: "routed",
      action: "advance",
      learningSession: { phase: "route_locked" },
    })
    if (firstRoute.status !== "routed") return

    const firstCompletion = await submitRoleCAssessment({
      ...firstIdentity,
      submissionId: "SUB-TEAM-FINAL-1",
      answers: reinforcementAnswers().filter((answer) =>
        firstRoute.requiredItemIds.includes(answer.item_id)),
    })
    expect(firstCompletion.status).toBe("completed")
    if (firstCompletion.status !== "completed") return
    expect(firstCompletion.feedback.round_score.accuracy).toBe(0.6)
    expect(firstCompletion.feedback.final_decision.action)
      .toBe("reinforce")

    const updatedBState = roleB.getCurrentState(profile.learner_id)
    expect(updatedBState?.profileRevision).toBe(2)
    expect(updatedBState?.currentProfile.known_concepts)
      .toEqual(expect.arrayContaining(["列表", "函数", "for 循环"]))
    expect(updatedBState?.currentProfile.weak_concepts)
      .toContain("成绩统计器综合项目")
    expect(updatedBState?.currentSnapshot.profile_version)
      .not.toBe(`${runId}-profile-v1`)

    const continueInput = {
      sessionId: firstIdentity.sessionId,
      submissionId: "SUB-TEAM-FINAL-1",
      learnerId: profile.learner_id,
      nextProfileSnapshot: updatedBState!.currentSnapshot,
    }
    await expect(continueRoleCAfterSubmission(continueInput))
      .rejects.toThrow("TEST_D_NEXT_RELEASE_TRANSIENT")
    const continued = await continueRoleCAfterSubmission(continueInput)
    expect(continued).toMatchObject({
      status: "published",
      preparation: {
        action: "reinforce",
        profile_version: updatedBState!.profileVersion,
      },
      learning_session: {
        phase: "anchor_pending",
      },
      delivery_to_d: {
        reviewed_release: { status: "accepted" },
        learning_session: { status: "accepted" },
      },
      role_d_handoff: {
        status: "ready",
        learningSession: {
          phase: "anchor_pending",
        },
      },
    })
    if (continued.status !== "published") return
    expect(continued.role_d_handoff.artifacts.map((artifact) =>
      artifact.kind)).toEqual(["lesson", "lab", "assessment"])

    const secondSession = continued.role_d_handoff.learningSession
    const secondIdentity = {
      sessionId: secondSession.sessionId,
      runId: continued.role_d_handoff.runId,
      learnerId: profile.learner_id,
      formId: secondSession.formId,
      attemptNo: secondSession.attemptNo,
    }
    const secondRoute = await routeRoleCAssessment({
      ...secondIdentity,
      routingRequestId: secondSession.routingRequestId,
      submissionId: "SUB-TEAM-ANCHORS-2",
      answers: anchorAnswers(),
    })
    expect(secondRoute).toMatchObject({
      status: "routed",
      action: "advance",
      learningSession: { phase: "route_locked" },
    })
    if (secondRoute.status !== "routed") return

    const secondCompletion = await submitRoleCAssessment({
      ...secondIdentity,
      submissionId: "SUB-TEAM-FINAL-2",
      answers: fullScoreAnswers().filter((answer) =>
        secondRoute.requiredItemIds.includes(answer.item_id)),
    })
    expect(secondCompletion.status).toBe("completed")
    if (secondCompletion.status !== "completed") return
    expect(secondCompletion.feedback.round_score.accuracy).toBe(1)
    expect(secondCompletion.feedback.final_decision.action).toBe("advance")
    expect(roleB.getCurrentState(profile.learner_id)?.profileRevision)
      .toBe(3)

    const deliveries = roleD.snapshot()
    expect(deliveries.reviewed_releases).toHaveLength(2)
    expect(deliveries.learning_sessions).toHaveLength(4)
    expect(deliveries.learning_sessions.map((delivery) =>
      delivery.session.phase)).toEqual([
      "anchor_pending",
      "route_locked",
      "anchor_pending",
      "route_locked",
    ])
    expect(JSON.stringify(deliveries)).not.toContain("secure://role-c/")
    expect(JSON.stringify(deliveries)).not.toContain("answer_spec")
  })
})

class FailOnceOnNextReleaseReceiver
extends RoleDRoleCDeliveryReceiver {
  private reviewedReleaseCalls = 0

  override async publishReviewedRelease(
    delivery: Parameters<
      RoleDRoleCDeliveryReceiver["publishReviewedRelease"]
    >[0],
  ) {
    this.reviewedReleaseCalls += 1
    if (this.reviewedReleaseCalls === 2) {
      throw new Error("TEST_D_NEXT_RELEASE_TRANSIENT")
    }
    return super.publishReviewedRelease(delivery)
  }
}

function anchorAnswers() {
  return [
    {
      item_id: "ITEM-O1-T1-MCQ",
      selected_option_id: "opt_iterate",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O2-T1-TF",
      selected_option_id: "opt_true",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O1-T2-TRACE",
      text_response: "8",
      hint_level_used: 0 as const,
    },
  ]
}

function reinforcementAnswers() {
  return [
    ...anchorAnswers(),
    {
      item_id: "ITEM-O2-T2-SHORT",
      text_response:
        "列表保存一组成绩并保持顺序，程序可以逐项处理。",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O3-T3-CODE",
      code_response: "def average_score(scores):\n    return None",
      hint_level_used: 0 as const,
    },
  ]
}

function fullScoreAnswers() {
  return [
    ...anchorAnswers(),
    {
      item_id: "ITEM-O2-T2-SHORT",
      text_response:
        "列表保存一组成绩并保持顺序，可以逐项处理每个成绩。",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O3-T3-CODE",
      code_response: [
        "def average_score(scores):",
        "    total = 0",
        "    count = 0",
        "    for score in scores:",
        "        total += score",
        "        count += 1",
        "    return total / count",
      ].join("\n"),
      hint_level_used: 0 as const,
    },
  ]
}
