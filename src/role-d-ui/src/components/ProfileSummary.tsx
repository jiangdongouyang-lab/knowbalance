import { AlertTriangle, CheckCircle2, Target } from "lucide-react"
import type { LearnerProfileView, ProfileConflictView } from "../domain/types"

interface ProfileSummaryProps {
  profile: LearnerProfileView
  conflicts: ProfileConflictView[]
}

export function ProfileSummary({ profile, conflicts }: ProfileSummaryProps) {
  return (
    <section className="panel profile-panel" aria-labelledby="profile-title">
      <div className="panel-heading">
        <div><span className="section-kicker">LEARNER PROFILE</span><h2 id="profile-title">学习者画像</h2></div>
        <span className="level-badge">{profile.level}</span>
      </div>

      <div className="goal-row">
        <span className="icon-box"><Target size={16} /></span>
        <div><small>本轮目标</small><p>{profile.goal}</p></div>
      </div>

      <div className="concept-columns">
        <div>
          <span className="micro-label"><CheckCircle2 size={13} /> 已掌握</span>
          <div className="chip-row">{profile.knownConcepts.map((item) => <span className="concept-chip known" key={item}>{item}</span>)}</div>
        </div>
        <div>
          <span className="micro-label"><AlertTriangle size={13} /> 待补强</span>
          <div className="chip-row">{profile.weakConcepts.map((item) => <span className="concept-chip weak" key={item}>{item}</span>)}</div>
        </div>
      </div>

      {conflicts.map((conflict) => (
        <div className="conflict-note" key={conflict.concept}>
          <AlertTriangle size={15} />
          <div><strong>{conflict.concept}存在证据冲突</strong><span>{conflict.rule}</span></div>
        </div>
      ))}
    </section>
  )
}
