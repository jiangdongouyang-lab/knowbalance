import { buildDifficultyMatchSeries } from "../domain/difficulty-match"
import type { AuditStatusView, RoleDSession, WorkflowStatus } from "../domain/types"

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

const levelScore: Record<RoleDSession["profile"]["level"], number> = {
  beginner: 35,
  basic: 55,
  intermediate: 75,
  integrated: 90,
}

const auditStatusLabel: Record<AuditStatusView, string> = {
  pass: "通过",
  revise: "需修订",
  reject: "驳回",
}

export function Week2VisualizationReport({ session }: Week2VisualizationReportProps) {
  const matchSeries = buildDifficultyMatchSeries(session.profile.level, session.retrieval.items)
  const radarAxes = buildRadarAxes(session)
  const radarPoints = radarAxes.map((axis, index) => radarPoint(index, radarAxes.length, axis.score))
  const workflowCounts = summarizeWorkflow(session.workflow)
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
        <article className="week2-card radar-card" aria-labelledby="ability-radar-title">
          <div className="week2-card-heading">
            <span>能力雷达图</span>
            <strong>{session.profile.level}</strong>
          </div>
          <svg className="ability-radar" role="img" aria-label="能力雷达图" viewBox="0 0 240 210">
            <title id="ability-radar-title">能力雷达图</title>
            <polygon className="radar-grid outer" points={radarPolygon(100)} />
            <polygon className="radar-grid middle" points={radarPolygon(66)} />
            <polygon className="radar-grid inner" points={radarPolygon(33)} />
            {radarAxes.map((axis, index) => {
              const end = radarPoint(index, radarAxes.length, 100)
              const label = radarPoint(index, radarAxes.length, 116)
              return (
                <g key={axis.label}>
                  <line className="radar-axis" x1="120" y1="105" x2={end.x} y2={end.y} />
                  <text className="radar-label" x={label.x} y={label.y}>{axis.label}</text>
                </g>
              )
            })}
            <polygon className="radar-value" points={radarPoints.map((point) => `${point.x},${point.y}`).join(" ")} />
            {radarAxes.map((axis, index) => {
              const point = radarPoints[index]!
              return <circle className="radar-dot" key={axis.label} cx={point.x} cy={point.y} r="3.5" />
            })}
          </svg>
          <div className="radar-legend">
            {radarAxes.map((axis) => <span key={axis.label}><b>{axis.score}</b>{axis.label}</span>)}
          </div>
        </article>

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
            {session.workflow.map((event) => (
              <div className={`week2-agent-step status-${event.status}`} key={event.id}>
                <span>{statusLabel[event.status]}</span>
                <strong>{event.stage}</strong>
                <small>{event.agent}</small>
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

function buildRadarAxes(session: RoleDSession) {
  const known = session.profile.knownConcepts.length
  const weak = session.profile.weakConcepts.length
  const resolvedPath = session.path.filter((node) => node.status === "completed" || node.status === "current").length
  const grounded = session.artifacts.filter((artifact) => artifact.evidenceStatus === "grounded").length
  const difficultyFits = session.retrieval.items.filter((item) => item.trace.difficultyMatch).length

  return [
    { label: "画像", score: levelScore[session.profile.level] },
    { label: "掌握", score: percentage(known, Math.max(known + weak, 1)) },
    { label: "溯源", score: percentage(grounded, Math.max(session.artifacts.length, 1)) },
    { label: "路径", score: percentage(resolvedPath, Math.max(session.path.length, 1)) },
    { label: "匹配", score: percentage(difficultyFits, Math.max(session.retrieval.items.length, 1)) },
  ]
}

function summarizeWorkflow(events: RoleDSession["workflow"]) {
  return {
    total: events.length,
    finished: events.filter((event) => event.status === "completed" || event.status === "review").length,
  }
}

function percentage(value: number, total: number): number {
  return Math.round(Math.max(0, Math.min(1, value / total)) * 100)
}

function radarPolygon(score: number): string {
  return Array.from({ length: 5 }, (_, index) => {
    const point = radarPoint(index, 5, score)
    return `${point.x},${point.y}`
  }).join(" ")
}

function radarPoint(index: number, total: number, score: number) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total
  const radius = score * 0.82
  return { x: 120 + Math.cos(angle) * radius, y: 105 + Math.sin(angle) * radius }
}
