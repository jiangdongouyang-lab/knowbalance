import { BarChart3, CircleDot, GraduationCap } from "lucide-react"
import { useState, type UIEvent } from "react"
import { buildDifficultyMatchSeries } from "../domain/difficulty-match"
import type { Difficulty, RetrievalItemView } from "../domain/types"

interface DifficultyMatchChartProps {
  learnerLevel: Difficulty
  items: RetrievalItemView[]
}

const WIDTH = 760
const HEIGHT = 260
const PLOT_LEFT = 82
const PLOT_RIGHT = 680
const PLOT_TOP = 30
const PLOT_BOTTOM = 194

export function DifficultyMatchChart({ learnerLevel, items }: DifficultyMatchChartProps) {
  const series = buildDifficultyMatchSeries(learnerLevel, items)
  const [scrollAtEnd, setScrollAtEnd] = useState(false)
  if (series.points.length === 0) {
    return <section className="difficulty-card" aria-labelledby="difficulty-title"><ChartHeading /><p className="difficulty-empty">知识检索暂未返回可绘制的推荐资源。</p></section>
  }

  const learnerY = yFor(series.learnerLevel.index)
  const pointStep = series.points.length === 1 ? 0 : (PLOT_RIGHT - PLOT_LEFT) / (series.points.length - 1)
  return (
    <section className="difficulty-card" aria-labelledby="difficulty-title">
      <ChartHeading />
      <div className="difficulty-summary">
        <span><GraduationCap size={15} />学生起点 <strong>{series.learnerLevel.label}</strong></span>
        <span>同级 <strong>{series.summary.sameLevel}</strong></span>
        <span>相邻一级 <strong>{series.summary.gentleStretch}</strong></span>
        <span>跨两级以上 <strong>{series.summary.advanced}</strong></span>
      </div>

      <div className="difficulty-explainer"><strong>横轴：知识资源推荐顺序</strong><span>横向间距无数值含义</span><span>检索分只用于排序，不是能力百分比</span></div>
      <div className="difficulty-swipe-hint">左右滑动查看全部推荐资源 →</div>

      <div className={`difficulty-chart-frame${scrollAtEnd ? " is-at-end" : ""}`}>
        <div className="difficulty-chart-scroll" onScroll={trackScrollEnd}>
          <svg className="difficulty-chart" role="img" aria-label="资源难度与学习者当前水平匹配图" aria-describedby="difficulty-svg-desc" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          <title id="difficulty-svg-title">资源难度与学习者当前水平匹配图</title>
          <desc id="difficulty-svg-desc">水平虚线代表学习者当前水平，每个独立点代表知识检索返回的一项资源，纵轴为真实知识库难度档位，横轴仅表示推荐顺序。</desc>
          {series.levels.map((level, index) => {
            const y = yFor(index)
            return <g key={level.value}><line className="difficulty-grid-line" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} /><text className="difficulty-axis-label" x={PLOT_LEFT - 16} y={y + 4} textAnchor="end">{level.label}</text></g>
          })}
          <line className="learner-level-line" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={learnerY} y2={learnerY} />
          <text className="learner-level-label" x={PLOT_RIGHT} y={learnerY - 8} textAnchor="end">你的当前水平 · {series.learnerLevel.label}</text>
          {series.points.map((point, index) => {
            const x = xFor(index, pointStep)
            const y = yFor(point.difficultyIndex)
            return (
              <g className={`difficulty-point gap-${gapClass(point.gap)}`} key={point.sourceId}>
                <circle aria-label={`${point.sourceId} ${point.title}，${point.difficultyLabel}，${point.relation}，知识检索分 ${point.score}`} cx={x} cy={y} r="9" />
                <circle className="difficulty-point-core" cx={x} cy={y} r="3" />
                <text className="difficulty-source-label" x={x} y={PLOT_BOTTOM + 29} textAnchor="middle">{point.sourceId}</text>
                <text className="difficulty-relation-label" x={x} y={y - 15} textAnchor="middle">{shortPointLabel(point.role, point.relation)}</text>
              </g>
            )
          })}
          </svg>
        </div>
        <span className="difficulty-scroll-fade" aria-hidden="true" />
      </div>

      <details className="difficulty-details"><summary>查看资源明细与推荐理由</summary><div className="difficulty-resource-list" aria-label="资源难度明细">{series.points.map((point) => <article key={point.sourceId}><span className={`difficulty-dot gap-${gapClass(point.gap)}`}><CircleDot size={14} /></span><div><strong>{point.sourceId} · {point.title}</strong><small>{point.role} · {point.difficultyLabel} · {point.relation} · 知识检索分 {point.score}</small><p>{point.reason}</p></div></article>)}</div></details>
      <p className="difficulty-note">难度档位来自 Python 知识库，学生起点来自学情画像；跨两级以上资源只作为远期目标锚点，不表示当前可直接学习。</p>
    </section>
  )

  function trackScrollEnd(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    setScrollAtEnd(element.scrollLeft + element.clientWidth >= element.scrollWidth - 2)
  }
}

function ChartHeading() {
  return <header className="difficulty-heading"><div><span className="section-kicker">DIFFICULTY FIT</span><h2 id="difficulty-title">资源难度匹配图</h2></div><BarChart3 size={21} /></header>
}

function xFor(index: number, step: number): number {
  return step === 0 ? (PLOT_LEFT + PLOT_RIGHT) / 2 : PLOT_LEFT + index * step
}

function yFor(index: number): number {
  return PLOT_BOTTOM - index * ((PLOT_BOTTOM - PLOT_TOP) / 3)
}

function gapClass(gap: number): string {
  if (gap === 0) return "same"
  if (Math.abs(gap) === 1) return "near"
  return "far"
}

function shortPointLabel(role: string, relation: string): string {
  if (role === "当前适配") return relation
  if (role === "远期目标") return `远期 · ${relation}`
  return relation
}
