import { Download, MoreHorizontal, Upload } from "lucide-react"
import { useRef, useState, type ChangeEvent } from "react"
import { exportProgressJson, importProgressJson } from "../domain/progress-file"
import type { RoleDSession } from "../domain/types"

interface ProgressFileControlsProps {
  session: RoleDSession
  onImport: (session: RoleDSession) => void
}

type Notice = { kind: "success" | "error"; text: string } | null

export function ProgressFileControls({ session, onImport }: ProgressFileControlsProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [open, setOpen] = useState(false)

  const exportProgress = () => {
    const blob = new Blob([exportProgressJson(session)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `knowbalance-progress-${safeFilePart(session.profile.learnerId)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setNotice({ kind: "success", text: "进度 JSON 已导出" })
    setOpen(false)
  }

  const importProgress = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    let json: string
    try {
      json = await file.text()
    } catch {
      setNotice({ kind: "error", text: "无法读取所选文件。" })
      return
    }

    const result = importProgressJson(json)
    if (!result.ok) {
      setNotice({ kind: "error", text: result.error })
      return
    }

    onImport(result.session)
    setNotice({ kind: "success", text: "进度已导入" })
    setOpen(false)
  }

  return (
    <div className="progress-file-controls">
      <button className="progress-menu-trigger" type="button" aria-label="进度管理" aria-expanded={open} aria-controls="progress-file-menu" title="进度管理" onClick={() => setOpen((current) => !current)}><MoreHorizontal size={18} /><span className="desktop-label">进度管理</span></button>
      {open && (
        <section className="progress-file-menu" id="progress-file-menu" aria-label="进度管理菜单">
          <div><strong>进度管理</strong><p>仅用于团队联调、换浏览器或手动备份，<span>平时无需操作。</span></p></div>
          <div className="progress-file-actions">
            <button type="button" aria-label="导出进度 JSON" onClick={exportProgress}><Download size={17} /><span>导出 JSON</span></button>
            <button type="button" aria-label="导入进度 JSON" onClick={() => inputRef.current?.click()}><Upload size={17} /><span>导入 JSON</span></button>
          </div>
          <input ref={inputRef} className="progress-file-input" type="file" accept="application/json,.json" aria-label="选择进度 JSON 文件" onChange={importProgress} />
        </section>
      )}
      {notice && <span className={`progress-file-notice${notice.kind === "error" ? " is-error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</span>}
    </div>
  )
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "learner"
}
