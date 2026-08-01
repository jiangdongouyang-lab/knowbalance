import { BookOpenCheck, Compass, Sparkles, Target, UserRound, ClipboardCheck } from "lucide-react"
import { diagnosisScore } from "../domain/diagnosis"
import type { RoleDSession } from "../domain/types"

interface ProfileScreenProps {
  session: RoleDSession
  onContinue: () => void
  onBack: () => void
}

export function ProfileScreen({ session, onContinue, onBack }: ProfileScreenProps) {
  const score = diagnosisScore(session.diagnosis, session.view.diagnosisAnswers ?? {})
  const selfKnown = session.planInput.knownConcepts
  const selfWeak = session.planInput.weakConcepts
  return (
    <section className="stage-screen profile-screen">
      <div className="screen-heading profile-heading"><span className="screen-step">学习流程 3 / 6 · 学情画像</span><h1>你的学习起点已经整理好了</h1><p>结果综合了你的自评、客观诊断和 B 的画像判断。它只用于安排接下来的学习顺序，不是能力排名。</p></div>

      <div className="profile-outcome-grid">
        <article className="profile-outcome-card mastered"><span className="profile-outcome-icon"><BookOpenCheck size={21} /></span><div><small>已掌握知识</small><h2>{session.profile.knownConcepts.length > 0 ? `${session.profile.knownConcepts.length} 个知识点` : "尚待确认"}</h2></div><div className="profile-chip-list">{session.profile.knownConcepts.length > 0 ? session.profile.knownConcepts.map((concept) => <b key={concept}>{concept}</b>) : <em>当前证据还不足以确认已掌握知识点</em>}</div></article>
        <article className="profile-outcome-card weak"><span className="profile-outcome-icon"><Target size={21} /></span><div><small>待补强知识</small><h2>{session.profile.weakConcepts.length > 0 ? `${session.profile.weakConcepts.length} 个优先项` : "暂未发现"}</h2></div><div className="profile-chip-list">{session.profile.weakConcepts.length > 0 ? session.profile.weakConcepts.map((concept) => <b key={concept}>{concept}</b>) : <em>本轮诊断未发现需要优先补强的知识点</em>}</div></article>
        <article className="profile-outcome-card start"><span className="profile-outcome-icon"><Compass size={21} /></span><div><small>B 综合画像</small><h2>推荐学习起点</h2></div><p>{levelLabel(session.profile.level)}</p><span className="profile-start-note"><Sparkles size={13} />接下来将依据这份画像生成学习顺序</span></article>
      </div>

      <section className="profile-evidence-story" aria-labelledby="profile-evidence-title">
        <div className="profile-section-heading"><span className="section-kicker">HOW WE GOT HERE</span><h2 id="profile-evidence-title">这份画像是怎么得出的？</h2></div>
        <div className="profile-evidence-grid">
          <article><span className="evidence-step-icon"><UserRound size={18} /></span><small>01 · 用户自评</small><h3>你对自己的判断</h3><p>已学：{selfKnown.length > 0 ? selfKnown.join("、") : "未填写"}</p><p>薄弱：{selfWeak.length > 0 ? selfWeak.join("、") : "未填写"}</p></article>
          <article><span className="evidence-step-icon"><ClipboardCheck size={18} /></span><small>02 · 客观诊断结果</small><h3>{score.correct} / {score.total} 题答对</h3><p>已提交 {score.total} 道客观诊断题，作答结果已参与画像合成。</p></article>
          <article><span className="evidence-step-icon"><Sparkles size={18} /></span><small>03 · B 综合画像</small><h3>{levelLabel(session.profile.level)}</h3><p>B 综合自评与作答证据，确定已掌握、待补强和推荐起点。</p></article>
        </div>
      </section>

      {session.conflicts.length > 0 && <details className="profile-conflicts"><summary>查看 {session.conflicts.length} 项自评与诊断差异</summary>{session.conflicts.map((conflict) => <div className="profile-conflict" key={conflict.concept}><strong>{conflict.concept}：自评与客观诊断不一致</strong><p>{conflict.rule}</p></div>)}</details>}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回诊断</button><button className="primary-action" type="button" onClick={onContinue}>生成个性化方案</button></div>
    </section>
  )
}

function levelLabel(level: RoleDSession["profile"]["level"]): string {
  return ({ beginner: "从基础概念开始", basic: "从基础应用开始", intermediate: "从独立编程开始", integrated: "从综合项目开始" })[level]
}
