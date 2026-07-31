import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { retrieveKnowledge } from "../src/rag/retriever"
import { contentHash } from "../src/role-c-content/contracts/common"
import { adaptRagResult } from "../src/role-c-content/contracts/evidence-pack"

const REQUIRED_ACCEPTANCE_PHRASES = [
  "角色 A Week 2 验收报告",
  "事实审核",
  "引用门禁 MVP",
  "知识溯源",
  "blockId",
  "text",
  "citations",
  "pass",
  "revise",
  "reject",
  "scripts/week2-role-a-demo.ts",
  "scripts/audit-role-c-json.ts",
  "role_c_artifact_missing_citation.json",
  "role_c_artifact_fake_citation.json",
  "MISSING_BLOCKS",
  "当前限制",
]

describe("Role A week-two fact-audit assets", () => {
  test("documents Role A week-two acceptance evidence and C handoff contract", async () => {
    const report = await Bun.file("docs/week2_role_a_acceptance.md").text()

    for (const phrase of REQUIRED_ACCEPTANCE_PHRASES) {
      expect(report).toContain(phrase)
    }
  })

  test("ships a CLI that audits a Role C JSON file", async () => {
    const script = await Bun.file("scripts/audit-role-c-json.ts").text()

    expect(script).toContain("adaptRoleCBlocksToFactAuditInput")
    expect(script).toContain("auditGeneratedContent")
    expect(script).toContain("retrieveKnowledge")
  })

  test("audits the example Role C artifact JSON from disk", async () => {
    const proc = Bun.spawn(["bun", "scripts/audit-role-c-json.ts", "examples/role_c_artifact_example.json"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)

    const output = JSON.parse(stdout)
    expect(output.workflow).toBe("Audit_RoleC_JSON_File")
    expect(output.input_file).toBe("examples/role_c_artifact_example.json")
    expect(output.audit.status).toBe("pass")
    expect(output.audit.checkedClaims[0]).toMatchObject({ verdict: "supported" })
  })

  test("audits a Role C JSON file against a frozen evidence pack instead of re-retrieving", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowbalance-audit-cli-"))
    const ragResult = await retrieveKnowledge({ query: "初学者，不会循环，需要完成成绩统计程序", learnerLevel: "beginner", topK: 3 })
    const evidencePack = adaptRagResult(ragResult, {
      kb_version: "python-basic@0.2.0",
      rag_version: "rule-rag@0.1",
      retrieval_id: "RAG-CLI-FROZEN",
    })
    const evidenceFile = join(root, "evidence-pack.json")
    await writeFile(evidenceFile, JSON.stringify(evidencePack), "utf8")

    const proc = Bun.spawn([
      "bun",
      "scripts/audit-role-c-json.ts",
      "examples/role_c_artifact_example.json",
      "--evidence",
      evidenceFile,
      "--expected-evidence-hash",
      contentHash(evidencePack),
    ], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.audit.status).toBe("pass")
    expect(output.evidence_source).toEqual({ kind: "frozen_evidence_pack", retrieval_id: "RAG-CLI-FROZEN" })
    expect(output.audit.evidence.content_hash).toBe(contentHash(evidencePack))
  })

  test("audits revise and reject Role C example artifacts from disk", async () => {
    const cases = [
      ["examples/role_c_artifact_missing_citation.json", "revise"],
      ["examples/role_c_artifact_fake_citation.json", "reject"],
    ] as const

    for (const [file, expectedStatus] of cases) {
      const proc = Bun.spawn(["bun", "scripts/audit-role-c-json.ts", file], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

      expect(stderr).toBe("")
      expect(exitCode).toBe(0)

      const output = JSON.parse(stdout)
      expect(output.workflow).toBe("Audit_RoleC_JSON_File")
      expect(output.input_file).toBe(file)
      expect(output.audit.status).toBe(expectedStatus)
    }
  })

  test("returns stable validation errors for malformed Role C JSON", async () => {
    const proc = Bun.spawn(["bun", "scripts/audit-role-c-json.ts", "examples/role_c_artifact_invalid_missing_blocks.json"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

    expect(stderr).toBe("")
    expect(exitCode).toBe(2)

    const output = JSON.parse(stdout)
    expect(output.workflow).toBe("Audit_RoleC_JSON_File")
    expect(output.ok).toBe(false)
    expect(output.error.code).toBe("MISSING_BLOCKS")
  })
})
