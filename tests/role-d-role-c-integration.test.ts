import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import { synthesizeProfile } from "../src/role-b-profile/profile-synthesizer"
import { generateRoleCForRoleD } from "../src/role-d-integration/role-c-service"

describe("Role D → official Role C Week 1 integration", () => {
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
    expect(result.workflow.some((event) => event.agent === "concept-tutor" && event.status === "completed")).toBe(true)
    expect(result.workflow.some((event) => event.agent === "code-lab" && event.status === "blocked")).toBe(true)
    expect("reason" in result ? result.reason : "").toContain("离线 code-lab 基准实现")
  })

  test("does not publish content when the newly merged C review gate rejects it", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const synthesis = synthesizeProfile({
      background: {
        evidence_type: "background",
        learner_id: "student-week1-001",
        education_context: "大二非计算机专业",
        prior_languages: ["Python"],
        prior_topics: ["变量", "列表"],
        goal_raw: "完成成绩统计程序",
        time_budget: "每周 4 小时",
        quotes: [],
      },
      selfAssessment: {
        evidence_type: "self_assessment",
        self_rating: "integrated",
        claimed_known: ["Python 是什么", "变量", "基本数据类型", "条件判断", "函数定义与调用", "列表"],
        claimed_weak: ["循环"],
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
      runId: "RUN-D-WEEK1-INTEGRATION",
    })

    expect(result.status).toBe("blocked")
    expect(result.artifacts).toEqual([])
    expect(result.audit?.arbitration.decision).toBe("reject")
    expect(result.workflow.some((event) => event.status === "blocked")).toBe(true)
    expect("reason" in result ? result.reason : "").toContain("不可发布")
  })
})
