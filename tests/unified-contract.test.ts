import { describe, expect, test } from "bun:test"
import {
  normalizeUnifiedArtifact,
  normalizeUnifiedHandoff,
  normalizeUnifiedRagResult,
} from "../src/unified-contract"

describe("unified contract", () => {
  test("normalizes camelCase and snake_case handoff payloads into the same canonical shape", () => {
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

    const camel = normalizeUnifiedHandoff({
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

    const snake = normalizeUnifiedHandoff({
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

    expect(camel.schemaVersion).toBe("1.0")
    expect(camel.retrieval.items[0]).toEqual(snake.retrieval.items[0])
    expect(camel.retrieval.topK).toBe(1)
    expect(snake.retrieval.topK).toBe(1)
  })

  test("preserves missing citations as explicit evidence gaps instead of inventing them", () => {
    const session = normalizeUnifiedHandoff({
      b_profile: {
        learner_id: "demo_loop_weak_001",
        level: "beginner",
        known_concepts: ["变量"],
        weak_concepts: ["循环", "列表"],
        goal: "完成成绩统计程序",
      },
      a_rag_result: { query: "循环", topK: 0, results: [] },
      c_artifacts: [{
        id: "lesson-1",
        kind: "lesson",
        title: "循环讲义",
        status: "mock",
        content: "这一段还没有引用。",
        citations: [],
      }],
      workflow_events: [],
    })

    expect(session.artifacts[0].evidenceStatus).toBe("gap")
    expect(session.evidenceGaps).toEqual(["lesson-1"])
  })

  test("normalizes artifact citations and keeps invalid references visible", () => {
    const artifact = normalizeUnifiedArtifact(
      {
        id: "lesson-invalid-citation",
        kind: "lesson",
        title: "错误引用讲义",
        status: "mock",
        content: "这条引用不存在。",
        citations: [{ source_id: "MISSING", fact_id: "F404" }],
      },
      new Set(["K007-F001"]),
    )

    expect(artifact.evidenceStatus).toBe("gap")
    expect(artifact.citations).toEqual([{ sourceId: "MISSING", factId: "F404" }])
  })

  test("normalizes a raw RAG result into canonical retrieval fields", () => {
    const rag = normalizeUnifiedRagResult({
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
          matched_keywords: ["循环"],
          matched_fields: ["keywords"],
          difficulty_match: true,
        },
      }],
    })

    expect(rag.topK).toBe(1)
    expect(rag.results[0].sourceId).toBe("K007")
    expect(rag.results[0].trace.scoreBreakdown.practiceTasks).toBe(2)
    expect(rag.results[0].trace.scoreBreakdown).not.toHaveProperty("practice_tasks")
  })
})
