import { AlertTriangle, Award, BookOpenText, CheckCircle2, Compass, Gauge, ListChecks } from "lucide-react"
import { DynamicFeedbackVisualization } from "../components/DynamicFeedbackVisualization"
import type { RoleDSession } from "../domain/types"

interface FeedbackScreenProps { session: RoleDSession; previewMode?: boolean; onRestart: () => void; onBack: () => void; onContinueNextStage?: () => void; continuing?: boolean; continueError?: string }

export function FeedbackScreen({ session, previewMode = false, onRestart, onBack, onContinueNextStage, continuing = false, continueError = "" }: FeedbackScreenProps) {
  const current = session.path.find((node) => node.status === "current") ?? session.path[0]
  const next = session.path.find((node) => node.status === "upcoming")
  const realKinds = new Set(session.artifacts.filter((artifact) => artifact.status === "real").map((artifact) => artifact.kind))
  const contentReady = (["lesson", "lab", "assessment"] as const).every((kind) => realKinds.has(kind))
  const submitted = session.view.assessmentSubmitted === true
  const graded = session.assessmentGraded === true && Boolean(session.feedback)
  const score = session.feedback?.roundScore
  const assessment = session.artifacts.find((artifact) => artifact.kind === "assessment")
  const modalityByItem = new Map((assessment?.items ?? []).map((item) => [item.id, item.modality]))
  const assessmentStatus = session.view.assessmentStatus ?? "idle"
  const resultTitle = graded ? `本轮正确率 ${Math.round((score?.accuracy ?? 0) * 100)}%` : assessmentStatus === "submitting" ? "正在进行正式评分" : assessmentStatus === "needs_review" ? "部分作答需要进一步审核" : assessmentStatus === "blocked" ? "本次评分暂未完成" : submitted ? "作答已成功提交" : "还差最后一步"
  const resultDescription = graded ? `${session.feedback?.feedbackSummary || "C 已返回正式反馈。"} 本轮得分 ${score?.rawScore ?? 0} / ${score?.maxScore ?? 0}。` : assessmentStatus === "submitting" || assessmentStatus === "needs_review" || assessmentStatus === "blocked" ? session.view.assessmentMessage || "请返回测评页查看当前处理状态。" : submitted ? session.view.assessmentMessage || "正在等待 C 返回正式评分结果。" : contentReady ? "完成并提交分阶测评后，这里会显示你的真实学习反馈。" : "学习资源尚未全部准备好。"
  const resultIcon = graded ? <Award size={25} /> : submitted ? <CheckCircle2 size={25} /> : <ListChecks size={25} />

  return (
    <section className="stage-screen feedback-screen">
      <div className="screen-heading feedback-heading"><span className="screen-step">学习流程 6 / 6 · 反馈调整</span><h1>本轮学习反馈</h1><p>先看本轮结果，再看掌握情况和下一步。技术执行信息已放到页面底部，需要时再展开。</p></div>
      {previewMode && <p className="plan-blocked-note" role="status">反馈界面预览 · 无 C 正式评分 · 不代表真实掌握度或动态决策</p>}

      <section className={`feedback-result-hero${graded ? " is-graded" : ""}`} aria-labelledby="feedback-result-title"><span className="feedback-result-icon">{resultIcon}</span><div><small>你最关心的结果</small><h2 id="feedback-result-title">{resultTitle}</h2><p>{resultDescription}</p></div><span className={graded ? "verified-badge" : "mock-badge"}>{graded ? "正式反馈" : "等待完成"}</span></section>

      <div className="feedback-user-grid">
        <article><span className="feedback-card-icon"><Gauge size={20} /></span><small>掌握情况</small><h2>{graded && session.feedback?.masterySnapshot.length ? `${session.feedback.masterySnapshot.length} 个目标已更新` : "等待正式掌握度"}</h2><p>{graded && session.feedback?.masterySnapshot.length ? session.feedback.masterySnapshot.map((item) => `${item.objectiveId} ${Math.round(item.mastery * 100)}%`).join(" · ") : "D 不根据页面表现自行推算掌握度，等待 C 返回正式结果。"}</p></article>
        <article className="next-action"><span className="feedback-card-icon"><Compass size={20} /></span><small>下一步建议</small><h2>{graded ? decisionLabel(session.decision.next) : submitted ? "等待评分完成" : `先完成 ${current?.title ?? "当前知识点"} 的测评`}</h2><p>{graded ? session.decision.reason : submitted ? "评分返回后会自动给出补救、巩固或进阶建议。" : "完成测评后再决定是否进入下一个节点。"}</p></article>
      </div>

      <section className="feedback-path-preview"><div><span><BookOpenText size={17} />本轮重点</span><strong>{current?.title ?? "当前知识点"}</strong><p>{current?.reason ?? "根据 A 检索结果安排当前学习任务。"}</p></div><div><span><Compass size={17} />可能的后续节点</span><strong>{next?.title ?? "等待动态决策"}</strong><p>{next?.reason ?? "由 C 的真实测评结果决定后续路径。"}</p></div></section>

      <details className="feedback-technical-details"><summary><AlertTriangle size={16} />查看评分分支与技术详情</summary><div><DynamicFeedbackVisualization session={session} />{graded && session.feedback && <div className="feedback-grid" aria-label="C 正式掌握度与逐题结果"><article><span>C 正式逐目标掌握度</span><strong>{session.feedback.masterySnapshot.length > 0 ? `${session.feedback.masterySnapshot.length} 个目标` : "本轮无公开掌握度"}</strong><p>{session.feedback.masterySnapshot.length > 0 ? session.feedback.masterySnapshot.map((item) => `${item.objectiveId} ${Math.round(item.mastery * 100)}%`).join(" · ") : "D 不依据画像字段推算 C 的正式掌握度。"}</p></article><article><span>C 正式逐题评分摘要</span><strong>{session.feedback.itemResults.length > 0 ? `${session.feedback.itemResults.length} 道题` : "未公开逐题结果"}</strong><p>{session.feedback.itemResults.length > 0 ? session.feedback.itemResults.map((item) => `${item.itemId} ${item.rawScore}/${item.maxScore}${modalityByItem.get(item.itemId) === "code" ? ` · 代码题 ${item.status}` : ""}`).join("；") : "当前 C 公开反馈只包含汇总结果；D 不展示隐藏测试或参考答案。"}</p></article></div>}</div></details>
      <div className="screen-actions">{graded && onContinueNextStage ? (!previewMode && <button className="primary-action" type="button" disabled={continuing} onClick={onContinueNextStage}>{continuing ? "正在进入下一阶段…" : session.decision.next === "reprofile" ? "重新校准学习画像" : "进入下一学习阶段"}</button>) : <><button className="secondary-action" type="button" onClick={onBack}>返回学习内容</button><button className="primary-action" type="button" onClick={onRestart}>返回继续学习</button></>}</div>
      {continueError && <p className="plan-blocked-note" role="alert">{continueError}</p>}
    </section>
  )
}

function decisionLabel(next: RoleDSession["decision"]["next"]): string {
  if (next === "advance") return "进入下一学习节点"
  if (next === "reinforce" || next === "consolidate") return "继续巩固当前知识"
  if (next === "reprofile") return "重新校准学习画像"
  return "回到当前知识点补救学习"
}
