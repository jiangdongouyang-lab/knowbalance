import { render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { demoHandoff } from "../data/demo-handoff"
import { adaptHandoff } from "../domain/adapt-handoff"
import { Week2VisualizationReport } from "./Week2VisualizationReport"

describe("Week2VisualizationReport", () => {
  test("uses the same distinct concept lifecycle labels as the detailed workflow", () => {
    const session = adaptHandoff(demoHandoff)
    session.workflow = [
      { id: "input", agent: "input-normalizer", stage: "输入标准化", status: "completed", summary: "输入已整理", timestamp: "刚刚" },
      { id: "concept-started", agent: "concept-tutor", stage: "定制讲义", status: "running", summary: "concept-tutor 开始生成讲义", timestamp: "2026-07-30T13:56:22.733Z" },
      { id: "concept-ready", agent: "concept-tutor", stage: "定制讲义", status: "completed", summary: "concept-tutor 讲义产物已就绪", timestamp: "2026-07-30T13:56:22.742Z" },
      { id: "lab", agent: "code-lab", stage: "代码实验", status: "running", summary: "code-lab 开始生成", timestamp: "2026-07-30T13:56:22.750Z" },
    ]

    render(<Week2VisualizationReport session={session} />)

    const flow = screen.getByRole("heading", { name: "Agent 协同过程展示" }).closest("article")!
    expect(within(flow).getAllByText(/定制讲义/).map((node) => node.textContent)).toEqual([
      "定制讲义准备",
      "定制讲义生成",
    ])
  })

  test("shows terminal blocked stages instead of stale running cards and exposes the reason", () => {
    const session = adaptHandoff(demoHandoff)
    session.workflow = [
      { id: "concept-started", agent: "concept-tutor", stage: "定制讲义生成", status: "running", summary: "concept-tutor 开始生成讲义", timestamp: "2026-07-31T02:00:00Z" },
      { id: "concept-blocked", agent: "concept-tutor", stage: "定制讲义受阻", status: "blocked", summary: "concept-tutor Draft 未通过结构、引用或目标覆盖门禁", timestamp: "2026-07-31T02:00:01Z" },
      { id: "recovery-blocked", agent: "A/C recovery-loop", stage: "审核恢复", status: "blocked", summary: "concept-tutor Draft 未通过结构、引用或目标覆盖门禁", timestamp: "刚刚" },
    ]

    render(<Week2VisualizationReport session={session} />)

    const flow = screen.getByRole("heading", { name: "Agent 协同过程展示" }).closest("article")!
    expect(within(flow).getAllByText(/受阻/).map((node) => node.textContent)).toEqual([
      "受阻",
      "定制讲义受阻",
      "受阻",
      "审核恢复受阻",
    ])
    expect(within(flow).queryByText("定制讲义生成")).not.toBeInTheDocument()
    expect(within(flow).getAllByText("concept-tutor Draft 未通过结构、引用或目标覆盖门禁")).toHaveLength(2)
  })
})