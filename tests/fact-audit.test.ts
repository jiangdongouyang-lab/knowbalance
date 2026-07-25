import { describe, expect, test } from "bun:test"
import Ajv from "ajv"
import { retrieveKnowledge } from "../src/rag/retriever"
import { auditGeneratedContent, buildEvidenceIndex } from "../src/fact-audit/auditor"

describe("RAG result schema", () => {
  test("accepts the real retrieveKnowledge output including object examples, quiz items and retrieval trace", async () => {
    const schema = await Bun.file("schemas/rag_result.schema.json").json()
    const ajv = new Ajv()
    const validate = ajv.compile(schema)
    const result = await retrieveKnowledge({
      query: "初学者，不会循环，需要完成成绩统计程序",
      learnerLevel: "beginner",
      topK: 3,
    })

    expect(validate(result)).toBe(true)
    expect(validate.errors ?? []).toEqual([])
  })
})

describe("fact audit MVP", () => {
  test("indexes RAG facts by source_id and fact_id", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const index = buildEvidenceIndex(ragResult)

    expect(index.get("K007:F001")?.content).toBe("for 循环常用于遍历序列中的元素。")
  })

  test("passes a generated block supported by a real citation", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const result = auditGeneratedContent({
      artifactId: "artifact-supported",
      ragResult,
      generatedContent: {
        blocks: [
          {
            blockId: "block-1",
            text: "for 循环常用于遍历序列中的元素。",
            citations: [{ source_id: "K007", fact_id: "F001" }],
          },
        ],
      },
    })

    expect(result.status).toBe("pass")
    expect(result.checkedClaims[0]).toMatchObject({ verdict: "supported", blockId: "block-1" })
    expect(result.conflicts).toEqual([])
  })

  test("asks for revision when a knowledge block has no citation", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const result = auditGeneratedContent({
      artifactId: "artifact-missing-citation",
      ragResult,
      generatedContent: {
        blocks: [
          {
            blockId: "block-1",
            text: "for 循环可以帮助学习者处理重复任务。",
            citations: [],
          },
        ],
      },
    })

    expect(result.status).toBe("revise")
    expect(result.checkedClaims[0]).toMatchObject({ verdict: "missing_citation", blockId: "block-1" })
  })

  test("rejects a citation that is not present in the current RAG result", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const result = auditGeneratedContent({
      artifactId: "artifact-fake-citation",
      ragResult,
      generatedContent: {
        blocks: [
          {
            blockId: "block-1",
            text: "for 循环常用于遍历序列中的元素。",
            citations: [{ source_id: "K999", fact_id: "F001" }],
          },
        ],
      },
    })

    expect(result.status).toBe("reject")
    expect(result.checkedClaims[0]).toMatchObject({ verdict: "unsupported", reason: expect.stringContaining("引用不存在") })
  })

  test("rejects a block whose claim is not supported by the cited fact", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const result = auditGeneratedContent({
      artifactId: "artifact-wrong-citation",
      ragResult,
      generatedContent: {
        blocks: [
          {
            blockId: "block-1",
            text: "字典使用键值对保存数据。",
            citations: [{ source_id: "K007", fact_id: "F001" }],
          },
        ],
      },
    })

    expect(result.status).toBe("reject")
    expect(result.checkedClaims[0]).toMatchObject({ verdict: "unsupported", blockId: "block-1" })
    expect(result.conflicts[0]?.issue).toContain("未被引用事实支持")
  })

  test("rejects external knowledge that is outside the RAG evidence", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const result = auditGeneratedContent({
      artifactId: "artifact-external-knowledge",
      ragResult,
      generatedContent: {
        blocks: [
          {
            blockId: "block-1",
            text: "Transformer 通过自注意力机制学习上下文关系。",
            citations: [{ source_id: "K007", fact_id: "F001" }],
          },
        ],
      },
    })

    expect(result.status).toBe("reject")
    expect(result.checkedClaims[0]).toMatchObject({ verdict: "external_knowledge", blockId: "block-1" })
  })
})
