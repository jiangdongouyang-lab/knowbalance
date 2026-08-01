import { Check, ChevronLeft, ChevronRight, CircleAlert } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
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
  const [currentIndex, setCurrentIndex] = useState(0)
  const [incompleteMessage, setIncompleteMessage] = useState("")
  const answeredCount = items.filter((item) => Boolean(answers[item.id])).length
  const currentItem = items[Math.min(currentIndex, Math.max(items.length - 1, 0))]
  const score = diagnosisScore(diagnosis, answers)
  const ratio = score.total === 0 ? 0 : score.correct / score.total
  const evidenceLabel = score.total >= 3 ? "证据较充分" : "证据有限"
  const resultLabel = score.total < 3 ? "当前证据不足，先按用户自评安排起点" : ratio >= 0.8 ? "已表现出初步掌握" : ratio >= 0.5 ? "部分知识已掌握，仍需针对性巩固" : "当前知识点建议优先补强"
  const unavailable = items.length === 0
  const progress = items.length === 0 ? 0 : Math.round(answeredCount / items.length * 100)
  const unansweredIndexes = useMemo(() => items.map((item, index) => answers[item.id] ? -1 : index).filter((index) => index >= 0), [answers, items])

  useEffect(() => {
    if (currentIndex >= items.length && items.length > 0) setCurrentIndex(items.length - 1)
  }, [currentIndex, items.length])

  const navigate = (index: number) => {
    setIncompleteMessage("")
    setCurrentIndex(Math.max(0, Math.min(index, items.length - 1)))
  }
  const submit = () => {
    if (unansweredIndexes.length > 0) {
      const target = unansweredIndexes[0]!
      setCurrentIndex(target)
      setIncompleteMessage(`还有 ${unansweredIndexes.length} 道题未完成，已定位到第 ${target + 1} 题。`)
      return
    }
    setIncompleteMessage("")
    onSubmit()
  }

  return (
    <section className="stage-screen diagnosis-screen">
      <div className="screen-heading diagnosis-heading"><span className="screen-step">学习流程 2 / 6 · 客观诊断</span><h1>用真实知识库题目确认基础</h1><p>系统只展示 A 当前命中的真实选择题，不额外借题或临时编造。请按自己的真实理解作答，提交前不会显示正确答案。</p></div>

      {unavailable
        ? <div className="diagnosis-result is-needs-work" role="status"><strong>本轮无可判分的客观题</strong><p>{diagnosis.unavailableReason ?? "当前目标没有知识库选择题，本轮不产生客观诊断证据。"}</p></div>
        : <>{!submitted && <section className="diagnosis-overview" aria-label="答题进度">
          <div className="diagnosis-overview-row"><div><span>当前进度</span><strong role="status">已完成 {answeredCount} / {items.length} 题</strong></div><b>{progress}%</b></div>
          <div className="diagnosis-progress-track" role="progressbar" aria-label="客观诊断完成进度" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={answeredCount}><span style={{ width: `${progress}%` }} /></div>
          <div className="diagnosis-step-dots" aria-label="题目导航">{items.map((item, index) => <button key={item.id} type="button" className={`${index === currentIndex ? "is-current" : ""}${answers[item.id] ? " is-answered" : ""}`} aria-label={`前往第 ${index + 1} 题${answers[item.id] ? "，已作答" : "，未作答"}`} aria-current={index === currentIndex ? "step" : undefined} onClick={() => navigate(index)}>{answers[item.id] ? <Check size={13} /> : index + 1}</button>)}</div>
        </section>}

        {currentItem && <article className="question-card diagnosis-focus-card">
          <header className="diagnosis-question-meta"><span>第 {currentIndex + 1} / {items.length} 题</span><small>{currentItem.concept}</small></header>
          <h2>{currentItem.question}</h2>
          <div className="diagnosis-options">{currentItem.options.map((option, index) => <label className={answers[currentItem.id] === option ? "is-selected" : ""} key={option}><input type="radio" name={`diagnosis-${currentItem.id}`} aria-label={option} checked={answers[currentItem.id] === option} disabled={submitted} onChange={() => { setIncompleteMessage(""); onAnswer(currentItem.id, option) }} /><span className="option-letter">{String.fromCharCode(65 + index)}</span><span>{option}</span></label>)}</div>
          {!submitted && <footer className="diagnosis-question-nav"><button className="secondary-action" type="button" disabled={currentIndex === 0} onClick={() => navigate(currentIndex - 1)}><ChevronLeft size={17} />上一题</button><span>{answers[currentItem.id] ? "本题已作答" : "请选择一个答案"}</span><button className="secondary-action" type="button" disabled={currentIndex === items.length - 1} onClick={() => navigate(currentIndex + 1)}>下一题<ChevronRight size={17} /></button></footer>}
        </article>}

        {incompleteMessage && <p className="diagnosis-incomplete" role="alert"><CircleAlert size={17} />{incompleteMessage}</p>}
        </>}

      {submitted && <div className={`diagnosis-result ${ratio >= 0.8 && score.total >= 3 ? "is-correct" : "is-needs-work"}`} role="status"><strong>客观诊断已完成 · {score.correct} / {score.total} 题</strong><p>{resultLabel}。{evidenceLabel}；B 已接收全部作答证据并重新运行画像，详细概念结论请在下一页查看。</p></div>}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回计划信息</button>{submitted ? <button className="primary-action" type="button" onClick={onContinue}>查看学情画像</button> : unavailable ? <button className="primary-action" type="button" disabled={submitting} onClick={onSubmit}>{submitting ? "正在更新 B/A/C…" : "跳过客观诊断并生成学习内容"}</button> : <button className="primary-action" type="button" disabled={submitting || items.length === 0} onClick={submit}>{submitting ? "正在更新 B/A/C…" : `提交 ${items.length} 道诊断题`}</button>}</div>
    </section>
  )
}
