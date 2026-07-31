import { buildEvidenceIndex } from "./evidence-index"
import type { CheckedClaim, FactAuditConflict, FactAuditInput, FactAuditResult, FactAuditStatus } from "./types"

const TOKEN_PATTERN = /[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|===?|!==?|<=|>=|[+*/%<>-]|[\u4e00-\u9fff]{2,}/g
const NEGATION_PATTERN = /(?:并非|不是|不能|不会|不可|无需|禁止|避免|没有|不应|未|无|没|非|不)/u

/**
 * Only collapse a deliberately small set of wording changes that preserve the
 * proposition. This is lexical normalization, not a knowledge-specific synonym
 * table: it never names a source, fact or Python concept.
 */
const EQUIVALENT_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
  [/通常/g, "常"],
  [/一般/g, "常"],
  [/逐个处理/g, "遍历"],
  [/逐一处理/g, "遍历"],
  [/一个个处理/g, "遍历"],
  [/(?:里面的|里的|当中的)/g, "中的"],
]

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
  if (!normalizedClaim || !normalizedFact) return false
  if (hasNegativePolarity(normalizedClaim) !== hasNegativePolarity(normalizedFact)) return false
  if (normalizedClaim === normalizedFact) return true

  // A sufficiently complete excerpt cannot introduce a new proposition.  The
  // inverse is intentionally not accepted: appending an unsupported assertion
  // to the full fact must not turn the whole block into a supported claim.
  if (normalizedFact.includes(normalizedClaim)) {
    return normalizedClaim.length / normalizedFact.length >= 0.65
  }

  const claimTokens = new Set(tokens(normalizedClaim))
  const factTokens = new Set(tokens(normalizedFact))
  if (claimTokens.size === 0 || factTokens.size === 0) return false

  let overlap = 0
  for (const token of claimTokens) {
    if (factTokens.has(token)) overlap += 1
  }
  const claimCoverage = overlap / claimTokens.size
  const factCoverage = overlap / factTokens.size
  const lengthRatio = normalizedClaim.length / normalizedFact.length

  // Both directions matter. Claim coverage rejects a true fact followed by a
  // fabricated extension; fact coverage rejects a loosely related sentence
  // that merely repeats a couple of prominent words.
  return claimCoverage >= 0.85
    && factCoverage >= 0.75
    && lengthRatio >= 0.65
    && lengthRatio <= 1.35
}

function normalize(value: string): string {
  let normalized = value.toLowerCase().replace(/[，。、“”"'：:；;、！？!?（）()【】\[\]\s]/g, "")
  for (const [pattern, replacement] of EQUIVALENT_WORDING) {
    normalized = normalized.replace(pattern, replacement)
  }
  return normalized
}

function hasNegativePolarity(value: string): boolean {
  return NEGATION_PATTERN.test(value)
}

function tokens(value: string): string[] {
  return (value.match(TOKEN_PATTERN) ?? []).flatMap((token) => {
    if (!/^[\u4e00-\u9fff]+$/u.test(token) || token.length <= 2) return [token]
    const grams: string[] = []
    for (let index = 0; index < token.length - 1; index += 1) {
      grams.push(token.slice(index, index + 2))
    }
    return grams
  })
}
