import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { exportProgressJson } from "./domain/progress-file"
import type { LearningWorkspaceState } from "./domain/workspace-store"
import { App } from "./App"

async function createLocalUser(name = "小王") {
  await userEvent.type(screen.getByLabelText("怎么称呼你 *"), name)
  await userEvent.type(screen.getByLabelText("专业、年级或职业"), "大二非计算机专业")
  await userEvent.click(screen.getByLabelText("有一点 Python 基础"))
  await userEvent.type(screen.getByLabelText("每周可学习时间"), "每周 4 小时")
  await userEvent.type(screen.getByLabelText("接触过的编程语言"), "Python、JavaScript")
  await userEvent.click(screen.getByRole("button", { name: "创建档案" }))
}

async function createPlan(title = "循环专项", goal = "完成成绩统计程序", weakConcepts = "循环") {
  await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
  await userEvent.type(screen.getByLabelText("计划名称 *"), title)
  await userEvent.type(screen.getByLabelText("学习目标 *"), goal)
  await userEvent.type(screen.getByLabelText("这个计划里觉得薄弱的知识"), weakConcepts)
  await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
  await screen.findByRole("heading", { name: "用真实知识库题目确认基础" })
}

async function answerDynamicDiagnosis(options = ["遍历序列", "append", "def", "=", "str"]) {
  for (const option of options) await userEvent.click(screen.getByLabelText(option))
  await userEvent.click(screen.getByRole("button", { name: `提交 ${options.length} 道诊断题` }))
  expect(await screen.findByRole("status")).toHaveTextContent(`客观诊断已完成 · ${options.length} / ${options.length} 题`)
}

async function enterLearning() {
  await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
  await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))
  await userEvent.click(screen.getByRole("button", { name: "进入学习实操" }))
}

async function setupRealPlan() {
  await createLocalUser()
  await createPlan()
}

describe("Role D local users and learning plans", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  test("creates a grounded local learner profile before showing the plan list", async () => {
    render(<App />)
    expect(screen.getByRole("heading", { name: "创建本机学习档案" })).toBeInTheDocument()
    expect(screen.getByText("资料仅保存在这台设备，不是云端账号")).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("怎么称呼你 *"), "小王")
    expect(screen.getByRole("button", { name: "创建档案" })).toBeDisabled()
    await userEvent.clear(screen.getByLabelText("怎么称呼你 *"))
    await createLocalUser("小王")

    expect(screen.getByRole("heading", { name: "小王的学习计划" })).toBeInTheDocument()
    expect(screen.getByText("大二非计算机专业 · 有一点基础 · 每周 4 小时")).toBeInTheDocument()
    expect(screen.getByText("还没有学习计划")).toBeInTheDocument()
  })

  test("reports local workspace save failures on first use", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked") })
    render(<App />)
    expect(await screen.findByText(/保存失败：浏览器未允许写入本机资料/)).toBeInTheDocument()
  })

  test("keeps multiple plans resumable and isolates them by local user", async () => {
    render(<App />)
    await setupRealPlan()
    await userEvent.click(screen.getByLabelText("遍历序列"))
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))

    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("计划名称 *"), "变量专项")
    await userEvent.type(screen.getByLabelText("学习目标 *"), "读懂最简单的 Python 代码")
    await userEvent.type(screen.getByLabelText("这个计划里觉得薄弱的知识"), "变量")
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))

    expect(screen.getByRole("heading", { name: "循环专项" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "变量专项" })).toBeInTheDocument()
    expect(screen.getAllByText("客观诊断 · 进度 2 / 6")).toHaveLength(2)
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByLabelText("遍历序列")).toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))
    await userEvent.click(screen.getByRole("button", { name: "切换用户" }))
    await userEvent.click(screen.getByRole("button", { name: "新增本机用户" }))
    await userEvent.type(screen.getByLabelText("怎么称呼你 *"), "小李")
    await userEvent.click(screen.getByLabelText("刚刚接触 Python"))
    await userEvent.click(screen.getByRole("button", { name: "创建档案" }))
    expect(screen.getByRole("heading", { name: "小李的学习计划" })).toBeInTheDocument()
    expect(screen.getByText("还没有学习计划")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "切换用户" }))
    await userEvent.click(screen.getByRole("button", { name: /小王/ }))
    expect(screen.getByRole("heading", { name: "循环专项" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "变量专项" })).toBeInTheDocument()
  })

  test("deletes only the active plan and keeps sibling plans", async () => {
    render(<App />)
    await setupRealPlan()
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))
    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("计划名称 *"), "临时计划")
    await userEvent.type(screen.getByLabelText("学习目标 *"), "读懂最简单的 Python 代码")
    await userEvent.type(screen.getByLabelText("这个计划里觉得薄弱的知识"), "变量")
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))

    await userEvent.click(screen.getByRole("button", { name: "删除当前学习计划" }))
    expect(screen.getByRole("dialog", { name: "删除当前学习计划？" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "删除计划" }))

    expect(screen.getByRole("heading", { name: "循环专项" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "临时计划" })).not.toBeInTheDocument()
  })

  test("returns to the plan list after refresh and resumes the selected checkpoint", async () => {
    const { unmount } = render(<App />)
    await setupRealPlan()
    await userEvent.click(screen.getByLabelText("遍历序列"))
    unmount()

    render(<App />)
    expect(screen.getByRole("heading", { name: "小王的学习计划" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByLabelText("遍历序列")).toBeChecked()
  })

  test("imports progress as a new plan instead of overwriting the current user's plans", async () => {
    render(<App />)
    await setupRealPlan()
    const workspace = JSON.parse(localStorage.getItem("knowbalance.role-d.workspace")!) as LearningWorkspaceState
    const original = workspace.plans[0]!.session

    await userEvent.click(screen.getByRole("button", { name: "进度管理" }))
    const importedSession = {
      ...original,
      sessionId: "imported-session",
      profile: { ...original.profile, learnerId: "foreign-learner" },
      planInput: { ...original.planInput, learnerId: "foreign-learner" },
    }
    const file = new File([exportProgressJson(importedSession)], "imported.json", { type: "application/json" })
    await userEvent.upload(screen.getByLabelText("选择进度 JSON 文件"), file)

    expect(await screen.findByRole("heading", { name: "小王的学习计划" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "循环专项" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: `导入 · ${original.profile.goal}` })).toBeInTheDocument()
    const importedWorkspace = JSON.parse(localStorage.getItem("knowbalance.role-d.workspace")!) as LearningWorkspaceState
    const importedPlan = importedWorkspace.plans.find((plan) => plan.session.sessionId === "imported-session")
    expect(importedPlan?.session.profile.learnerId).toBe(importedWorkspace.activeUserId)
    expect(importedPlan?.session.planInput.learnerId).toBe(importedWorkspace.activeUserId)
  })
})

describe("Role D dynamic diagnosis and official C resources", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  test("uses A results and prerequisite evidence to build a non-fixed five-question diagnosis", async () => {
    render(<App />)
    await setupRealPlan()

    expect(screen.getAllByRole("article")).toHaveLength(5)
    expect(screen.getByText(/优先使用 A 当前命中的真实题.*prerequisites/)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "变量赋值在 Python 中使用哪个符号？" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: '"95" 在 Python 中通常属于哪种类型？' })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("已答 0 / 5 题 · 请完成全部真实题后提交")
    expect(screen.getByRole("button", { name: "提交 5 道诊断题" })).toBeDisabled()
  })

  test("feeds all diagnosis answers to B and presents an evidence-based learning start", async () => {
    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))

    expect(screen.getByText("当前学习起点（不是最终能力评分）")).toBeInTheDocument()
    expect(screen.getByText("5 / 5 题")).toBeInTheDocument()
    expect(screen.getByText("从基础应用开始")).toBeInTheDocument()
    expect(screen.getByText("for 循环")).toBeInTheDocument()
    expect(screen.queryByText("循环", { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText("本轮诊断未发现需要优先补强的知识点")).toBeInTheDocument()
    expect(screen.getByText(/客观测试答对覆盖自评薄弱/)).toBeInTheDocument()
  })

  test("raises an under-confident beginner teaching start after five fully correct objective answers", async () => {
    render(<App />)
    await userEvent.type(screen.getByLabelText("怎么称呼你 *"), "小陈")
    await userEvent.click(screen.getByLabelText("刚刚接触 Python"))
    await userEvent.click(screen.getByRole("button", { name: "创建档案" }))
    await createPlan("基础校准", "完成成绩统计程序", "循环")
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))

    expect(screen.getByText("从基础应用开始")).toBeInTheDocument()
    expect(screen.getByText("5 / 5 题")).toBeInTheDocument()
  })

  test("opens real A/B/C workflow and grounded evidence on demand", async () => {
    render(<App />)
    await setupRealPlan()

    expect(screen.queryByText("A/B/C 本次实跑")).not.toBeInTheDocument()
    expect(screen.queryByText("实时事件")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "查看 A/B/C 执行链" }))
    expect(screen.getByText("concept-tutor")).toBeInTheDocument()
    expect(screen.getByText("code-lab")).toBeInTheDocument()
    expect(screen.getByText("tiered-evaluator")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "关闭详情" }))

    await userEvent.click(screen.getByRole("button", { name: "查看知识证据" }))
    expect(screen.getByRole("heading", { name: "检索轨迹与生成内容引用" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "K002 变量与赋值 beginner" }))
    expect(screen.getByText("由 A 命中知识点的 prerequisites 关系补充，用于客观诊断前置基础。")).toBeInTheDocument()
    expect(screen.getAllByText("K007-F001").length).toBeGreaterThan(0)
  })

  test("keeps a delayed onboarding result bound to the plan that started it", async () => {
    render(<App />)
    await setupRealPlan()
    await userEvent.click(screen.getByRole("button", { name: "返回计划信息" }))

    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    let completed!: () => void
    const requestCompleted = new Promise<void>((resolve) => { completed = resolve })
    const originalFetch = globalThis.fetch
    let intercepted = false
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (!intercepted) {
        intercepted = true
        await delayed
      }
      const response = await originalFetch(...args)
      if (intercepted) completed()
      return response
    }))

    await userEvent.clear(screen.getByLabelText("这次你想学会什么？"))
    await userEvent.type(screen.getByLabelText("这次你想学会什么？"), "更新后的成绩统计目标")
    await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))
    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("计划名称 *"), "另一个计划")
    await userEvent.type(screen.getByLabelText("学习目标 *"), "读懂最简单的 Python 代码")
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
    await userEvent.click(screen.getByRole("button", { name: "返回计划信息" }))
    expect(screen.getByRole("button", { name: "下一步：客观诊断" })).toBeEnabled()
    release()
    await requestCompleted

    await vi.waitFor(() => {
      const workspace = JSON.parse(localStorage.getItem("knowbalance.role-d.workspace")!) as LearningWorkspaceState
      expect(workspace.plans.find((plan) => plan.title === "循环专项")?.session.profile.goal).toBe("更新后的成绩统计目标")
      expect(workspace.plans.find((plan) => plan.title === "另一个计划")?.session.profile.goal).toBe("读懂最简单的 Python 代码")
    })
  })

  test("renders official C artifacts and keeps grading pending", async () => {
    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await enterLearning()

    expect(screen.getByText("C 官方流水线 · REAL")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "分阶测评" }))
    expect(screen.getAllByText(/Tier [123]/)).toHaveLength(5)
    expect(screen.getByText("补全 average_score。")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "查看反馈状态" }))
    expect(screen.getByText("评分与动态反馈 · PENDING")).toBeInTheDocument()
  })

  test("restores public C choices without revealing grading", async () => {
    const { unmount } = render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await enterLearning()
    await userEvent.click(screen.getByRole("tab", { name: "分阶测评" }))

    await userEvent.click(screen.getByRole("button", { name: "B. 安装第三方包" }))
    expect(screen.getByRole("button", { name: "B. 安装第三方包" })).toHaveAttribute("aria-pressed", "true")
    unmount()

    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByRole("button", { name: "B. 安装第三方包" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText(/回答正确|回答错误|得分/)).not.toBeInTheDocument()
  })

  test("captures every public C response type and submits locally", async () => {
    const { unmount } = render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await enterLearning()
    await userEvent.click(screen.getByRole("tab", { name: "分阶测评" }))

    const submit = screen.getByRole("button", { name: "提交整套测评" })
    expect(submit).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "A. 依次处理列表中的每个元素" }))
    await userEvent.click(screen.getByRole("button", { name: "B. 正确" }))
    await userEvent.type(screen.getByLabelText("第 3 题代码追踪答案"), "total 最终为 6")
    await userEvent.type(screen.getByLabelText("第 4 题简答答案"), "列表按顺序保存多项成绩。")
    const code = screen.getByLabelText("第 5 题代码答案")
    await userEvent.clear(code)
    await userEvent.type(code, "def average_score(scores):\n    return sum(scores) / len(scores)")
    await userEvent.click(submit)
    expect(screen.getByRole("status")).toHaveTextContent("作答已提交，等待 C 正式评分")

    unmount()
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByLabelText("第 3 题代码追踪答案")).toHaveValue("total 最终为 6")
    expect(screen.getByLabelText("第 4 题简答答案")).toHaveValue("列表按顺序保存多项成绩。")
    expect(screen.getByLabelText("第 5 题代码答案")).toHaveValue("def average_score(scores):\n    return sum(scores) / len(scores)")
    expect(screen.getByRole("status")).toHaveTextContent("作答已提交，等待 C 正式评分")
  })
})
