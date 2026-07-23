import { X } from "lucide-react"
import { useMemo, useState } from "react"
import type { Difficulty } from "../domain/types"
import type { NewLearningPlanInput } from "../domain/create-learning-plan"

interface NewPlanDialogProps {
  onCancel: () => void
  onCreate: (input: NewLearningPlanInput) => Promise<void>
}

const levels: Array<{ value: Difficulty; label: string }> = [
  { value: "beginner", label: "刚刚接触" },
  { value: "basic", label: "有一点基础" },
  { value: "intermediate", label: "可以独立编程" },
]

export function NewPlanDialog({ onCancel, onCreate }: NewPlanDialogProps) {
  const [learnerId, setLearnerId] = useState("")
  const [educationContext, setEducationContext] = useState("")
  const [timeBudget, setTimeBudget] = useState("")
  const [selfRating, setSelfRating] = useState<Difficulty>("beginner")
  const [knownText, setKnownText] = useState("")
  const [weakText, setWeakText] = useState("")
  const [goal, setGoal] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const valid = useMemo(() => learnerId.trim().length > 0 && goal.trim().length > 0, [learnerId, goal])

  const submit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    setError("")
    try {
      await onCreate({
        learnerId: learnerId.trim(),
        educationContext: educationContext.trim(),
        timeBudget: timeBudget.trim(),
        selfRating,
        knownConcepts: splitConcepts(knownText),
        weakConcepts: splitConcepts(weakText),
        goal: goal.trim(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新计划创建失败")
      setSubmitting(false)
    }
  }

  return (
    <div className="dialog-backdrop new-plan-backdrop" role="presentation">
      <section className="new-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="new-plan-title">
        <header><div><span className="section-kicker">REAL A/B/C PIPELINE</span><h2 id="new-plan-title">新建学习计划</h2><p>B 生成画像，A 检索知识库，C 生成并验证讲义、实验和分阶题。</p></div><button type="button" aria-label="关闭新建计划" onClick={onCancel}><X size={20} /></button></header>
        <div className="new-plan-form">
          <label><span>学习者编号 *</span><input value={learnerId} onChange={(event) => setLearnerId(event.target.value)} placeholder="例如 student-001" /></label>
          <label><span>教育背景</span><input value={educationContext} onChange={(event) => setEducationContext(event.target.value)} placeholder="例如 大二非计算机专业" /></label>
          <label><span>每周学习时间</span><input value={timeBudget} onChange={(event) => setTimeBudget(event.target.value)} placeholder="例如 每周 4 小时" /></label>
          <fieldset><legend>自评水平</legend><div className="new-plan-levels">{levels.map((level) => <label className={selfRating === level.value ? "is-selected" : ""} key={level.value}><input type="radio" name="new-plan-level" checked={selfRating === level.value} onChange={() => setSelfRating(level.value)} /><span>{level.label}</span></label>)}</div></fieldset>
          <label><span>已经学过的知识</span><input value={knownText} onChange={(event) => setKnownText(event.target.value)} placeholder="变量、列表；用逗号分隔" /></label>
          <label><span>觉得薄弱的知识</span><input value={weakText} onChange={(event) => setWeakText(event.target.value)} placeholder="循环、函数；用逗号分隔" /></label>
          <label className="full-row"><span>学习目标 *</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} placeholder="例如 完成成绩统计程序" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer><span>Week 1 成绩统计目标将运行官方 C 确定性流水线；不支持的目标会明确显示受阻原因。</span><div><button className="secondary-action" type="button" onClick={onCancel}>取消</button><button className="primary-action" type="button" disabled={!valid || submitting} onClick={submit}>{submitting ? "正在运行 A/B/C…" : "创建并运行 A/B/C"}</button></div></footer>
      </section>
    </div>
  )
}

function splitConcepts(value: string): string[] {
  return [...new Set(value.split(/[，,、;；\n]+/).map((item) => item.trim()).filter(Boolean))]
}
