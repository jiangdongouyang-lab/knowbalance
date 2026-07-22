import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

describe("role C full public integration demo", () => {
  test("runs profile → evidence → content → assessment → grade → mastery without public secrets", async () => {
    const child = Bun.spawn([process.execPath, "scripts/role-c-full-demo.ts"], {
      cwd: resolve("."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const output = JSON.parse(stdout)
    expect(output.status).toBe("ready")
    expect(output.public_artifacts.grade_result.payload.score_frozen).toBe(true)
    expect(output.learning_evidence_to_b.length).toBe(5)
    expect(output.mastery_after_update.states).toHaveLength(3)
    expect(output.secure_refs).toHaveLength(2)
    for (const forbidden of ["answer_spec", "correct_option_id", "reference_solution", "hidden_tests", "option_order_seed"]) {
      expect(stdout).not.toContain(`"${forbidden}"`)
    }
  })
})
