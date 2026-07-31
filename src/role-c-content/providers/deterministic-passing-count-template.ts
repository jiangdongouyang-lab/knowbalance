import type { ExecutionContract } from "../contracts/artifacts"

export const PASSING_COUNT_TARGET_SOURCE_IDS = [
  "K007",
  "K009",
  "K006",
] as const

export const PASSING_COUNT_STARTER_CODE = [
  "def count_passing_scores(scores, pass_mark):",
  "    count = 0",
  "    for score in scores:",
  "        # TODO: 只统计达到 pass_mark 的成绩",
  "        pass",
  "    return count",
].join("\n")

export const PASSING_COUNT_REFERENCE_SOLUTION = [
  "def count_passing_scores(scores, pass_mark):",
  "    count = 0",
  "    for score in scores:",
  "        if score >= pass_mark:",
  "            count += 1",
  "    return count",
].join("\n")

export interface PassingCountCase {
  readonly id: "ALL_ITEMS" | "LAST_ITEM" | "MIXED_LIST"
    | "BOUNDARY" | "CUSTOM_MARK"
  readonly input: {
    readonly args: readonly [readonly number[], number]
  }
  readonly expected: number
  readonly objective_index: 0 | 1 | 2
}

export const PASSING_COUNT_HIDDEN_CASES: readonly PassingCountCase[] = [
  {
    id: "ALL_ITEMS",
    input: { args: [[20, 85, 90, 10, 70], 60] },
    expected: 3,
    objective_index: 0,
  },
  {
    id: "LAST_ITEM",
    input: { args: [[80, 95, 40, 75], 70] },
    expected: 3,
    objective_index: 0,
  },
  {
    id: "MIXED_LIST",
    input: { args: [[45, 72], 60] },
    expected: 1,
    objective_index: 1,
  },
  {
    id: "BOUNDARY",
    input: { args: [[59.9, 60, 60.1], 60] },
    expected: 2,
    objective_index: 2,
  },
  {
    id: "CUSTOM_MARK",
    input: { args: [[70, 80, 90], 85] },
    expected: 1,
    objective_index: 2,
  },
] as const

export function passingCountExecutionContract(): ExecutionContract {
  return {
    language: "python",
    execution_mode: "function",
    entry_point: "count_passing_scores",
    allowed_imports: [],
    input_contract: {
      type: "args[list[number], number]",
      constraints: [
        "scores is a list of numbers",
        "pass_mark is a finite number",
      ],
    },
    output_contract: {
      type: "integer",
      constraints: ["0 <= result <= len(scores)"],
    },
    resource_limits: {
      timeout_ms: 2000,
      memory_mb: 128,
      max_output_bytes: 20000,
    },
  }
}

export function isPassingCountTargetSet(
  targetSourceIds: readonly string[],
): boolean {
  return targetSourceIds.length === PASSING_COUNT_TARGET_SOURCE_IDS.length
    && targetSourceIds.every(
      (sourceId, index) =>
        sourceId === PASSING_COUNT_TARGET_SOURCE_IDS[index],
    )
}
