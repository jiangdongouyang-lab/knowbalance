import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { App } from "./App"

describe("Role D guided learning app", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  test("shows when browser progress could not be saved", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked") })
    render(<App />)
    expect(await screen.findByText("保存失败")).toBeInTheDocument()
  })

  test("starts with one focused learner onboarding task", () => {
    render(<App />)
    expect(screen.getByRole("heading", { name: "先告诉我们你的学习目标" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "学情画像报告" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "个性化学习方案" })).not.toBeInTheDocument()
  })

  test("runs the prefilled case through the real A/B/C pipeline and guided stages", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
    expect(await screen.findByRole("heading", { name: "用一道真实题目确认基础" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "查看 A/B/C 执行链" })).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText("遍历序列"))
    await userEvent.click(screen.getByRole("button", { name: "提交诊断" }))
    expect(screen.getByRole("status")).toHaveTextContent("客观诊断已完成")
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))

    expect(screen.getByRole("heading", { name: "学情画像报告" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))
    expect(screen.getByRole("heading", { name: "个性化学习方案" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "资源难度匹配图" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "资源难度与学习者当前水平匹配图" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "进入学习实操" }))
    expect(screen.getByText("C 官方流水线 · REAL")).toBeInTheDocument()
  })

  test("opens agent and evidence details on demand instead of crowding the main screen", async () => {
    render(<App />)
    expect(screen.queryByRole("heading", { name: "多智能体协同" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "查看 Agent 协同" }))
    expect(screen.getByRole("heading", { name: "多智能体协同" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "关闭详情" }))

    await userEvent.click(screen.getByRole("button", { name: "查看知识证据" }))
    expect(screen.getByRole("heading", { name: "检索轨迹与生成内容引用" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "推荐知识点" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "推荐原因" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "匹配证据" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "匹配字段" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "分数构成" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "知识来源" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "生成内容引用" })).toBeInTheDocument()
    expect(screen.getByText("循环不是重复抄代码")).toBeInTheDocument()
    expect(screen.getAllByText("K007-F001").length).toBeGreaterThan(1)
    expect(screen.getAllByText("MOCK").length).toBeGreaterThan(0)
  })


  test("restores the learner's current stage after remount", async () => {
    const { unmount } = render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
    unmount()

    render(<App />)
    expect(screen.getByRole("heading", { name: "用一道真实题目确认基础" })).toBeInTheDocument()
  })

  test("renders incoming workflow events through the Agent drawer", async () => {
    render(<App />)
    window.dispatchEvent(new CustomEvent("knowbalance:workflow-event", {
      detail: {
        id: "e6",
        agent: "concept-tutor",
        stage: "个性化讲义",
        status: "completed",
        summary: "讲义已通过审核。",
        timestamp: "10:00:00",
      },
    }))

    await userEvent.click(screen.getByRole("button", { name: "查看 Agent 协同" }))
    expect(await screen.findByText("讲义已通过审核。")).toBeInTheDocument()
  })

  test("requires confirmation before restarting the current plan", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
    await userEvent.click(screen.getByLabelText("遍历序列"))

    await userEvent.click(screen.getByRole("button", { name: "重新开始当前计划" }))
    expect(screen.getByRole("dialog", { name: "重新开始当前计划？" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(screen.getByLabelText("遍历序列")).toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "重新开始当前计划" }))
    await userEvent.click(screen.getByRole("button", { name: "清空并重新开始" }))
    expect(screen.getByRole("heading", { name: "先告诉我们你的学习目标" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
    expect(screen.getByLabelText("遍历序列")).not.toBeChecked()
    expect(screen.getByRole("button", { name: "提交诊断" })).toBeDisabled()
  })

  test("creates a new plan by running the repository A/B/C pipeline", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    expect(screen.getByRole("dialog", { name: "新建学习计划" })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("学习者编号 *"), "student-project-001")
    await userEvent.type(screen.getByLabelText("教育背景"), "大二非计算机专业")
    await userEvent.type(screen.getByLabelText("每周学习时间"), "每周 4 小时")
    await userEvent.click(screen.getByLabelText("有一点基础"))
    await userEvent.type(screen.getByLabelText("已经学过的知识"), "变量、列表")
    await userEvent.type(screen.getByLabelText("觉得薄弱的知识"), "循环")
    await userEvent.type(screen.getByLabelText("学习目标 *"), "完成成绩统计程序")
    await userEvent.click(screen.getByRole("button", { name: "创建并运行 A/B/C" }))

    expect(await screen.findByText("知识库题目 · K009-F001")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "向列表末尾添加元素常用哪个方法？" })).toBeInTheDocument()
    expect(screen.getByText("实时事件")).toBeInTheDocument()
    expect(screen.getByLabelText("学习者头像 S")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "查看 A/B/C 执行链" }))
    expect(screen.getByRole("heading", { name: "A/B/C 执行链" })).toBeInTheDocument()
    expect(screen.getByText("concept-tutor")).toBeInTheDocument()
    expect(screen.getByText("code-lab")).toBeInTheDocument()
    expect(screen.getByText("tiered-evaluator")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "关闭详情" }))

    await userEvent.click(screen.getByLabelText("split"))
    await userEvent.click(screen.getByRole("button", { name: "提交诊断" }))
    expect(await screen.findByRole("status")).toHaveTextContent("B 已把列表更新为优先补强知识点")
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    expect(screen.getAllByText("列表").length).toBeGreaterThan(0)
  })

  test("restarting a real A/B/C plan keeps its learner instead of returning to the demo learner", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("学习者编号 *"), "student-keep-001")
    await userEvent.type(screen.getByLabelText("觉得薄弱的知识"), "变量")
    await userEvent.type(screen.getByLabelText("学习目标 *"), "读懂最简单的 Python 代码")
    await userEvent.click(screen.getByRole("button", { name: "创建并运行 A/B/C" }))

    await userEvent.click(await screen.findByRole("button", { name: "重新开始当前计划" }))
    await userEvent.click(screen.getByRole("button", { name: "清空并重新开始" }))
    expect(await screen.findByText("student-keep-001", { exact: true })).toBeInTheDocument()
    expect(screen.getByText("实时事件")).toBeInTheDocument()
  })

  test("renders official C resources and keeps grading pending until a real submission", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("学习者编号 *"), "student-aligned-001")
    await userEvent.click(screen.getByLabelText("有一点基础"))
    await userEvent.type(screen.getByLabelText("已经学过的知识"), "变量、列表")
    await userEvent.type(screen.getByLabelText("觉得薄弱的知识"), "循环")
    await userEvent.type(screen.getByLabelText("学习目标 *"), "完成成绩统计程序")
    await userEvent.click(screen.getByRole("button", { name: "创建并运行 A/B/C" }))

    await userEvent.click(await screen.findByLabelText("split"))
    await userEvent.click(screen.getByRole("button", { name: "提交诊断" }))
    await userEvent.click(await screen.findByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))
    expect(screen.getByRole("heading", { name: "资源难度匹配图" })).toBeInTheDocument()
    expect(screen.getByLabelText(/K009 列表，基础，高 1 级，知识检索分 \d+/)).toBeInTheDocument()
    expect(screen.getByText("查看资源明细与推荐理由")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "进入学习实操" }))
    expect(screen.getByText("C 官方流水线 · REAL")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "分阶测评" }))

    expect(screen.getAllByText(/Tier [123]/)).toHaveLength(5)
    expect(screen.getByText("补全 average_score。")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "查看反馈状态" }))
    expect(screen.getByRole("heading", { name: "完成正式测评后生成反馈" })).toBeInTheDocument()
    expect(screen.getByText("评分与动态反馈 · PENDING")).toBeInTheDocument()
  })

  test("selects and restores public C assessment answers without grading them", async () => {
    const { unmount } = render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
    await userEvent.click(await screen.findByLabelText("遍历序列"))
    await userEvent.click(screen.getByRole("button", { name: "提交诊断" }))
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))
    await userEvent.click(screen.getByRole("button", { name: "进入学习实操" }))
    await userEvent.click(screen.getByRole("tab", { name: "分阶测评" }))

    const first = screen.getByRole("button", { name: "A. 依次处理列表中的每个元素" })
    const second = screen.getByRole("button", { name: "B. 安装第三方包" })
    await userEvent.click(first)
    expect(first).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(second)
    expect(first).toHaveAttribute("aria-pressed", "false")
    expect(second).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText(/回答正确|回答错误|得分/)).not.toBeInTheDocument()

    unmount()
    render(<App />)
    expect(screen.getByRole("button", { name: "B. 安装第三方包" })).toHaveAttribute("aria-pressed", "true")
  })
})