import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { retrieveKnowledge } from "../src/rag/retriever"
import {
  continueRoleCAfterSubmission,
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessmentAnchors,
  runRoleCCodeLab,
  submitRoleCAssessment,
} from "../src/role-d-integration/role-c-service"
import {
  defineLearningPathNode,
  type ContentReviewPort,
} from "../src/role-c-content"

describe("Role D → Role C durable HTTP runtime boundary", () => {
  test("submits after runtime reconstruction and replays one frozen result idempotently", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "role-d-role-c-runtime-"))
    const dataDirectory = join(temporary, "role-c-runtime")
    try {
      const knowledgeBase = await loadKnowledgeBase()
      const profile = {
        learner_id: "student-runtime-restart",
        level: "integrated" as const,
        known_concepts: ["变量与赋值", "条件判断", "函数定义与调用"],
        weak_concepts: ["for 循环", "列表", "成绩统计综合实践"],
        goal: "理解循环与列表，并完成一个成绩统计程序",
      }
      const ragResult = await retrieveKnowledge({
        query: "for 循环 列表 成绩统计综合实践 变量 条件判断",
        learnerLevel: profile.level,
        topK: 8,
      })
      const pathNode = defineLearningPathNode({
        node_id: "B-PATH-RUNTIME-RESTART",
        target_source_ids: ["K007", "K009", "K018"],
        prerequisite_source_ids: ["K002", "K006"],
        goal: profile.goal,
        objectives: [
          { objective_id: "O1", source_id: "K007", required_fact_ids: ["F001"], observable_behavior: "trace", importance: "core" },
          { objective_id: "O2", source_id: "K009", required_fact_ids: ["F001"], observable_behavior: "apply", importance: "core" },
          { objective_id: "O3", source_id: "K018", required_fact_ids: ["F001"], observable_behavior: "create", importance: "core" },
        ],
        assessment_blueprint: {
          tier_1_count: 2,
          tier_2_count: 2,
          tier_3_count: 1,
          required_modalities: ["mcq", "trace", "code"],
        },
      })

      const generated = await generateRoleCForRoleDWithRuntime({
        profile,
        ragResult,
        kbVersion: knowledgeBase.version,
        runId: "RUN-DURABLE-RUNTIME-RESTART",
        pathNode,
      }, {
        providerMode: "deterministic",
        allowDeterministicFallback: true,
        dataDirectory,
        reviewPort: alwaysPassReviewPort(),
      })

      expect(generated.status).toBe("ready")
      if (generated.status !== "ready") throw new Error(generated.reason)

      const publishedLab = generated.artifacts.find((artifact) =>
        artifact.kind === "lab")
      expect(publishedLab?.content).toBe(publishedLab?.lab?.starter_code)
      expect(typeof publishedLab?.lab?.lab_id).toBe("string")
      expect(publishedLab?.lab?.execution_contract.language).toBe("python")
      expect(typeof publishedLab?.lab?.starter_code).toBe("string")
      expect(Array.isArray(publishedLab?.lab?.instructions)).toBe(true)
      expect(Array.isArray(publishedLab?.lab?.public_tests)).toBe(true)
      expect(Array.isArray(publishedLab?.lab?.hint_ladders)).toBe(true)
      expect(Array.isArray(publishedLab?.lab?.reflection_questions)).toBe(true)
      expect(JSON.stringify(publishedLab?.lab)).not.toContain("hidden_tests")
      expect(JSON.stringify(publishedLab?.lab)).not.toContain("reference_solution")
      const labId = publishedLab?.lab?.lab_id
      if (!publishedLab?.lab || typeof labId !== "string") {
        throw new Error(`generated lab contract is missing: ${JSON.stringify(labId)}`)
      }
      const starterRun = await runRoleCCodeLab({
        executionId: "LAB-EXEC-STARTER",
        sessionId: generated.learningSession.sessionId,
        runId: generated.runId,
        learnerId: profile.learner_id,
        labId,
        code: publishedLab.lab.starter_code,
      }, { dataDirectory })
      expect(starterRun).toMatchObject({
        status: "failed",
        executionId: "LAB-EXEC-STARTER",
        runId: generated.runId,
        labId,
        scoreRatio: 0,
        feedback: [{ code: "assertion_failed" }],
      })
      expect(JSON.stringify(starterRun)).not.toContain("HT-")

      const completedCode = [
        "def average_score(scores):",
        "    total = 0",
        "    count = 0",
        "    for score in scores:",
        "        total += score",
        "        count += 1",
        "    return total / count",
      ].join("\n")
      const completedRun = await runRoleCCodeLab({
        executionId: "LAB-EXEC-PASS",
        sessionId: generated.learningSession.sessionId,
        runId: generated.runId,
        learnerId: profile.learner_id,
        labId,
        code: completedCode,
      }, { dataDirectory })
      expect(completedRun).toMatchObject({
        status: "passed",
        executionId: "LAB-EXEC-PASS",
        passedChecks: expect.any(Number),
        totalChecks: expect.any(Number),
        scoreRatio: 1,
        feedback: [],
      })

      const foreignLearnerRun = await runRoleCCodeLab({
        executionId: "LAB-EXEC-FOREIGN",
        sessionId: generated.learningSession.sessionId,
        runId: generated.runId,
        learnerId: "another-learner",
        labId,
        code: completedCode,
      }, { dataDirectory })
      expect(foreignLearnerRun).toMatchObject({
        status: "blocked",
        code: "LEARNER_IDENTITY_MISMATCH",
      })

      const submission = {
        sessionId: generated.learningSession.sessionId,
        runId: generated.runId,
        learnerId: profile.learner_id,
        formId: generated.learningSession.formId,
        attemptNo: generated.learningSession.attemptNo,
        submissionId: "SUB-DURABLE-RUNTIME-1",
        answers: [
          { item_id: "ITEM-O1-T1-MCQ", selected_option_id: "opt_iterate", hint_level_used: 0 as const },
          { item_id: "ITEM-O2-T1-TF", selected_option_id: "opt_true", hint_level_used: 0 as const },
          { item_id: "ITEM-O1-T2-TRACE", text_response: "8", hint_level_used: 0 as const },
          {
            item_id: "ITEM-O2-T2-SHORT",
            text_response: "列表保存一组成绩并保持顺序，程序可以逐项处理列表元素。",
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
        ],
      }

      // Each call reconstructs file-backed stores and LearningCycleService from
      // the directory, matching a new Vite process with no in-memory session map.
      const first = await submitRoleCAssessment(submission, { dataDirectory })
      const replay = await submitRoleCAssessment(
        structuredClone(submission),
        { dataDirectory },
      )

      expect(first.status).toBe("completed")
      expect(replay).toEqual(first)
      if (first.status === "completed") {
        expect(first.feedback.submission_id).toBe(submission.submissionId)
        expect(first.feedback.session_id).toBe(submission.sessionId)
        expect(first.feedback.run_id).toBe(submission.runId)
        expect(first.feedback.final_decision.action).toBe("advance")
      }

      const nextPathNode = defineLearningPathNode({
        node_id: "B-PATH-RUNTIME-NEXT-PASSING-COUNT",
        target_source_ids: ["K007", "K009", "K006"],
        prerequisite_source_ids: ["K002", "K003", "K005"],
        goal: "使用循环、列表和条件判断统计及格人数",
        objectives: [
          { objective_id: "NEXT-O1", source_id: "K007", required_fact_ids: [], observable_behavior: "trace", importance: "core" },
          { objective_id: "NEXT-O2", source_id: "K009", required_fact_ids: [], observable_behavior: "apply", importance: "core" },
          { objective_id: "NEXT-O3", source_id: "K006", required_fact_ids: [], observable_behavior: "create", importance: "core" },
        ],
        assessment_blueprint: {
          tier_1_count: 2,
          tier_2_count: 2,
          tier_3_count: 1,
          required_modalities: ["mcq", "trace", "code"],
        },
      })
      const continuationRuntime = {
        providerMode: "deterministic" as const,
        allowDeterministicFallback: true,
        dataDirectory,
        reviewPort: alwaysPassReviewPort(),
      }
      const awaitingPath = await continueRoleCAfterSubmission({
        sessionId: submission.sessionId,
        submissionId: submission.submissionId,
        learnerId: profile.learner_id,
      }, continuationRuntime)
      expect(awaitingPath).toEqual({
        status: "awaiting_input",
        action: "advance",
        requestId: expect.any(String),
        requiredInputs: ["nextPathNode"],
      })

      const continued = await continueRoleCAfterSubmission({
        sessionId: submission.sessionId,
        submissionId: submission.submissionId,
        learnerId: profile.learner_id,
        nextPathNode,
      }, continuationRuntime)
      const continuedReplay = await continueRoleCAfterSubmission({
        sessionId: submission.sessionId,
        submissionId: submission.submissionId,
        learnerId: profile.learner_id,
        nextPathNode: structuredClone(nextPathNode),
      }, continuationRuntime)

      expect(continued.status).toBe("published")
      expect(continuedReplay).toEqual(continued)
      if (continued.status !== "published") {
        throw new Error(JSON.stringify(continued))
      }
      expect(continued.reviewedRelease.artifacts).toHaveLength(3)
      expect(continued.artifacts).toHaveLength(3)
      expect(typeof continued.artifacts.find(
        (artifact) => artifact.kind === "lab",
      )?.lab?.starter_code).toBe("string")
      expect(continued.learningSession.session.phase).toBe("anchor_pending")
      expect(continued.finalContext.pathNode.target_source_ids)
        .toEqual(["K007", "K009", "K006"])
      expect(continued.finalContext.pathNode.objectives.every(
        (objective) => objective.required_fact_ids.length > 0,
      )).toBe(true)
      expect(JSON.stringify(continued)).not.toContain("quiz_seeds")

      const anchorSession = continued.learningSession.session
      if (anchorSession.phase !== "anchor_pending") {
        throw new Error("expected anchor-pending continuation")
      }
      const routed = await routeRoleCAssessmentAnchors({
        routingRequestId: anchorSession.routing_request_id,
        sessionId: anchorSession.session_id,
        runId: anchorSession.run_id,
        learnerId: profile.learner_id,
        formId: anchorSession.form_id,
        attemptNo: anchorSession.attempt_no,
        submissionId: "SUB-DURABLE-RUNTIME-ANCHORS-1",
        answers: [
          { item_id: "ITEM-O1-T1-MCQ", selected_option_id: "opt_iterate", hint_level_used: 0 },
          { item_id: "ITEM-O2-T1-TF", selected_option_id: "opt_true", hint_level_used: 0 },
          { item_id: "ITEM-O1-T2-TRACE", text_response: "8", hint_level_used: 0 },
        ],
      }, { dataDirectory })
      expect(routed.status).toBe("routed")
      if (routed.status === "routed") {
        expect(routed.learning_session.phase).toBe("route_locked")
        expect(routed.learning_session.run_id).toBe(anchorSession.run_id)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})

function alwaysPassReviewPort(): ContentReviewPort {
  return {
    policy_version: "runtime-persistence-test-review-v1",
    async review(request) {
      return {
        run_id: request.run_id,
        pipeline_input_hash: request.pipeline_input_hash,
        generation_spec_hash: request.generation_spec_hash,
        policy_version: this.policy_version,
        revision_round: request.revision_round,
        max_revision_rounds: request.max_revision_rounds,
        evidence_hash: request.evidence_hash,
        decision: "pass",
        artifact_results: request.artifacts.map((artifact) => ({
          artifact_kind: artifact.kind,
          artifact_id: artifact.artifact.artifact_id,
          artifact_hash: artifact.artifact_hash,
          fact_status: "pass",
          teaching_status: "pass",
          decision: "pass",
          can_revise: false,
          findings: [],
          revision_instructions: [],
        })),
        revision_instructions: [],
      }
    },
  }
}
