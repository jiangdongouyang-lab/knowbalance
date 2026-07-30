import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import { synthesizeProfile } from "../src/role-b-profile/profile-synthesizer"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  contentHash,
  type RoleBLearningProgressPort,
  type RoleCLearningProgressDelivery,
  type RoleCReviewRecoveryStatusDelivery,
  type RoleCReviewedReleaseDelivery,
} from "../src/role-c-content"
import {
  RoleDRoleCDeliveryReceiver,
} from "../src/role-d-integration/role-c-delivery-receiver"
import {
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessment,
  submitRoleCAssessment,
} from "../src/role-d-integration/role-c-service"
import {
  createLearningPlan,
  evaluatePlanDiagnosis,
} from "../src/role-d-ui/src/domain/create-learning-plan"
import { RoleCTestRunner } from "./helpers/role-c-test-runner"

describe("Role D → official Role C integration", () => {
  test("derives targets from A retrieval instead of requiring the fixed score-project trio", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const synthesis = synthesizeProfile({
      background: {
        evidence_type: "background",
        learner_id: "student-variable-001",
        education_context: "大二非计算机专业",
        prior_languages: ["Python"],
        prior_topics: ["Python 是什么"],
        goal_raw: "学会变量与赋值，能用变量保存和更新数据",
        time_budget: "每周 4 小时",
        quotes: [],
      },
      selfAssessment: {
        evidence_type: "self_assessment",
        self_rating: "beginner",
        claimed_known: ["Python 是什么"],
        claimed_weak: ["变量"],
        quotes: [],
      },
      objectiveDiagnosis: {
        evidence_type: "objective_diagnosis",
        items: [],
        quotes: [],
      },
      knowledgeBase,
    })
    const { rag_result: ragResult } =
      await executeProfileRetrieval(synthesis.profile)

    const result = await generateRoleCForRoleDWithRuntime({
      profile: synthesis.profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DYNAMIC-K002-INTEGRATION",
    }, {
      runner: new RoleCTestRunner(),
    })

    expect("reason" in result ? result.reason : "")
      .not.toContain("K007、K009、K018")
    expect(result.workflow.some((event) =>
      event.agent === "concept-tutor"
        && event.status === "completed")).toBe(true)
    expect(result.workflow.some((event) =>
      event.agent === "code-lab"
        && event.status === "blocked")).toBe(true)
    expect("reason" in result ? result.reason : "")
      .toContain("离线 code-lab 基准实现")
  })

  test("does not duplicate a sole preferred target before fallback candidates", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const retrievalProfile: LearnerProfile = {
      learner_id: "student-target-ranking-source",
      level: "intermediate",
      known_concepts: ["变量", "列表", "函数", "基本数据类型"],
      weak_concepts: ["循环综合应用", "项目组织"],
      goal: "完成成绩统计程序",
    }
    const { rag_result: ragResult } =
      await executeProfileRetrieval(retrievalProfile)
    const selectionProfile: LearnerProfile = {
      learner_id: "student-target-ranking-selection",
      level: "intermediate",
      known_concepts: [],
      weak_concepts: ["for 循环"],
      goal: "目标待确认",
    }

    const result = await generateRoleCForRoleDWithRuntime({
      profile: selectionProfile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-TARGET-RANKING-UNIQUE",
    }, {
      runner: new RoleCTestRunner(),
    })

    expect(result.workflow).toContainEqual(expect.objectContaining({
      agent: "code-lab",
      status: "completed",
    }))
    expect(result.workflow).toContainEqual(expect.objectContaining({
      agent: "tiered-evaluator",
      status: "completed",
    }))
    expect(result.workflow.some((event) =>
      (event.agent === "code-lab" || event.agent === "tiered-evaluator")
        && event.status === "blocked")).toBe(false)
  })

  test("deduplicates repeated B teaching guidance in a blocked D result", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const profile: LearnerProfile = {
      learner_id: "student-missing-function-prerequisite",
      level: "intermediate",
      known_concepts: ["变量", "数据类型", "条件判断"],
      weak_concepts: ["循环", "列表"],
      goal: "完成一个成绩统计小程序，能遍历成绩并计算平均分",
    }
    const { rag_result: ragResult } =
      await executeProfileRetrieval(profile)

    const result = await generateRoleCForRoleDWithRuntime({
      profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DEDUPE-TEACHING-GUIDANCE",
    }, {
      runner: new RoleCTestRunner(),
    })

    expect(result.status).toBe("blocked")
    const revisionHints = result.audit?.teachingAudit.revisionHints ?? []
    expect(revisionHints.length).toBeGreaterThan(0)
    expect(new Set(revisionHints).size).toBe(revisionHints.length)
  })

  test("defers targets beyond the learner teaching range before review", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const profile: LearnerProfile = {
      learner_id: "student-basic-deferred-project",
      level: "basic",
      known_concepts: ["变量", "基本数据类型", "for 循环", "列表", "函数"],
      weak_concepts: [],
      goal: "使用列表和循环完成成绩统计",
    }
    const { rag_result: ragResult } =
      await executeProfileRetrieval(profile)

    const result = await generateRoleCForRoleDWithRuntime({
      profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DEFER-INTEGRATED-TARGET",
    }, {
      runner: new RoleCTestRunner(),
    })

    expect(result.status).toBe("blocked")
    expect("reason" in result ? result.reason : "")
      .toContain("当前画像可学习范围")
    expect(result.workflow).toEqual([])
    expect(result.artifacts).toEqual([])
  })

  test("keeps an integrated project upcoming after a basic learner answers all diagnosis items correctly", async () => {
    const runner = new RoleCTestRunner()
    const requestRoleC = async (
      input: Parameters<typeof generateRoleCForRoleDWithRuntime>[0],
    ) => generateRoleCForRoleDWithRuntime(input, { runner })
    const plan = await createLearningPlan({
      learnerId: "student-basic-five-of-five",
      educationContext: "大二非计算机专业",
      timeBudget: "每周 4 小时",
      selfRating: "basic",
      knownConcepts: ["变量", "列表"],
      weakConcepts: ["循环", "函数"],
      goal: "使用列表和循环完成成绩统计",
    }, requestRoleC)
    const answers = Object.fromEntries(
      plan.diagnosis.items.map((item) => [item.id, item.answer]),
    )

    const updated = await evaluatePlanDiagnosis(
      plan,
      answers,
      requestRoleC,
    )

    expect(updated.diagnosis.items).toHaveLength(5)
    expect(updated.session.profile.level).toBe("basic")
    expect(updated.session.path.find((node) => node.id === "K018"))
      .toMatchObject({
        status: "upcoming",
        reason: expect.stringContaining("超出当前画像一档"),
      })
    expect(updated.session.path.some((node) =>
      node.status === "current" && node.id === "K018")).toBe(false)
    expect(updated.session.artifacts).toEqual([])
    expect(updated.session.workflow).toContainEqual(
      expect.objectContaining({
        status: "blocked",
        summary: expect.stringContaining("当前画像可学习范围"),
      }),
    )
  })

  test("publishes anchors, freezes the route, and then accepts the complete submission", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const profile: LearnerProfile = {
      learner_id: "student-project-integration-001",
      level: "intermediate",
      known_concepts: ["变量", "列表", "函数", "基本数据类型"],
      weak_concepts: ["循环综合应用", "项目组织"],
      goal: "完成成绩统计程序",
    }
    const { rag_result: ragResult } =
      await executeProfileRetrieval(profile)
    expect(ragResult.results.map((item) => item.source_id)).toEqual([
      "K018",
      "K009",
      "K003",
      "K007",
      "K013",
    ])

    const receiver = new RoleDRoleCDeliveryReceiver(
      "role-d-integration-test",
    )
    const progressDeliveries: RoleCLearningProgressDelivery[] = []
    const progressPort: RoleBLearningProgressPort = {
      async publishLearningProgress(delivery) {
        progressDeliveries.push(structuredClone(delivery))
        return {
          schema_version: "1.0",
          delivery_kind: "learning_progress",
          delivery_id: delivery.delivery_id,
          status: "accepted",
        }
      },
    }
    const result = await generateRoleCForRoleDWithRuntime({
      profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-ANCHOR-INTEGRATION",
    }, {
      runner: new RoleCTestRunner(),
      roleDPort: receiver,
      learningProgressPort: progressPort,
    })

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.learningSession).toMatchObject({
      phase: "anchor_pending",
      requiredItemIds: [
        "ITEM-O1-T1-MCQ",
        "ITEM-O2-T1-TF",
        "ITEM-O1-T2-TRACE",
      ],
    })
    expect(result.artifacts.find((artifact) =>
      artifact.kind === "assessment")?.citations.map((citation) =>
      citation.source_id)).toEqual(["K007", "K009", "K018"])
    expect(result.deliveryToD.reviewedRelease.status).toBe("accepted")
    expect(result.deliveryToD.learningSession.status).toBe("accepted")

    const firstSnapshot = receiver.snapshot()
    expect(firstSnapshot.reviewed_releases).toHaveLength(1)
    expect(firstSnapshot.learning_sessions).toHaveLength(1)
    expect(firstSnapshot.learning_sessions[0]!.session.phase)
      .toBe("anchor_pending")
    expect(JSON.stringify(firstSnapshot)).not.toContain("secure://role-c/")
    expect(JSON.stringify(firstSnapshot)).not.toContain("answer_spec")

    const release = firstSnapshot.reviewed_releases[0]!
    expect((await receiver.publishReviewedRelease(
      structuredClone(release),
    )).status).toBe("duplicate")
    const answerLeak = {
      ...structuredClone(release),
      answer: "private",
    } as unknown as RoleCReviewedReleaseDelivery
    await expect(receiver.publishReviewedRelease(answerLeak))
      .rejects.toThrow("ROLE_D_C_DELIVERY_SCHEMA_INVALID")
    const secureLeak = structuredClone(release)
    secureLeak.artifacts[0].payload!.title =
      "secure://role-c/private"
    await expect(receiver.publishReviewedRelease(secureLeak))
      .rejects.toThrow("ROLE_D_C_DELIVERY_SECRET_REJECTED")
    const mutatedReplay = structuredClone(release)
    mutatedReplay.artifacts[0].payload!.title += "（被篡改）"
    await expect(receiver.publishReviewedRelease(mutatedReplay))
      .rejects.toThrow("ROLE_D_C_DELIVERY_IDENTITY_MISMATCH")
    const recoveryAfterReady = recoveryStatusDelivery(release.run_id)
    await expect(receiver.publishReviewRecoveryStatus(recoveryAfterReady))
      .rejects.toThrow("ROLE_D_C_RUN_TERMINAL_CONFLICT")
    const recoveryFirstReceiver = new RoleDRoleCDeliveryReceiver(
      "role-d-terminal-recovery-first-test",
    )
    expect((await recoveryFirstReceiver.publishReviewRecoveryStatus(
      recoveryAfterReady,
    )).status).toBe("accepted")
    await expect(recoveryFirstReceiver.publishReviewedRelease(release))
      .rejects.toThrow("ROLE_D_C_RUN_TERMINAL_CONFLICT")
    expect(receiver.snapshot().reviewed_releases).toHaveLength(1)

    const identity = {
      sessionId: result.learningSession.sessionId,
      runId: result.runId,
      learnerId: profile.learner_id,
      formId: result.learningSession.formId,
      attemptNo: result.learningSession.attemptNo,
    }
    const premature = await submitRoleCAssessment({
      ...identity,
      submissionId: "SUB-D-PREMATURE",
      answers: fullScoreAnswers(),
    })
    expect(premature).toMatchObject({
      status: "blocked",
      code: "ANCHOR_ROUTING_REQUIRED",
    })

    const routeInput = {
      ...identity,
      routingRequestId: result.learningSession.routingRequestId,
      submissionId: "SUB-D-ANCHORS",
      answers: anchorAnswers(),
    }
    const routed = await routeRoleCAssessment(routeInput)
    expect(routed).toMatchObject({
      status: "routed",
      action: "advance",
      anchorScoreRatio: 1,
      learningSession: {
        phase: "route_locked",
      },
      deliveryToD: {
        status: "accepted",
      },
    })
    const replay = await routeRoleCAssessment({
      ...routeInput,
      answers: [...routeInput.answers].reverse(),
    })
    expect(replay).toMatchObject({
      status: "routed",
      deliveryToD: {
        status: "duplicate",
      },
    })
    expect(receiver.snapshot().learning_sessions).toHaveLength(2)
    expect(receiver.getLearningSession(identity.sessionId)?.session.phase)
      .toBe("route_locked")
    const sessionDeliveries = receiver.snapshot().learning_sessions
    const anchorDelivery = sessionDeliveries.find((delivery) =>
      delivery.session.phase === "anchor_pending")!
    const routeDelivery = sessionDeliveries.find((delivery) =>
      delivery.session.phase === "route_locked")!
    const outOfOrderReceiver = new RoleDRoleCDeliveryReceiver(
      "role-d-out-of-order-test",
    )
    await expect(outOfOrderReceiver.publishLearningSession(routeDelivery))
      .rejects.toThrow("ROLE_D_C_REVIEWED_RELEASE_REQUIRED")
    await expect(outOfOrderReceiver.publishLearningSession(anchorDelivery))
      .rejects.toThrow("ROLE_D_C_REVIEWED_RELEASE_REQUIRED")
    expect((await outOfOrderReceiver.publishReviewedRelease(release)).status)
      .toBe("accepted")
    await expect(outOfOrderReceiver.publishLearningSession(routeDelivery))
      .rejects.toThrow("ROLE_D_C_LEARNING_SESSION_OUT_OF_ORDER")
    const invalidAnchorItems = structuredClone(anchorDelivery)
    invalidAnchorItems.session.required_item_ids.pop()
    const {
      delivery_id: _invalidAnchorId,
      ...invalidAnchorBody
    } = invalidAnchorItems
    invalidAnchorItems.delivery_id = contentHash(invalidAnchorBody)
    await expect(outOfOrderReceiver.publishLearningSession(
      invalidAnchorItems,
    )).rejects.toThrow("ROLE_C_D_SESSION_ITEMS_MISMATCH")
    const nonCanonicalAnchor = structuredClone(anchorDelivery)
    nonCanonicalAnchor.session.required_item_ids.reverse()
    const {
      delivery_id: _nonCanonicalAnchorId,
      ...nonCanonicalAnchorBody
    } = nonCanonicalAnchor
    nonCanonicalAnchor.delivery_id = contentHash(
      nonCanonicalAnchorBody,
    )
    await expect(outOfOrderReceiver.publishLearningSession(
      nonCanonicalAnchor,
    )).rejects.toThrow(
      "ROLE_D_C_LEARNING_SESSION_NON_CANONICAL",
    )
    expect((await outOfOrderReceiver.publishLearningSession(
      anchorDelivery,
    )).status).toBe("accepted")
    const invalidRoute = structuredClone(routeDelivery)
    if (invalidRoute.session.phase === "route_locked") {
      invalidRoute.session.action = invalidRoute.session.action === "advance"
        ? "reinforce"
        : "advance"
    }
    const {
      delivery_id: _invalidRouteId,
      ...invalidRouteBody
    } = invalidRoute
    invalidRoute.delivery_id = contentHash(invalidRouteBody)
    await expect(outOfOrderReceiver.publishLearningSession(invalidRoute))
      .rejects.toThrow("ROLE_C_D_SESSION_ROUTE_MISMATCH")
    expect((await outOfOrderReceiver.publishLearningSession(
      routeDelivery,
    )).status).toBe("accepted")
    expect((await outOfOrderReceiver.publishLearningSession(
      structuredClone(routeDelivery),
    )).status).toBe("duplicate")
    const mutatedSessionReplay = structuredClone(routeDelivery)
    mutatedSessionReplay.session.attempt_no += 1
    await expect(outOfOrderReceiver.publishLearningSession(
      mutatedSessionReplay,
    )).rejects.toThrow("ROLE_D_C_DELIVERY_IDENTITY_MISMATCH")
    await expect(recoveryFirstReceiver.publishLearningSession(
      anchorDelivery,
    )).rejects.toThrow("ROLE_D_C_LEARNING_SESSION_AFTER_RECOVERY")
    const mismatchedForm = structuredClone(anchorDelivery)
    mismatchedForm.session.form_id = "FORM-MISMATCH"
    const {
      delivery_id: _mismatchedDeliveryId,
      ...mismatchedFormBody
    } = mismatchedForm
    mismatchedForm.delivery_id = contentHash(mismatchedFormBody)
    const formReceiver = new RoleDRoleCDeliveryReceiver(
      "role-d-session-form-test",
    )
    expect((await formReceiver.publishReviewedRelease(release)).status)
      .toBe("accepted")
    await expect(formReceiver.publishLearningSession(mismatchedForm))
      .rejects.toThrow("ROLE_D_C_LEARNING_SESSION_FORM_CONFLICT")

    const completed = await submitRoleCAssessment({
      ...identity,
      submissionId: "SUB-D-COMPLETE",
      answers: fullScoreAnswers(),
    })
    expect(completed.status).toBe("completed")
    expect(progressDeliveries).toHaveLength(1)
    expect(progressDeliveries[0]!.learner_id_hash)
      .toBe(profile.learner_id)
  })

  test("receives terminal recovery status independently and rejects private fields", async () => {
    const receiver = new RoleDRoleCDeliveryReceiver(
      "role-d-recovery-test",
    )
    const delivery = recoveryStatusDelivery()
    expect((await receiver.publishReviewRecoveryStatus(delivery)).status)
      .toBe("accepted")
    expect((await receiver.publishReviewRecoveryStatus(
      structuredClone(delivery),
    )).status).toBe("duplicate")
    expect(receiver.getReviewRecoveryStatus(delivery.result.run_id))
      .toEqual(delivery)

    const answerLeak = {
      ...structuredClone(delivery),
      answer: "private",
    } as unknown as RoleCReviewRecoveryStatusDelivery
    await expect(receiver.publishReviewRecoveryStatus(answerLeak))
      .rejects.toThrow("ROLE_D_C_DELIVERY_SCHEMA_INVALID")
    const secureLeak = structuredClone(delivery)
    secureLeak.result.recovery.message = "secure://role-c/private"
    await expect(receiver.publishReviewRecoveryStatus(secureLeak))
      .rejects.toThrow("ROLE_D_C_DELIVERY_SECRET_REJECTED")
    const mutatedReplay = structuredClone(delivery)
    mutatedReplay.result.recovery.message = "路径恢复被篡改"
    await expect(receiver.publishReviewRecoveryStatus(mutatedReplay))
      .rejects.toThrow("ROLE_D_C_DELIVERY_IDENTITY_MISMATCH")
    expect(receiver.snapshot().review_recovery_statuses).toHaveLength(1)
  })
})

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

function fullScoreAnswers() {
  return [
    ...anchorAnswers(),
    {
      item_id: "ITEM-O2-T2-SHORT",
      text_response:
        "列表保存一组成绩并保持顺序，可以逐项处理每个成绩",
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

function recoveryStatusDelivery(
  runId = "RUN-D-RECOVERY-BLOCKED",
): RoleCReviewRecoveryStatusDelivery {
  const result: RoleCReviewRecoveryStatusDelivery["result"] = {
    schema_version: "1.0",
    result_kind: "review_recovery",
    run_id: runId,
    spec_id: "SPEC-D-RECOVERY-BLOCKED",
    pipeline_input_hash: `sha256:${"b".repeat(64)}`,
    generation_spec_hash: `sha256:${"c".repeat(64)}`,
    pipeline_status: "blocked",
    pipeline_state: "BLOCKED",
    review_policy_version: "role-d-recovery-test-v1",
    recovery: {
      code: "BLOCKED",
      failed_dimensions: ["prerequisite_alignment"],
      missing_prerequisite_source_ids: ["K007"],
      unknown_prerequisite_refs: [],
      required_action: "replan_path",
      fix_scope: "new_spec",
      can_recover: false,
      recovery_attempts: 1,
      message: "路径恢复达到本轮上限",
    },
    recovery_history: [{
      attempt_no: 1,
      action: "new_spec",
      input_spec_id: "SPEC-D-RECOVERY-INPUT",
      input_run_id: "RUN-D-RECOVERY-INPUT",
    }],
  }
  const body = {
    schema_version: "1.0" as const,
    delivery_kind: "review_recovery_status" as const,
    result,
  }
  return {
    ...body,
    delivery_id: contentHash(body),
  }
}
