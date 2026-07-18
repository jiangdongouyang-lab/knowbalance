import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"

const coreSourceIds = ["K002", "K003", "K006", "K007", "K009", "K013", "K018"]

describe("Python basics knowledge base", () => {
  test("loads a versioned Python basics module with traceable facts", async () => {
    const knowledgeBase = await loadKnowledgeBase()

    expect(knowledgeBase.module).toBe("Python基础")
    expect(knowledgeBase.version).toMatch(/^0\.1\./)
    expect(knowledgeBase.items.length).toBeGreaterThanOrEqual(15)

    const sourceIds = new Set(knowledgeBase.items.map((item) => item.sourceId))
    expect(sourceIds.size).toBe(knowledgeBase.items.length)

    for (const item of knowledgeBase.items) {
      expect(item.sourceId).toMatch(/^K\d{3}$/)
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.difficulty).toBeOneOf(["beginner", "basic", "intermediate", "integrated"])
      expect(item.keywords.length).toBeGreaterThan(0)
      expect(item.facts.length).toBeGreaterThanOrEqual(3)
      expect(item.quizItems.length).toBeGreaterThanOrEqual(2)
      for (const fact of item.facts) {
        expect(fact.factId).toMatch(/^F\d{3}$/)
        expect(fact.sourceId).toBe(item.sourceId)
        expect(fact.content.length).toBeGreaterThan(0)
      }
    }
  })

  test("provides real examples and quiz items for the week-one core concepts", async () => {
    const knowledgeBase = await loadKnowledgeBase()

    for (const sourceId of coreSourceIds) {
      const item = knowledgeBase.items.find((candidate) => candidate.sourceId === sourceId)
      expect(item).toBeDefined()
      expect(item?.examples[0]).toMatchObject({
        title: expect.any(String),
        code: expect.stringContaining("\n"),
        explanation: expect.any(String),
      })
      expect(item?.quizItems[0]).toMatchObject({
        level: 1,
        type: expect.any(String),
        question: expect.any(String),
        answer: expect.any(String),
        sourceId,
        factId: expect.stringMatching(/^F\d{3}$/),
      })
    }
  })

  test("ships a JSON index that mirrors the TypeScript knowledge registry", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const indexFile = await Bun.file("knowledge_base/python_basic/index.json").json()

    expect(indexFile.module).toBe(knowledgeBase.module)
    expect(indexFile.version).toBe(knowledgeBase.version)
    expect(indexFile.items).toHaveLength(knowledgeBase.items.length)
    expect(indexFile.items.map((item: { source_id: string }) => item.source_id)).toContain("K007")
  })
})
