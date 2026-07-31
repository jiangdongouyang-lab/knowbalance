import { describe, expect, test } from "bun:test"
import { LlmSemanticAuditJudge } from "../src/fact-audit/semantic-llm-judge"
import type { ModelGateway } from "../src/role-c-content/contracts/model-gateway"

class FixtureGateway implements ModelGateway {
  readonly model_id = "fixture-judge"
  readonly model_config_hash = "fixture-judge-hash"
  lastRequest: Parameters<ModelGateway["generateStructured"]>[0] | null = null

  constructor(private readonly response: unknown) {}

  async generateStructured<T>(request: Parameters<ModelGateway["generateStructured"]>[0]): Promise<T> {
    this.lastRequest = request
    return this.response as T
  }
}

describe("LLM semantic audit judge", () => {
  test("maps structured LLM supported verdict into SemanticAuditPort output", async () => {
    const gateway = new FixtureGateway({ verdict: "supported", confidence: 0.93, reason: "claim is entailed" })
    const judge = new LlmSemanticAuditJudge(gateway)

    const result = await judge.auditClaim({
      claim: "for 循环常用于遍历序列中的元素。",
      evidence: "for 循环常用于遍历序列中的元素。",
      citations: [{ source_id: "K007", fact_id: "F001" }],
    })

    expect(result).toEqual({ verdict: "supported", confidence: 0.93, reason: "claim is entailed" })
    expect(gateway.lastRequest).toMatchObject({
      task: "role-a.semantic-fact-audit",
      output_schema_id: "role_a_semantic_fact_audit_v1",
      temperature: 0,
    })
    expect(JSON.stringify(gateway.lastRequest?.input)).toContain("K007")
    expect(gateway.lastRequest?.idempotency_key).toMatch(/^semantic-audit:sha256:[a-f0-9]{64}$/)
    expect(gateway.lastRequest?.idempotency_key).not.toContain("for 循环")
  })

  test("normalizes invalid LLM judge output to uncertain instead of passing content", async () => {
    const gateway = new FixtureGateway({ verdict: "pass", confidence: 2, reason: "" })
    const judge = new LlmSemanticAuditJudge(gateway)

    const result = await judge.auditClaim({
      claim: "for 循环不适合遍历序列。",
      evidence: "for 循环常用于遍历序列中的元素。",
      citations: [{ source_id: "K007", fact_id: "F001" }],
    })

    expect(result.verdict).toBe("uncertain")
    expect(result.confidence).toBe(0)
    expect(result.reason).toContain("语义审核模型输出不合法")
  })
})
