import { contentHash } from "../role-c-content/contracts/common"
import { buildEvidenceIndex, buildEvidenceIndexFromPack } from "./evidence-index"
import type { CheckedClaim, EvidenceIndex, FactAuditConflict, FactAuditInput, FactAuditResult, FactAuditStatus } from "./types"

const EXTERNAL_KNOWLEDGE_TERMS = [
  "Transformer", "自注意力", "神经网络", "梯度下降", "CNN",
  "Pandas", "NumPy", "matplotlib", "数据框", "DataFrame",
  "λ", "yield",
  "闭包", "作用域", "global", "nonlocal",
  "正则表达式", "re模块", "正则",
  "多线程", "多进程", "并发", "async", "await",
  "数据库", "SQL", "MySQL", "SQLite",
  "GUI", "图形界面", "tkinter",
  "API", "HTTP", "网络请求", "requests",
  "单元测试", "unittest", "pytest",
  "pip", "虚拟环境", "venv", "conda",
  "git", "版本控制", "GitHub",
  "AI", "机器学习", "深度学习", "大模型", "LLM",
]
const TOKEN_PATTERN = /[A-Za-z]+|[\u4e00-\u9fff]{2,}/g

export { buildEvidenceIndex }
export type { FactAuditInput, FactAuditResult } from "./types"

export interface SemanticAuditPort {
  auditClaim(input: {
    claim: string
    evidence: string
    citations: { source_id: string; fact_id: string }[]
  }): Promise<{
    verdict: "supported" | "unsupported" | "uncertain"
    confidence: number
    reason: string
  }>
}

export function auditGeneratedContent(input: FactAuditInput): FactAuditResult {
  const evidence = resolveAuditEvidence(input)
  if (evidence.error) {
    return {
      artifactId: input.artifactId,
      status: "reject",
      checkedClaims: [],
      conflicts: [evidence.error],
      evidence: evidence.metadata,
    }
  }

  const evidenceIndex = evidence.index
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
    evidence: evidence.metadata,
  }
}

export async function auditGeneratedContentWithSemantic(input: {
  input: FactAuditInput
  semanticAuditPort: SemanticAuditPort
}): Promise<FactAuditResult> {
  const base = auditGeneratedContent(input.input)
  if (base.status === "reject") return base

  const checkedClaims: CheckedClaim[] = []
  const semanticConflicts: FactAuditConflict[] = []
  for (const claim of base.checkedClaims) {
    if (claim.verdict !== "supported" || !claim.evidence) {
      checkedClaims.push(claim)
      continue
    }

    const semantic = await input.semanticAuditPort.auditClaim({
      claim: claim.claim,
      evidence: claim.evidence,
      citations: claim.citations,
    })
    if (semantic.verdict === "supported") {
      checkedClaims.push({ ...claim, semantic })
      continue
    }

    checkedClaims.push({
      ...claim,
      verdict: "semantic_unsupported",
      semantic,
      reason: `语义审核未通过：${semantic.reason}`,
    })
    semanticConflicts.push({
      blockId: claim.blockId,
      claim: claim.claim,
      issue: "语义审核未通过",
      expectedEvidence: semantic.reason,
    })
  }

  return {
    ...base,
    status: checkedClaims.some((claim) => claim.verdict === "semantic_unsupported") ? "reject" : base.status,
    checkedClaims,
    conflicts: [...base.conflicts, ...semanticConflicts],
  }
}

function resolveAuditEvidence(input: FactAuditInput): {
  index: EvidenceIndex
  metadata: NonNullable<FactAuditResult["evidence"]>
  error?: FactAuditConflict
} {
  if (input.evidencePack) {
    const actualHash = contentHash(input.evidencePack)
    const metadata = {
      kind: "frozen_evidence_pack" as const,
      retrieval_id: input.evidencePack.retrieval_id,
      content_hash: actualHash,
    }

    if (input.expectedEvidenceContentHash && input.expectedEvidenceContentHash !== actualHash) {
      return {
        index: new Map(),
        metadata,
        error: {
          blockId: "__evidence_pack__",
          claim: input.evidencePack.retrieval_id,
          issue: "冻结证据包哈希不匹配",
          expectedEvidence: `expected=${input.expectedEvidenceContentHash}; actual=${actualHash}`,
        },
      }
    }

    return { index: buildEvidenceIndexFromPack(input.evidencePack), metadata }
  }

  if (input.ragResult) {
    return { index: buildEvidenceIndex(input.ragResult), metadata: { kind: "rag_result" } }
  }

  return {
    index: new Map(),
    metadata: { kind: "rag_result" },
    error: {
      blockId: "__evidence__",
      claim: input.artifactId,
      issue: "缺少审核证据：必须提供 ragResult 或冻结 evidencePack",
    },
  }
}

function deriveStatus(checkedClaims: CheckedClaim[]): FactAuditStatus {
  if (checkedClaims.some((claim) => claim.verdict === "unsupported" || claim.verdict === "external_knowledge" || claim.verdict === "semantic_unsupported")) return "reject"
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
