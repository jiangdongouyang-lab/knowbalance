import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { demoHandoff } from "../data/demo-handoff"
import { adaptHandoff } from "../domain/adapt-handoff"
import { DynamicFeedbackVisualization } from "./DynamicFeedbackVisualization"

describe("DynamicFeedbackVisualization", () => {
  test("shows C policy bands without inventing a learner score before formal grading", () => {
    const session = adaptHandoff(demoHandoff)

    render(<DynamicFeedbackVisualization session={session} />)

    expect(screen.getByRole("heading", { name: "C 动态反馈决策图" })).toBeInTheDocument()
    expect(screen.getByText("低于 40%" )).toBeInTheDocument()
    expect(screen.getByText("40%–80%" )).toBeInTheDocument()
    expect(screen.getByText("达到 80%" )).toBeInTheDocument()
    expect(screen.getByText("等待 C 正式评分")).toBeInTheDocument()
    expect(screen.queryByText(/本轮正确率：/)).not.toBeInTheDocument()
  })

  test("highlights the verified next branch returned by C", () => {
    const session = adaptHandoff(demoHandoff)
    session.assessmentGraded = true
    session.decision = { next: "advance", reason: "掌握度达到进阶阈值，证据模态充分。" }

    render(<DynamicFeedbackVisualization session={session} />)

    const branch = screen.getByTestId("feedback-branch-advance")
    expect(branch).toHaveClass("selected")
    expect(screen.getByText("C 已返回：进阶挑战")).toBeInTheDocument()
    expect(screen.getByText("掌握度达到进阶阈值，证据模态充分。")).toBeInTheDocument()
  })
})
