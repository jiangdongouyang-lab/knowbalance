import { buildDifficultyMatchSeries } from "../domain/difficulty-match"
import type { AuditStatusView, RoleDSession, WorkflowStatus } from "../domain/types"
import { arrangeWorkflowForDisplay } from "../domain/workflow-display"

interface Week2VisualizationReportProps {
  session: RoleDSession
}

const statusLabel: Record<WorkflowStatus, string> = {
  pending: "等待",
  running: "运行中",
  completed: "完成",
  review: "审核",
  blocked: "受阻",
}


const auditStatusLabel: Record<AuditStatusView, string> = {
  pass: "通过",
  revise: "需修订",
  reject: "驳回",
}

export function Week2VisualizationReport({ session }: Week2VisualizationReportProps) {
  const matchSeries = buildDifficultyMatchSeries(session.profile.level, session.retrieval.items)

  const displayWorkflow = arrangeWorkflowForDisplay(session.workflow)
  const workflowCounts = summarizeWorkflow(displayWorkflow)
  const audit = session.audit

  return (
    <section className="week2-report" aria-labelledby="week2-report-title">
      <header className="week2-report-heading">
        <div>
          <span className="section-kicker">WEEK 2 ROLE D</span>
          <h2 id="week2-report-title">Week2 可视化报告</h2>
          <p>把画像、学习路径、资源匹配度和 Agent 协同过程放到同一个页面，方便演示时说明有没有做偏。</p>
        </div>
        <span>画像 + 路径 + 匹配度 + 双审核</span>
      </header>

      <div className="week2-report-grid">

        <article className="week2-card" aria-labelledby="week2-path-title">
          <div className="week2-card-heading">
            <h3 id="week2-path-title">学习路径图</h3>
            <strong>{session.path.length} 个节点</strong>
          </div>
          <ol className="week2-path-list">
            {session.path.map((node, index) => (
              <li className={`week2-path-node ${node.status}`} key={node.id}>
                <span>{index + 1}</span>
                <div><strong>{node.title}</strong><small>{node.difficulty} · {node.status}</small><p>{node.reason}</p></div>
              </li>
            ))}
          </ol>
        </article>

        <article className="week2-card" aria-labelledby="week2-match-title">
          <div className="week2-card-heading">
            <h3 id="week2-match-title">资源匹配度</h3>
            <strong>{matchSeries.points.length} 项资源</strong>
          </div>
          <div className="week2-match-metrics">
            <span><b>{matchSeries.summary.sameLevel}</b>同级</span>
            <span><b>{matchSeries.summary.gentleStretch}</b>相邻一级</span>
            <span><b>{matchSeries.summary.advanced}</b>远期目标</span>
          </div>
          <ul className="week2-match-list">
            {matchSeries.points.slice(0, 5).map((point) => <li key={point.sourceId}><strong>{point.sourceId}</strong><span>{point.title}</span><em>{point.relation}</em></li>)}
          </ul>
        </article>

        <article className="week2-card" aria-labelledby="week2-agent-title">
          <div className="week2-card-heading">
            <h3 id="week2-agent-title">Agent 协同过程展示</h3>
            <strong>{workflowCounts.finished}/{workflowCounts.total} 已流转</strong>
          </div>
          <div className="week2-agent-flow">
            {displayWorkflow.map((event) => (
              <div className={`week2-agent-step status-${event.status}`} key={event.id}>
                <span>{statusLabel[event.status]}</span>
                <strong>{event.stage}</strong>
                <small>{event.agent}</small>
                {event.status === "blocked" && <p>{event.summary}</p>}
              </div>
            ))}
          </div>
          <p className="week2-agent-note">当前 D 端只展示 C 返回的编程练习和沙箱结果；Docker 沙箱本身由 C 负责实现。</p>
        </article>

        <article className="week2-card week2-audit-card" aria-labelledby="week2-audit-title">
          <div className="week2-card-heading">
            <h3 id="week2-audit-title">A/B 双审核与仲裁</h3>
            <strong>{audit ? auditStatusLabel[audit.arbitration.decision] : "等待结果"}</strong>
          </div>
          {audit ? (
            <>
              <div className="week2-audit-summary">
                <span className={`audit-status audit-${audit.factStatus}`}><b>A 事实审核</b>{auditStatusLabel[audit.factStatus]}</span>
                <span className={`audit-status audit-${audit.teachingAudit.status}`}><b>B 教学审核</b>{auditStatusLabel[audit.teachingAudit.status]}</span>
                <span className={`audit-status audit-${audit.arbitration.decision}`}><b>仲裁结果</b>{auditStatusLabel[audit.arbitration.decision]}</span>
              </div>
              <p className="week2-audit-reason">{audit.arbitration.reason}</p>
              <ul className="week2-audit-list">
                {audit.factAudits.map((item) => (
                  <li key={item.artifactId}>
                    <strong>{item.artifactTitle}</strong>
                    <span className={`audit-status audit-${item.status}`}>{item.artifactKind} · {auditStatusLabel[item.status]}</span>
                    <small>{item.checkedClaims} 条检查，{item.conflicts} 个冲突</small>
                  </li>
                ))}
              </ul>
              {audit.teachingAudit.revisionHints.length > 0 && <p className="week2-audit-hint">{audit.teachingAudit.revisionHints[0]}</p>}
            </>
          ) : (
            <p className="week2-agent-note">等待 A 事实审核、B 教学审核和仲裁结果；D 不自行编造审核结论。</p>
          )}
        </article>
      </div>
    </section>
  )
}


function summarizeWorkflow(events: RoleDSession["workflow"]) {
  return {
    total: events.length,
    finished: events.filter((event) => event.status === "completed" || event.status === "review").length,
  }
}
