import type { LearningArtifactView } from "./types"

type AssessmentItem = NonNullable<LearningArtifactView["items"]>[number]

export function displayedAssessmentAnswer(item: AssessmentItem, answers: Record<string, string>): string {
  return answers[item.id] ?? (item.modality === "code" ? item.starterCode ?? "" : "")
}

export function isAssessmentAnswerValid(item: AssessmentItem, answer: string): boolean {
  if (item.modality === "mcq" || item.modality === "true_false") {
    const validOptions = item.optionIds?.length ? item.optionIds : item.options
    return validOptions.includes(answer)
  }
  return typeof answer === "string"
}

export function isAssessmentItemComplete(item: AssessmentItem, answers: Record<string, string>): boolean {
  const answer = answers[item.id]
  if (item.modality === "mcq" || item.modality === "true_false") return Boolean(answer) && isAssessmentAnswerValid(item, answer)
  if (!answer?.trim()) return false
  if (item.modality === "code") return answer.trim() !== (item.starterCode ?? "").trim()
  return true
}

export function isAssessmentComplete(items: AssessmentItem[], answers: Record<string, string>): boolean {
  return items.length > 0 && items.every((item) => isAssessmentItemComplete(item, answers))
}
