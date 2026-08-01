import { describe, expect, test } from "bun:test"
import {
  buildWeek3EvaluationCases,
  runWeek3Evaluation,
} from "../src/evaluation/week3-evaluation"

describe("Week 3 evaluation framework", () => {
  test("builds exactly 60 cases across three golden learner profiles and all core knowledge items", () => {
    const cases = buildWeek3EvaluationCases()

    expect(cases).toHaveLength(60)
    expect(new Set(cases.map((item) => item.case_id)).size).toBe(60)
    expect(new Set(cases.map((item) => item.learner_profile_id))).toEqual(new Set([
      "golden-cs-basic",
      "golden-cross-major",
      "golden-zero-beginner",
    ]))
    expect(new Set(cases.flatMap((item) => item.target_source_ids))).toEqual(new Set([
      "K001", "K002", "K003", "K004", "K005", "K006", "K007", "K008", "K009",
      "K010", "K011", "K012", "K013", "K014", "K015", "K016", "K017", "K018",
    ]))
  })

  test("runs the offline evaluation and reports three competition metrics", async () => {
    const report = await runWeek3Evaluation()

    expect(report.workflow).toBe("Week3_Offline_Evaluation")
    expect(report.total_cases).toBe(60)
    expect(report.metrics.hallucination_rate).toBeLessThanOrEqual(0.05)
    expect(report.metrics.difficulty_match_accuracy).toBeGreaterThanOrEqual(0.85)
    expect(report.metrics.core_knowledge_coverage).toBeGreaterThanOrEqual(0.9)
    expect(report.case_results).toHaveLength(60)
    expect(report.case_results.every((item) => item.frozen_evidence_hash.startsWith("sha256:"))).toBe(true)
    expect(report.case_results.every((item) => item.audit_status === "pass")).toBe(true)
  })
})
