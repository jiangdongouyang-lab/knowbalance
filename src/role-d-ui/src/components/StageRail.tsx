import { Check } from "lucide-react"
import { STAGES, stageIndex } from "../domain/guided-flow"
import type { GuidedStage } from "../domain/types"

interface StageRailProps {
  current: GuidedStage
  maxUnlocked: GuidedStage
  onSelect: (stage: GuidedStage) => void
}

export function StageRail({ current, maxUnlocked, onSelect }: StageRailProps) {
  const currentIndex = stageIndex(current)
  const maxIndex = stageIndex(maxUnlocked)
  return (
    <nav className="stage-rail" aria-label="学习流程">
      {STAGES.map((stage, index) => {
        const completed = index < currentIndex
        const active = stage.id === current
        const locked = index > maxIndex
        return (
          <button type="button" className={`${active ? "is-active " : ""}${completed ? "is-completed" : ""}`} disabled={locked} onClick={() => onSelect(stage.id)} key={stage.id}>
            <span className="stage-index">{completed ? <Check size={15} /> : index + 1}</span>
            <span><strong>{stage.label}</strong><small>{locked ? "尚未解锁" : active ? "当前阶段" : completed ? "已完成" : "可查看"}</small></span>
          </button>
        )
      })}
    </nav>
  )
}
