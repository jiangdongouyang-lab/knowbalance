import { BrainCircuit } from "lucide-react"
import type { GuidedStage, LearnerProfileView } from "../domain/types"
import { StageRail } from "./StageRail"

interface AppSidebarProps {
  profile: LearnerProfileView
  learnerName?: string
  currentStage: GuidedStage
  maxUnlockedStage: GuidedStage
  onStageSelect: (stage: GuidedStage) => void
}

export function AppSidebar({ profile, learnerName: providedName, currentStage, maxUnlockedStage, onStageSelect }: AppSidebarProps) {
  const learnerName = providedName ?? profile.learnerId.replace("demo_", "")
  const avatar = learnerName.trim().charAt(0).toUpperCase() || "学"
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="KnowBalance">
        <span className="brand-mark"><BrainCircuit size={19} strokeWidth={1.8} /></span>
        <span><strong>KnowBalance</strong><small>个性化学习助手</small></span>
        <span className="mobile-course-label"><b>Python</b><small>基础训练</small></span>
      </div>
      <div className="sidebar-label">本次学习流程</div>
      <StageRail current={currentStage} maxUnlocked={maxUnlockedStage} onSelect={onStageSelect} />
      <div className="sidebar-spacer" />
      <div className="session-summary"><span>当前目标</span><p>{profile.goal}</p></div>
      <div className="learner-card">
        <span className="avatar" aria-label={`学习者头像 ${avatar}`}>{avatar}</span>
        <span className="learner-meta"><strong>{learnerName}</strong><small>{profile.level} · Python 基础</small></span>
        <span className="online-dot" title="会话已保存" />
      </div>
    </aside>
  )
}
