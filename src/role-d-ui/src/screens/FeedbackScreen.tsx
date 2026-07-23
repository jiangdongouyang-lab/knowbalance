import type { RoleDSession } from "../domain/types"

interface FeedbackScreenProps { session: RoleDSession; onRestart: () => void; onBack: () => void }

export function FeedbackScreen({ session, onRestart, onBack }: FeedbackScreenProps) {
  const current = session.path.find((node) => node.status === "current") ?? session.path[0]
  const next = session.path.find((node) => node.status === "upcoming")
  const contentReady = session.artifacts.length === 3 && session.artifacts.every((artifact) => artifact.status === "real")
  const hasGrade = session.assessmentGraded === true
  return (
    <section className="stage-screen feedback-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 6 / 6 · 反馈调整</span><h1>{hasGrade ? "根据学习反馈动态调整" : "完成正式测评后生成反馈"}</h1><p>{hasGrade ? "测评结果将决定补救、巩固、进阶或重新构建画像。" : contentReady ? "三类 C 学习资源已就绪；当前尚未把整套作答提交给 C 评分，因此不展示虚构分数或决策。" : "C 资源尚未就绪，暂不生成反馈。"}</p></div>
      {!hasGrade && <span className="mock-badge">评分与动态反馈 · PENDING</span>}
      <div className="feedback-decision"><span>当前建议</span><h2>{hasGrade ? session.decision.next : `先完成 ${current?.title ?? "当前知识点"} 的公开测评`}</h2><p>{hasGrade ? session.decision.reason : "等待正式提交、服务端评分和学习证据回传后再更新路径。"}</p></div>
      <div className="feedback-grid"><article><span>本轮重点</span><strong>{current?.title ?? "当前知识点"}</strong><p>{current?.reason ?? "根据 A 检索结果安排当前学习任务。"}</p></article><article><span>后续节点</span><strong>{next?.title ?? "等待动态决策"}</strong><p>{next?.reason ?? "由 C 的真实测评结果决定后续路径。"}</p></article></div>
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回学习内容</button><button className="primary-action" type="button" onClick={onRestart}>{hasGrade ? "开始下一轮补救" : "返回继续学习"}</button></div>
    </section>
  )
}
