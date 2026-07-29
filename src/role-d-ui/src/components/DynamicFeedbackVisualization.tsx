import type { RoleDSession } from "../domain/types"

interface DynamicFeedbackVisualizationProps {
  session: RoleDSession
}

type FeedbackBranch = "remediate" | "reinforce" | "advance"

const branches: Array<{
  id: FeedbackBranch
  threshold: string
  title: string
  description: string
  destination: string
}> = [
  {
    id: "remediate",
    threshold: "低于 40%",
    title: "补救 · 降维解释",
    description: "回到当前知识点，用更小步骤、更多示例和三级提示重新讲解。",
    destination: "重新进入当前讲义与基础练习",
  },
  {
    id: "reinforce",
    threshold: "40%–80%",
    title: "巩固练习",
    description: "保留当前难度，通过同族变式和薄弱项练习稳定掌握度。",
    destination: "进入当前知识点的巩固任务",
  },
  {
    id: "advance",
    threshold: "达到 80%",
    title: "进阶挑战",
    description: "证据充分时提高任务复杂度，并推进到后续路径节点。",
    destination: "进入进阶任务或下一个知识点",
  },
]

export function DynamicFeedbackVisualization({ session }: DynamicFeedbackVisualizationProps) {
  const selected = session.assessmentGraded ? normalizeDecision(session.decision.next) : undefined
  const selectedBranch = branches.find((branch) => branch.id === selected)
  const decisionTitle = selectedBranch ? `C 已返回：${selectedBranch.title}` : "等待 C 正式评分"
  const scoreLabel = session.feedback
    ? `本轮正确率：${Math.round(session.feedback.roundScore.accuracy * 100)}%`
    : undefined

  return (
    <section className="dynamic-feedback-card" aria-labelledby="dynamic-feedback-title">
      <header className="dynamic-feedback-heading">
        <div>
          <span className="section-kicker">ROLE C → ROLE D</span>
          <h2 id="dynamic-feedback-title">C 动态反馈决策图</h2>
          <p>D 负责把 C 的补救、巩固、进阶决策可视化；评分和分支判断仍由 C 返回。</p>
        </div>
        <span className={session.assessmentGraded ? "feedback-state verified" : "feedback-state pending"}>
          {session.assessmentGraded ? "正式决策" : "等待评分"}
        </span>
      </header>

      <div className="feedback-policy-track" aria-label="C 动态反馈阈值分支">
        {branches.map((branch, index) => (
          <article
            className={`feedback-policy-branch branch-${branch.id}${selected === branch.id ? " selected" : ""}`}
            data-testid={`feedback-branch-${branch.id}`}
            key={branch.id}
          >
            <div className="feedback-branch-topline">
              <span>{index + 1}</span>
              <strong>{branch.threshold}</strong>
            </div>
            <h3>{branch.title}</h3>
            <p>{branch.description}</p>
            <small>{branch.destination}</small>
          </article>
        ))}
      </div>

      <div className={`feedback-current-result${selected ? ` result-${selected}` : " result-pending"}`}>
        <div>
          <span>当前分支状态</span>
          <strong>{decisionTitle}</strong>
        </div>
        <p>{session.assessmentGraded
          ? `${scoreLabel ?? ""}${scoreLabel ? " · " : ""}${session.decision.reason}`
          : session.view.assessmentSubmitted
            ? "D 已保存公开作答；待 C 返回正式评分、掌握度与 next_action 后，高亮对应分支。"
            : "完成并提交正式测评后，D 将在这里展示 C 返回的补救、巩固或进阶结果。"}</p>
      </div>

      <footer className="feedback-policy-note">
        <span>阈值来源：C role-c-round-accuracy-v1</span>
        <span>未正式评分时不推算正确率，不伪造分支结果</span>
      </footer>
    </section>
  )
}

function normalizeDecision(next: RoleDSession["decision"]["next"]): FeedbackBranch | undefined {
  if (next === "consolidate" || next === "reinforce") return "reinforce"
  if (next === "remediate" || next === "advance") return next
  return undefined
}
