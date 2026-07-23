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
})
