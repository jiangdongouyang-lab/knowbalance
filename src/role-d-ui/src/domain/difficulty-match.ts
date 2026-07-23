import type { Difficulty, RetrievalItemView } from "./types"

const LEVELS: Array<{ value: Difficulty; label: string }> = [
  { value: "beginner", label: "入门" },
  { value: "basic", label: "基础" },
  { value: "intermediate", label: "进阶" },
  { value: "integrated", label: "综合" },
]

export interface DifficultyMatchPoint {
  sourceId: string
  title: string
  difficulty: Difficulty
  difficultyIndex: number
  difficultyLabel: string
  score: number
  gap: number
  relation: string
  role: "当前适配" | "相邻资源" | "远期目标"
  reason: string
}

export interface DifficultyMatchSeries {
  levels: typeof LEVELS
  learnerLevel: { value: Difficulty; index: number; label: string }
  points: DifficultyMatchPoint[]
  summary: {
    sameLevel: number
    gentleStretch: number
    advanced: number
  }
}

export function buildDifficultyMatchSeries(learnerLevel: Difficulty, items: RetrievalItemView[]): DifficultyMatchSeries {
  const learnerIndex = levelIndex(learnerLevel)
  const points = items.map((item) => {
    const difficultyIndex = levelIndex(item.difficulty)
    const gap = difficultyIndex - learnerIndex
    return {
      sourceId: item.sourceId,
      title: item.title,
      difficulty: item.difficulty,
      difficultyIndex,
      difficultyLabel: LEVELS[difficultyIndex].label,
      score: item.score,
      gap,
      relation: relationLabel(gap),
      role: resourceRole(gap),
      reason: item.reason,
    }
  })

  return {
    levels: LEVELS,
    learnerLevel: { value: learnerLevel, index: learnerIndex, label: LEVELS[learnerIndex].label },
    points,
    summary: {
      sameLevel: points.filter((point) => point.gap === 0).length,
      gentleStretch: points.filter((point) => Math.abs(point.gap) === 1).length,
      advanced: points.filter((point) => Math.abs(point.gap) >= 2).length,
    },
  }
}

function levelIndex(level: Difficulty): number {
  return LEVELS.findIndex((item) => item.value === level)
}

function relationLabel(gap: number): string {
  if (gap === 0) return "同级"
  return `${gap > 0 ? "高" : "低"} ${Math.abs(gap)} 级`
}

function resourceRole(gap: number): DifficultyMatchPoint["role"] {
  if (gap === 0) return "当前适配"
  if (Math.abs(gap) === 1) return "相邻资源"
  return "远期目标"
}
