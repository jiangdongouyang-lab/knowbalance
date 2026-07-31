import type { SemanticAuditPort } from "./auditor"
import type { ModelGateway } from "../role-c-content/contracts/model-gateway"
import { contentHash } from "../role-c-content/contracts/common"

export interface LlmSemanticAuditJudgeOptions {
  model_id?: string
  output_schema_id?: string
}

type JudgeOutput = {
  verdict: "supported" | "unsupported" | "uncertain"
  confidence: number
  reason: string
}

export class LlmSemanticAuditJudge implements SemanticAuditPort {
  private readonly outputSchemaId: string

  constructor(
    private readonly gateway: ModelGateway,
    options: LlmSemanticAuditJudgeOptions = {},
  ) {
    this.outputSchemaId = options.output_schema_id ?? "role_a_semantic_fact_audit_v1"
  }

  async auditClaim(input: {
    claim: string
    evidence: string
    citations: { source_id: string; fact_id: string }[]
  }): Promise<JudgeOutput> {
    const response = await this.gateway.generateStructured<unknown>({
      task: "role-a.semantic-fact-audit",
      system_prompt: SEMANTIC_AUDIT_SYSTEM_PROMPT,
      input,
      output_schema_id: this.outputSchemaId,
      output_schema: SEMANTIC_AUDIT_OUTPUT_SCHEMA,
      temperature: 0,
      max_tokens: 256,
      idempotency_key: semanticIdempotencyKey(input),
    })
    return normalizeJudgeOutput(response)
  }
}

const SEMANTIC_AUDIT_SYSTEM_PROMPT = [
  "你是角色A的语义事实审核器。",
  "只判断生成 claim 是否被 evidence 语义支持。",
  "允许同义改写；若 claim 否定、扩展、混入未给出的结论，判 unsupported。",
  "输出必须是严格 JSON，字段为 verdict / confidence / reason。",
].join("\n")

const SEMANTIC_AUDIT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reason"],
  properties: {
    verdict: { type: "string", enum: ["supported", "unsupported", "uncertain"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
} as const

function normalizeJudgeOutput(value: unknown): JudgeOutput {
  if (!isRecord(value)) return uncertain("语义审核模型输出不是对象")
  const verdict = value.verdict
  const confidence = value.confidence
  const reason = value.reason
  if (verdict !== "supported" && verdict !== "unsupported" && verdict !== "uncertain") {
    return uncertain("语义审核模型输出不合法：verdict 必须是 supported / unsupported / uncertain")
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return uncertain("语义审核模型输出不合法：confidence 必须是 0..1 的数字")
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    return uncertain("语义审核模型输出不合法：reason 不能为空")
  }
  return { verdict, confidence, reason }
}

function uncertain(reason: string): JudgeOutput {
  return { verdict: "uncertain", confidence: 0, reason: `语义审核模型输出不合法：${reason}` }
}

function semanticIdempotencyKey(input: {
  claim: string
  evidence: string
  citations: { source_id: string; fact_id: string }[]
}): string {
  return `semantic-audit:${contentHash(input)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
