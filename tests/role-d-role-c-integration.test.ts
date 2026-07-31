import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import { synthesizeProfile } from "../src/role-b-profile/profile-synthesizer"
import {
  generateRoleCForRoleD,
  generateRoleCForRoleDWithRuntime,
  resolveRoleCCodeRunner,
} from "../src/role-d-integration/role-c-service"

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

    const result = await generateRoleCForRoleDWithRuntime({
      profile: synthesis.profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DOCKER-UNAVAILABLE",
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
      objectiveDiagnosis: { evidence_type: "objective_diagnosis", items: [], quotes: [] },
      knowledgeBase,
    })
    const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)

    const result = await generateRoleCForRoleD({
      profile: synthesis.profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-DYNAMIC-K002-INTEGRATION",
    })

    expect("reason" in result ? result.reason : "").not.toContain("K007、K009、K018")
    const conceptEvents = result.workflow.filter((event) => event.agent === "concept-tutor")
    expect(conceptEvents.map((event) => event.stage)).toEqual(["定制讲义生成", "定制讲义准备"])
    expect(conceptEvents.map((event) => event.status)).toEqual(["running", "completed"])
    expect(result.workflow.some((event) => event.agent === "concept-tutor" && event.status === "completed")).toBe(true)
    expect(result.workflow.some((event) => event.agent === "code-lab" && event.status === "blocked")).toBe(true)
    expect("reason" in result ? result.reason : "").toContain("离线 code-lab 基准实现")
  })

  test("uses C's recoverable pipeline and exposes its terminal recovery status to D", async () => {
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

    const result = await generateRoleCForRoleD({
      profile: synthesis.profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-WEEK1-INTEGRATION",
    })

    expect(result.status).toBe("blocked")
    expect(result.artifacts).toEqual([])
    expect(result.recovery).toMatchObject({
      code: "UNSUPPORTED_TARGET",
      requiredAction: "replan_path",
      fixScope: "new_spec",
      canRecover: false,
    })
    expect(result.recovery?.attempts).toBeGreaterThan(0)
    expect(result.workflow.some((event) => event.stage === "审核恢复" && event.status === "blocked")).toBe(true)
    expect("reason" in result ? result.reason : "").toContain("离线 code-lab 基准实现")
  })
})
