import { describe, expect, test } from "bun:test"
import {
  conservativeCodeLabPublicSafetyPatch,
  shouldUseDeterministicPublicSafetyRepair,
} from "../src/role-c-content/providers/model-backed-provider"

describe("Role C targeted public-safety repair", () => {
  test("uses deterministic compression for reference solution leaks", () => {
    expect(shouldUseDeterministicPublicSafetyRepair(["reference_solution_leak"])).toBe(true)
    expect(shouldUseDeterministicPublicSafetyRepair(["starter_equals_reference"])).toBe(true)
    expect(shouldUseDeterministicPublicSafetyRepair(["hidden_test_id_leak"])).toBe(false)
  })

  test("shortens starter, public tests and hints while preserving array identities", () => {
    const patch = conservativeCodeLabPublicSafetyPatch({
      starter_code: "def solve(values):\n    result = list(values)\n    result.append(4)\n    return result\n",
      execution_contract: { execution_mode: "function", entry_point: "solve" },
      instructions: [{ block_id: "B1" }],
      public_tests: [{ test_id: "P1" }],
      hint_ladders: [{ objective_id: "O1", hints: [{}, {}, {}] }],
      reflection_questions: ["完整写出 solve 的实现"],
    } as any)
    expect(patch.starter_code).toContain("NotImplementedError")
    expect(patch.starter_code).not.toContain("append(4)")
    expect(patch.public_test_descriptions).toHaveLength(1)
    expect(patch.public_test_expected_behaviors).toEqual(["结果应符合执行合同和题目中的输出约束。"])
    expect(patch.hint_texts).toHaveLength(1)
    expect(patch.hint_texts[0]).toHaveLength(3)
    expect(JSON.stringify(patch)).not.toContain("append(4)")
  })
})
