import { BookOpenText, Braces, ClipboardCheck, ExternalLink, FlaskConical, ListTree } from "lucide-react"
import type { ArtifactKind, LearningArtifactView } from "../domain/types"
import { displayedAssessmentAnswer, isAssessmentComplete, isAssessmentItemComplete } from "../domain/assessment-responses"

interface LearningWorkspaceProps {
  artifacts: LearningArtifactView[]
  activeKind: ArtifactKind
  assessmentAnswers: Record<string, string>
  assessmentSubmitted: boolean
  assessmentStatus?: "idle" | "submitting" | "completed" | "needs_review" | "blocked"
  assessmentMessage?: string
  anchorMode?: boolean
  anchorItemIds?: string[]
  routing?: boolean
  onKindChange: (kind: ArtifactKind) => void
  onCitationSelect: (sourceId: string) => void
  onAssessmentAnswer: (itemId: string, optionId: string) => void
  onAssessmentSubmit: () => void
  onRouteAnchors?: () => void
  previewMode?: boolean
}

const tabs: Array<{ kind: ArtifactKind; label: string; description: string; icon: typeof BookOpenText }> = [
  { kind: "lesson", label: "定制讲义", description: "先理解核心概念", icon: BookOpenText },
  { kind: "lab", label: "代码实验", description: "动手阅读与修改代码", icon: Braces },
  { kind: "assessment", label: "分阶测评", description: "检查本轮学习效果", icon: ClipboardCheck },
]

export function LearningWorkspace({ artifacts, activeKind, assessmentAnswers, assessmentSubmitted, assessmentStatus, assessmentMessage, anchorMode = false, anchorItemIds = [], routing = false, onKindChange, onCitationSelect, onAssessmentAnswer, onAssessmentSubmit, onRouteAnchors, previewMode = false }: LearningWorkspaceProps) {
  const artifact = artifacts.find((item) => item.kind === activeKind) ?? artifacts[0]
  if (!artifact) return <section className="panel workspace-panel workspace-blocked"><span className="mock-badge">C 生成未就绪</span><h2>当前没有可发布的学习资源</h2><p>请打开“查看 A/B/C 执行链”，检查 Role C 的证据缺口或受阻原因。A/B 画像与检索结果仍已保留。</p></section>
  const isReal = artifact.status === "real"
  const lessonSections = artifact.kind === "lesson" ? artifact.sections ?? [] : []
  return (
    <section className="panel workspace-panel" aria-labelledby="workspace-title">
      <div className="workspace-header">
        <div><span className="section-kicker">LEARNING WORKSPACE</span><h2 id="workspace-title">本轮学习任务</h2></div>
        <span className={isReal ? "verified-badge" : "mock-badge"}>{isReal ? "C 已验证资源 · REAL" : previewMode ? "界面预览 · 非正式资源" : "C 生成未就绪"}</span>
      </div>
      <div className="resource-tabs enhanced-resource-tabs" role="tablist" aria-label="学习资源类型">
        {tabs.map(({ kind, label, description, icon: Icon }, index) => (
          <button id={`resource-tab-${kind}`} type="button" role="tab" aria-controls={`resource-panel-${kind}`} aria-selected={activeKind === kind} className={activeKind === kind ? "is-active" : ""} key={kind} onClick={() => onKindChange(kind)}>
            <span className="resource-tab-icon"><Icon size={18} /></span><span><small>0{index + 1}</small><strong>{label}</strong><em>{description}</em></span>
          </button>
        ))}
      </div>
      <article id={`resource-panel-${artifact.kind}`} className="resource-body" role="tabpanel" aria-labelledby={`resource-tab-${artifact.kind}`} tabIndex={0}>
        <span className="resource-number">当前学习节点</span>
        <h3>{artifact.title}</h3>
        {artifact.kind === "lesson" && lessonSections.length > 1 && <nav className="lesson-outline" aria-label="讲义目录"><span><ListTree size={15} />讲义目录</span>{lessonSections.map((section, index) => <a key={section.id} href={`#lesson-section-${index + 1}`}>{index + 1}. {section.title}</a>)}</nav>}
        {artifact.kind === "lab" ? <div className="lab-editor-shell"><header><span><Braces size={15} />代码实验区</span><small>可滚动查看完整代码</small></header><pre aria-label="代码实验内容"><code>{artifact.content}</code></pre></div> : artifact.kind !== "assessment" ? <LessonContent content={artifact.content} sections={lessonSections} /> : null}
        {artifact.kind === "assessment" && <AssessmentPreview artifact={artifact} answers={assessmentAnswers} submitted={assessmentSubmitted} status={assessmentStatus} message={assessmentMessage} anchorMode={anchorMode} anchorItemIds={anchorItemIds} routing={routing} onAnswer={onAssessmentAnswer} onSubmit={onAssessmentSubmit} onRouteAnchors={onRouteAnchors} previewMode={previewMode} />}
        <aside className="resource-guidance"><strong>为什么现在学习这个？</strong><p>{isReal ? "这项内容来自当前画像和学习路径，并已通过 C 的公开资源校验。" : previewMode ? "这里只展示循环主题的页面交互，不代表 A/B 审核通过，也不会进入 C 正式评分。" : "C 未能为当前证据生成可发布资源，请查看 Agent 详情中的受阻原因。"}</p></aside>
        <details className="citation-details"><summary><FlaskConical size={14} />查看知识依据与引用（{artifact.citations.length}）</summary><div className="citation-row">{artifact.citations.length > 0 ? artifact.citations.map((citation) => { const label = `${citation.sourceId}-${citation.factId}`; return <button type="button" aria-label={`查看引用 ${label}`} onClick={() => onCitationSelect(citation.sourceId)} key={label}>{label}<ExternalLink size={11} /></button> }) : <span>{artifact.evidenceStatus === "gap" ? "当前存在引用缺口" : "C 未公开引用"}</span>}</div></details>
      </article>
    </section>
  )
}

function LessonContent({ content, sections }: { content: string; sections: NonNullable<LearningArtifactView["sections"]> }) {
  if (sections.length === 0) return <p className="resource-prose">{content}</p>
  return <div className="lesson-sections">{sections.map((section, index) => <section id={`lesson-section-${index + 1}`} className={`lesson-section-${section.kind}`} key={section.id}><h4>{section.title}</h4>{section.code ? <pre><code>{section.code}</code></pre> : <p>{section.text}</p>}</section>)}</div>
}

function AssessmentPreview({ artifact, answers, submitted, status = "idle", message = "", anchorMode = false, anchorItemIds = [], routing = false, onAnswer, onSubmit, onRouteAnchors, previewMode = false }: { artifact: LearningArtifactView; answers: Record<string, string>; submitted: boolean; status?: "idle" | "submitting" | "completed" | "needs_review" | "blocked"; message?: string; anchorMode?: boolean; anchorItemIds?: string[]; routing?: boolean; onAnswer: (itemId: string, answer: string) => void; onSubmit: () => void; onRouteAnchors?: () => void; previewMode?: boolean }) {
  const allItems = artifact.items ?? []
  const items = anchorMode ? allItems.filter((item) => anchorItemIds.includes(item.id)) : allItems
  if (items.length === 0) return <p className="mock-empty">{anchorMode ? "本轮锚点题尚未就绪。" : "当前没有可发布的分阶测评题。"}</p>
  const completedCount = items.filter((item) => isAssessmentItemComplete(item, answers)).length
  const complete = isAssessmentComplete(items, answers)
  return <div className="assessment-preview" aria-label="C 生成的分阶测评题"><p className="assessment-note">{previewMode ? "仅用于查看测评交互；答案不会提交 C，也不会生成正式分数、掌握度或下一步决策。" : anchorMode ? "先完成锚点题，C 将据此确定本轮测评路线并解锁完整测评。" : "答案会自动保存到当前计划。正确答案、评分规范和隐藏测试保留在服务端。"}</p>{items.map((item, index) => <article className="assessment-item" key={item.id}><div><span>第 {index + 1} 题</span><small>Tier {item.tier} · {modalityLabel(item.modality)}{item.maxScore ? ` · ${item.maxScore} 分` : ""}</small></div><h4>{item.prompt}</h4>{(item.modality === "mcq" || item.modality === "true_false") && <div className="answer-options">{item.options.map((option, optionIndex) => { const optionId = item.optionIds?.[optionIndex] ?? option; const selected = answers[item.id] === optionId; return <button type="button" aria-pressed={selected} className={selected ? "is-selected" : ""} key={optionId} onClick={() => onAnswer(item.id, optionId)}>{option}</button> })}</div>}{(item.modality === "trace" || item.modality === "short_answer") && <textarea className="assessment-text-response" aria-label={`第 ${index + 1} 题${item.modality === "trace" ? "代码追踪" : "简答"}答案`} rows={item.modality === "trace" ? 4 : 5} value={answers[item.id] ?? ""} placeholder={item.modality === "trace" ? "写出运行结果或变量变化过程" : "用自己的话说明答案"} onChange={(event) => onAnswer(item.id, event.target.value)} />}{item.modality === "code" && <textarea className="assessment-code-response" aria-label={`第 ${index + 1} 题代码答案`} rows={16} spellCheck={false} value={displayedAssessmentAnswer(item, answers)} onChange={(event) => onAnswer(item.id, event.target.value)} />}</article>)}{!previewMode && <div className="assessment-submit"><span role="status">{anchorMode ? (routing ? "正在确定测评路线…" : `已自动保存 · 锚点题完成 ${completedCount} / ${items.length}`) : status === "submitting" ? "已提交，C 正在正式评分" : status === "completed" ? message || "C 已完成正式评分" : status === "needs_review" || status === "blocked" ? message : submitted ? "作答已提交，等待 C 正式评分" : `已自动保存 · 完成 ${completedCount} / ${items.length} 题`}</span><button type="button" disabled={!complete || routing || (!anchorMode && (status === "submitting" || status === "completed" || status === "needs_review"))} onClick={anchorMode ? onRouteAnchors : onSubmit}>{anchorMode ? (routing ? "正在确定路线…" : "提交锚点题，确定测评路线") : status === "submitting" ? "评分中…" : status === "completed" ? "已评分" : submitted && status !== "blocked" ? "已提交" : status === "blocked" ? "重新提交整套测评" : "提交整套测评"}</button></div>}</div>
}

function modalityLabel(modality: NonNullable<LearningArtifactView["items"]>[number]["modality"]): string {
  return ({ mcq: "选择题", true_false: "判断题", trace: "代码追踪", short_answer: "简答题", code: "代码题" })[modality]
}
