import { AlertTriangle, CheckCircle2, FileText, Search, Sparkles } from "lucide-react"
import type { LearningArtifactView, RetrievalItemView } from "../domain/types"

interface EvidenceInspectorProps {
  items: RetrievalItemView[]
  artifacts: LearningArtifactView[]
  selectedSourceId: string
  onSelect: (sourceId: string) => void
}

const scoreLabels: Record<string, string> = {
  keyword: "关键词",
  title: "标题",
  facts: "知识事实",
  practiceTasks: "练习任务",
  difficulty: "难度匹配",
  bonus: "意图加分",
}

export function EvidenceInspector({ items, artifacts, selectedSourceId, onSelect }: EvidenceInspectorProps) {
  const selected = items.find((item) => item.sourceId === selectedSourceId)
  if (!selected) return null
  const factKeys = new Set(items.flatMap((item) => item.facts.map((fact) => `${fact.sourceId}-${fact.factId}`)))
  const hasCitationGap = artifacts.some((artifact) => artifact.evidenceStatus === "gap")
  const hasMockContent = artifacts.some((artifact) => artifact.status === "mock")
  const scoreEntries = Object.entries(selected.trace.scoreBreakdown).filter(([, value]) => value > 0)
  const maxScore = Math.max(1, ...scoreEntries.map(([, value]) => value))

  return (
    <section className="panel evidence-panel" aria-labelledby="evidence-title">
      <div className="panel-heading">
        <div><span className="section-kicker">TRACEABLE EVIDENCE</span><h2 id="evidence-title">检索轨迹与生成内容引用</h2></div>
        <span className={hasCitationGap ? "evidence-gap-badge" : "verified-badge"}>{hasCitationGap ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}{hasCitationGap ? "存在引用缺口" : "事实来源已匹配"}</span>
      </div>

      <section className="evidence-section evidence-recommendations" aria-labelledby="recommendation-title">
        <h3 id="recommendation-title">推荐知识点</h3>
        <div className="retrieval-picker">
          {items.map((item) => (
            <button type="button" className={item.sourceId === selected.sourceId ? "is-active" : ""} aria-label={`${item.sourceId} ${item.title} ${item.difficulty}`} onClick={() => onSelect(item.sourceId)} key={item.sourceId}>
              <span>{item.sourceId}</span><strong title={item.title}>{item.title}</strong><small>{item.difficulty} · {item.score} pts</small>
            </button>
          ))}
        </div>
      </section>

      <article className="evidence-detail">
        <div className="evidence-title-row"><span className="source-token">{selected.sourceId}</span><div><strong>{selected.title}</strong><p>{selected.difficulty} · 检索分 {selected.score}</p></div></div>
        <section className="evidence-section" aria-labelledby="reason-title"><h3 id="reason-title">推荐原因</h3><p className="evidence-reason">{selected.reason}</p></section>
        <p className="snippet">“{selected.snippet}”</p>

        <div className="trace-grid">
          <section className="evidence-section" aria-labelledby="keywords-title"><h3 id="keywords-title"><Search size={13} />匹配证据</h3><div className="token-row">{selected.trace.matchedKeywords.map((item) => <span key={item}>{item}</span>)}</div></section>
          <section className="evidence-section" aria-labelledby="fields-title"><h3 id="fields-title"><Sparkles size={13} />匹配字段</h3><div className="token-row muted">{selected.trace.matchedFields.map((item) => <span key={item}>{item}</span>)}</div></section>
        </div>

        <section className="evidence-section" aria-labelledby="score-title"><h3 id="score-title">分数构成</h3><div className="score-list">
          {scoreEntries.map(([label, value]) => <div className="score-row" key={label}><span>{scoreLabels[label] ?? label}</span><i><b style={{ width: `${(value / maxScore) * 100}%` }} /></i><strong>+{value}</strong></div>)}
          {scoreEntries.length === 0 && <p className="evidence-empty">当前结果没有正向分数组成。</p>}
        </div></section>

        <section className="evidence-section" aria-labelledby="sources-title"><h3 id="sources-title">知识来源</h3><div className="fact-list">
          {selected.facts.map((fact) => (
            <div className="fact-row" key={`${fact.sourceId}-${fact.factId}`}>
              <div className="fact-id"><span>source_id: {fact.sourceId}</span><span>fact_id: {fact.factId}</span></div><p>{fact.content}</p>
            </div>
          ))}
          {selected.facts.length === 0 && <p className="evidence-empty">当前推荐知识点没有可用的事实来源。</p>}
        </div></section>
        <div className="source-file"><FileText size={14} /><span>{selected.file}</span></div>
      </article>

      <section className="evidence-section artifact-citations" aria-labelledby="citations-title">
        <div className="evidence-section-heading"><h3 id="citations-title">生成内容引用</h3><span className={hasMockContent ? "mock-badge" : "verified-badge"}>{hasMockContent ? "生成内容 MOCK" : "生成内容 REAL"}</span></div>
        <p className="evidence-section-intro">逐项核对生成资源中的 citations；REAL 表示通过 C 官方发布门禁，MOCK 表示演示或未发布内容。</p>
        <div className="citation-audit-list">
          {artifacts.map((artifact) => (
            <article key={artifact.id}>
              <div><strong>{artifact.title}</strong><span className={artifact.status === "mock" ? "mock-badge" : "verified-badge"}>{artifact.status === "mock" ? "MOCK" : "REAL"}</span></div>
              <p>{artifact.kind === "lesson" ? "定制讲义" : artifact.kind === "lab" ? "代码实验" : "分阶测评"}</p>
              <div className="citation-audit-row">
                {artifact.citations.map((citation) => {
                  const label = `${citation.sourceId}-${citation.factId}`
                  return factKeys.has(label)
                    ? <button type="button" onClick={() => onSelect(citation.sourceId)} key={label}>{label}</button>
                    : <span className="invalid-citation" key={label}>{label}</span>
                })}
                {artifact.evidenceStatus === "gap" && <span className="citation-gap"><AlertTriangle size={13} />引用缺失或未命中检索事实</span>}
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  )
}
