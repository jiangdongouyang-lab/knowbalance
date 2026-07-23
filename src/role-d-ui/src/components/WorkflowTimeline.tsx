import { Bot, Check, Clock3, LoaderCircle, ShieldAlert } from "lucide-react"
import type { WorkflowEventView } from "../domain/types"

interface WorkflowTimelineProps {
  events: WorkflowEventView[]
  localExecution?: boolean
  includesRoleC?: boolean
}

const statusIcon = {
  completed: Check,
  running: LoaderCircle,
  review: ShieldAlert,
  pending: Clock3,
  blocked: ShieldAlert,
}

export function WorkflowTimeline({ events, localExecution = false, includesRoleC = false }: WorkflowTimelineProps) {
  const finished = events.filter((event) => event.status === "completed" || event.status === "review").length
  return (
    <section className="panel workflow-panel" aria-labelledby="workflow-title">
      <div className="panel-heading">
        <div><span className="section-kicker">{localExecution ? "LOCAL VERIFIED PIPELINE" : "AGENT ORCHESTRATION"}</span><h2 id="workflow-title">{localExecution ? includesRoleC ? "A/B/C 执行链" : "A/B 本地执行链" : "多智能体协同"}</h2></div>
        <span className="status-summary"><i /> {finished}/{events.length} 已流转</span>
      </div>
      <div className="workflow-list">
        {events.map((event, index) => {
          const Icon = statusIcon[event.status]
          return (
            <article className={`workflow-item status-${event.status}`} key={event.id}>
              <div className="workflow-rail">
                <span className="workflow-node"><Icon size={14} /></span>
                {index < events.length - 1 && <span className="workflow-line" />}
              </div>
              <div className="workflow-copy">
                <div><strong>{event.stage}</strong><span className="agent-name"><Bot size={12} />{event.agent}</span></div>
                <p>{event.summary}</p>
              </div>
              <time>{event.timestamp}</time>
            </article>
          )
        })}
      </div>
    </section>
  )
}
