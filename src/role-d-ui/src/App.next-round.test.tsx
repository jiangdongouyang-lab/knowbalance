import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { LearningWorkspaceState } from "./domain/workspace-store"
import {
  completedRoleDSession,
  nextRoundHandoff,
} from "./test/role-c-next-round-fixtures"

const { continueRoleCMock, loadWorkspaceMock } = vi.hoisted(() => ({
  continueRoleCMock: vi.fn(),
  loadWorkspaceMock: vi.fn(),
}))

vi.mock("./domain/role-c-continuation-client", () => ({
  continueRoleCAfterSubmission: continueRoleCMock,
}))

vi.mock("./domain/workspace-store", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./domain/workspace-store")
  >()
  return {
    ...actual,
    loadWorkspace: loadWorkspaceMock,
  }
})

import { App } from "./App"

describe("Role D next-round UI", () => {
  beforeEach(() => {
    localStorage.clear()
    continueRoleCMock.mockReset()
    loadWorkspaceMock.mockReset()
    loadWorkspaceMock.mockReturnValue(completedWorkspace())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("deduplicates clicks and enters the published anchor-first round", async () => {
    let release!: (value: {
      status: "published"
      handoff: typeof nextRoundHandoff
    }) => void
    continueRoleCMock.mockImplementation(() => new Promise((resolve) => {
      release = resolve
    }))
    render(<App />)
    await userEvent.click(screen.getByRole("button", {
      name: "继续学习：循环强化",
    }))

    const continueButton = screen.getByRole("button", {
      name: "继续下一轮",
    })
    fireEvent.click(continueButton)
    fireEvent.click(continueButton)

    expect(continueRoleCMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", {
      name: "正在准备下一轮…",
    })).toBeDisabled()

    await act(async () => {
      release({ status: "published", handoff: nextRoundHandoff })
    })

    expect(await screen.findByRole("heading", {
      name: "下一轮循环讲义",
    })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "分阶测评" }))
    expect(screen.getByRole("button", {
      name: "确认锚点并继续",
    })).toBeDisabled()
    expect(screen.queryByText("本轮需要继续巩固。")).not.toBeInTheDocument()
  })

  test("keeps the completed round visible and retryable when C awaits A/B input", async () => {
    continueRoleCMock.mockResolvedValue({
      status: "awaiting_input",
      message: "下一轮需要 A/B 提供新的学习路径与检索证据，请完成上游更新后重试。",
    })
    render(<App />)
    await userEvent.click(screen.getByRole("button", {
      name: "继续学习：循环强化",
    }))
    await userEvent.click(screen.getByRole("button", {
      name: "继续下一轮",
    }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "下一轮需要 A/B 提供新的学习路径与检索证据",
    )
    expect(screen.getByRole("heading", {
      name: "C 已完成正式评分与动态反馈",
    })).toBeInTheDocument()
    expect(screen.getByRole("button", {
      name: "继续下一轮",
    })).toBeEnabled()
    expect(screen.queryByRole("heading", {
      name: "下一轮循环讲义",
    })).not.toBeInTheDocument()
  })
})

function completedWorkspace(): LearningWorkspaceState {
  const session = completedRoleDSession()
  return {
    version: 1,
    activeUserId: "learner-1",
    activePlanId: "plan-1",
    users: [{
      id: "learner-1",
      displayName: "小王",
      educationContext: "测试",
      selfRating: "basic",
      timeBudget: "每周 2 小时",
      priorLanguages: [],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }],
    plans: [{
      id: "plan-1",
      userId: "learner-1",
      title: "循环强化",
      session,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }],
  }
}
