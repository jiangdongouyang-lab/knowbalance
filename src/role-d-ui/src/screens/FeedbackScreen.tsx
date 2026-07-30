import { DynamicFeedbackVisualization } from "../components/DynamicFeedbackVisualization"
import type { RoleDSession } from "../domain/types"

interface FeedbackScreenProps {
  session: RoleDSession
  onRestart: () => void
  onContinueNextRound: () => void
  continuing: boolean
  continueError: string
  onBack: () => void
}

export function FeedbackScreen({
  session,
  onRestart,
  onContinueNextRound,
  continuing,
  continueError,
  onBack,
}: FeedbackScreenProps) {
  const current = session.path.find((node) => node.status === "current")
  const upcoming = session.path.find((node) => node.status === "upcoming")
  const targetIds = new Set(session.roleC?.targetSourceIds ?? [])
  const assessedTargets = session.path.filter((node) => targetIds.has(node.id))
  const pathComplete = session.path.length > 0
    && session.path.every((node) => node.status === "completed")
  const realKinds = new Set(session.artifacts.filter((artifact) => artifact.status === "real").map((artifact) => artifact.kind))
  const contentReady = (["lesson", "lab", "assessment"] as const).every((kind) => realKinds.has(kind))
  const submitted = session.view.assessmentSubmitted === true
  const graded = session.assessmentGraded === true && Boolean(session.feedback)
  const canContinueNextRound = graded && session.planSource === "real-ab"
  const score = session.feedback?.roundScore
  const heading = graded ? "C 已完成正式评分与动态反馈" : submitted ? "作答已提交，等待正式评分" : "完成正式测评后生成反馈"
  const description = graded
    ? `本轮得分 ${score?.rawScore ?? 0} / ${score?.maxScore ?? 0}，正确率 ${Math.round((score?.accuracy ?? 0) * 100)}%。`
    : submitted
      ? session.view.assessmentMessage || "本轮答案已提交给 C，等待可信评分结果。"
      : contentReady ? "三类 C 学习资源已就绪；请先完成并提交整套测评。" : "C 资源尚未就绪，暂不生成反馈。"
  const focusTitle = graded && assessedTargets.length > 0
    ? assessedTargets.map((node) => node.title).join("、")
    : current?.title ?? "当前知识点"
  const focusReason = graded && assessedTargets.length > 0
    ? "本轮 C 生成、测评并判定的目标知识包。"
    : current?.reason ?? "根据 A 检索结果安排当前学习任务。"
  const followUp = graded && session.decision.next === "advance"
    ? current
    : upcoming
  return (
    <section className="stage-screen feedback-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 6 / 6 · 反馈调整</span><h1>{heading}</h1><p>{description}</p></div>
      <span className={graded ? "verified-badge" : "mock-badge"}>{graded ? "C 正式评分与动态反馈 · REAL" : "评分与动态反馈 · PENDING"}</span>
      <DynamicFeedbackVisualization session={session} />
      {graded && session.feedback && (
        <div className="feedback-grid" aria-label="C 正式掌握度与逐题结果">
          <article>
            <span>C 正式逐目标掌握度</span>
            <strong>{session.feedback.masterySnapshot.length > 0 ? `${session.feedback.masterySnapshot.length} 个目标` : "本轮无公开掌握度"}</strong>
            <p>{session.feedback.masterySnapshot.length > 0
              ? session.feedback.masterySnapshot.map((item) => `${item.objectiveId} ${Math.round(item.mastery * 100)}%`).join(" · ")
              : "D 不依据画像字段推算 C 的正式掌握度。"}</p>
          </article>
          <article>
            <span>C 正式逐题评分摘要</span>
            <strong>{session.feedback.itemResults.length > 0 ? `${session.feedback.itemResults.length} 道题` : "未公开逐题结果"}</strong>
            <p>{session.feedback.itemResults.length > 0
              ? session.feedback.itemResults.map((item) => `${item.itemId} ${item.rawScore}/${item.maxScore}${item.modality === "code" ? ` · 代码题 ${item.status}` : ""}`).join("；")
              : "当前 C 公开反馈只包含汇总结果；D 不展示隐藏测试或参考答案。"}</p>
          </article>
        </div>
      )}
      <div className="feedback-decision"><span>当前建议</span><h2>{graded ? decisionLabel(session.decision.next) : submitted ? "等待 C 返回评分结果" : `先完成 ${current?.title ?? "当前知识点"} 的公开测评`}</h2><p>{graded ? session.decision.reason : submitted ? session.view.assessmentMessage || "C 正在处理本轮提交。" : "等待正式提交、服务端评分和学习证据回传后再更新路径。"}</p></div>
      <div className="feedback-grid"><article><span>本轮重点</span><strong>{focusTitle}</strong><p>{focusReason}</p></article><article><span>后续节点</span><strong>{pathComplete ? "本轮路径已完成" : followUp?.title ?? "等待动态决策"}</strong><p>{pathComplete ? "当前路径中的目标均已完成，后续由下一轮学习会话继续。" : followUp?.reason ?? "由 C 的真实测评结果决定后续路径。"}</p></article></div>
      {continueError && <p className="round-continuation-error" role="alert">{continueError}</p>}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回学习内容</button>{canContinueNextRound
        ? <button className="primary-action" type="button" disabled={continuing} onClick={onContinueNextRound}>{continuing ? "正在准备下一轮…" : "继续下一轮"}</button>
        : <button className="primary-action" type="button" onClick={onRestart}>返回继续学习</button>}</div>
    </section>
  )
}

function decisionLabel(next: RoleDSession["decision"]["next"]): string {
  if (next === "advance") return "进入下一学习节点"
  if (next === "reinforce" || next === "consolidate") return "继续巩固当前知识"
  if (next === "reprofile") return "重新校准学习画像"
  return "回到当前知识点补救学习"
}
