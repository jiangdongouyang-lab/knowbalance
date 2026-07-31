import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeBase, KnowledgeItem } from "../src/knowledge/types"
import { retrieveStructuredEvidenceFromKnowledgeBase } from "../src/rag/structured-evidence"
import type { EvidenceGapRequest } from "../src/role-c-content"
import { createRoleCRecoveryEvidenceRefreshPort } from "../src/role-d-integration/role-c-service"

describe("Role D local A recovery evidence adapter", () => {
  test("splits a large source request into protocol-sized A calls and merges exact targets", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const added = generatedKnowledgeItem()
    const extended: KnowledgeBase = {
      ...knowledgeBase,
      items: [...knowledgeBase.items, added],
      sources: [...knowledgeBase.sources, added.file],
    }
    const targetSourceIds = extended.items.map((item) => item.sourceId)
    const calls: Array<{
      source_ids: string[]
      fact_ids_by_source?: Record<string, string[]>
    }> = []
    const port = createRoleCRecoveryEvidenceRefreshPort({
      kbVersion: extended.version,
      knowledgeBase: extended,
      structuredEvidencePort: {
        async retrieveStructuredEvidence(input) {
          calls.push(structuredClone(input))
          return retrieveStructuredEvidenceFromKnowledgeBase(input, extended)
        },
      },
    })
    const request: EvidenceGapRequest = {
      schema_version: "1.0",
      request_id: "EGR-LARGE-BATCH",
      run_id: "RUN-LARGE-BATCH",
      target_source_ids: targetSourceIds,
      missing_type: "knowledge_item",
      reason: "新路径需要完整目标证据",
      learner_level: "basic",
      required_facts: extended.items.flatMap((item) => {
        const fact = item.facts[0]
        return fact
          ? [{ source_id: item.sourceId, fact_id: fact.factId }]
          : []
      }),
    }

    const evidence = await port.refreshEvidence(request)

    expect(calls.length).toBe(Math.ceil(targetSourceIds.length / 8))
    expect(calls.every((call) => call.source_ids.length <= 8)).toBe(true)
    expect(calls.flatMap((call) => call.source_ids)).toEqual(targetSourceIds)
    expect(calls.at(-1)?.source_ids).toContain("K777")
    expect(evidence.top_k).toBe(targetSourceIds.length)
    expect(evidence.results.map((item) => item.source_id))
      .toEqual(targetSourceIds)
    expect(evidence.match_status).toBe("strong")
    expect(evidence.rag_version).toBe("structured-evidence-1.0-recovery")
    const factKeys = new Set(evidence.results.flatMap((item) =>
      item.facts.map((fact) => `${fact.source_id}:${fact.fact_id}`)))
    expect(request.required_facts.every((fact) =>
      factKeys.has(`${fact.source_id}:${fact.fact_id}`)))
      .toBe(true)
  })

  test("returns an explicit weak evidence result when a source or fact identity is missing", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const port = createRoleCRecoveryEvidenceRefreshPort({
      kbVersion: knowledgeBase.version,
      knowledgeBase,
    })

    const evidence = await port.refreshEvidence({
      schema_version: "1.0",
      request_id: "EGR-MISSING-IDENTITIES",
      run_id: "RUN-MISSING-IDENTITIES",
      target_source_ids: ["K010", "K-NOT-FOUND"],
      missing_type: "fact",
      reason: "恢复路径要求精确事实",
      learner_level: "basic",
      required_facts: [{ source_id: "K010", fact_id: "F-NOT-FOUND" }],
    })

    expect(evidence.query).toBe("按标识刷新证据：K010、K-NOT-FOUND")
    expect(evidence.match_status).toBe("weak")
    expect(evidence.results.map((item) => item.source_id)).toEqual(["K010"])
    expect(evidence.results[0]!.facts).toEqual([])
  })
})

function generatedKnowledgeItem(): KnowledgeItem {
  return {
    sourceId: "K777",
    title: "生成器基础",
    module: "python-basic",
    difficulty: "intermediate",
    prerequisites: [],
    keywords: ["生成器", "yield"],
    file: "knowledge_base/python_basic/K777_generator.md",
    snippet: "生成器按需逐项产生值。",
    facts: [{
      sourceId: "K777",
      factId: "F001",
      content: "yield 会产生一个值并暂停函数。",
    }],
    examples: [],
    practiceTasks: ["编写一个生成器"],
    quizItems: [],
  }
}
