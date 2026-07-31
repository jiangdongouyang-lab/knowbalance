import { render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import type { WorkflowEventView } from "../domain/types"
import { WorkflowTimeline } from "./WorkflowTimeline"

describe("WorkflowTimeline", () => {
  test("swaps only the concept preparation and generation rows without reversing the timeline", () => {
    const events: WorkflowEventView[] = [
      { id: "input", agent: "input-normalizer", stage: "输入标准化", status: "completed", summary: "输入已整理", timestamp: "刚刚" },
      { id: "concept-started", agent: "concept-tutor", stage: "定制讲义", status: "running", summary: "concept-tutor 开始生成讲义", timestamp: "2026-07-30T13:56:22.733Z" },
      { id: "concept-ready", agent: "concept-tutor", stage: "定制讲义", status: "completed", summary: "concept-tutor 讲义产物已就绪", timestamp: "2026-07-30T13:56:22.742Z" },
      { id: "lab", agent: "code-lab", stage: "代码实验", status: "running", summary: "code-lab 开始生成", timestamp: "2026-07-30T13:56:22.750Z" },
    ]

    render(<WorkflowTimeline events={events} localExecution includesRoleC />)

    const items = screen.getAllByRole("article")
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "输入标准化",
      "定制讲义准备",
      "定制讲义生成",
      "代码实验",
    ])
    expect(within(items[1]!).getByText("concept-tutor 讲义产物已就绪")).toBeInTheDocument()
    expect(within(items[2]!).getByText("concept-tutor 开始生成讲义")).toBeInTheDocument()
    expect(events.map((event) => event.id)).toEqual(["input", "concept-started", "concept-ready", "lab"])
  })

  test("collapses a started concept event into its terminal blocked event and shows the exact reason", () => {
    const events: WorkflowEventView[] = [
      { id: "input", agent: "input-normalizer", stage: "输入标准化", status: "completed", summary: "输入已整理", timestamp: "刚刚" },
      { id: "concept-started", agent: "concept-tutor", stage: "定制讲义生成", status: "running", summary: "concept-tutor 开始生成讲义", timestamp: "2026-07-31T02:00:00Z" },
      { id: "concept-blocked", agent: "concept-tutor", stage: "定制讲义受阻", status: "blocked", summary: "concept-tutor Draft 未通过结构、引用或目标覆盖门禁", timestamp: "2026-07-31T02:00:01Z" },
      { id: "recovery-blocked", agent: "A/C recovery-loop", stage: "审核恢复", status: "blocked", summary: "concept-tutor Draft 未通过结构、引用或目标覆盖门禁", timestamp: "刚刚" },
    ]

    render(<WorkflowTimeline events={events} localExecution includesRoleC />)

    const items = screen.getAllByRole("article")
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "输入标准化",
      "定制讲义受阻",
      "审核恢复受阻",
    ])
    expect(screen.queryByText("concept-tutor 开始生成讲义")).not.toBeInTheDocument()
    expect(screen.getAllByText("concept-tutor Draft 未通过结构、引用或目标覆盖门禁")).toHaveLength(2)
    expect(within(items[2]!).getByText("C recovery-loop")).toBeInTheDocument()
  })
})