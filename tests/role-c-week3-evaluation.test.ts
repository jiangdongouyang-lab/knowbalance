import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import {
  buildWeek3EvaluationCases,
  GOLDEN_LEARNER_PROFILES,
} from "../src/evaluation/week3-evaluation"
import {
  buildRoleCWeek3Report,
  prepareRoleCWeek3Input,
  renderRoleCWeek3Report,
  runRoleCWeek3Case,
} from "../src/role-c-content/evaluation"

describe("Role C Week 3 actual pipeline evaluation", () => {
  test("adapts A's cases without changing requested targets", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const evaluationCase = buildWeek3EvaluationCases().find((item) =>
      item.target_source_ids.length === 3)!
    const prepared = await prepareRoleCWeek3Input(evaluationCase, { knowledgeBase })

    expect(prepared.profile).toEqual(
      GOLDEN_LEARNER_PROFILES[evaluationCase.learner_profile_id],
    )
    expect(prepared.profile).not.toBe(
      GOLDEN_LEARNER_PROFILES[evaluationCase.learner_profile_id],
    )
    expect(prepared.pathNode.target_source_ids).toEqual(evaluationCase.target_source_ids)
    expect(prepared.pathNode.objectives.map((item) => item.source_id))
      .toEqual(evaluationCase.target_source_ids)
    expect(prepared.pathNode.objectives.every((item) => item.required_fact_ids.length > 0)).toBe(true)
    const evidenceIds = new Set(prepared.ragResult.results.map((item) => item.source_id))
    expect([
      ...prepared.pathNode.target_source_ids,
      ...prepared.pathNode.prerequisite_source_ids,
    ].every((sourceId) => evidenceIds.has(sourceId))).toBe(true)
  })

  test("runs a supported formal path through all three C agents and the review boundary", async () => {
    const evaluationCase = buildWeek3EvaluationCases().find((item) =>
      item.target_source_ids.join(",") === "K007,K009,K018")!
    const result = await runRoleCWeek3Case(evaluationCase, {
      executionMode: "deterministic",
      profile: offlineReferenceProfile(),
      runtime: {
        providerMode: "deterministic",
        allowDeterministicFallback: true,
      },
    })

    expect(result.status).toBe("ready")
    expect(result.all_three_artifacts_present).toBe(true)
    expect(result.artifacts.map((item) => item.kind)).toEqual([
      "lesson",
      "lab",
      "assessment",
    ])
    expect(result.artifacts.every((item) => item.target_coverage === 1)).toBe(true)
    expect(result.review_decision).toBe("pass")
    expect(result.code_execution).toBe("passed")
    expect(result.teaching_audit_status).toBe("pass")
    expect(result.difficulty_matched).toBe(true)
    expect(result.prerequisite_covered).toBe(true)
    expect(result.weak_concepts_covered).toBe(true)
    expect(result.goal_aligned).toBe(true)
  })

  test("reports unsupported offline targets honestly instead of fabricating metrics", async () => {
    const evaluationCase = buildWeek3EvaluationCases().find((item) =>
      item.target_source_ids.length === 1)!
    const result = await runRoleCWeek3Case(evaluationCase, {
      executionMode: "deterministic",
      runtime: {
        providerMode: "deterministic",
        allowDeterministicFallback: true,
      },
    })

    expect(result.status).toBe("blocked")
    expect(result.recovery_code).toBe("UNSUPPORTED_TARGET")
    expect(result.all_three_artifacts_present).toBe(false)
    expect(result.failure_reason).toContain("离线 code-lab 基准实现")
    expect(result.hallucination_rate).toBeNull()
  })

  test("renders an auditable human-readable report", async () => {
    const evaluationCase = buildWeek3EvaluationCases().find((item) =>
      item.target_source_ids.join(",") === "K007,K009,K018")!
    const result = await runRoleCWeek3Case(evaluationCase, {
      executionMode: "deterministic",
      profile: offlineReferenceProfile(),
      runtime: {
        providerMode: "deterministic",
        allowDeterministicFallback: true,
      },
    })
    const report = buildRoleCWeek3Report(
      "deterministic",
      [result],
      "2026-08-01T00:00:00.000Z",
    )
    const markdown = renderRoleCWeek3Report(report)

    expect(report.summary.ready).toBe(1)
    expect(report.summary.all_three_artifacts_rate).toBe(1)
    expect(report.summary.teaching_audit_pass_rate).toBe(1)
    expect(report.summary.difficulty_match_rate).toBe(1)
    expect(markdown).toContain("Role C Week 3 真实流水线评测")
    expect(markdown).toContain(evaluationCase.case_id)
    expect(markdown).toContain("K007/K009/K018")
    expect(markdown).toContain("发布内容预览")
    expect(markdown).toContain("编程练习")
  })
})

function offlineReferenceProfile() {
  return {
    learner_id: "week3-offline-reference",
    level: "integrated" as const,
    known_concepts: [
      "Python 是什么",
      "变量与赋值",
      "基本数据类型",
      "运算符",
      "条件判断",
      "函数定义与调用",
    ],
    weak_concepts: ["for 循环", "列表", "成绩统计器综合项目"],
    goal: "理解循环与列表，完成成绩统计器",
  }
}
