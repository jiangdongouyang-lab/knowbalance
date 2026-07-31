import type { RoleDSession } from "./types"

export type DiagnosisItemView = NonNullable<RoleDSession["diagnosis"]["items"]>[number]

export function diagnosisItems(diagnosis: RoleDSession["diagnosis"]): DiagnosisItemView[] {
  if (diagnosis.items !== undefined) return diagnosis.items
  if (!diagnosis.question.trim() || diagnosis.options.length < 2 || !diagnosis.answer.trim()) return []
  return [{
    id: `${diagnosis.sourceId}-${diagnosis.factId}-1`,
    sourceId: diagnosis.sourceId,
    factId: diagnosis.factId,
    concept: diagnosis.concept,
    difficulty: diagnosis.difficulty,
    question: diagnosis.question,
    options: diagnosis.options,
    answer: diagnosis.answer,
  }]
}

export function diagnosisScore(diagnosis: RoleDSession["diagnosis"], answers: Record<string, string>): { correct: number; total: number } {
  const items = diagnosisItems(diagnosis)
  return {
    total: items.length,
    correct: items.filter((item) => normalize(answers[item.id] ?? "") === normalize(item.answer)).length,
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
