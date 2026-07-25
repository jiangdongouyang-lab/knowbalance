import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"
import { demoHandoff } from "../data/demo-handoff"
import { adaptHandoff } from "../domain/adapt-handoff"
import { exportProgressJson } from "../domain/progress-file"
import { ProgressFileControls } from "./ProgressFileControls"

const session = adaptHandoff(demoHandoff)

describe("ProgressFileControls", () => {
  test("keeps JSON operations hidden behind a low-priority progress menu", async () => {
    render(<ProgressFileControls session={session} onImport={() => undefined} />)

    expect(screen.queryByRole("button", { name: "导出进度 JSON" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "导入进度 JSON" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "进度管理" }))

    expect(screen.getByRole("region", { name: "进度管理菜单" })).toHaveTextContent("仅用于团队联调、换浏览器或手动备份，平时无需操作。")
    expect(screen.getByRole("button", { name: "导出进度 JSON" })).toBeVisible()
    expect(screen.getByRole("button", { name: "导入进度 JSON" })).toBeVisible()
  })

  test("imports a valid progress file and reports success", async () => {
    const onImport = vi.fn()
    render(<ProgressFileControls session={session} onImport={onImport} />)

    await userEvent.click(screen.getByRole("button", { name: "进度管理" }))
    const file = new File([exportProgressJson(session)], "progress.json", { type: "application/json" })
    await userEvent.upload(screen.getByLabelText("选择进度 JSON 文件"), file)

    expect(onImport).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      assessmentGraded: false,
      decision: { next: "remediate", reason: "等待 C 正式评分后更新动态路径。" },
      view: session.view,
    }))
    expect(screen.getByRole("status")).toHaveTextContent("进度已导入")
    expect(screen.queryByRole("button", { name: "导入进度 JSON" })).not.toBeInTheDocument()
  })

  test("rejects an invalid progress file without replacing the session", async () => {
    const onImport = vi.fn()
    render(<ProgressFileControls session={session} onImport={onImport} />)

    await userEvent.click(screen.getByRole("button", { name: "进度管理" }))
    const file = new File(["not-json"], "broken.json", { type: "application/json" })
    await userEvent.upload(screen.getByLabelText("选择进度 JSON 文件"), file)

    expect(onImport).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("文件不是有效的 JSON")
  })

  test("exports the complete progress through a JSON download", async () => {
    const createObjectUrl = vi.fn(() => "blob:progress")
    const revokeObjectUrl = vi.fn()
    vi.stubGlobal("URL", { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)

    render(<ProgressFileControls session={session} onImport={() => undefined} />)
    await userEvent.click(screen.getByRole("button", { name: "进度管理" }))
    await userEvent.click(screen.getByRole("button", { name: "导出进度 JSON" }))

    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:progress")
    expect(screen.queryByRole("button", { name: "导出进度 JSON" })).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
