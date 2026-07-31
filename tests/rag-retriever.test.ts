import { describe, expect, test } from "bun:test"
import {
  retrieveKnowledge,
  retrieveKnowledgeFromKnowledgeBase,
} from "../src/rag/retriever"
import { retrieveStructuredEvidence } from "../src/rag/structured-evidence"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeItem } from "../src/knowledge/types"

const cases = [
  { query: "我不知道变量是什么", expected: "K002" },
  { query: "Python 有哪些数据类型", expected: "K003" },
  { query: "怎么判断条件", expected: "K006" },
  { query: "怎么让代码重复执行", expected: "K007" },
  { query: "怎么保存一组成绩", expected: "K009" },
  { query: "怎么根据姓名查成绩", expected: "K010" },
  { query: "怎么写一个函数", expected: "K013" },
  { query: "怎么读取文本文件", expected: "K015" },
  { query: "程序报错了怎么处理", expected: "K016" },
  { query: "怎么导入模块", expected: "K017" },
]

describe("RAG retriever", () => {
  test("returns OpenCode-consumable traceable JSON results", async () => {
    const result = await retrieveKnowledge({
      query: "初学者，不会循环，需要完成成绩统计程序",
      learnerLevel: "beginner",
      topK: 3,
    })

    expect(result.query).toBe("初学者，不会循环，需要完成成绩统计程序")
    expect(result.results).toHaveLength(3)
    expect(result.results.some((item) => item.title.includes("循环"))).toBe(true)
    expect(result.results.some((item) => item.title.includes("成绩统计"))).toBe(true)
    expect(result.results.every((item) =>
      item.retrievalTrace.matchedFields.some((field) =>
        field !== "difficulty"))).toBe(true)

    for (const item of result.results) {
      expect(item.score).toBeGreaterThan(0)
      expect(item.source_id).toBe(item.sourceId)
      expect(item.snippet.length).toBeGreaterThan(0)
      expect(item.facts.length).toBeGreaterThan(0)
      expect(item.facts[0].sourceId).toBe(item.sourceId)
      expect(item.facts[0].source_id).toBe(item.sourceId)
      expect(item.facts[0].fact_id).toBe(item.facts[0].factId)
      expect(item.retrievalTrace.matchedFields.length).toBeGreaterThan(0)
      expect(item.retrieval_trace.matched_fields).toEqual(item.retrievalTrace.matchedFields)
    }
  })

  test("achieves at least 80 percent top-3 hit rate on evaluation queries", async () => {
    let hits = 0

    for (const evaluation of cases) {
      const result = await retrieveKnowledge({ query: evaluation.query, topK: 3 })
      if (result.results.some((item) => item.sourceId === evaluation.expected)) {
        hits += 1
      }
    }

    expect(hits).toBeGreaterThanOrEqual(8)
  })

  test("expands beginner synonyms before scoring", async () => {
    const result = await retrieveKnowledge({
      query: "我想让程序一遍遍处理很多数据",
      learnerLevel: "beginner",
      topK: 3,
    })

    const matchedKeywords = new Set(result.results.flatMap((item) =>
      item.retrievalTrace.matchedKeywords))
    expect(matchedKeywords).toContain("循环")
    expect(matchedKeywords).toContain("列表")
    expect(result.results[0].retrievalTrace.matchedFields).toContain("synonyms")
  })

  test("ranks a newly added source from its content without source-id rules", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const added: KnowledgeItem = {
      sourceId: "K777",
      title: "生成器基础",
      module: knowledgeBase.module,
      difficulty: "intermediate",
      prerequisites: [],
      keywords: ["生成器", "yield", "惰性迭代"],
      file: "knowledge_base/python_basic/K777_generator.md",
      snippet: "生成器可以按需逐项产生值。",
      facts: [{
        sourceId: "K777",
        factId: "F001",
        content: "yield 会产生一个值并暂停函数。",
      }],
      examples: [],
      practiceTasks: ["用 yield 编写一个惰性迭代器"],
      quizItems: [],
    }

    const result = retrieveKnowledgeFromKnowledgeBase({
      query: "用 yield 编写生成器实现惰性迭代",
      learnerLevel: "intermediate",
      topK: 1,
    }, {
      ...knowledgeBase,
      items: [...knowledgeBase.items, added],
      sources: [...knowledgeBase.sources, added.file],
    })

    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.title).toBe("生成器基础")
    expect(result.results[0]!.retrievalTrace.matchedFields).toContain("keywords")
    expect(result.results[0]!.retrievalTrace.matchedFields).not.toContain("taskIntent")
  })

  test("reads exact source and fact evidence without pretending it was a text match", async () => {
    const result = await retrieveStructuredEvidence({
      source_ids: ["K010", "K014"],
      fact_ids_by_source: { K010: ["F001"] },
    })

    expect(result.missing_source_ids).toEqual([])
    expect(result.missing_fact_refs).toEqual([])
    expect(result.results.map((item) => item.sourceId)).toEqual(["K010", "K014"])
    expect(result.results[0]!.facts.map((fact) => fact.factId)).toEqual(["F001"])
    for (const item of result.results) {
      expect(item.score).toBe(0)
      expect(item.retrievalTrace.matchedFields).toEqual(["source_id"])
      expect(Object.values(item.retrievalTrace.scoreBreakdown)
        .every((score) => score === 0)).toBe(true)
    }
  })

  test("reports unknown source and fact identities explicitly", async () => {
    const result = await retrieveStructuredEvidence({
      source_ids: ["K010", "K-NOT-FOUND"],
      fact_ids_by_source: { K010: ["F-NOT-FOUND"] },
    })

    expect(result.missing_source_ids).toEqual(["K-NOT-FOUND"])
    expect(result.missing_fact_refs).toEqual([{
      source_id: "K010",
      fact_id: "F-NOT-FOUND",
    }])
  })
})
