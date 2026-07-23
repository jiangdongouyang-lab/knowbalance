import { Plus, X } from "lucide-react"
import type { LocalLearner } from "../domain/workspace-store"

interface UserSwitcherProps {
  users: LocalLearner[]
  activeUserId: string
  onSelect: (userId: string) => void
  onAdd: () => void
  onClose: () => void
}

export function UserSwitcher({ users, activeUserId, onSelect, onAdd, onClose }: UserSwitcherProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="user-switcher" role="dialog" aria-modal="true" aria-labelledby="user-switcher-title">
        <header><div><span className="section-kicker">LOCAL USERS</span><h2 id="user-switcher-title">切换本机用户</h2><p>每个用户拥有独立的学习计划单和学习进度。</p></div><button type="button" aria-label="关闭用户切换" onClick={onClose}><X size={20} /></button></header>
        <div className="user-switch-list">{users.map((user) => <button className={user.id === activeUserId ? "is-active" : ""} type="button" key={user.id} onClick={() => onSelect(user.id)}><span className="avatar">{user.displayName.charAt(0).toUpperCase()}</span><span><strong>{user.displayName}</strong><small>{user.educationContext || "未填写专业或身份"}</small></span>{user.id === activeUserId && <em>当前</em>}</button>)}</div>
        <footer><button className="secondary-action" type="button" onClick={onAdd}><Plus size={16} />新增本机用户</button></footer>
      </section>
    </div>
  )
}
