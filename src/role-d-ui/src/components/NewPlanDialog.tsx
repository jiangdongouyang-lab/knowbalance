import { X } from "lucide-react"
import { useMemo, useState } from "react"
import type { NewLearningPlanInput } from "../domain/create-learning-plan"
import type { LocalLearner } from "../domain/workspace-store"

interface NewPlanDialogProps {
  user: LocalLearner
  onCancel: () => void
  onCreate: (input: NewLearningPlanInput & { title: string }) => Promise<void>
}

export function NewPlanDialog({ user, onCancel, onCreate }: NewPlanDialogProps) {
  const [title, setTitle] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const valid = useMemo(() => title.trim().length > 0, [title])

  const submit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    setError("")
    try {
      await onCreate({
        title: title.trim(),
        learnerId: user.id,
        educationContext: user.educationContext,
        timeBudget: user.timeBudget,
        selfRating: user.selfRating,
        priorLanguages: user.priorLanguages,
        knownConcepts: [],
        weakConcepts: [],
        goal: "",
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新计划创建失败")
      setSubmitting(false)
    }
  }

  return (
    <div className="dialog-backdrop new-plan-backdrop" role="presentation">
      <section className="new-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="new-plan-title">
        <header><div><span className="section-kicker">{user.displayName.toUpperCase()} · NEW PLAN</span><h2 id="new-plan-title">新建学习计划</h2><p>先给计划起一个名称，进入学习建档后再填写目标、已学知识和薄弱知识。</p></div><button type="button" aria-label="关闭新建计划" disabled={submitting} onClick={onCancel}><X size={20} /></button></header>
        <div className="new-plan-form">
          <label className="full-row"><span>计划名称 *</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 循环与列表专项" /></label>
          <div className="profile-reuse-note full-row"><strong>复用用户档案</strong><span>{user.educationContext || "未填写专业或身份"} · {levelLabel(user.selfRating)} · {user.timeBudget || "未填写学习时间"}</span></div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer><span>创建后会先保存草稿，不会立即运行 ABC。</span><div><button className="secondary-action" type="button" disabled={submitting} onClick={onCancel}>取消</button><button className="primary-action" type="button" disabled={!valid || submitting} onClick={submit}>{submitting ? "正在创建…" : "创建学习计划"}</button></div></footer>
      </section>
    </div>
  )
}

function levelLabel(level: LocalLearner["selfRating"]): string {
  return ({ beginner: "刚刚接触", basic: "有一点基础", intermediate: "可以独立编程", integrated: "能够综合运用" })[level]
}
