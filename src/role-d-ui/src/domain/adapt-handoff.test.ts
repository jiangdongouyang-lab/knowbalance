import { describe, expect, test } from "vitest"
import { adaptHandoff } from "./adapt-handoff"

const shared = {
  b_profile: {
    learner_id: "demo_loop_weak_001",
    level: "beginner",
    known_concepts: ["变量"],
    weak_concepts: ["循环", "列表"],
    goal: "完成成绩统计程序",
  },
  c_artifacts: [],
  workflow_events: [],
}

describe("adaptHandoff", () => {
  test("does not invent the K007 demo diagnosis when a handoff omits diagnosis data", () => {
    const session = adaptHandoff({
      ...shared,
      a_rag_result: { query: "变量", topK: 0, results: [] },
    })

    expect(session.diagnosis.sourceId).toBe("UNKNOWN")
    expect(session.diagnosis.question).toBe("")
    expect(session.diagnosis.options).toEqual([])
  })

  test("normalizes camelCase and snake_case retrieval contracts into the same Role D model", () => {
    const camel = adaptHandoff({
      ...shared,
      a_rag_result: {
        query: "循环",
        topK: 1,
        results: [{
          sourceId: "K007",
          title: "for 循环",
          difficulty: "beginner",
          score: 35,
          reason: "命中循环",
          snippet: "用于遍历序列",
          file: "K007_for_loop.md",
          facts: [{ sourceId: "K007", factId: "F001", content: "for 循环用于遍历序列" }],
          examples: [],
          practiceTasks: [],
          quizItems: [],
          retrievalTrace: {
            matchedKeywords: ["循环"],
            matchedFields: ["keywords"],
            difficultyMatch: true,
            scoreBreakdown: { keyword: 10, title: 0, facts: 0, practiceTasks: 0, difficulty: 3, bonus: 22 },
          },
        }],
      },
    })

    const snake = adaptHandoff({
      ...shared,
      a_rag_result: {
        query: "循环",
        top_k: 1,
        results: [{
          source_id: "K007",
          title: "for 循环",
          difficulty: "beginner",
          score: 35,
          reason: "命中循环",
          snippet: "用于遍历序列",
          file: "K007_for_loop.md",
          facts: [{ source_id: "K007", fact_id: "F001", content: "for 循环用于遍历序列" }],
          examples: [],
          practice_tasks: [],
          quiz_items: [],
          retrieval_trace: {
            matched_keywords: ["循环"],
            matched_fields: ["keywords"],
            difficulty_match: true,
            score_breakdown: { keyword: 10, title: 0, facts: 0, practiceTasks: 0, difficulty: 3, bonus: 22 },
          },
        }],
      },
    })

    expect(camel.retrieval.items[0]).toEqual(snake.retrieval.items[0])
    expect(camel.retrieval.topK).toBe(1)
    expect(snake.retrieval.topK).toBe(1)
  })

  test("preserves missing citations as explicit evidence gaps instead of inventing them", () => {
    const session = adaptHandoff({
      ...shared,
      a_rag_result: { query: "循环", topK: 0, results: [] },
      c_artifacts: [{
        id: "lesson-1",
        kind: "lesson",
        title: "循环讲义",
        status: "mock",
        content: "这一段还没有引用。",
        citations: [],
      }],
    })

    expect(session.artifacts[0].evidenceStatus).toBe("gap")
    expect(session.evidenceGaps).toEqual(["lesson-1"])
  })

  test("treats citations absent from retrieved facts as evidence gaps", () => {
    const session = adaptHandoff({
      ...shared,
      a_rag_result: {
        query: "循环",
        topK: 1,
        results: [{
          source_id: "K007",
          title: "for 循环",
          difficulty: "beginner",
          score: 1,
          facts: [{ source_id: "K007", fact_id: "F001", content: "可验证事实" }],
          retrieval_trace: { score_breakdown: {} },
        }],
      },
      c_artifacts: [{
        id: "lesson-invalid-citation",
        kind: "lesson",
        title: "错误引用讲义",
        status: "mock",
        content: "这条引用不存在。",
        citations: [{ source_id: "MISSING", fact_id: "F404" }],
      }],
    })

    expect(session.artifacts[0].evidenceStatus).toBe("gap")
    expect(session.evidenceGaps).toEqual(["lesson-invalid-citation"])
  })

  test("normalizes snake_case fields nested inside score_breakdown", () => {
    const session = adaptHandoff({
      ...shared,
      a_rag_result: {
        query: "循环",
        top_k: 1,
        results: [{
          source_id: "K007",
          title: "for 循环",
          difficulty: "beginner",
          score: 2,
          facts: [],
          retrieval_trace: {
            score_breakdown: { practice_tasks: 2 },
          },
        }],
      },
    })

    expect(session.retrieval.items[0].trace.scoreBreakdown.practiceTasks).toBe(2)
    expect(session.retrieval.items[0].trace.scoreBreakdown).not.toHaveProperty("practice_tasks")
  })

  test("does not trust formal grading flags from an unsigned handoff", () => {
    const session = adaptHandoff({
      ...shared,
      assessmentGraded: true,
      decision: { next: "advance", reason: "unsigned perfect score" },
    })

    expect(session.assessmentGraded).toBe(false)
  })

  test("preserves A/B audit and arbitration summaries for Role D reporting", () => {
    const session = adaptHandoff({
      ...shared,
      a_rag_result: {
        query: "循环",
        topK: 1,
        results: [{
          source_id: "K007",
          title: "for 循环",
          difficulty: "beginner",
          score: 1,
          facts: [{ source_id: "K007", fact_id: "F001", content: "for 循环用于遍历序列" }],
          retrieval_trace: { score_breakdown: {} },
        }],
      },
      audit: {
        fact_status: "pass",
        fact_audits: [{ artifact_id: "lesson-1", artifact_title: "循环讲义", artifact_kind: "lesson", status: "pass", checked_claims: 1, conflicts: 0, notes: [] }],
        teaching_audit: { artifact_id: "role-c-week2-content", status: "revise", summary: "需要调整讲解顺序。", revision_hints: ["先补变量"] },
        arbitration: { artifact_id: "role-c-week2-content", decision: "revise", revision_round: 0, max_revision_rounds: 2, can_revise: true, reason: "允许再修订一轮。" },
      },
    })

    expect(session.audit?.factStatus).toBe("pass")
    expect(session.audit?.factAudits[0]).toMatchObject({ artifactId: "lesson-1", artifactTitle: "循环讲义", status: "pass" })
    expect(session.audit?.teachingAudit.revisionHints).toEqual(["先补变量"])
    expect(session.audit?.arbitration).toMatchObject({ decision: "revise", canRevise: true })
  })
})
