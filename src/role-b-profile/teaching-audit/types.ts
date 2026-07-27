// 输入: 无（纯类型定义）
// 输出: 教学审核与仲裁机制的完整数据契约
// 作用: B 角色 Week2 主线——教学审核（审核 C 生成内容的教学规范性）+ 仲裁（合并 A 事实审核与 B 教学审核）
// 与 A 的事实审核互补：A 审"引用了没"，B 审"教得对不对"
import type { KnowledgeBase, KnowledgeDifficulty } from "../../knowledge/types"
import type { LearnerProfile } from "../types"

// ── 教学审核维度 ──

export type TeachingAuditDimension =
  | "difficulty_alignment"   // 内容难度是否匹配学习者水平
  | "prerequisite_coverage"  // 前置知识是否已被学习者掌握
  | "weak_concept_coverage"  // 薄弱点是否被教学内容覆盖
  | "goal_alignment"         // 教学内容是否服务学习目标
  | "scaffold_appropriateness" // 脚手架水平是否合适

export type TeachingAuditVerdict =
  | "aligned"        // 教学上合理
  | "misaligned"     // 不匹配（难度/前置/薄弱点）
  | "incomplete"     // 覆盖不足
  | "overscaffolded" // 过度简化（学习者水平高于内容）

export type TeachingAuditStatus = "pass" | "revise" | "reject"

// ── 教学审核输入 ──

export interface TeachingAuditInput {
  artifactId: string
  learnerProfile: LearnerProfile
  knowledgeBase: KnowledgeBase
  // C 生成内容中引用的知识点 source_id 列表（从 citations 提取）
  citedSourceIds: string[]
  // C 生成内容的目标知识点（默认为 citedSourceIds 去重）
  targetSourceIds?: string[]
  // 可选：教学内容的文本摘要，用于目标对齐判断
  contentSummary?: string
}

// ── 审核维度结果 ──

export interface DifficultyCheck {
  dimension: "difficulty_alignment"
  verdict: TeachingAuditVerdict
  learnerLevel: KnowledgeDifficulty
  contentMaxDifficulty: KnowledgeDifficulty | null
  reason: string
}

export interface PrerequisiteCheck {
  dimension: "prerequisite_coverage"
  verdict: TeachingAuditVerdict
  checkedConcepts: Array<{
    sourceId: string
    title: string
    prerequisites: string[]
    missingPrerequisites: string[]
  }>
  reason: string
}

export interface WeakConceptCheck {
  dimension: "weak_concept_coverage"
  verdict: TeachingAuditVerdict
  learnerWeakConcepts: string[]
  coveredWeakConcepts: string[]
  uncoveredWeakConcepts: string[]
  reason: string
}

export interface GoalCheck {
  dimension: "goal_alignment"
  verdict: TeachingAuditVerdict
  learnerGoal: string
  reason: string
}

// ── 教学审核输出 ──

export interface TeachingAuditResult {
  artifactId: string
  learnerId: string
  status: TeachingAuditStatus
  checks: {
    difficulty: DifficultyCheck
    prerequisite: PrerequisiteCheck
    weakConcept: WeakConceptCheck
    goal: GoalCheck
  }
  summary: string
  revisionHints: string[]
}

// ── 仲裁机制 ──

export interface ArbitrationInput {
  artifactId: string
  factAuditStatus: "pass" | "revise" | "reject"
  teachingAuditStatus: TeachingAuditStatus
  revisionRound: number  // 当前是第几轮修订（从 0 开始，首轮为 0）
}

export type ArbitrationDecision = "pass" | "revise" | "reject"

export interface ArbitrationResult {
  artifactId: string
  decision: ArbitrationDecision
  revisionRound: number
  maxRevisionRounds: number
  canRevise: boolean
  reason: string
  // 分别来自两个审核的建议
  factAuditNotes: string[]
  teachingAuditNotes: string[]
}
