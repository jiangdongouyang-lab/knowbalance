import { buildEvidenceIndex } from "./evidence-index"
import type { CheckedClaim, FactAuditConflict, FactAuditInput, FactAuditResult, FactAuditStatus } from "./types"

const EXTERNAL_KNOWLEDGE_TERMS = ["Transformer", "自注意力", "神经网络", "梯度下降", "CNN"]
const TOKEN_PATTERN = /[A-Za-z]+|[\u4e00-\u9fff]{2,}/g

export { buildEvidenceIndex }
export type { FactAuditInput, FactAuditResult } from "./types"

export function auditGeneratedContent(input: FactAuditInput): FactAuditResult {
  const evidenceIndex = buildEvidenceIndex(input.ragResult)
  const checkedClaims: CheckedClaim[] = []
  const conflicts: FactAuditConflict[] = []

  for (const block of input.generatedContent.blocks) {
    if (block.citations.length === 0) {
      checkedClaims.push({
        blockId: block.blockId,
        claim: block.text,
        citations: [],
        verdict: "missing_citation",
        reason: "知识性内容缺少 source_id/fact_id 引用。",
      })
      conflicts.push({ blockId: block.blockId, claim: block.text, issue: "缺少知识库引用" })
      continue
    }

    const externalTerm = EXTERNAL_KNOWLEDGE_TERMS.find((term) => block.text.includes(term))
    if (externalTerm) {
      checkedClaims.push({
        blockId: block.blockId,
        claim: block.text,
        citations: block.citations,
        verdict: "external_knowledge",
        reason: `内容包含当前 RAG 证据之外的外部知识：${externalTerm}`,
      })
      conflicts.push({ blockId: block.blockId, claim: block.text, issue: `外部知识未被当前 RAG 证据支持：${externalTerm}` })
      continue
    }

    const citedFacts = block.citations.map((citation) => ({
      citation,
      fact: evidenceIndex.get(`${citation.source_id}:${citation.fact_id}`),
    }))
    const missingCitation = citedFacts.find((entry) => !entry.fact)
    if (missingCitation) {
      checkedClaims.push({
        blockId: block.blockId,
        claim: block.text,
        citations: block.citations,
        verdict: "unsupported",
        reason: `引用不存在于当前 RAG 结果：${missingCitation.citation.source_id}:${missingCitation.citation.fact_id}`,
      })
      conflicts.push({ blockId: block.blockId, claim: block.text, issue: "引用不存在于当前 RAG 结果" })
      continue
    }

    const supportingFact = citedFacts.find((entry) => entry.fact && isClaimSupportedByFact(block.text, entry.fact.content))?.fact
    if (supportingFact) {
      checkedClaims.push({
        blockId: block.blockId,
        claim: block.text,
        citations: block.citations,
        verdict: "supported",
        evidence: supportingFact.content,
        reason: "生成内容与引用事实存在足够词面重叠。",
      })
      continue
    }

    checkedClaims.push({
      blockId: block.blockId,
      claim: block.text,
      citations: block.citations,
      verdict: "unsupported",
      reason: "生成内容未被引用事实支持。",
    })
    conflicts.push({
      blockId: block.blockId,
      claim: block.text,
      issue: "生成内容未被引用事实支持",
      expectedEvidence: citedFacts.map((entry) => entry.fact?.content).filter(Boolean).join("；"),
    })
  }

  return {
    artifactId: input.artifactId,
    status: deriveStatus(checkedClaims),
    checkedClaims,
    conflicts,
  }
}

function deriveStatus(checkedClaims: CheckedClaim[]): FactAuditStatus {
  if (checkedClaims.some((claim) => claim.verdict === "unsupported" || claim.verdict === "external_knowledge")) return "reject"
  if (checkedClaims.some((claim) => claim.verdict === "missing_citation")) return "revise"
  return "pass"
}

function isClaimSupportedByFact(claim: string, fact: string): boolean {
  const normalizedClaim = normalize(claim)
  const normalizedFact = normalize(fact)
  if (normalizedClaim.includes(normalizedFact) || normalizedFact.includes(normalizedClaim)) return true

  const claimTokens = new Set(tokens(normalizedClaim))
  const factTokens = tokens(normalizedFact)
  const overlap = factTokens.filter((token) => claimTokens.has(token)).length
  return overlap >= Math.min(2, factTokens.length)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[，。、“”"'：:；;、\s]/g, "")
}

function tokens(value: string): string[] {
  return value.match(TOKEN_PATTERN) ?? []
}
