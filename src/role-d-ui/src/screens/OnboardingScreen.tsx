import type { Difficulty } from "../domain/types"

interface OnboardingScreenProps {
  isDemo?: boolean
  goal: string
  selfRating: Difficulty
  onGoalChange: (goal: string) => void
  onRatingChange: (rating: Difficulty) => void
  onContinue: () => Promise<void> | void
  submitting?: boolean
  error?: string
}

const levels: Array<{ value: Difficulty; label: string; detail: string }> = [
  { value: "beginner", label: "刚刚接触", detail: "需要从概念和直观例子开始" },
  { value: "basic", label: "有一点基础", detail: "能看懂简单代码，但综合运用不稳定" },
  { value: "intermediate", label: "可以独立编程", detail: "希望补齐知识盲区并挑战项目" },
]

export function OnboardingScreen({ isDemo = true, goal, selfRating, onGoalChange, onRatingChange, onContinue, submitting = false, error }: OnboardingScreenProps) {
  return (
    <section className="stage-screen onboarding-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 1 / 6 · 学习建档</span><h1>先告诉我们你的学习目标</h1><p>目标和自评只用于确定诊断起点，系统还会用客观题目校正画像。</p></div>
      <div className="form-section">
        <label htmlFor="learning-goal">这次你想学会什么？</label>
        <textarea id="learning-goal" value={goal} onChange={(event) => onGoalChange(event.target.value)} rows={4} />
        <small>{isDemo ? "已根据案例集画像预填，你可以直接修改；下一步会真实运行 B / A / C。" : "已根据新建计划预填，修改后会用于下一步诊断。"}</small>
      </div>
      <fieldset className="rating-options"><legend>你觉得自己目前处于什么水平？</legend>{levels.map((level) => <label className={selfRating === level.value ? "is-selected" : ""} key={level.value}><input type="radio" name="self-rating" checked={selfRating === level.value} onChange={() => onRatingChange(level.value)} /><span><strong>{level.label}</strong><small>{level.detail}</small></span></label>)}</fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="screen-actions"><span>{isDemo ? "将运行真实 B / A / C 流水线" : "下一阶段预计用时 2 分钟"}</span><button className="primary-action" type="button" disabled={!goal.trim() || submitting} onClick={onContinue}>{submitting ? "正在运行 B/A/C…" : "下一步：客观诊断"}</button></div>
    </section>
  )
}
