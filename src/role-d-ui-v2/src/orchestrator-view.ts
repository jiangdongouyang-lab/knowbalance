import type { SubmissionAnswer } from "./orchestrator-client"

export type OrchestratorPage = "goal" | "diagnosis" | "path" | "lesson" | "assessment" | "feedback"

export function pageForSession(session: any, options?: { feedbackDismissed?: boolean }): OrchestratorPage {
  const hasPlanCheckpoint = Boolean(session?.profile && session?.formal_path && session?.current_path_node)
  if (session?.feedback && !options?.feedbackDismissed) return "feedback"
  if (hasPlanCheckpoint) return "path"
  if (session?.status === "blocked" || session?.status === "failed") return "feedback"
  if (session?.waiting_for?.type === "diagnosis_answers" || session?.current_stage === "objective_diagnosis") return "diagnosis"
  if (session?.current_stage === "assessment") {
    if (session?.learning_resources?.concept_lesson || session?.learning_resources?.code_lab) return "lesson"
    return "assessment"
  }
  if (session?.feedback) return "feedback"
  if (session?.status === "completed" || session?.current_stage === "completed") return "feedback"
  if (session?.profile || session?.formal_path) return "path"
  return "goal"
}

export function pathNodeTitle(node: any, ragItems: Array<{ source_id: string; title?: string }>): string {
  const target = node?.target_source_ids?.[0]
  if (!target) return node?.goal ?? "未命名节点"
  const title = ragItems.find((item) => item.source_id === target)?.title
  return title || node?.goal || "未命名节点"
}

export interface PathChainEntry {
  node_id: string
  source_id: string
  title: string
  status: "completed" | "in_progress" | "pending" | "blocked" | "reference_mastered" | "reference_pending"
}

/**
 * 展开展示链：按 B 节点顺序，在每个节点前插入其先修中尚未出现过的
 * source（来自 B 公开的 prerequisite_source_ids）。先修若与画像
 * known_concepts 匹配则标 reference_mastered（已掌握），否则 reference_pending（先修）。
 * 只做展示展开，不改变 B 的节点顺序与学习决策。
 */
export function pathChainView(
  nodes: Array<{ node_id?: string; target_source_ids?: string[]; prerequisite_source_ids?: string[]; status?: string }>,
  ragItems: Array<{ source_id: string; title?: string }>,
  knownConcepts: string[],
): PathChainEntry[] {
  const seen = new Set<string>()
  const chain: PathChainEntry[] = []
  const mastered = new Set(knownConcepts.map((concept) => concept.trim()))
  const titleFor = (sourceId: string): string => ragItems.find((item) => item.source_id === sourceId)?.title ?? sourceId

  for (const node of nodes) {
    for (const prereq of node.prerequisite_source_ids ?? []) {
      if (seen.has(prereq)) continue
      seen.add(prereq)
      chain.push({
        node_id: `PREREQ-${prereq}`,
        source_id: prereq,
        title: titleFor(prereq),
        status: mastered.has(titleFor(prereq)) ? "reference_mastered" : "reference_pending",
      })
    }
    const target = node.target_source_ids?.[0]
    if (target && !seen.has(target)) {
      seen.add(target)
      chain.push({
        node_id: node.node_id ?? `NODE-${target}`,
        source_id: target,
        title: titleFor(target),
        status: (node.status === "in_progress" ? "in_progress" : node.status === "completed" ? "completed" : node.status === "blocked" ? "blocked" : "pending") as PathChainEntry["status"],
      })
    }
  }
  return chain
}

export interface AssessmentItemFeedbackView {
  item_id: string
  prompt: string
  modality: string
  max_score: number
  raw_score: number
  correct: boolean | null
  your_answer_text: string
  feedback_message?: string
  next_step?: string
}

export function assessmentFeedbackView(
  items: Array<{ item_id: string; modality?: string; prompt?: string; max_score?: number; options?: Array<{ option_id: string; text?: string }> }>,
  gradeResult: any,
  yourAnswers: Array<{ item_id: string; selected_option_id?: string | null; text_response?: string | null; code_response?: string | null }>,
): AssessmentItemFeedbackView[] {
  const results = new Map<string, any>((gradeResult?.item_results ?? []).map((r: any) => [r.item_id, r]))
  const itemFeedback = new Map<string, any>((gradeResult?.feedback?.item_feedback ?? []).map((f: any) => [f.item_id, f]))
  const yours = new Map<string, any>((yourAnswers ?? []).map((a) => [a.item_id, a]))
  return (items ?? []).map((item) => {
    const result = results.get(item.item_id)
    const guidance = itemFeedback.get(item.item_id)
    const your = yours.get(item.item_id)
    let yourAnswerText = ""
    if (your) {
      if (your.selected_option_id) {
        yourAnswerText = item.options?.find((o) => o.option_id === your.selected_option_id)?.text ?? your.selected_option_id
      } else if (your.code_response) {
        yourAnswerText = your.code_response.length > 80 ? `${your.code_response.slice(0, 77)}…` : your.code_response
      } else if (your.text_response) {
        yourAnswerText = your.text_response.length > 80 ? `${your.text_response.slice(0, 77)}…` : your.text_response
      } else {
        yourAnswerText = "未作答"
      }
    }
    return {
      item_id: item.item_id,
      prompt: item.prompt ?? item.item_id,
      modality: item.modality ?? "unknown",
      max_score: item.max_score ?? result?.max_score ?? 0,
      raw_score: result?.raw_score ?? 0,
      correct: result ? result.feedback_code === "correct" || result.raw_score >= (result.max_score || 1) : null,
      your_answer_text: your ? yourAnswerText : "未作答",
      feedback_message: guidance?.message,
      next_step: guidance?.next_step,
    }
  })
}

export function abilityRadarView(profile: any): { status: "pending" | "verified"; dimensions: Array<{ label: string; value: number }> } {
  const dimensions = Array.isArray(profile?.ability_dimensions)
    ? profile.ability_dimensions.filter((item: any) => typeof item?.label === "string" && Number.isFinite(item?.value) && item.value >= 0 && item.value <= 1).map((item: any) => ({ label: item.label, value: item.value }))
    : []
  return dimensions.length >= 3 ? { status: "verified", dimensions } : { status: "pending", dimensions: [] }
}

export function initialGoalSelection(): { mode: "catalog"; selectedNodeId: string; customGoal: string } {
  return { mode: "catalog", selectedNodeId: "", customGoal: "" }
}

export function blockedSessionAction(session: any): { canRetry: boolean; label: string } {
  const hasGenerationCheckpoint = Boolean(session?.profile && session?.formal_path && session?.current_path_node)
  return hasGenerationCheckpoint
    ? { canRetry: true, label: "原样重试 C 资源生成" }
    : { canRetry: false, label: "重新诊断" }
}

export function answersToSubmission(items: any[], answers: Record<string, string>): SubmissionAnswer[] {
  return items.map((item) => {
    const answer = answers[item.item_id] ?? ""
    if (item.modality === "mcq" || item.modality === "true_false") {
      return { item_id: item.item_id, selected_option_id: answer, hint_level_used: 0 }
    }
    if (item.modality === "code") {
      return { item_id: item.item_id, code_response: answer, hint_level_used: 0 }
    }
    return { item_id: item.item_id, text_response: answer, hint_level_used: 0 }
  })
}

export function diagnosisComplete(session: any, answers: Record<string, string>): boolean {
  const items = session?.waiting_for?.type === "diagnosis_answers" ? session.waiting_for.items ?? [] : []
  return items.length > 0 && items.every((item: any) => (answers[item.item_id] ?? "").trim().length > 0)
}

export function assessmentComplete(session: any, answers: Record<string, string>): boolean {
  const items = session?.assessment?.payload?.items ?? []
  return items.length > 0 && items.every((item: any) => (answers[item.item_id] ?? "").trim().length > 0)
}
