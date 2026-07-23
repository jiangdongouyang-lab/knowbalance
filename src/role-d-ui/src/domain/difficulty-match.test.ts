import { describe, expect, test } from "vitest"
import type { RetrievalItemView } from "./types"
import { buildDifficultyMatchSeries } from "./difficulty-match"

function item(sourceId: string, difficulty: RetrievalItemView["difficulty"], score: number): RetrievalItemView {
  return {
    sourceId,
    title: sourceId,
    difficulty,
    score,
    reason: "测试推荐",
    snippet: "",
    file: `${sourceId}.md`,
    facts: [],
    examples: [],
    practiceTasks: [],
    quizItems: [],
    trace: {
      matchedKeywords: [],
      matchedFields: [],
      difficultyMatch: true,
      scoreBreakdown: { keyword: 0, title: 0, facts: 0, practiceTasks: 0, difficulty: 0, bonus: 0 },
    },
  }
}

describe("buildDifficultyMatchSeries", () => {
  test("compares real resource difficulty against the B profile level without inventing percentages", () => {
    const series = buildDifficultyMatchSeries("basic", [
      item("K002", "beginner", 20),
      item("K009", "basic", 35),
      item("K018", "integrated", 18),
    ])

    expect(series.learnerLevel).toEqual({ value: "basic", index: 1, label: "基础" })
    expect(series.points.map((point) => ({ sourceId: point.sourceId, gap: point.gap, relation: point.relation, role: point.role, score: point.score }))).toEqual([
      { sourceId: "K002", gap: -1, relation: "低 1 级", role: "相邻资源", score: 20 },
      { sourceId: "K009", gap: 0, relation: "同级", role: "当前适配", score: 35 },
      { sourceId: "K018", gap: 2, relation: "高 2 级", role: "远期目标", score: 18 },
    ])
    expect(series.summary).toEqual({ sameLevel: 1, gentleStretch: 1, advanced: 1 })
  })

  test("returns an explicit empty series when A has no retrieved resources", () => {
    const series = buildDifficultyMatchSeries("beginner", [])
    expect(series.points).toEqual([])
    expect(series.summary).toEqual({ sameLevel: 0, gentleStretch: 0, advanced: 0 })
  })

  test("changes the relation when B reports a different learner level", () => {
    const resources = [item("K009", "basic", 35), item("K018", "integrated", 18)]

    expect(buildDifficultyMatchSeries("beginner", resources).points.map((point) => point.relation)).toEqual(["高 1 级", "高 3 级"])
    expect(buildDifficultyMatchSeries("intermediate", resources).points.map((point) => point.relation)).toEqual(["低 1 级", "高 1 级"])
  })
})
