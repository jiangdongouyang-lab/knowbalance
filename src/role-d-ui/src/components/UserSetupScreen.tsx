import { useMemo, useState } from "react"
import type { Difficulty } from "../domain/types"
import type { CreateLocalLearnerInput } from "../domain/workspace-store"

interface UserSetupScreenProps {
  saved?: boolean
  canCancel?: boolean
  onCancel?: () => void
  onCreate: (input: CreateLocalLearnerInput) => void
}

const levels: Array<{ value: Difficulty; label: string; description: string }> = [
  { value: "beginner", label: "刚刚接触 Python", description: "需要从概念与示例开始" },
  { value: "basic", label: "有一点 Python 基础", description: "能看懂简单代码" },
  { value: "intermediate", label: "可以独立编程", description: "希望补齐盲区并做项目" },
  { value: "integrated", label: "能够综合运用", description: "希望挑战复杂任务" },
]

export function UserSetupScreen({ saved = true, canCancel = false, onCancel, onCreate }: UserSetupScreenProps) {
  const [displayName, setDisplayName] = useState("")
  const [educationContext, setEducationContext] = useState("")
  const [selfRating, setSelfRating] = useState<Difficulty | null>(null)
  const [timeBudget, setTimeBudget] = useState("")
  const [priorLanguages, setPriorLanguages] = useState("")
  const valid = useMemo(() => displayName.trim().length > 0 && selfRating !== null, [displayName, selfRating])

  return (
    <main className="entry-shell">
      <section className="entry-card user-setup-card" aria-labelledby="user-setup-title">
        <span className="section-kicker">LOCAL LEARNER PROFILE</span>
        <h1 id="user-setup-title">创建本机学习档案</h1>
        <p>先记录 B 画像链需要的基础背景。没有填写的信息会保持为空，系统不会替你猜测。</p>
        <div className={`local-only-note${saved ? "" : " is-error"}`}>{saved ? "资料仅保存在这台设备，不是云端账号" : "保存失败：浏览器未允许写入本机资料"}</div>
        <div className="user-setup-form">
          <label><span>怎么称呼你 *</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如 小王" /></label>
          <label><span>专业、年级或职业</span><input value={educationContext} onChange={(event) => setEducationContext(event.target.value)} placeholder="例如 大二金融专业" /></label>
          <label><span>每周可学习时间</span><input value={timeBudget} onChange={(event) => setTimeBudget(event.target.value)} placeholder="例如 每周 3 小时" /></label>
          <label><span>接触过的编程语言</span><input value={priorLanguages} onChange={(event) => setPriorLanguages(event.target.value)} placeholder="例如 Python、JavaScript" /></label>
          <fieldset className="full-row"><legend>你目前对 Python 的了解 *</legend><div className="profile-levels">{levels.map((level) => <label className={selfRating === level.value ? "is-selected" : ""} key={level.value}><input type="radio" name="local-profile-level" aria-label={level.label} checked={selfRating === level.value} onChange={() => setSelfRating(level.value)} /><span><strong>{level.label}</strong><small>{level.description}</small></span></label>)}</div></fieldset>
        </div>
        <footer className="entry-actions">
          {canCancel && <button className="secondary-action" type="button" onClick={onCancel}>取消</button>}
          <button className="primary-action" type="button" disabled={!valid} onClick={() => selfRating && onCreate({ displayName: displayName.trim(), educationContext: educationContext.trim(), selfRating, timeBudget: timeBudget.trim(), priorLanguages: splitValues(priorLanguages) })}>创建档案</button>
        </footer>
      </section>
    </main>
  )
}

function splitValues(value: string): string[] {
  return [...new Set(value.split(/[，,、;；\n]+/).map((item) => item.trim()).filter(Boolean))]
}
