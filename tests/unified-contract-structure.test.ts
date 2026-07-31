import { describe, expect, test } from "bun:test"

import { unifiedBoundaryReport, normalizeUnifiedHandoff } from "../src/contracts/unified"

describe("unified I/O contract package", () => {
  test("exports a boundary report for the full ABCD handoff", () => {
    const handoff = normalizeUnifiedHandoff({
      b_profile: {
        learner_id: "demo_loop_weak_001",
        level: "beginner",
        known_concepts: ["变量"],
        weak_concepts: ["循环"],
        goal: "完成成绩统计程序",
      },
      a_rag_result: { query: "循环", topK: 0, results: [] },
      workflow_events: [],
      c_artifacts: [],
    })

    expect(unifiedBoundaryReport(handoff)).toEqual({
      boundary: "A_B_C_D_FULL_HANDOFF",
      schemaVersion: "1.0",
      canonicalFields: ["profile", "retrieval", "artifacts", "workflow", "evidenceGaps"],
      evidenceGaps: [],
    })
  })
})
