import { X } from "lucide-react"
import type { ReactNode } from "react"

interface DetailDrawerProps {
  title: string
  onClose: () => void
  children: ReactNode
}

export function DetailDrawer({ title, onClose, children }: DetailDrawerProps) {
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="detail-drawer" aria-label={title}>
        <header><div><span className="section-kicker">DETAILS</span><h2>{title}</h2></div><button type="button" aria-label="关闭详情" onClick={onClose}><X size={20} /></button></header>
        <div className="drawer-content">{children}</div>
      </aside>
    </div>
  )
}
