import { ArrowRight, Check, LockKeyhole, MapPinned, Sparkles } from "lucide-react"
import { Week2VisualizationReport } from "../components/Week2VisualizationReport"
import type { RoleDSession } from "../domain/types"

interface PlanScreenProps {
  session: RoleDSession
  onContinue: () => void
  onPreview: () => void
  onRetryGeneration: () => void
  onBack: () => void
  retrying?: boolean
  retryError?: string
}

export function PlanScreen({ session, onContinue, onPreview, onRetryGeneration, onBack, retrying = false, retryError = "" }: PlanScreenProps) {
  const current = session.path.find((node) => node.status === "current") ?? session.path[0]
  const hasPath = session.path.length > 0
  const resourcesReady = session.artifacts.some((artifact) => artifact.status === "real")
  const auditRejected = session.audit?.arbitration.decision === "reject"
  const canContinue = hasPath && resourcesReady && !auditRejected
  return (
    <section className="stage-screen plan-screen">
      <div className="screen-heading plan-heading"><span className="screen-step">学习流程 4 / 6 · 定制方案</span><h1>这就是你的本次学习路线</h1><p>D 根据 B 的画像结果、A 的知识检索结果和先修关系整理本次学习路线。当前节点已突出显示，先完成它再继续后面的内容。</p></div>
      {current ? <section className="plan-priority-card" aria-labelledby="priority-node-title"><span className="plan-priority-icon"><MapPinned size={23} /></span><div><small>为什么先学这个</small><h2 id="priority-node-title">{current.title}</h2><p>{current.reason}</p></div><span className="plan-priority-badge"><Sparkles size={14} />现在从这里开始</span></section> : <section className="plan-empty-state"><LockKeyhole size={24} /><div><h2>学习路线还没有准备好</h2><p>请查看 A/B/C 执行详情中的受阻原因；D 不会自行补造路径节点。</p></div></section>}
      {hasPath && <div className="plan-route enhanced-plan-route">{session.path.map((node, index) => <article className={node.status} key={node.id}><div className="route-content"><small className="route-meta"><b>0{index + 1}</b><span>难度 {node.difficulty}</span></small><h2>{node.title}</h2><p><b>学习原因：</b>{node.reason}</p></div>{node.status === "completed" && <Check size={18} />}{node.status === "current" && <span className="current-node-label"><Sparkles size={12} />当前学习节点</span>}{node.status === "upcoming" && <LockKeyhole size={16} />}{index < session.path.length - 1 && <ArrowRight className="route-arrow" size={17} />}</article>)}</div>}
      {!canContinue && <p className="plan-blocked-note" role="status">{retrying ? "正在调用 C 重新生成学习资源，请稍候…" : auditRejected ? "本轮资源已被审核驳回，暂不能进入学习实操。" : !resourcesReady ? "C 还没有返回可发布的学习资源，暂不能进入学习实操。" : "学习路线尚未准备好。"}</p>}
      {retryError && <p className="form-error" role="alert">{retryError}</p>}
      <details className="plan-technical-details"><summary>查看完整画像、资源匹配与审核详情</summary><div><Week2VisualizationReport session={session} /></div></details>
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回画像</button>{!canContinue && <button className="secondary-action" type="button" disabled={retrying} onClick={onRetryGeneration}>{retrying ? "正在重新生成…" : "重新生成学习资源"}</button>}{!canContinue && <button className="secondary-action" type="button" disabled={retrying} onClick={onPreview}>仅预览学习界面</button>}<button className="primary-action" type="button" disabled={!canContinue} onClick={onContinue}>进入学习实操</button></div>
    </section>
  )
}
