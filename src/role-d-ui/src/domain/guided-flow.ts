import type { GuidedStage } from "./types"

export type { GuidedStage } from "./types"

export const STAGES: ReadonlyArray<{ id: GuidedStage; label: string; shortLabel: string }> = [
  { id: "onboarding", label: "学习建档", shortLabel: "建档" },
  { id: "diagnosis", label: "客观诊断", shortLabel: "诊断" },
  { id: "profile", label: "学情画像", shortLabel: "画像" },
  { id: "plan", label: "定制方案", shortLabel: "方案" },
  { id: "learning", label: "学习实操", shortLabel: "学习" },
  { id: "feedback", label: "反馈调整", shortLabel: "反馈" },
]

export function advanceStage(stage: GuidedStage): GuidedStage {
  return moveStage(stage, 1)
}

export function retreatStage(stage: GuidedStage): GuidedStage {
  return moveStage(stage, -1)
}

export function stageIndex(stage: GuidedStage): number {
  return STAGES.findIndex((item) => item.id === stage)
}

export function furthestStage(current: GuidedStage, candidate: GuidedStage): GuidedStage {
  return stageIndex(candidate) > stageIndex(current) ? candidate : current
}

export function isGuidedStage(value: unknown): value is GuidedStage {
  return typeof value === "string" && STAGES.some((stage) => stage.id === value)
}

function moveStage(stage: GuidedStage, offset: -1 | 1): GuidedStage {
  const index = stageIndex(stage)
  const nextIndex = Math.min(STAGES.length - 1, Math.max(0, index + offset))
  return STAGES[nextIndex].id
}
