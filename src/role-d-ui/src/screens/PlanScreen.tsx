import { ArrowRight, Check, LockKeyhole } from "lucide-react"
import { DifficultyMatchChart } from "../components/DifficultyMatchChart"
import type { RoleDSession } from "../domain/types"

interface PlanScreenProps { session: RoleDSession; onContinue: () => void; onBack: () => void }

export function PlanScreen({ session, onContinue, onBack }: PlanScreenProps) {
  return (
    <section className="stage-screen plan-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 4 / 6 · 定制方案</span><h1>个性化学习方案</h1><p>系统根据画像、先修关系和知识检索结果，选择一条从薄弱点走向项目目标的路径。</p></div>
      <div className="plan-route">{session.path.map((node, index) => <article className={node.status} key={node.id}><span className="route-number">{node.status === "completed" ? <Check size={18} /> : index + 1}</span><div><small>{node.difficulty}</small><h2>{node.title}</h2><p>{node.reason}</p></div>{node.status === "upcoming" && <LockKeyhole size={17} />}{index < session.path.length - 1 && <ArrowRight className="route-arrow" size={20} />}</article>)}</div>
      <DifficultyMatchChart learnerLevel={session.profile.level} items={session.retrieval.items} />
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回画像</button><button className="primary-action" type="button" onClick={onContinue}>进入学习实操</button></div>
    </section>
  )
}
