import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import { synthesizeProfile } from "../src/role-b-profile/profile-synthesizer"
import {
  generateRoleCForRoleD,
  generateRoleCForRoleDWithRuntime,
  resolveRoleCCodeRunner,
} from "../src/role-d-integration/role-c-service"
import { buildInitialRoleCContext } from "../src/role-d-integration/initial-learning-path"
import {
  defineLearningPathNode,
  type ContentReviewPort,
} from "../src/role-c-content"

describe("Role D → official Role C Week 1 integration", () => {
  test("requires C's Docker runner in model mode and keeps the conformance runner deterministic-only", async () => {
    const injectedRunner = {
      runner_image_digest: `sha256:${"a".repeat(64)}`,
      async execute() {
        throw new Error("not used")
      },
    }
    let factoryCalls = 0

    expect(await resolveRoleCCodeRunner({ providerMode: "deterministic", runner: injectedRunner }))
      .toBe(injectedRunner)
    expect(factoryCalls).toBe(0)

    const dockerRunner = {
      runner_image_digest: `sha256:${"b".repeat(64)}`,
      async execute() {
        throw new Error("not used")
      },
    }
    expect(await resolveRoleCCodeRunner({
      providerMode: "model",
      env: { ROLE_C_DOCKER_IMAGE: "knowbalance-role-c-python-runner:1.0.0" },
      dockerRunnerFactory: async () => {
        factoryCalls += 1
        return dockerRunner
      },
    })).toBe(dockerRunner)
    expect(factoryCalls).toBe(1)

    await expect(resolveRoleCCodeRunner({
      providerMode: "model",
      dockerRunnerFactory: async () => {
        throw new Error("Docker runner 镜像不可用")
      },
    })).rejects.toThrow("Docker runner 镜像不可用")
  })

  test("returns an explicit D blocked result when model mode cannot start C's Docker runner", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const synthesis = synthesizeProfile({
      background: {
        evidence_type: "background",
        learner_id: "student-docker-unavailable",
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
      objectiveDiagnosis: { evidence_type: "objective_diagnosis", items: [], quotes: [] },
      knowledgeBase,
    })
    const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)
    const initial = await buildInitialRoleCContext({
      profile: synthesis.profile,
      ragResult,
      knowledgeBase,
    })
    if (!initial.ok) throw new Error(initial.reason)

    const result = await generateRoleCForRoleDWithRuntime({
      profile: synthesis.profile,
      ragResult: initial.ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DOCKER-UNAVAILABLE",
      pathNode: initial.pathNode,
    }, {
      providerMode: "model",
      env: {
        ROLE_C_MODEL_ENDPOINT: "https://example.invalid/chat/completions",
        ROLE_C_MODEL_ID: "test-model",
      },
      dockerRunnerFactory: async () => {
        throw new Error("Docker runner 镜像不可用：请先运行 bun run docker:role-c:build")
      },
    })

    expect(result.status).toBe("blocked")
    expect("reason" in result ? result.reason : "").toContain("Docker runner 镜像不可用")
    expect(result.workflow).toContainEqual(expect.objectContaining({
      agent: "docker-python-runner",
      stage: "可信代码执行",
      status: "blocked",
    }))
  })

  test("fails closed instead of silently selecting the fixed offline Provider", async () => {
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
      objectiveDiagnosis: { evidence_type: "objective_diagnosis", items: [], quotes: [] },
      knowledgeBase,
    })
    const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)
    const initial = await buildInitialRoleCContext({
      profile: synthesis.profile,
      ragResult,
      knowledgeBase,
    })
    if (!initial.ok) throw new Error(initial.reason)

    const result = await generateRoleCForRoleD({
      profile: synthesis.profile,
      ragResult: initial.ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DYNAMIC-K002-INTEGRATION",
      pathNode: initial.pathNode,
    })

    expect(result.status).toBe("blocked")
    expect(result.artifacts).toEqual([])
    expect("reason" in result ? result.reason : "").toContain("通用内容生成模型尚未配置")
    expect(result.workflow).toContainEqual(expect.objectContaining({
      agent: "role-c-model-provider",
      status: "blocked",
    }))
  })

  test("exposes C's terminal unsupported status to D without inventing a recovery attempt", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const synthesis = synthesizeProfile({
      background: {
        evidence_type: "background",
        learner_id: "student-week1-001",
        education_context: "大二非计算机专业",
        prior_languages: ["Python"],
        prior_topics: ["变量", "列表"],
        goal_raw: "完成成绩统计程序，使用循环遍历列表，并用函数计算平均成绩",
        time_budget: "每周 4 小时",
        quotes: [],
      },
      selfAssessment: {
        evidence_type: "self_assessment",
        self_rating: "integrated",
        claimed_known: ["Python 是什么", "变量", "基本数据类型", "条件判断", "函数定义与调用", "列表"],
        claimed_weak: ["循环", "列表", "函数"],
        quotes: [],
      },
      objectiveDiagnosis: {
        evidence_type: "objective_diagnosis",
        items: [
          { source_id: "K007", fact_id: "F001", question: "for", learner_answer: "遍历序列", verdict: "correct", concept: "for 循环", difficulty: "beginner" },
          { source_id: "K009", fact_id: "F001", question: "list", learner_answer: "append", verdict: "correct", concept: "列表", difficulty: "basic" },
          { source_id: "K013", fact_id: "F001", question: "function", learner_answer: "def", verdict: "correct", concept: "函数定义与调用", difficulty: "basic" },
          { source_id: "K002", fact_id: "F001", question: "variable", learner_answer: "错误答案", verdict: "incorrect", concept: "变量与赋值", difficulty: "beginner" },
          { source_id: "K003", fact_id: "F001", question: "type", learner_answer: "str", verdict: "correct", concept: "基本数据类型", difficulty: "beginner" },
        ],
        quotes: [],
      },
      knowledgeBase,
    })
    const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)
    const initial = await buildInitialRoleCContext({
      profile: synthesis.profile,
      ragResult,
      knowledgeBase,
    })
    if (!initial.ok) throw new Error(initial.reason)

    const result = await generateRoleCForRoleDWithRuntime({
      profile: synthesis.profile,
      ragResult: initial.ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-WEEK1-INTEGRATION",
      pathNode: initial.pathNode,
    }, {
      providerMode: "deterministic",
      allowDeterministicFallback: true,
    })

    expect(result.status).toBe("blocked")
    expect(result.artifacts).toEqual([])
    expect(result.recovery).toMatchObject({
      code: "UNSUPPORTED_TARGET",
      requiredAction: "replan_path",
      fixScope: "new_spec",
      canRecover: false,
    })
    expect(result.recovery?.attempts).toBe(0)
    expect(result.workflow.some((event) => event.stage === "审核恢复" && event.status === "blocked")).toBe(true)
    expect("reason" in result ? result.reason : "").toContain("离线 code-lab 基准实现")
  })

  test("consumes a formal B path verbatim and returns an answer-free final context", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const profile = {
      learner_id: "student-formal-path",
      level: "integrated" as const,
      known_concepts: ["Python 是什么", "变量与赋值", "条件判断", "函数定义与调用"],
      weak_concepts: ["for 循环", "列表", "成绩统计综合实践"],
      goal: "理解循环与列表，并完成一个成绩统计程序",
    }
    const { retrieveKnowledge } = await import("../src/rag/retriever")
    const ragResult = await retrieveKnowledge({
      query: "for 循环 列表 成绩统计综合实践 变量 条件判断",
      learnerLevel: profile.level,
      topK: 8,
    })
    const answerMarker = "PRIVATE-QUIZ-ANSWER-MUST-NOT-CROSS-C"
    ragResult.results[0]!.quizItems[0]!.answer = answerMarker
    const pathNode = defineLearningPathNode({
      node_id: "B-PATH-CUSTOM-ORDER",
      target_source_ids: ["K007", "K009", "K018"],
      prerequisite_source_ids: ["K002", "K006"],
      goal: profile.goal,
      objectives: [
        { objective_id: "B-OBJ-LOOP", source_id: "K007", required_fact_ids: ["F001"], observable_behavior: "trace", importance: "core" },
        { objective_id: "B-OBJ-LIST", source_id: "K009", required_fact_ids: ["F001"], observable_behavior: "apply", importance: "core" },
        { objective_id: "B-OBJ-PROJECT", source_id: "K018", required_fact_ids: ["F001"], observable_behavior: "create", importance: "core" },
      ],
      assessment_blueprint: {
        tier_1_count: 2,
        tier_2_count: 2,
        tier_3_count: 1,
        required_modalities: ["mcq", "trace", "code"],
      },
    })

    const result = await generateRoleCForRoleDWithRuntime({
      profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-FORMAL-B-PATH",
      pathNode,
    }, {
      providerMode: "deterministic",
      allowDeterministicFallback: true,
      reviewPort: alwaysPassReviewPort(),
    })

    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error(result.reason)
    expect(result.finalContext.pathNode).toEqual(pathNode)
    expect(result.finalContext.profileVersion).toBe(result.finalContext.profileSnapshot.profile_version)
    expect(result.finalContext.profileSnapshot).toMatchObject({
      learner_id: profile.learner_id,
      level: profile.level,
      known_concepts: profile.known_concepts,
      weak_concepts: profile.weak_concepts,
      goal: profile.goal,
    })
    expect(result.finalContext.pathNode.objectives.map((item) => item.objective_id)).toEqual([
      "B-OBJ-LOOP",
      "B-OBJ-LIST",
      "B-OBJ-PROJECT",
    ])
    const publicContext = JSON.stringify(result.finalContext)
    expect(publicContext).not.toContain(answerMarker)
    expect(publicContext).not.toContain("quiz_seeds")
    expect(publicContext).not.toContain("learner_answer")
    const factKeys = new Set(result.finalContext.evidencePack.results.flatMap((item) =>
      item.facts.map((fact) => `${fact.source_id}:${fact.fact_id}`)))
    expect(result.artifacts.flatMap((artifact) => artifact.citations).every((citation) =>
      factKeys.has(`${citation.source_id}:${citation.fact_id}`))).toBe(true)
  })
})

function alwaysPassReviewPort(): ContentReviewPort {
  return {
    policy_version: "test-always-pass-v1",
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
