import type { RagResult } from "../rag/retriever"
import type { KnowledgeFact } from "../knowledge/types"

export type Citation = {
  source_id: string
  fact_id: string
}

export type GeneratedContentBlock = {
  blockId: string
  text: string
  citations: Citation[]
}

export type FactAuditInput = {
  artifactId: string
  ragResult: RagResult
  generatedContent: {
    blocks: GeneratedContentBlock[]
  }
}

export type FactAuditVerdict = "supported" | "missing_citation" | "unsupported" | "external_knowledge"

export type FactAuditStatus = "pass" | "revise" | "reject"

export type CheckedClaim = {
  blockId: string
  claim: string
  citations: Citation[]
  verdict: FactAuditVerdict
  evidence?: string
  reason: string
}

export type FactAuditConflict = {
  blockId: string
  claim: string
  issue: string
  expectedEvidence?: string
}

export type FactAuditResult = {
  artifactId: string
  status: FactAuditStatus
  checkedClaims: CheckedClaim[]
  conflicts: FactAuditConflict[]
}

export type EvidenceIndex = Map<string, KnowledgeFact>
