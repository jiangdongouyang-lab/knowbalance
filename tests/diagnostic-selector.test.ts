import { describe, expect, test } from "bun:test"
import { selectDiagnosticItems } from "../src/knowledge/diagnostic-selector"
import { loadKnowledgeBase } from "../src/knowledge/loader"

describe("diagnostic item selector", () => {
  test("selects diagnostic questions from target, prerequisite, and weak historical sources", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const learnerMemory = {
      schema_version: "1.0",
      learner_id: "learner-diagnostic",
      mastery_by_source_id: { K006: 0.25 },
      mastered_source_ids: [],
      weak_source_ids: ["K006"],
      completed_sessions: [],
      recent_errors: [{ source_id: "K006", pattern: "branch_condition", count: 1 }],
      updated_at: "2026-08-04T00:00:00.000Z",
    }
    const selection = selectDiagnosticItems({
      knowledgeBase,
      target_source_ids: ["K018"],
      prerequisite_source_ids: ["K007", "K009"],
      learner_memory: learnerMemory,
      max_items: 5,
    })

    expect(selection.items.length).toBeGreaterThanOrEqual(3)
    expect(selection.items.length).toBeLessThanOrEqual(5)
    expect(selection.coverage.target_source_ids).toEqual(["K018"])
    expect(selection.coverage.prerequisite_source_ids).toEqual(["K007", "K009"])
    expect(selection.coverage.weak_source_ids).toEqual(["K006"])
    expect(selection.items.map((item) => item.source_id)).toEqual(expect.arrayContaining(["K018", "K007", "K009", "K006"]))
    expect(selection.items.every((item) => item.question.length > 0 && item.selection_reason.length > 0)).toBe(true)
    expect(selection.rationale.join("\n")).toContain("target")
  })

  test("does not fill a focused target to five with unrelated knowledge", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const selection = selectDiagnosticItems({
      knowledgeBase,
      target_source_ids: ["K007"],
      prerequisite_source_ids: ["K002", "K003"],
      max_items: 5,
    })

    expect(selection.items.map((item) => item.source_id)).toEqual(["K007", "K002", "K003"])
    expect(selection.items.every((item) => ["K007", "K002", "K003"].includes(item.source_id))).toBe(true)
  })

  test("uses an honest broad probe only when a custom goal cannot map to the knowledge base", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const selection = selectDiagnosticItems({
      knowledgeBase,
      target_source_ids: [],
      prerequisite_source_ids: [],
      max_items: 5,
    })

    expect(selection.items).toHaveLength(5)
    expect(selection.items.every((item) => item.selection_reason === "unmapped_goal_probe")).toBe(true)
  })
})
