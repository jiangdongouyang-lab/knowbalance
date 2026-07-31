import { describe, expect, test } from "bun:test"

const REQUIRED_GUIDE_PHRASES = [
  "角色 A Week3 联调规范",
  "B → A",
  "A → C",
  "C → A",
  "A → D",
  "frozen evidence pack",
  "content_hash",
  "semantic.verdict",
  "DeepSeek Reasoner",
  "tests/fixtures/fact-audit-eval/cases.json",
]

const REQUIRED_EXAMPLES = [
  "examples/week3/role_a_rag_request_example.json",
  "examples/week3/frozen_evidence_pack_example.json",
  "examples/week3/role_c_audit_input_example.json",
  "examples/week3/fact_audit_result_example.json",
]

describe("Role A week-three integration assets", () => {
  test("documents B/C/D integration boundaries for Role A", async () => {
    const guide = await Bun.file("docs/role_a_week3_integration_guide.md").text()
    for (const phrase of REQUIRED_GUIDE_PHRASES) {
      expect(guide).toContain(phrase)
    }
  })

  test("ships JSON examples for B->A, A->C, C->A, and A->D handoffs", async () => {
    for (const file of REQUIRED_EXAMPLES) {
      const example = await Bun.file(file).json()
      expect(example).toBeTruthy()
    }

    const ragRequest = await Bun.file("examples/week3/role_a_rag_request_example.json").json()
    expect(ragRequest.learner_profile).toMatchObject({ level: "beginner" })
    expect(ragRequest.query).toContain("循环")

    const evidencePack = await Bun.file("examples/week3/frozen_evidence_pack_example.json").json()
    expect(evidencePack.retrieval_id).toBe("RAG-W3-DEMO")
    expect(evidencePack.results[0].facts[0]).toMatchObject({ source_id: "K007", fact_id: "F001" })

    const auditInput = await Bun.file("examples/week3/role_c_audit_input_example.json").json()
    expect(auditInput.evidence_hash).toMatch(/^sha256:/)
    expect(auditInput.blocks[0].citations[0]).toMatchObject({ source_id: "K007", fact_id: "F001" })

    const auditResult = await Bun.file("examples/week3/fact_audit_result_example.json").json()
    expect(auditResult.status).toBe("pass")
    expect(auditResult.evidence).toMatchObject({ kind: "frozen_evidence_pack", retrieval_id: "RAG-W3-DEMO" })
  })
})
