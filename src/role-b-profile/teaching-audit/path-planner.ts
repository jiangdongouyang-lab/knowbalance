// 输入: PlanRecoveryPathInput（学习者画像 + 审核结果 + 知识库 + 可选当前路径）
// 输出: PlanRecoveryPathResult（新 LearningPathNode + 是否需要A重新检索）
// 作用: B 角色路径规划——当教学审核驳回内容时，给出替代学习路径
// 规则:
//   1. 难度不匹配 → 降档选择目标知识点（从弱点和目标相关中筛选更低难度）
//   2. 前置知识缺失 → 先补前置知识点作为新路径目标
//   3. 薄弱点/目标问题 → 在当前难度档内替换知识点
// 这是 C 在收到 "replan_path" 动作后调用的接口
import type { KnowledgeBase, KnowledgeDifficulty, KnowledgeItem } from "../../knowledge/types"
import type { LearnerProfile } from "../types"
import type { TeachingAuditResult } from "./types"
import type { PlanRecoveryPathInput, PlanRecoveryPathResult } from "./types"
import type { LearningPathNode, LearningObjective, AssessmentBlueprint } from "../../role-c-content/contracts/profile-adapter"
import { canonicalizeConcept } from "../concept-canonicalizer"

const LEVEL_ORDER: KnowledgeDifficulty[] = ["beginner", "basic", "intermediate", "integrated"]

export function planRecoveryPath(input: PlanRecoveryPathInput): PlanRecoveryPathResult {
  const { learnerProfile, knowledgeBase, auditResult, currentPathNode } = input

  const failedDims = new Set(auditResult.failedDimensions)
  const currentTargetIds = new Set(currentPathNode?.target_source_ids ?? [])
  const currentGoal = currentPathNode?.goal ?? learnerProfile.goal

  // 情况 1：前置知识缺失 → 先补缺失的前置知识点（优先级高于难度，因为难度不匹配可能只是前置缺失的级联效应）
  if (failedDims.has("prerequisite_coverage") && auditResult.missingPrerequisiteSourceIds.length > 0) {
    return planPrerequisitePath(learnerProfile, knowledgeBase, auditResult.missingPrerequisiteSourceIds, currentPathNode)
  }

  // 情况 2：难度不匹配 → 降档选择更简单的目标
  if (failedDims.has("difficulty_alignment") && auditResult.recommendedLevel) {
    return planLowerDifficultyPath(learnerProfile, knowledgeBase, auditResult.recommendedLevel, currentGoal, currentTargetIds)
  }

  // 情况 3：薄弱点或目标对齐问题 → 在当前难度档内替换
  return planAdjustedContentPath(learnerProfile, knowledgeBase, currentGoal, currentTargetIds, auditResult)
}

function planLowerDifficultyPath(
  profile: LearnerProfile,
  kb: KnowledgeBase,
  targetLevel: KnowledgeDifficulty,
  goal: string,
  excludeIds: Set<string>,
): PlanRecoveryPathResult {
  const targetIdx = LEVEL_ORDER.indexOf(targetLevel)
  // 用于学习者水平及以下的知识点
  const levelItems = kb.items.filter((item) => {
    if (excludeIds.has(item.sourceId)) return false
    const itemIdx = LEVEL_ORDER.indexOf(item.difficulty)
    return itemIdx <= targetIdx
  })

  const selected = selectBestTargets(levelItems, profile, kb, goal, 3)
  if (selected.length === 0) {
    // 回退：选任意同难度非排除项
    const fallback = levelItems.slice(0, Math.min(3, levelItems.length))
    return buildPathResult(fallback, goal, `难度不匹配，推荐降至 ${targetLevel} 级别重新学习。已重新选择 ${fallback.length} 个目标知识点。`, true)
  }

  return buildPathResult(selected, goal, `难度不匹配，推荐降至 ${targetLevel} 级别重新学习。新路径包含 ${selected.map((i) => i.title).join("、")}。`, true)
}

function planPrerequisitePath(
  profile: LearnerProfile,
  kb: KnowledgeBase,
  missingPrerequisiteIds: string[],
  currentPathNode?: PlanRecoveryPathInput["currentPathNode"],
): PlanRecoveryPathResult {
  const prereqItems = missingPrerequisiteIds
    .map((sid) => kb.items.find((item) => item.sourceId === sid))
    .filter((item): item is KnowledgeItem => item != null)

  if (prereqItems.length === 0) {
    // 知识库中找不到这些前置知识点（未知引用已经被标记为 unknownPrerequisiteRefs）
    return buildPathResult(
      [],
      currentPathNode?.goal ?? profile.goal,
      "缺失的前置知识点在知识库中不存在，无法自动规划路径。请人工检查知识库完整性。",
      currentPathNode !== undefined,
    )
  }

  // 前置知识点作为新路径目标，要学的知识点先放一放
  const allTargets = [...prereqItems]
  const rationale = `前置知识缺失，先学习 ${prereqItems.map((i) => `${i.sourceId} ${i.title}`).join("、")}。原目标知识点需在掌握前置知识后学习。`

  return buildPathResult(allTargets, profile.goal, rationale, currentPathNode !== undefined)
}

function planAdjustedContentPath(
  profile: LearnerProfile,
  kb: KnowledgeBase,
  goal: string,
  excludeIds: Set<string>,
  auditResult: TeachingAuditResult,
): PlanRecoveryPathResult {
  const profileLevel = LEVEL_ORDER.indexOf(profile.level)
  const levelItems = kb.items.filter((item) => {
    if (excludeIds.has(item.sourceId)) return false
    const itemIdx = LEVEL_ORDER.indexOf(item.difficulty)
    return itemIdx <= profileLevel + 1
  })

  const selected = selectBestTargets(levelItems, profile, kb, goal, 3)
  if (selected.length === 0) {
    const fallback = levelItems.slice(0, Math.min(3, levelItems.length))
    return buildPathResult(
      fallback,
      goal,
      `薄弱点/目标对齐问题：原教学内容不匹配，已替换为 ${fallback.map((i) => i.title).join("、")}。`,
      fallback.length > 0,
    )
  }

  return buildPathResult(
    selected,
    goal,
    `薄弱点/目标对齐问题：原教学内容已替换为 ${selected.map((i) => i.title).join("、")}，覆盖学习者薄弱点并匹配学习目标。`,
    true,
  )
}

/** 从候选知识点中选择最佳目标：优先覆盖薄弱点，其次关联目标 */
function selectBestTargets(
  candidates: KnowledgeItem[],
  profile: LearnerProfile,
  kb: KnowledgeBase,
  goal: string,
  maxCount: number,
): KnowledgeItem[] {
  if (candidates.length === 0) return []

  // 打分：薄弱点覆盖 +4，目标关联 +2，难度接近 +1
  const goalLower = goal.toLowerCase()
  const weakMapped = new Set(
    profile.weak_concepts.flatMap((raw) => {
      const mapped = canonicalizeConcept(raw, kb)
      return mapped.sourceIds
    }),
  )

  const scored = candidates.map((item) => {
    let score = 0
    // 薄弱点覆盖
    if (weakMapped.has(item.sourceId)) score += 4
    // 目标关联
    const kwText = [item.title, ...(item.keywords ?? [])].join(" ").toLowerCase()
    const goalWords = goalLower.split(/[\s，,、。！？；：""''（）]+/).filter((w) => w.length >= 2)
    if (goalWords.some((w) => kwText.includes(w))) score += 2
    // 难度接近学习者水平
    const itemIdx = LEVEL_ORDER.indexOf(item.difficulty)
    const profileIdx = LEVEL_ORDER.indexOf(profile.level)
    if (itemIdx === profileIdx || itemIdx === profileIdx + 1) score += 1
    return { item, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, maxCount).map((s) => s.item)
}

function buildPathResult(
  items: KnowledgeItem[],
  goal: string,
  rationale: string,
  requiresNewRag: boolean,
): PlanRecoveryPathResult {
  const targetSourceIds = items.map((item) => item.sourceId)
  const nodeId = `RECOVERY-${targetSourceIds.join("-")}-${Date.now()}`

  const objectives: LearningObjective[] = items.map((item, index) => ({
    objective_id: `RO${index + 1}`,
    source_id: item.sourceId,
    required_fact_ids: [],
    observable_behavior: index === 0 ? "recognize" as const : index === 1 ? "apply" as const : "create" as const,
    importance: "core" as const,
  }))

  const blueprint: AssessmentBlueprint = items.length >= 3
    ? { tier_1_count: 2, tier_2_count: 2, tier_3_count: 1, required_modalities: ["mcq", "trace", "code"] }
    : items.length === 2
      ? { tier_1_count: 1, tier_2_count: 1, tier_3_count: 0, required_modalities: ["mcq", "trace"] }
      : { tier_1_count: 1, tier_2_count: 0, tier_3_count: 0, required_modalities: ["mcq"] }

  const prerequisiteSourceIds = items
    .flatMap((item) => item.prerequisites ?? [])
    .filter((pid) => !targetSourceIds.includes(pid))
    .filter((pid, idx, arr) => arr.indexOf(pid) === idx)

  const pathNode: LearningPathNode = {
    schema_version: "1.0",
    node_id: nodeId,
    target_source_ids: targetSourceIds,
    prerequisite_source_ids: prerequisiteSourceIds,
    goal,
    objectives,
    assessment_blueprint: blueprint,
  }

  return { pathNode, rationale, requiresNewRag }
}
