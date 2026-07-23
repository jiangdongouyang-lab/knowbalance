import type { RoleDSession } from "../domain/types"

interface ProfileScreenProps {
  session: RoleDSession
  onContinue: () => void
  onBack: () => void
}

export function ProfileScreen({ session, onContinue, onBack }: ProfileScreenProps) {
  return (
    <section className="stage-screen profile-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 3 / 6 · 学情画像</span><h1>学情画像报告</h1><p>画像由背景、自评和客观诊断共同生成；冲突不会被静默隐藏。</p></div>
      <div className="profile-hero"><div><span>当前起点</span><strong>{session.profile.level}</strong><p>{session.profile.goal}</p></div><div className="profile-score"><span>建议策略</span><strong>先补基础，再做项目</strong><small>客观证据优先于自评</small></div></div>
      <div className="profile-groups"><article><span>已掌握</span><div>{session.profile.knownConcepts.map((concept) => <b key={concept}>{concept}</b>)}</div></article><article><span>优先补强</span><div>{session.profile.weakConcepts.map((concept) => <b key={concept}>{concept}</b>)}</div></article></div>
      {session.conflicts.map((conflict) => <div className="profile-conflict" key={conflict.concept}><strong>{conflict.concept}：自评与客观诊断不一致</strong><p>{conflict.rule}</p></div>)}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回诊断</button><button className="primary-action" type="button" onClick={onContinue}>生成个性化方案</button></div>
    </section>
  )
}
