import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, test, vi } from "vitest"
import { EvidenceInspector } from "./EvidenceInspector"
import type { LearningArtifactView, RetrievalItemView } from "../domain/types"

const retrieval: RetrievalItemView = {
  sourceId: "K007",
  title: "for 循环",
  difficulty: "beginner",
  score: 35,
  reason: "命中循环",
  snippet: "用于遍历序列",
  file: "K007.md",
  facts: [{ sourceId: "K007", factId: "F001", content: "for 循环用于遍历序列" }],
  examples: [],
  practiceTasks: [],
  quizItems: [],
  trace: {
    matchedKeywords: ["循环"],
    matchedFields: ["keywords"],
    difficultyMatch: true,
    scoreBreakdown: { keyword: 10, title: 0, facts: 0, practiceTasks: 0, difficulty: 3, bonus: 0 },
  },
}

describe("EvidenceInspector", () => {
  test("separates verified facts from mock generated content", () => {
    const artifact: LearningArtifactView = {
      id: "lesson-valid",
      kind: "lesson",
      title: "有效引用讲义",
      status: "mock",
      content: "内容",
      options: [],
      citations: [{ sourceId: "K007", factId: "F001" }],
      evidenceStatus: "grounded",
    }

    render(<EvidenceInspector items={[retrieval]} artifacts={[artifact]} selectedSourceId="K007" onSelect={() => undefined} />)

    expect(screen.getByText("事实来源已匹配")).toBeInTheDocument()
    expect(screen.getByText("生成内容 MOCK")).toBeInTheDocument()
    expect(screen.getByText("source_id: K007")).toBeInTheDocument()
    expect(screen.getByText("fact_id: F001")).toBeInTheDocument()
  })

  test("shows invalid generated citations as a gap and never navigates to a missing source", async () => {
    const onSelect = vi.fn()
    const artifact: LearningArtifactView = {
      id: "lesson-gap",
      kind: "lesson",
      title: "引用异常讲义",
      status: "mock",
      content: "内容",
      options: [],
      citations: [{ sourceId: "MISSING", factId: "F404" }],
      evidenceStatus: "gap",
    }

    render(<EvidenceInspector items={[retrieval]} artifacts={[artifact]} selectedSourceId="K007" onSelect={onSelect} />)

    expect(screen.getByText("存在引用缺口")).toBeInTheDocument()
    expect(screen.queryByText("引用已校验")).not.toBeInTheDocument()
    expect(screen.getByText("引用缺失或未命中检索事实")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "MISSING-F404" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText("MISSING-F404"))
    expect(onSelect).not.toHaveBeenCalled()
  })

  test("shows an explicit evidence gap instead of a blank drawer for a missing selected source", async () => {
    const onSelect = vi.fn()
    const artifact: LearningArtifactView = {
      id: "lesson-external",
      kind: "lesson",
      title: "下一节点讲义",
      status: "real",
      content: "内容",
      options: [],
      citations: [{ sourceId: "K999", factId: "F001" }],
      evidenceStatus: "gap",
    }

    render(<EvidenceInspector items={[retrieval]} artifacts={[artifact]} selectedSourceId="K999" onSelect={onSelect} />)

    expect(screen.getByRole("status")).toHaveTextContent(
      "当前引用缺少可验证证据",
    )
    expect(screen.getByRole("status")).toHaveTextContent("K999")
    expect(screen.getByText("D 不会为该引用补造检索事实；请等待 A/B 提供对应证据，或选择下方已有来源继续查看。")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", {
      name: "K007 for 循环 beginner",
    }))
    expect(onSelect).toHaveBeenCalledWith("K007")
  })
})
