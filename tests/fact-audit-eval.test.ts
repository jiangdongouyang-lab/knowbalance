import { describe, expect, test } from "bun:test"

describe("Role A fact-audit eval suite", () => {
  test("produces a stable benchmark summary from fixtures", async () => {
    const proc = Bun.spawn(["bun", "scripts/fact-audit-eval.ts"], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)

    const output = JSON.parse(stdout)
    expect(output.suite_id).toBe("role-a-fact-audit-eval-v1")
    expect(output.total_cases).toBe(60)
    expect(output.mismatches).toEqual([])
    expect(output.category_counts).toEqual({
      correct_citation: 12,
      missing_citation: 10,
      fake_citation: 10,
      wrong_citation: 8,
      external_knowledge: 8,
      semantic_mutation: 8,
      semantic_paraphrase: 4,
    })
    expect(output.metrics).toMatchObject({
      accuracy: 1,
      unsupported_leak_rate: 0,
      semantic_mutation_caught: 1,
    })
  })
})
