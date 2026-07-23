import { diagnosisScore } from "../domain/diagnosis"
import type { RoleDSession } from "../domain/types"

interface ProfileScreenProps {
  session: RoleDSession
  onContinue: () => void
  onBack: () => void
}

export function ProfileScreen({ session, onContinue, onBack }: ProfileScreenProps) {
  const score = diagnosisScore(session.diagnosis, session.view.diagnosisAnswers ?? {})
  return (
    <section className="stage-screen profile-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 3 / 6 · 学情画像</span><h1>学情画像报告</h1><p>画像由用户背景、自评和 {score.total} 道客观诊断共同生成；这是教学起点，不是一次测验的最终能力评分。</p></div>
      <div className="profile-hero"><div><span>当前学习起点（不是最终能力评分）</span><strong>{levelLabel(session.profile.level)}</strong><p>{session.profile.goal}</p></div><div className="profile-score"><span>本轮诊断证据</span><strong>{score.correct} / {score.total} 题</strong><small>{score.total >= 3 ? "证据较充分；B 按概念分别归入已掌握或待补强" : "证据有限；暂按用户自评安排起点"}</small></div></div>
      <div className="profile-groups"><article><span>已掌握</span><div>{session.profile.knownConcepts.length > 0 ? session.profile.knownConcepts.map((concept) => <b key={concept}>{concept}</b>) : <em>当前证据还不足以确认已掌握知识点</em>}</div></article><article><span>优先补强</span><div>{session.profile.weakConcepts.length > 0 ? session.profile.weakConcepts.map((concept) => <b key={concept}>{concept}</b>) : <em>本轮诊断未发现需要优先补强的知识点</em>}</div></article></div>
      {session.conflicts.map((conflict) => <div className="profile-conflict" key={conflict.concept}><strong>{conflict.concept}：自评与客观诊断不一致</strong><p>{conflict.rule}</p></div>)}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回诊断</button><button className="primary-action" type="button" onClick={onContinue}>生成个性化方案</button></div>
    </section>
  )
}

function levelLabel(level: RoleDSession["profile"]["level"]): string {
  return ({ beginner: "从基础概念开始", basic: "从基础应用开始", intermediate: "从独立编程开始", integrated: "从综合项目开始" })[level]
}
