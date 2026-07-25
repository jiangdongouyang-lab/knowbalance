import type { RetrievalItemView } from "../domain/types"

interface DifficultyMatchProps {
  items: RetrievalItemView[]
}

const difficultyPosition = { beginner: 14, basic: 39, intermediate: 66, integrated: 90 }

export function DifficultyMatch({ items }: DifficultyMatchProps) {
  return (
    <section className="panel match-panel" aria-labelledby="match-title">
      <div className="panel-heading compact">
        <div><span className="section-kicker">DIFFICULTY FIT</span><h2 id="match-title">资源难度匹配</h2></div>
      </div>
      <div className="match-scale" aria-label="从入门到综合的资源难度分布">
        <span className="scale-line" />
        {items.map((item) => (
          <span className={`match-point${item.trace.difficultyMatch ? " is-fit" : ""}`} style={{ left: `${difficultyPosition[item.difficulty]}%` }} key={item.sourceId} title={`${item.title}：${item.difficulty}`}>
            <i />
            <b>{item.sourceId}</b>
          </span>
        ))}
        <span className="scale-label start">入门</span><span className="scale-label end">综合</span>
      </div>
      <p className="match-note"><span className="fit-dot" /> K007 与当前 beginner 档直接匹配；高阶资源保留为路径目标，不提前灌输。</p>
    </section>
  )
}
