import { describe, expect, test } from "vitest"
import type { RoleDSession } from "./types"
import {
  applyRoleCRoutingOutcome,
  applyRoleCSubmissionOutcome,
  buildRoleCSubmissionAnswers,
  buildRoleCSubmissionId,
  type RoleCFeedbackPayload,
} from "./role-c-submission"

const session: RoleDSession = {
  version: 1,
  eventMode: "live",
  sessionId: "session-d-1",
  updatedAt: "2026-07-29T00:00:00.000Z",
  profile: { learnerId: "learner-1", level: "integrated", knownConcepts: [], weakConcepts: [], goal: "完成成绩统计" },
  conflicts: [],
  retrieval: { query: "成绩统计", topK: 0, items: [] },
  artifacts: [{
    id: "assessment-1",
    kind: "assessment",
    title: "正式测评",
    status: "real",
    content: "",
    options: [],
    citations: [],
    evidenceStatus: "gap",
    items: [
      { id: "mcq-1", tier: 1, modality: "mcq", prompt: "选择", options: ["A", "B"], optionIds: ["opt-a", "opt-b"], citations: [] },
      { id: "trace-1", tier: 2, modality: "trace", prompt: "追踪", options: [], citations: [] },
      { id: "code-1", tier: 3, modality: "code", prompt: "代码", options: [], starterCode: "def solve():\n    pass", citations: [] },
    ],
  }],
  evidenceGaps: [],
  workflow: [],
  path: [
    { id: "K007", title: "for 循环", difficulty: "beginner", status: "current", reason: "当前节点" },
    { id: "K009", title: "列表", difficulty: "basic", status: "upcoming", reason: "目标节点" },
    { id: "K018", title: "成绩统计", difficulty: "integrated", status: "upcoming", reason: "目标节点" },
    { id: "K019", title: "进阶项目", difficulty: "integrated", status: "upcoming", reason: "下一节点" },
  ],
  decision: { next: "remediate", reason: "等待评分" },
  assessmentGraded: false,
  roleC: {
    runId: "RUN-1",
    learningSessionId: "C-SESSION-1",
    formId: "FORM-1",
    attemptNo: 1,
    profileVersion: "RUN-1-profile-v1",
    pathNodeId: "RUN-1-PATH-K007-K009-K018",
    targetSourceIds: ["K007", "K009", "K018"],
  },
  planSource: "real-ab",
  planInput: { learnerId: "learner-1", educationContext: "", timeBudget: "", knownConcepts: [], weakConcepts: [] },
  diagnosis: { sourceId: "UNKNOWN", factId: "UNKNOWN", concept: "", difficulty: "beginner", question: "", options: [], answer: "" },
  view: {
    currentStage: "learning",
    maxUnlockedStage: "feedback",
    activeArtifactKind: "assessment",
    selectedSourceId: "",
    remediationStarted: false,
    goalDraft: "完成成绩统计",
    selfRatingDraft: "integrated",
    diagnosisAnswer: "",
    diagnosisSubmitted: false,
    assessmentAnswers: { "mcq-1": "opt-b", "trace-1": "变量最终为 8", "code-1": "def solve():\n    return 8" },
    assessmentSubmitted: false,
    assessmentStatus: "idle",
    detailDrawer: "none",
  },
}

describe("Role D formal C submission adapter", () => {
  test("maps every public response modality into C SubmissionAnswer without inventing grading fields", () => {
    expect(buildRoleCSubmissionAnswers(session)).toEqual([
      { item_id: "mcq-1", selected_option_id: "opt-b", hint_level_used: 0 },
      { item_id: "trace-1", text_response: "变量最终为 8", hint_level_used: 0 },
      { item_id: "code-1", code_response: "def solve():\n    return 8", hint_level_used: 0 },
    ])
  })

  test("persists the trusted route, removes off-route answers, and ignores late routing failures", () => {
    const pending = structuredClone(session)
    pending.roleC!.routing = {
      phase: "anchor_pending",
      routingRequestId: "ROUTING-1",
      requiredItemIds: ["mcq-1"],
    }
    expect(buildRoleCSubmissionAnswers(pending).map((answer) => answer.item_id))
      .toEqual(["mcq-1"])

    const locked = applyRoleCRoutingOutcome(pending, {
      status: "routed",
      routingRequestId: "ROUTING-1",
      anchorScoreRatio: 0.5,
      routeId: "ROUTE-1",
      action: "reinforce",
      requiredItemIds: ["mcq-1", "trace-1"],
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
        anchorScoreRatio: 0.5,
        requiredItemIds: ["mcq-1", "trace-1"],
      },
    })

    expect(locked.roleC?.routing).toMatchObject({
      phase: "route_locked",
      routeLockId: "LOCK-1",
      anchorItemIds: ["mcq-1"],
      requiredItemIds: ["mcq-1", "trace-1"],
    })
    expect(locked.view.assessmentAnswers).toEqual({
      "mcq-1": "opt-b",
      "trace-1": "变量最终为 8",
    })
    expect(buildRoleCSubmissionAnswers(locked).map((answer) => answer.item_id))
      .toEqual(["mcq-1", "trace-1"])

    const afterLateFailure = applyRoleCRoutingOutcome(locked, {
      status: "blocked",
      routingRequestId: "ROUTING-1",
      issues: ["迟到的网络错误"],
    })
    expect(afterLateFailure).toEqual(locked)
  })

  test("applies C completed feedback without inventing B's next path node in D", () => {
    const submissionId = buildRoleCSubmissionId(session)
    const updated = applyRoleCSubmissionOutcome(session, submissionId, {
      status: "completed",
      feedback: formalFeedback(submissionId),
    })

    expect(updated.assessmentGraded).toBe(true)
    expect(updated.decision.next).toBe("advance")
    expect(updated.feedback?.roundScore.accuracy).toBe(0.8)
    expect(updated.feedback?.itemResults).toEqual([expect.objectContaining({
      itemId: "mcq-1",
      modality: "mcq",
      status: "correct",
    })])
    expect(updated.path.map((node) => node.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "upcoming",
    ])
    expect(updated.view.assessmentStatus).toBe("completed")

    const afterLateFailure = applyRoleCSubmissionOutcome(
      updated,
      submissionId,
      {
        status: "blocked",
        submission_id: submissionId,
        code: "TEMPORARY_UNAVAILABLE",
        message: "迟到的网络失败",
      },
    )
    expect(afterLateFailure).toEqual(updated)
  })

  test("rejects completed feedback for another frozen C path node", () => {
    const submissionId = buildRoleCSubmissionId(session)
    const updated = applyRoleCSubmissionOutcome(session, submissionId, {
      status: "completed",
      feedback: {
        ...formalFeedback(submissionId),
        path_node_id: "RUN-1-PATH-K999",
      },
    })

    expect(updated.assessmentGraded).toBe(false)
    expect(updated.view.assessmentMessage).toContain("身份不匹配")
  })

  test("keeps blocked C outcomes ungraded and visible instead of fabricating a local score", () => {
    const submissionId = buildRoleCSubmissionId(session)
    const updated = applyRoleCSubmissionOutcome(session, submissionId, {
      status: "blocked",
      submission_id: submissionId,
      code: "SUBMISSION_BOUNDARY_BLOCKED",
      message: "提交未通过可信边界校验",
    })

    expect(updated.assessmentGraded).toBe(false)
    expect(updated.feedback).toBeUndefined()
    expect(updated.view.assessmentStatus).toBe("blocked")
    expect(updated.view.assessmentMessage).toContain("可信边界")
  })

  test("rejects completed feedback that belongs to another run, session, form, attempt, or submission", () => {
    const foreign = applyRoleCSubmissionOutcome(
      session,
      buildRoleCSubmissionId(session),
      {
        status: "completed",
        feedback: {
          schema_version: "1.0",
          feedback_id: "DFR-FOREIGN",
          submission_id: "SUB-FOREIGN",
          run_id: "RUN-FOREIGN",
          session_id: "SESSION-FOREIGN",
          learner_id_hash: "learner-foreign",
          profile_version: "RUN-FOREIGN-profile-v1",
          path_node_id: "RUN-FOREIGN-PATH-K018",
          form_id: "FORM-FOREIGN",
          attempt_no: 2,
          round_score: { raw_score: 10, max_score: 10, accuracy: 1, evidence_score: 1 },
          objective_results: [],
          mastery_snapshot: [],
          final_decision: {
            action: "advance",
            basis: "round_accuracy",
            confidence: 1,
            reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
            target_objective_ids: [],
            policy_ref: "role-c-round-accuracy-v1",
          },
          grade_result: formalGradeResult({
            artifactId: "GRADE-FOREIGN",
            submissionId: "SUB-FOREIGN",
            formId: "FORM-FOREIGN",
            rawScore: 10,
            maxScore: 10,
            evidenceScore: 1,
            summary: "伪造进阶",
          }),
        },
      },
    )

    expect(foreign.assessmentGraded).toBe(false)
    expect(foreign.feedback).toBeUndefined()
    expect(foreign.decision.next).toBe("remediate")
    expect(foreign.view.assessmentStatus).toBe("blocked")
    expect(foreign.view.assessmentMessage).toContain("身份不匹配")
  })

  test("rejects completed feedback whose learner identity belongs to another learner", () => {
    const submissionId = buildRoleCSubmissionId(session)
    const foreign = applyRoleCSubmissionOutcome(session, submissionId, {
      status: "completed",
      feedback: {
        schema_version: "1.0",
        feedback_id: "DFR-FOREIGN-LEARNER",
        submission_id: submissionId,
        run_id: "RUN-1",
        session_id: "C-SESSION-1",
        learner_id_hash: "learner-foreign",
        profile_version: "RUN-1-profile-v1",
        path_node_id: "RUN-1-PATH-K007-K009-K018",
        form_id: "FORM-1",
        attempt_no: 1,
        round_score: { raw_score: 10, max_score: 10, accuracy: 1, evidence_score: 1 },
        objective_results: [],
        mastery_snapshot: [],
        final_decision: {
          action: "advance",
          basis: "round_accuracy",
          confidence: 1,
          reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
          target_objective_ids: [],
          policy_ref: "role-c-round-accuracy-v1",
        },
        grade_result: formalGradeResult({
          artifactId: "GRADE-FOREIGN-LEARNER",
          submissionId,
          formId: "FORM-1",
          rawScore: 10,
          maxScore: 10,
          evidenceScore: 1,
          summary: "错误身份",
        }),
      },
    })

    expect(foreign.assessmentGraded).toBe(false)
    expect(foreign.view.assessmentStatus).toBe("blocked")
    expect(foreign.view.assessmentMessage).toContain("身份不匹配")
  })

  test("rejects a late blocked response from another submission", () => {
    const updated = applyRoleCSubmissionOutcome(
      session,
      buildRoleCSubmissionId(session),
      {
        status: "blocked",
        submission_id: "SUB-OLD",
        code: "TEMPORARY_UNAVAILABLE",
        message: "旧请求失败",
      },
    )

    expect(updated.view.assessmentStatus).toBe("blocked")
    expect(updated.view.assessmentMessage).toContain("身份不匹配")
  })
})

function formalFeedback(submissionId: string): RoleCFeedbackPayload {
  return {
    schema_version: "1.0",
    feedback_id: "DFR-1",
    submission_id: submissionId,
    run_id: "RUN-1",
    session_id: "C-SESSION-1",
    learner_id_hash: "learner-1",
    profile_version: "RUN-1-profile-v1",
    path_node_id: "RUN-1-PATH-K007-K009-K018",
    form_id: "FORM-1",
    attempt_no: 1,
    round_score: {
      raw_score: 8,
      max_score: 10,
      accuracy: 0.8,
      evidence_score: 0.72,
    },
    objective_results: [{
      objective_id: "O1",
      raw_score: 8,
      max_score: 10,
      accuracy: 0.8,
      evidence_score: 0.72,
      misconception_tags: [],
    }],
    mastery_snapshot: [{
      objective_id: "O1",
      mastery: 0.8,
      evidence_batches: 1,
      observed_modalities: ["mcq"],
      revision: 1,
    }],
    final_decision: {
      action: "advance",
      basis: "round_accuracy",
      confidence: 0.8,
      reason_codes: [
        "round_accuracy_at_or_above_advancement_threshold",
      ],
      target_objective_ids: [],
      policy_ref: "role-c-round-accuracy-v1",
    },
    grade_result: formalGradeResult({
      artifactId: "GRADE-1",
      submissionId,
      formId: "FORM-1",
      rawScore: 8,
      maxScore: 10,
      evidenceScore: 0.72,
      summary: "本轮达到进阶标准。",
    }),
  }
}

function formalGradeResult(input: {
  artifactId: string
  submissionId: string
  formId: string
  rawScore: number
  maxScore: number
  evidenceScore: number
  summary: string
}): RoleCFeedbackPayload["grade_result"] {
  return {
    schema_version: "1.0",
    run_id: input.artifactId.includes("FOREIGN") ? "RUN-FOREIGN" : "RUN-1",
    artifact_id: input.artifactId,
    artifact_type: "grade_result",
    agent: "tiered-evaluator",
    status: "ready",
    versions: {
      profile_version: input.artifactId.includes("FOREIGN")
        ? "RUN-FOREIGN-profile-v1"
        : "RUN-1-profile-v1",
      kb_version: "kb-v1",
      rag_version: "rag-v1",
      prompt_version: "prompt-v1",
      model_config_hash: "model-v1",
      schema_version: "1.0",
    },
    seed: 1,
    input_refs: [input.submissionId],
    citations: [],
    quality: {
      schema_ok: true,
      citation_coverage: 1,
      objective_coverage: 1,
      alignment_score: 1,
      answer_key_verified: true,
    },
    payload: {
      submission_id: input.submissionId,
      form_id: input.formId,
      score_frozen: true,
      raw_score: input.rawScore,
      max_score: input.maxScore,
      evidence_score: input.evidenceScore,
      item_results: [{
        item_id: "mcq-1",
        objective_id: "O1",
        raw_score: input.rawScore,
        max_score: input.maxScore,
        evidence_score: input.evidenceScore,
        grader_confidence: 1,
        hint_factor: 1,
        repeat_factor: 1,
        misconception_tags: [],
        feedback_code: "correct",
      }],
      recommendation: {
        action: "advance",
        confidence: input.rawScore / input.maxScore,
        reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
      },
      feedback: {
        generated_after_score_freeze: true,
        mode: "formative",
        summary: input.summary,
        item_feedback: [{
          item_id: "mcq-1",
          feedback_code: "correct",
          message: "已完成",
          next_step: "继续学习",
        }],
      },
    },
    trace_ref: `TRACE-${input.artifactId}`,
  }
}
