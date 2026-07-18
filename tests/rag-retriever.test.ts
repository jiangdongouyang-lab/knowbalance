import { describe, expect, test } from "bun:test"
import { retrieveKnowledge } from "../src/rag/retriever"

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
    expect(result.results[0].sourceId).toBe("K007")
    expect(result.results.map((item) => item.sourceId)).toContain("K009")
    expect(result.results.map((item) => item.sourceId)).toContain("K018")

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

    expect(result.results.map((item) => item.sourceId)).toContain("K007")
    expect(result.results.map((item) => item.sourceId)).toContain("K009")
    expect(result.results[0].retrievalTrace.matchedFields).toContain("synonyms")
  })
})
