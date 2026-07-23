import { diagnosisItems, diagnosisScore } from "../domain/diagnosis"
import type { RoleDSession } from "../domain/types"

interface DiagnosisScreenProps {
  diagnosis: RoleDSession["diagnosis"]
  answers: Record<string, string>
  submitted: boolean
  submitting: boolean
  onAnswer: (itemId: string, answer: string) => void
  onSubmit: () => void
  onContinue: () => void
  onBack: () => void
}

export function DiagnosisScreen({ diagnosis, answers, submitted, submitting, onAnswer, onSubmit, onContinue, onBack }: DiagnosisScreenProps) {
  const items = diagnosisItems(diagnosis)
  const answeredCount = items.filter((item) => Boolean(answers[item.id])).length
  const score = diagnosisScore(diagnosis, answers)
  const ratio = score.total === 0 ? 0 : score.correct / score.total
  const evidenceLabel = score.total >= 3 ? "证据较充分" : "证据有限"
  const resultLabel = score.total < 3 ? "当前证据不足，先按用户自评安排起点" : ratio >= 0.8 ? "已表现出初步掌握" : ratio >= 0.5 ? "部分知识已掌握，仍需针对性巩固" : "当前知识点建议优先补强"
  return (
    <section className="stage-screen diagnosis-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 2 / 6 · 客观诊断</span><h1>用真实知识库题目确认基础</h1><p>系统优先使用 A 当前命中的真实题；不足时沿命中知识点的 prerequisites 补充前置题。有多少可追溯题就展示多少，最多 5 道，不临时编造；具体来源可在“知识证据”中查看。</p></div>
      <div className="diagnosis-question-list">{items.map((item, index) => <article className="question-card" key={item.id}><span className="question-source">第 {index + 1} 题 · {item.sourceId}-{item.factId} · {item.concept}</span><h2>{item.question}</h2><div className="diagnosis-options">{item.options.map((option) => <label className={answers[item.id] === option ? "is-selected" : ""} key={option}><input type="radio" name={`diagnosis-${item.id}`} aria-label={option} checked={answers[item.id] === option} disabled={submitted} onChange={() => onAnswer(item.id, option)} /><span>{option}</span></label>)}</div></article>)}</div>
      {!submitted && <p className="diagnosis-progress" role="status">已答 {answeredCount} / {items.length} 题 · {answeredCount === items.length ? "可以提交诊断" : "请完成全部真实题后提交"}</p>}
      {submitted && <div className={`diagnosis-result ${ratio >= 0.8 && score.total >= 3 ? "is-correct" : "is-needs-work"}`} role="status"><strong>客观诊断已完成 · {score.correct} / {score.total} 题</strong><p>{resultLabel}。{evidenceLabel}；B 已接收全部作答证据并重新运行画像，详细概念结论请在下一页查看。</p></div>}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回计划信息</button>{submitted ? <button className="primary-action" type="button" onClick={onContinue}>查看学情画像</button> : <button className="primary-action" type="button" disabled={answeredCount !== items.length || submitting} onClick={onSubmit}>{submitting ? "正在更新 B/A/C…" : `提交 ${items.length} 道诊断题`}</button>}</div>
    </section>
  )
}
