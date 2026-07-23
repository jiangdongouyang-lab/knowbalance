import type { RoleDSession } from "../domain/types"

interface DiagnosisScreenProps {
  diagnosis: RoleDSession["diagnosis"]
  answer: string
  submitted: boolean
  onAnswer: (answer: string) => void
  onSubmit: () => void
  onContinue: () => void
  onBack: () => void
}

export function DiagnosisScreen({ diagnosis, answer, submitted, onAnswer, onSubmit, onContinue, onBack }: DiagnosisScreenProps) {
  const correct = normalize(answer) === normalize(diagnosis.answer)
  return (
    <section className="stage-screen diagnosis-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 2 / 6 · 客观诊断</span><h1>用一道真实题目确认基础</h1><p>题目来自 Python 知识库 {diagnosis.sourceId}，用于校正“{diagnosis.concept}”自评，不会用模型临时编造。</p></div>
      <article className="question-card"><span className="question-source">知识库题目 · {diagnosis.sourceId}-{diagnosis.factId}</span><h2>{diagnosis.question}</h2><div className="diagnosis-options">{diagnosis.options.map((item) => <label className={answer === item ? "is-selected" : ""} key={item}><input type="radio" name="diagnosis" aria-label={item} checked={answer === item} onChange={() => onAnswer(item)} /><span>{item}</span></label>)}</div></article>
      {submitted && <div className={`diagnosis-result ${correct ? "is-correct" : "is-needs-work"}`} role="status"><strong>客观诊断已完成</strong><p>{correct ? `回答正确：${diagnosis.concept}基础较稳定。` : `本题未通过：B 已把${diagnosis.concept}更新为优先补强知识点，并重新触发 A 检索。`}</p></div>}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回修改目标</button>{submitted ? <button className="primary-action" type="button" onClick={onContinue}>查看学情画像</button> : <button className="primary-action" type="button" disabled={!answer} onClick={onSubmit}>提交诊断</button>}</div>
    </section>
  )
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
