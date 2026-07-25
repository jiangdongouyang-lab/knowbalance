import type { RagResult } from "../rag/retriever"
import type { EvidenceIndex } from "./types"

export function buildEvidenceIndex(ragResult: RagResult): EvidenceIndex {
  const index: EvidenceIndex = new Map()

  for (const item of ragResult.results) {
    for (const fact of item.facts) {
      const sourceId = fact.source_id ?? fact.sourceId
      const factId = fact.fact_id ?? fact.factId
      index.set(`${sourceId}:${factId}`, { ...fact, source_id: sourceId, fact_id: factId })
    }
  }

  return index
}
