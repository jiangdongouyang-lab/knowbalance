import { PYTHON_BASIC_KNOWLEDGE_BASE } from "./python-basic"
import type { KnowledgeBase } from "./types"

export async function loadKnowledgeBase(): Promise<KnowledgeBase> {
  validateKnowledgeBase(PYTHON_BASIC_KNOWLEDGE_BASE)
  return PYTHON_BASIC_KNOWLEDGE_BASE
}

function validateKnowledgeBase(knowledgeBase: KnowledgeBase): void {
  const sourceIds = new Set<string>()

  for (const item of knowledgeBase.items) {
    if (sourceIds.has(item.sourceId)) {
      throw new Error(`Duplicate knowledge source_id: ${item.sourceId}`)
    }
    sourceIds.add(item.sourceId)

    for (const fact of item.facts) {
      if (fact.sourceId !== item.sourceId) {
        throw new Error(`Fact ${fact.factId} is attached to the wrong source_id`)
      }
    }
  }
}

export type { KnowledgeBase, KnowledgeFact, KnowledgeItem, KnowledgeDifficulty } from "./types"
