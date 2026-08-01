import { AlertTriangle, BookOpenCheck, Target, X } from "lucide-react"
import { useState } from "react"
import type { ReactNode } from "react"

interface OnboardingScreenProps {
  isDemo?: boolean
  isDraft?: boolean
  goal: string
  knownConcepts: string[]
  weakConcepts: string[]
  learnerLevelLabel: string
  onGoalChange: (goal: string) => void
  onKnownConceptsChange: (concepts: string[]) => void
  onWeakConceptsChange: (concepts: string[]) => void
  onContinue: () => Promise<void> | void
  submitting?: boolean
  error?: string
}

export function OnboardingScreen({ isDemo = true, isDraft = false, goal, knownConcepts, weakConcepts, learnerLevelLabel, onGoalChange, onKnownConceptsChange, onWeakConceptsChange, onContinue, submitting = false, error }: OnboardingScreenProps) {
  return (
    <section className="stage-screen onboarding-screen">
      <div className="screen-heading onboarding-heading"><span className="screen-step">学习流程 1 / 6 · 学习建档</span><h1>规划这一次的学习</h1><p>只填写本次计划相关的信息。你的基础水平会直接复用用户档案，后续再由客观诊断进行校正。</p></div>

      <div className="onboarding-card-grid">
        <article className="onboarding-step-card onboarding-goal-card">
          <div className="onboarding-card-title"><span><Target size={18} /></span><div><small>STEP 01</small><h2>本次想学会什么</h2></div></div>
          <label className="sr-only" htmlFor="learning-goal">这次你想学会什么？</label>
          <textarea id="learning-goal" value={goal} onChange={(event) => onGoalChange(event.target.value)} rows={4} placeholder="例如：理解 Python 变量与赋值，并能用变量保存和更新数据" />
          <div className="field-footnote"><span>{isDemo ? "可以修改案例预填目标" : "写清楚希望最终做到什么"}</span><span>{goal.trim().length} 字</span></div>
        </article>

        <ConceptTagCard
          kind="known"
          icon={<BookOpenCheck size={18} />}
          step="STEP 02"
          title="已经学过什么"
          label="本次计划已经学过的知识"
          placeholder="输入知识点，用逗号或回车分隔"
          hint="没有已学知识可以留空"
          concepts={knownConcepts}
          onChange={onKnownConceptsChange}
        />

        <ConceptTagCard
          kind="weak"
          icon={<AlertTriangle size={18} />}
          step="STEP 03"
          title="哪些地方比较薄弱"
          label="本次计划觉得薄弱的知识"
          placeholder="输入薄弱点，用逗号或回车分隔"
          hint="这里只是自评，客观诊断会再次校正"
          concepts={weakConcepts}
          onChange={onWeakConceptsChange}
        />
      </div>

      <section className="onboarding-preview" aria-labelledby="onboarding-preview-title">
        <div><span className="section-kicker">PLAN PREVIEW</span><h2 id="onboarding-preview-title">本次学习档案预览</h2></div>
        <dl>
          <div><dt>学习目标</dt><dd>{goal.trim() || "等待填写"}</dd></div>
          <div><dt>已学知识</dt><dd>{knownConcepts.length > 0 ? knownConcepts.join("、") : "暂未填写"}</dd></div>
          <div><dt>薄弱知识</dt><dd>{weakConcepts.length > 0 ? weakConcepts.join("、") : "暂未填写"}</dd></div>
          <div><dt>学习水平</dt><dd>{learnerLevelLabel}（来自用户档案）</dd></div>
        </dl>
        <p className="preview-readable-summary">学习目标：{goal.trim() || "等待填写"}</p>
        <p className="preview-readable-summary">学习水平：{learnerLevelLabel}（来自用户档案）</p>
      </section>

      {isDraft && <p className="local-only-note">计划草稿已保存；本步骤才会运行 ABC，失败后可以修改并重试。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="screen-actions"><span>{isDemo ? "确认后开始运行真实 B / A / C" : "确认后开始生成客观诊断"}</span><button className="primary-action" type="button" disabled={!goal.trim() || submitting} onClick={onContinue}>{submitting ? "正在运行 B/A/C…" : "下一步：客观诊断"}</button></div>
    </section>
  )
}

interface ConceptTagCardProps {
  kind: "known" | "weak"
  icon: ReactNode
  step: string
  title: string
  label: string
  placeholder: string
  hint: string
  concepts: string[]
  onChange: (concepts: string[]) => void
}

function ConceptTagCard({ kind, icon, step, title, label, placeholder, hint, concepts, onChange }: ConceptTagCardProps) {
  const [text, setText] = useState(() => concepts.join("、"))
  const update = (value: string) => {
    setText(value)
    onChange(splitConcepts(value))
  }
  const remove = (concept: string) => {
    const next = concepts.filter((item) => item !== concept)
    setText(next.join("、"))
    onChange(next)
  }
  return (
    <article className={`onboarding-step-card concept-card ${kind}`}>
      <div className="onboarding-card-title"><span>{icon}</span><div><small>{step}</small><h2>{title}</h2></div></div>
      <label className="sr-only" htmlFor={`${kind}-concepts`}>{label}</label>
      <input id={`${kind}-concepts`} value={text} onChange={(event) => update(event.target.value)} placeholder={placeholder} />
      <div className="concept-tag-list" aria-live="polite">
        {concepts.map((concept) => <button key={concept} type="button" aria-label={`删除${kind === "known" ? "已学" : "薄弱"}知识 ${concept}`} onClick={() => remove(concept)}>{concept}<X size={13} /></button>)}
        {concepts.length === 0 && <span>尚未添加</span>}
      </div>
      <small className="concept-hint">{hint}</small>
    </article>
  )
}

function splitConcepts(value: string): string[] {
  return [...new Set(value.split(/[，,、;；\n]+/).map((item) => item.trim()).filter(Boolean))]
}
