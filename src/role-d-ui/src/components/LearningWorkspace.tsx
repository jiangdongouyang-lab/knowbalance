import { BookOpenText, Braces, ClipboardCheck, ExternalLink, FlaskConical } from "lucide-react"
import type { ArtifactKind, LearningArtifactView } from "../domain/types"

interface LearningWorkspaceProps {
  artifacts: LearningArtifactView[]
  activeKind: ArtifactKind
  onKindChange: (kind: ArtifactKind) => void
  onCitationSelect: (sourceId: string) => void
}

const tabs: Array<{ kind: ArtifactKind; label: string; icon: typeof BookOpenText }> = [
  { kind: "lesson", label: "定制讲义", icon: BookOpenText },
  { kind: "lab", label: "代码实验", icon: Braces },
  { kind: "assessment", label: "分阶测评", icon: ClipboardCheck },
]

export function LearningWorkspace({ artifacts, activeKind, onKindChange, onCitationSelect }: LearningWorkspaceProps) {
  const artifact = artifacts.find((item) => item.kind === activeKind) ?? artifacts[0]
  if (!artifact) return <section className="panel workspace-panel workspace-blocked"><span className="mock-badge">C 生成未就绪</span><h2>当前没有可发布的学习资源</h2><p>请打开“查看 A/B/C 执行链”，检查 Role C 的证据缺口或受阻原因。A/B 画像与检索结果仍已保留。</p></section>
  const isReal = artifact.status === "real"
  return (
    <section className="panel workspace-panel" aria-labelledby="workspace-title">
      <div className="workspace-header">
        <div><span className="section-kicker">LEARNING WORKSPACE</span><h2 id="workspace-title">当前学习资源</h2></div>
        <span className={isReal ? "verified-badge" : "mock-badge"}>{isReal ? "C 官方流水线 · REAL" : "C 生成未就绪"}</span>
      </div>
      <div className="resource-tabs" role="tablist" aria-label="学习资源类型">
        {tabs.map(({ kind, label, icon: Icon }) => (
          <button id={`resource-tab-${kind}`} type="button" role="tab" aria-controls={`resource-panel-${kind}`} aria-selected={activeKind === kind} className={activeKind === kind ? "is-active" : ""} key={kind} onClick={() => onKindChange(kind)}>
            <Icon size={15} />{label}
          </button>
        ))}
      </div>
      <article id={`resource-panel-${artifact.kind}`} className="resource-body" role="tabpanel" aria-labelledby={`resource-tab-${artifact.kind}`} tabIndex={0}>
        <span className="resource-number">当前学习节点</span>
        <h3>{artifact.title}</h3>
        {artifact.kind === "lab" ? <pre><code>{artifact.content}</code></pre> : artifact.kind !== "assessment" ? <p className="resource-prose">{artifact.content}</p> : null}
        {artifact.kind === "assessment" && <AssessmentPreview artifact={artifact} />}
        <aside className="resource-guidance">
          <strong>为什么现在学习这个？</strong>
          <p>{isReal ? "当前内容由 C 官方流水线基于 B 画像、A 检索证据和统一 GenerationSpec 生成，并已通过引用与结构门禁。" : "C 未能为当前证据生成可发布资源，请查看 Agent 详情中的受阻原因。"}</p>
        </aside>
        <div className="citation-row">
          <span><FlaskConical size={14} /> 知识依据</span>
          {artifact.citations.map((citation) => {
            const label = `${citation.sourceId}-${citation.factId}`
            return <button type="button" aria-label={`查看引用 ${label}`} onClick={() => onCitationSelect(citation.sourceId)} key={label}>{label}<ExternalLink size={11} /></button>
          })}
        </div>
      </article>
    </section>
  )
}

function AssessmentPreview({ artifact }: { artifact: LearningArtifactView }) {
  const items = artifact.items ?? []
  if (items.length === 0) return <p className="mock-empty">当前没有可发布的分阶测评题。</p>
  return (
    <div className="assessment-preview" aria-label="C 生成的分阶测评题">
      <p className="assessment-note">以下为 C 已验证的公开题面。正确答案、评分规范和隐藏测试保留在服务端。</p>
      {items.map((item, index) => (
        <article className="assessment-item" key={item.id}>
          <div><span>第 {index + 1} 题</span><small>Tier {item.tier} · {modalityLabel(item.modality)}</small></div>
          <h4>{item.prompt}</h4>
          {item.options.length > 0 && <div className="answer-options">{item.options.map((option) => <button type="button" key={option}>{option}</button>)}</div>}
          {item.starterCode && <pre><code>{item.starterCode}</code></pre>}
        </article>
      ))}
    </div>
  )
}

function modalityLabel(modality: NonNullable<LearningArtifactView["items"]>[number]["modality"]): string {
  return ({ mcq: "选择题", true_false: "判断题", trace: "代码追踪", short_answer: "简答题", code: "代码题" })[modality]
}
