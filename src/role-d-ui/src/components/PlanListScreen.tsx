import { ArrowRight, Plus } from "lucide-react"
import type { LearningPlanRecord, LocalLearner } from "../domain/workspace-store"

interface PlanListScreenProps {
  user: LocalLearner
  plans: LearningPlanRecord[]
  saved: boolean
  onCreate: () => void
  onOpen: (planId: string) => void
  onSwitchUser: () => void
}

export function PlanListScreen({ user, plans, saved, onCreate, onOpen, onSwitchUser }: PlanListScreenProps) {
  const sorted = [...plans].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return (
    <main className="entry-shell">
      <section className="entry-card plan-list-card" aria-labelledby="plan-list-title">
        <header className="plan-list-header">
          <div><span className="section-kicker">LEARNING PLANS</span><h1 id="plan-list-title">{user.displayName}的学习计划</h1><p>{user.educationContext || "未填写专业或身份"} · {levelLabel(user.selfRating)} · {user.timeBudget || "未填写学习时间"}</p></div>
          <div><button className="secondary-action" type="button" onClick={onSwitchUser}>切换用户</button>{sorted.length > 0 && <button className="primary-action" type="button" aria-label="新建学习计划" onClick={onCreate}><Plus size={17} />新建计划</button>}</div>
        </header>
        {sorted.length === 0 ? (
          <div className="empty-plan-state"><strong>还没有学习计划</strong><p>为当前用户创建第一个知识点学习计划，之后可以从这里接着上次进度继续。</p><button className="primary-action" type="button" onClick={onCreate}><Plus size={17} />新建学习计划</button></div>
        ) : (
          <div className="plan-card-grid">{sorted.map((plan) => <article className="plan-card" key={plan.id}><span>{stageLabel(plan.session.view.currentStage)} · 进度 {stageProgress(plan.session.view.currentStage)} / 6</span><h2>{plan.title}</h2><p>{plan.session.profile.goal}</p><small>最近学习：{formatDate(plan.updatedAt)}</small><button type="button" aria-label={`继续学习：${plan.title}`} onClick={() => onOpen(plan.id)}>继续学习<ArrowRight size={16} /></button></article>)}</div>
        )}
        <footer className={`local-only-note${saved ? "" : " is-error"}`}>{saved ? "所有用户与计划目前仅保存在这台设备；尚未接入真实账号登录或云同步。" : "保存失败：浏览器未允许写入本机进度，请检查隐私或存储设置。"}</footer>
      </section>
    </main>
  )
}

function levelLabel(level: LocalLearner["selfRating"]): string {
  return ({ beginner: "刚刚接触", basic: "有一点基础", intermediate: "可以独立编程", integrated: "能够综合运用" })[level]
}

function stageLabel(stage: LearningPlanRecord["session"]["view"]["currentStage"]): string {
  return ({ onboarding: "学习建档", diagnosis: "客观诊断", profile: "学情画像", plan: "定制方案", learning: "学习实操", feedback: "反馈调整" })[stage]
}

function stageProgress(stage: LearningPlanRecord["session"]["view"]["currentStage"]): number {
  return ({ onboarding: 1, diagnosis: 2, profile: 3, plan: 4, learning: 5, feedback: 6 })[stage]
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
}
