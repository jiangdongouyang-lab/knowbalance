import { Check, Flag, LockKeyhole } from "lucide-react"
import type { LearningPathNodeView } from "../domain/types"

interface LearningPathProps {
  nodes: LearningPathNodeView[]
}

export function LearningPath({ nodes }: LearningPathProps) {
  return (
    <section className="panel path-panel" aria-labelledby="path-title">
      <div className="panel-heading">
        <div><span className="section-kicker">ADAPTIVE ROUTE</span><h2 id="path-title">个性化学习路径</h2></div>
        <span className="quiet-badge">动态调整中</span>
      </div>
      <ol className="path-list">
        {nodes.map((node, index) => (
          <li className={`path-node ${node.status}`} key={node.id} title={node.reason}>
            <span className="path-marker">
              {node.status === "completed" ? <Check size={14} /> : node.status === "current" ? <Flag size={14} /> : <LockKeyhole size={12} />}
            </span>
            <span className="path-copy"><strong>{node.title}</strong><small>{node.difficulty}</small></span>
            {index < nodes.length - 1 && <span className="path-connector" />}
          </li>
        ))}
      </ol>
      <p className="path-rationale"><strong>当前路径依据：</strong>{nodes.find((node) => node.status === "current")?.reason}</p>
    </section>
  )
}
