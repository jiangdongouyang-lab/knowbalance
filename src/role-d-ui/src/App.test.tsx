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
  await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
  await userEvent.type(screen.getByLabelText("这次你想学会什么？"), goal)
  await userEvent.type(screen.getByLabelText("本次计划已经学过的知识"), "变量、列表")
  await userEvent.type(screen.getByLabelText("本次计划觉得薄弱的知识"), weakConcepts)
  await userEvent.click(screen.getByRole("button", { name: "下一步：客观诊断" }))
  await screen.findByRole("heading", { name: "用真实知识库题目确认基础" })
}

async function answerDynamicDiagnosis(options = [
  "遍历序列",
  "append",
  "x=5; while x>0: print(x)",
  "def",
  "=",
  "str",
]) {
  const optionSet = new Set(options)
  const answeredNames = new Set<string>()
  for (let guard = 0; guard < options.length + 3; guard += 1) {
    const radio = screen.getAllByRole("radio").find((element) => {
      const input = element as HTMLInputElement
      return !answeredNames.has(input.name) && optionSet.has(input.getAttribute("aria-label") ?? "")
    }) as HTMLInputElement | undefined
    if (!radio) break
    await userEvent.click(radio)
    answeredNames.add(radio.name)
    const next = screen.queryByRole("button", { name: "下一题" })
    if (!next || next.hasAttribute("disabled")) break
    await userEvent.click(next)
  }
  await userEvent.click(screen.getByRole("button", { name: /^提交 \d+ 道诊断题$/ }))
  expect(await screen.findByRole("status")).toHaveTextContent(/客观诊断已完成 · \d+ \/ \d+ 题/)
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

  test("creates a local plan draft before running the ABC pipeline", async () => {
    render(<App />)
    await createLocalUser()
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockClear()

    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("计划名称 *"), "变量草稿")
    expect(screen.queryByLabelText("学习目标 *")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("这个计划里觉得薄弱的知识")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))

    expect(screen.getByRole("heading", { name: "规划这一次的学习" })).toBeInTheDocument()
    expect(screen.getByLabelText("这次你想学会什么？")).toHaveValue("")
    expect(screen.getByLabelText("本次计划已经学过的知识")).toHaveValue("")
    expect(screen.getByLabelText("本次计划觉得薄弱的知识")).toHaveValue("")
    expect(screen.queryByText("你觉得自己目前处于什么水平？")).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("这次你想学会什么？"), "学会变量与赋值")
    await userEvent.type(screen.getByLabelText("本次计划已经学过的知识"), "Python 是什么、基本数据类型")
    await userEvent.tab()
    await userEvent.type(screen.getByLabelText("本次计划觉得薄弱的知识"), "变量、赋值")
    await userEvent.tab()
    expect(screen.getByRole("button", { name: "删除已学知识 Python 是什么" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "删除薄弱知识 变量" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "本次学习档案预览" })).toBeInTheDocument()
    expect(screen.getByText("学习目标：学会变量与赋值")).toBeInTheDocument()
    expect(screen.getByText("学习水平：有一点基础（来自用户档案）")).toBeInTheDocument()
    expect(screen.getByText("计划草稿已保存；本步骤才会运行 ABC，失败后可以修改并重试。")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "下一步：客观诊断" })).toBeEnabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("keeps multiple plans resumable and isolates them by local user", async () => {
    render(<App />)
    await setupRealPlan()
    await userEvent.click(screen.getByLabelText("append"))
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))

    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("计划名称 *"), "变量专项")
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
    await userEvent.type(screen.getByLabelText("这次你想学会什么？"), "学会变量与赋值，能用变量保存和更新数据")
    await userEvent.type(screen.getByLabelText("本次计划觉得薄弱的知识"), "变量")
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))

    expect(screen.getByRole("heading", { name: "循环专项" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "变量专项" })).toBeInTheDocument()
    expect(screen.getByText("学习建档 · 进度 1 / 6")).toBeInTheDocument()
    expect(screen.getByText("客观诊断 · 进度 2 / 6")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByLabelText("append")).toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))
    await userEvent.click(screen.getByRole("button", { name: "切换用户" }))
    await userEvent.click(screen.getByRole("button", { name: "新增本机用户" }))
    expect(screen.getByRole("heading", { name: "创建本机学习档案" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "小王的学习计划" })).not.toBeInTheDocument()
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
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
    await userEvent.type(screen.getByLabelText("这次你想学会什么？"), "学会变量与赋值，能用变量保存和更新数据")
    await userEvent.type(screen.getByLabelText("本次计划觉得薄弱的知识"), "变量")

    await userEvent.click(screen.getByRole("button", { name: "删除当前学习计划" }))
    expect(screen.getByRole("dialog", { name: "删除当前学习计划？" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "删除计划" }))

    expect(screen.getByRole("heading", { name: "循环专项" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "临时计划" })).not.toBeInTheDocument()
  })

  test("returns to the plan list after refresh and resumes the selected checkpoint", async () => {
    const { unmount } = render(<App />)
    await setupRealPlan()
    await userEvent.click(screen.getByLabelText("append"))
    unmount()

    render(<App />)
    expect(screen.getByRole("heading", { name: "小王的学习计划" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByLabelText("append")).toBeChecked()
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

    expect(screen.getAllByRole("article")).toHaveLength(1)
    expect(screen.getByText(/系统只展示 A 当前命中的真实选择题/)).toBeInTheDocument()
    expect(screen.getByText("第 1 / 5 题")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "客观诊断完成进度" })).toHaveAttribute("aria-valuenow", "0")
    expect(screen.getByRole("heading", { name: "向列表末尾添加元素常用哪个方法？" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "for 循环最适合用于什么场景？" })).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("已完成 0 / 5 题")
    await userEvent.click(screen.getByLabelText("append"))
    await userEvent.click(screen.getByRole("button", { name: "提交 5 道诊断题" }))
    expect(screen.getByRole("alert")).toHaveTextContent("还有 4 道题未完成，已定位到第 2 题")
    expect(screen.getByRole("heading", { name: "for 循环最适合用于什么场景？" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "上一题" })).toBeEnabled()
  })

  test("feeds all diagnosis answers to B and presents an evidence-based learning start", async () => {
    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))

    expect(screen.getByText("已掌握知识")).toBeInTheDocument()
    expect(screen.getByText("待补强知识")).toBeInTheDocument()
    expect(screen.getByText("推荐学习起点")).toBeInTheDocument()
    expect(screen.getByText("01 · 用户自评")).toBeInTheDocument()
    expect(screen.getByText("02 · 客观诊断结果")).toBeInTheDocument()
    expect(screen.getByText("03 · B 综合画像")).toBeInTheDocument()
    expect(screen.getByText("5 / 5 题答对")).toBeInTheDocument()
    expect(screen.getAllByText("从基础应用开始").length).toBeGreaterThan(0)
    expect(screen.getByText("for 循环")).toBeInTheDocument()
    expect(screen.getByText("循环", { exact: true })).toBeInTheDocument()
    expect(screen.queryByText("本轮诊断未发现需要优先补强的知识点")).not.toBeInTheDocument()
    expect(screen.queryByText(/客观测试答对覆盖自评薄弱/)).not.toBeInTheDocument()
  })

  test("raises an under-confident beginner teaching start after five fully correct objective answers", async () => {
    render(<App />)
    await userEvent.type(screen.getByLabelText("怎么称呼你 *"), "小陈")
    await userEvent.click(screen.getByLabelText("刚刚接触 Python"))
    await userEvent.click(screen.getByRole("button", { name: "创建档案" }))
    await createPlan("基础校准", "完成成绩统计程序", "循环")
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))

    expect(screen.getAllByText("从基础应用开始").length).toBeGreaterThan(0)
    expect(screen.getByText("5 / 5 题答对")).toBeInTheDocument()
  })

  test("opens real A/B/C workflow and grounded evidence on demand", async () => {
    render(<App />)
    await setupRealPlan()

    expect(screen.queryByText("A/B/C 本次实跑")).not.toBeInTheDocument()
    expect(screen.queryByText("实时事件")).not.toBeInTheDocument()

    expect(screen.getByRole("button", { name: "查看 B/A 执行链" })).toBeInTheDocument()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看 A/B/C 执行链" }))
    expect(screen.getByText("concept-tutor")).toBeInTheDocument()
    expect(screen.getByText("code-lab")).toBeInTheDocument()
    expect(screen.getByText("tiered-evaluator")).toBeInTheDocument()
    expect(screen.getAllByText("A 事实审核").length).toBeGreaterThan(0)
    expect(screen.getAllByText("B 教学审核").length).toBeGreaterThan(0)
    expect(screen.getAllByText("B 仲裁").length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole("button", { name: "关闭详情" }))

    await userEvent.click(screen.getByRole("button", { name: "查看知识证据" }))
    expect(screen.getByRole("heading", { name: "检索轨迹与生成内容引用" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "K002 变量与赋值 beginner" }))
    expect(screen.getByText("由 A 命中知识点的 prerequisites 关系补充，用于客观诊断前置基础。")).toBeInTheDocument()
    expect(screen.getAllByText("K007-F001").length).toBeGreaterThan(0)
  })

  test("keeps a delayed C result bound to the diagnosed plan that started it", async () => {
    render(<App />)
    await setupRealPlan()

    let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    let completed!: () => void
    const requestCompleted = new Promise<void>((resolve) => { completed = resolve })
    const originalFetch = globalThis.fetch
    let intercepted = false
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      const input = args[0] as string
      if (!intercepted && String(input).includes("/api/role-c/generate")) {
        intercepted = true
        await delayed
      }
      const response = await originalFetch(...args)
      if (intercepted && String(input).includes("/api/role-c/generate")) completed()
      return response
    }))

    const answered = new Set<string>()
    for (let round = 0; round < 5; round += 1) {
      const radio = screen.getAllByRole("radio").find((el) => !answered.has(el.getAttribute("name") ?? ""))
      if (!radio) break
      answered.add(radio.getAttribute("name") ?? "")
      await userEvent.click(radio)
      if (round < 4) await userEvent.click(screen.getByRole("button", { name: /下一题/ }))
    }
    await userEvent.click(screen.getByRole("button", { name: "提交 5 道诊断题" }))
    await userEvent.click(screen.getByRole("button", { name: "返回计划信息" }))
    await userEvent.click(screen.getByRole("button", { name: "返回学习计划单" }))
    await userEvent.click(screen.getByRole("button", { name: "新建学习计划" }))
    await userEvent.type(screen.getByLabelText("计划名称 *"), "另一个计划")
    await userEvent.click(screen.getByRole("button", { name: "创建学习计划" }))
    await userEvent.type(screen.getByLabelText("这次你想学会什么？"), "学会变量与赋值，能用变量保存和更新数据")
    expect(screen.getByRole("button", { name: "下一步：客观诊断" })).toBeEnabled()
    release()
    await requestCompleted

    await vi.waitFor(() => {
      const workspace = JSON.parse(localStorage.getItem("knowbalance.role-d.workspace")!) as LearningWorkspaceState
      expect(workspace.plans.find((plan) => plan.title === "循环专项")?.session.roleC?.runId).toBeTruthy()
      expect(workspace.plans.find((plan) => plan.title === "另一个计划")?.session.profile.goal).toBe("学会变量与赋值，能用变量保存和更新数据")
      expect(workspace.plans.find((plan) => plan.title === "另一个计划")?.session.roleC).toBeUndefined()
    })
  })

  test("renders official C artifacts and keeps grading pending", async () => {
    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await enterLearning()

    expect(screen.getByText("C 已验证资源 · REAL")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /定制讲义.*先理解核心概念/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /代码实验.*动手阅读与修改代码/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /分阶测评.*检查本轮学习效果/ })).toBeInTheDocument()
    expect(screen.getByText("查看知识依据与引用（2）")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "查看反馈状态" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: /分阶测评.*检查本轮学习效果/ }))
    expect(screen.getAllByText(/Tier [123]/)).toHaveLength(5)
    expect(screen.getByText("补全 average_score。")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "查看反馈状态" }))
    expect(screen.getByRole("heading", { name: "本轮学习反馈" })).toBeInTheDocument()
    expect(screen.getByText("你最关心的结果")).toBeInTheDocument()
    expect(screen.getByText("掌握情况")).toBeInTheDocument()
    expect(screen.getByText("下一步建议")).toBeInTheDocument()
    expect(screen.getByText("查看评分分支与技术详情").closest("details")).not.toHaveAttribute("open")
  })

  test("presents the Week2 Role D visualization report before learning starts", async () => {
    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))

    expect(screen.getByText("为什么先学这个")).toBeInTheDocument()
    expect(screen.queryByText(/预计 \d+/)).not.toBeInTheDocument()
    expect(screen.getByText("现在从这里开始")).toBeInTheDocument()
    await userEvent.click(screen.getByText("查看完整画像、资源匹配与审核详情"))

    expect(screen.getByRole("heading", { name: "Week2 可视化报告" })).toBeInTheDocument()
    expect(screen.getByText("画像 + 路径 + 匹配度 + 双审核")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: "能力雷达图" })).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "学习路径图" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "资源匹配度" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Agent 协同过程展示" })).toBeInTheDocument()
    expect(screen.getAllByText("A 事实审核").length).toBeGreaterThan(0)
    expect(screen.getAllByText("B 教学审核").length).toBeGreaterThan(0)
    expect(screen.getAllByText("B 仲裁").length).toBeGreaterThan(0)
    expect(screen.getByRole("heading", { name: "A/B 双审核与仲裁" })).toBeInTheDocument()
    expect(screen.getByText("事实审核与教学审核均通过，内容可发布。")).toBeInTheDocument()
  })

  test("lets a rejected plan preview learning and feedback without publishing formal resources", async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/api/role-c/status")) {
        return new Response(JSON.stringify({ providerMode: "deterministic", docker: "not_required", modelId: null }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (String(input).includes("/api/role-c/generate")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { runId?: string }
        return new Response(JSON.stringify({
          status: "blocked",
          runId: request.runId ?? "RUN-PREVIEW-BLOCKED",
          artifacts: [],
          workflow: [],
          reason: "内容审核已驳回，当前产物不可发布",
          audit: {
            factStatus: "pass",
            factAudits: [],
            teachingAudit: { artifactId: "role-c-reviewed-content", status: "reject", summary: "B 教学审核未通过。", revisionHints: [] },
            arbitration: { artifactId: "role-c-reviewed-content", decision: "reject", revisionRound: 0, maxRevisionRounds: 2, canRevise: false, reason: "A/B 审核驳回。" },
          },
        }), { status: 422, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 })
    })

    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))

    expect(screen.getByRole("button", { name: "进入学习实操" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "仅预览学习界面" }))
    expect(screen.getByRole("status")).toHaveTextContent("界面预览 · 非审核正式资源")
    expect(screen.getByRole("heading", { name: "Python for 循环与 range" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "预览反馈调整界面" }))
    expect(screen.getByRole("heading", { name: "本轮学习反馈" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("反馈界面预览 · 无 C 正式评分")
  })

  test("lets a rejected plan retry C generation from the plan page and unlock learning", async () => {
    const fetchMock = vi.mocked(fetch)
    const readyImplementation = fetchMock.getMockImplementation()!
    let generateCalls = 0
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/api/role-c/generate") && generateCalls++ < 1) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { runId?: string }
        return new Response(JSON.stringify({
          status: "blocked",
          runId: request.runId ?? "RUN-RETRY-BLOCKED",
          artifacts: [],
          workflow: [],
          reason: "内容审核已驳回，当前产物不可发布",
          audit: {
            factStatus: "pass",
            factAudits: [],
            teachingAudit: { artifactId: "role-c-reviewed-content", status: "reject", summary: "B 教学审核未通过。", revisionHints: [] },
            arbitration: { artifactId: "role-c-reviewed-content", decision: "reject", revisionRound: 0, maxRevisionRounds: 2, canRevise: false, reason: "A/B 审核驳回。" },
          },
        }), { status: 422, headers: { "content-type": "application/json" } })
      }
      return readyImplementation(input, init)
    })

    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))

    expect(screen.getByRole("button", { name: "进入学习实操" })).toBeDisabled()
    expect(screen.getByText("本轮资源已被审核驳回，暂不能进入学习实操。")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "重新生成学习资源" }))
    expect(await screen.findByRole("button", { name: "进入学习实操" })).toBeEnabled()
    expect(screen.queryByText("本轮资源已被审核驳回，暂不能进入学习实操。")).not.toBeInTheDocument()
  })

  test("shows retry progress on the plan page while regeneration is in flight", async () => {
    const fetchMock = vi.mocked(fetch)
    const readyImplementation = fetchMock.getMockImplementation()!
    let generateCalls = 0
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes("/api/role-c/generate") && generateCalls++ < 1) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { runId?: string }
        return new Response(JSON.stringify({
          status: "blocked",
          runId: request.runId ?? "RUN-RETRY-BLOCKED",
          artifacts: [],
          workflow: [],
          reason: "内容审核已驳回，当前产物不可发布",
          audit: {
            factStatus: "pass",
            factAudits: [],
            teachingAudit: { artifactId: "role-c-reviewed-content", status: "reject", summary: "B 教学审核未通过。", revisionHints: [] },
            arbitration: { artifactId: "role-c-reviewed-content", decision: "reject", revisionRound: 0, maxRevisionRounds: 2, canRevise: false, reason: "A/B 审核驳回。" },
          },
        }), { status: 422, headers: { "content-type": "application/json" } })
      }
      if (String(input).includes("/api/role-c/generate")) {
        return new Promise<Response>(() => {})
      }
      return readyImplementation(input, init)
    })

    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))

    await userEvent.click(screen.getByRole("button", { name: "重新生成学习资源" }))
    expect(await screen.findByRole("button", { name: "正在重新生成…" })).toBeDisabled()
    expect(screen.getByText("正在调用 C 重新生成学习资源，请稍候…")).toBeInTheDocument()
  })

  test("restores public C choices without revealing grading", async () => {
    const { unmount } = render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await enterLearning()
    await userEvent.click(screen.getByRole("tab", { name: /分阶测评.*检查本轮学习效果/ }))

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
    await userEvent.click(screen.getByRole("tab", { name: /分阶测评.*检查本轮学习效果/ }))

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
    expect(screen.getByRole("status")).toHaveTextContent("测试环境未执行 C 正式评分")

    unmount()
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "继续学习：循环专项" }))
    expect(screen.getByLabelText("第 3 题代码追踪答案")).toHaveValue("total 最终为 6")
    expect(screen.getByLabelText("第 4 题简答答案")).toHaveValue("列表按顺序保存多项成绩。")
    expect(screen.getByLabelText("第 5 题代码答案")).toHaveValue("def average_score(scores):\n    return sum(scores) / len(scores)")
    expect(screen.getByRole("status")).toHaveTextContent("测试环境未执行 C 正式评分")
  })

  test("enters the next learning stage through the official continue endpoint after an advancing grade", async () => {
    const fetchMock = vi.mocked(fetch)
    const readyImplementation = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/api/role-c/submit")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { submissionId?: string; sessionId?: string; runId?: string; learnerId?: string; formId?: string }
        return new Response(JSON.stringify({
          status: "completed",
          feedback: {
            feedback_id: "DFR-CONTINUE",
            submission_id: request.submissionId ?? "SUB-CONTINUE",
            run_id: request.runId ?? "RUN-TEST",
            session_id: request.sessionId ?? "C-SESSION-TEST",
            learner_id_hash: request.learnerId ?? "learner-test",
            profile_version: "RUN-TEST-profile-v1",
            path_node_id: "PATH-TEST",
            form_id: request.formId ?? "FORM-TEST",
            attempt_no: 1,
            round_score: { raw_score: 5, max_score: 5, accuracy: 1, evidence_score: 1 },
            objective_results: [{ objective_id: "OBJECTIVE-1", raw_score: 5, max_score: 5, accuracy: 1, evidence_score: 1, misconception_tags: [] }],
            grade_result: {
              artifact_id: "GRADE-CONTINUE",
              payload: {
                item_results: [
                  { item_id: "I1", objective_id: "OBJECTIVE-1", raw_score: 1, max_score: 1, evidence_score: 1, misconception_tags: [], feedback_code: "correct" },
                  { item_id: "I5", objective_id: "OBJECTIVE-1", raw_score: 4, max_score: 4, evidence_score: 1, misconception_tags: [], feedback_code: "passed" },
                ],
                feedback: { summary: "本轮全部达到完整要求。" },
              },
            },
            mastery_snapshot: [{ objective_id: "OBJECTIVE-1", mastery: 1, evidence_batches: 1, observed_modalities: ["mcq", "code"], revision: 1 }],
            final_decision: {
              action: "advance",
              basis: "round_accuracy",
              confidence: 0.9,
              reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
              target_objective_ids: [],
              policy_ref: "role-c-round-accuracy-v1",
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("/api/role-c/continue")) {
        return new Response(JSON.stringify({
          status: "published",
          reviewedRelease: {
            delivery_kind: "reviewed_release",
            delivery_id: "DLV-NEXT-1",
            run_id: "RUN-NEXT",
            artifacts: [
              {
                artifact_id: "ART-NEXT-LESSON",
                artifact_type: "concept_lesson",
                payload: {
                  title: "下一轮：文件读写讲义",
                  explanation_blocks: [{ block_id: "b1", block_type: "paragraph", text: "下一轮从文件读取成绩。", claims: [] }],
                  worked_examples: [],
                  misconceptions: [],
                  summary: [{ block_id: "b2", block_type: "paragraph", text: "文件读写总结。", claims: [] }],
                  prerequisite_bridge: [],
                },
                citations: [],
              },
              {
                artifact_id: "ART-NEXT-LAB",
                artifact_type: "code_lab_public",
                payload: {
                  title: "下一轮：成绩文件实验",
                  instructions: [{ block_id: "b1", block_type: "paragraph", text: "读取 score.txt 并统计。", claims: [] }],
                  public_tests: [],
                  starter_code: "def load_scores(path):\n    pass",
                },
                citations: [],
              },
              {
                artifact_id: "ART-NEXT-ASSESSMENT",
                artifact_type: "assessment_public",
                payload: {
                  title: "下一轮：文件读写测评",
                  items: [
                    { item_id: "N1", tier: 1, modality: "mcq", prompt: "打开文件用什么函数？", options: [{ option_id: "O1", label: "A", text: "open()" }], max_score: 1, citations: [] },
                  ],
                },
                citations: [],
              },
            ],
            trace_events: [
              { run_id: "RUN-NEXT", seq: 1, agent: "concept-tutor", event_type: "c.agent.ready", status: "success", summary: "下一轮讲义已就绪", occurred_at: "刚刚" },
              { run_id: "RUN-NEXT", seq: 2, agent: "code-lab", event_type: "c.agent.ready", status: "success", summary: "下一轮代码实验已就绪", occurred_at: "刚刚" },
              { run_id: "RUN-NEXT", seq: 3, agent: "tiered-evaluator", event_type: "c.agent.ready", status: "success", summary: "下一轮测评已就绪", occurred_at: "刚刚" },
            ],
          },
          learningSession: {
            session: {
              phase: "route_locked",
              routing_request_id: "R-NEXT",
              session_id: "C-SESSION-NEXT",
              run_id: "RUN-NEXT",
              form_id: "FORM-NEXT",
              attempt_no: 1,
              route_lock_id: "RL-NEXT",
              route_id: "RT-NEXT",
              action: "advance",
              anchor_score_ratio: 1,
              required_item_ids: ["N1"],
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return readyImplementation(input, init)
    })

    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))
    await userEvent.click(screen.getByRole("button", { name: "进入学习实操" }))
    await userEvent.click(screen.getByRole("tab", { name: /分阶测评.*检查本轮学习效果/ }))
    await userEvent.click(screen.getByRole("button", { name: "A. 依次处理列表中的每个元素" }))
    await userEvent.click(screen.getByRole("button", { name: "B. 正确" }))
    await userEvent.type(screen.getByLabelText("第 3 题代码追踪答案"), "total 最终为 6")
    await userEvent.type(screen.getByLabelText("第 4 题简答答案"), "列表按顺序保存多项成绩。")
    const code = screen.getByLabelText("第 5 题代码答案")
    await userEvent.clear(code)
    await userEvent.type(code, "def average_score(scores):\n    return sum(scores) / len(scores)")
    await userEvent.click(screen.getByRole("button", { name: "提交整套测评" }))
    await userEvent.click(screen.getByRole("button", { name: "查看反馈状态" }))

    expect(await screen.findByRole("button", { name: "进入下一学习阶段" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "进入下一学习阶段" }))

    expect(await screen.findByRole("tab", { name: /定制讲义/ })).toBeInTheDocument()
    expect(screen.getByText("下一轮：文件读写讲义")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: /代码实验/ }))
    expect(screen.getByText("下一轮：成绩文件实验")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: /分阶测评/ }))
    expect(screen.getByText("下一轮：文件读写测评")).toBeInTheDocument()
  }, 15000)

  test("routes anchor questions before unlocking the full assessment of the next stage", async () => {
    const fetchMock = vi.mocked(fetch)
    const readyImplementation = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/api/role-c/submit")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { submissionId?: string; sessionId?: string; runId?: string; learnerId?: string; formId?: string }
        return new Response(JSON.stringify({
          status: "completed",
          feedback: {
            feedback_id: "DFR-ANCHOR-GRADE",
            submission_id: request.submissionId ?? "SUB-ANCHOR-GRADE",
            run_id: request.runId ?? "RUN-TEST",
            session_id: request.sessionId ?? "C-SESSION-TEST",
            learner_id_hash: request.learnerId ?? "learner-test",
            profile_version: "RUN-TEST-profile-v1",
            path_node_id: "PATH-TEST",
            form_id: request.formId ?? "FORM-TEST",
            attempt_no: 1,
            round_score: { raw_score: 5, max_score: 5, accuracy: 1, evidence_score: 1 },
            objective_results: [{ objective_id: "OBJECTIVE-1", raw_score: 5, max_score: 5, accuracy: 1, evidence_score: 1, misconception_tags: [] }],
            grade_result: {
              artifact_id: "GRADE-ANCHOR",
              payload: {
                item_results: [
                  { item_id: "I1", objective_id: "OBJECTIVE-1", raw_score: 1, max_score: 1, evidence_score: 1, misconception_tags: [], feedback_code: "correct" },
                  { item_id: "I5", objective_id: "OBJECTIVE-1", raw_score: 4, max_score: 4, evidence_score: 1, misconception_tags: [], feedback_code: "passed" },
                ],
                feedback: { summary: "本轮全部达到完整要求。" },
              },
            },
            mastery_snapshot: [{ objective_id: "OBJECTIVE-1", mastery: 1, evidence_batches: 1, observed_modalities: ["mcq", "code"], revision: 1 }],
            final_decision: {
              action: "advance",
              basis: "round_accuracy",
              confidence: 0.9,
              reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
              target_objective_ids: [],
              policy_ref: "role-c-round-accuracy-v1",
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("/api/role-c/route-anchors")) {
        return new Response(JSON.stringify({
          status: "routed",
          routing_request_id: "R-ANCHOR",
          anchor_score_ratio: 1,
          route_id: "RT-ANCHOR",
          action: "advance",
          required_item_ids: ["N1"],
          learning_session: {
            phase: "route_locked",
            routing_request_id: "R-ANCHOR",
            session_id: "C-SESSION-LOCKED",
            run_id: "RUN-LOCKED",
            form_id: "FORM-LOCKED",
            attempt_no: 1,
            route_lock_id: "RL-ANCHOR",
            route_id: "RT-ANCHOR",
            action: "advance",
            anchor_score_ratio: 1,
            required_item_ids: ["N1"],
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("/api/role-c/continue")) {
        return new Response(JSON.stringify({
          status: "published",
          reviewedRelease: {
            delivery_kind: "reviewed_release",
            delivery_id: "DLV-ANCHOR-1",
            run_id: "RUN-ANCHOR",
            artifacts: [
              {
                artifact_id: "ART-ANCHOR-LESSON",
                artifact_type: "concept_lesson",
                payload: {
                  title: "锚点轮讲义",
                  explanation_blocks: [{ block_id: "b1", block_type: "paragraph", text: "锚点轮内容。", claims: [] }],
                  worked_examples: [],
                  misconceptions: [],
                  summary: [{ block_id: "b2", block_type: "paragraph", text: "总结。", claims: [] }],
                  prerequisite_bridge: [],
                },
                citations: [],
              },
              {
                artifact_id: "ART-ANCHOR-LAB",
                artifact_type: "code_lab_public",
                payload: {
                  title: "锚点轮实验",
                  instructions: [{ block_id: "b1", block_type: "paragraph", text: "实验说明。", claims: [] }],
                  public_tests: [],
                  starter_code: "def f():\n    pass",
                },
                citations: [],
              },
              {
                artifact_id: "ART-ANCHOR-ASSESSMENT",
                artifact_type: "assessment_public",
                payload: {
                  title: "锚点轮测评",
                  items: [
                    { item_id: "N1", tier: 1, modality: "mcq", prompt: "锚点题：打开文件用什么函数？", options: [{ option_id: "O1", label: "A", text: "open()" }], max_score: 1, citations: [] },
                    { item_id: "N2", tier: 3, modality: "code", prompt: "完整题：统计文件成绩。", starter_code: "def stats():\n    pass", max_score: 4, citations: [] },
                  ],
                },
                citations: [],
              },
            ],
            trace_events: [
              { run_id: "RUN-ANCHOR", seq: 1, agent: "tiered-evaluator", event_type: "c.agent.ready", status: "success", summary: "下一轮测评已就绪", occurred_at: "刚刚" },
            ],
          },
          learningSession: {
            session: {
              phase: "anchor_pending",
              routing_request_id: "R-ANCHOR",
              session_id: "C-SESSION-ANCHOR",
              run_id: "RUN-ANCHOR",
              form_id: "FORM-ANCHOR",
              attempt_no: 1,
              required_item_ids: ["N1"],
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return readyImplementation(input, init)
    })

    render(<App />)
    await setupRealPlan()
    await answerDynamicDiagnosis()
    await userEvent.click(screen.getByRole("button", { name: "查看学情画像" }))
    await userEvent.click(screen.getByRole("button", { name: "生成个性化方案" }))
    await userEvent.click(screen.getByRole("button", { name: "进入学习实操" }))
    await userEvent.click(screen.getByRole("tab", { name: /分阶测评.*检查本轮学习效果/ }))
    await userEvent.click(screen.getByRole("button", { name: "A. 依次处理列表中的每个元素" }))
    await userEvent.click(screen.getByRole("button", { name: "B. 正确" }))
    await userEvent.type(screen.getByLabelText("第 3 题代码追踪答案"), "total 最终为 6")
    await userEvent.type(screen.getByLabelText("第 4 题简答答案"), "列表按顺序保存多项成绩。")
    const code = screen.getByLabelText("第 5 题代码答案")
    await userEvent.clear(code)
    await userEvent.type(code, "def average_score(scores):\n    return sum(scores) / len(scores)")
    await userEvent.click(screen.getByRole("button", { name: "提交整套测评" }))
    await userEvent.click(screen.getByRole("button", { name: "查看反馈状态" }))
    await userEvent.click(await screen.findByRole("button", { name: "进入下一学习阶段" }))

    expect(await screen.findByRole("button", { name: "提交锚点题，确定测评路线" })).toBeDisabled()
    expect(screen.getByText("锚点题：打开文件用什么函数？")).toBeInTheDocument()
    expect(screen.queryByText("完整题：统计文件成绩。")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "A. open()" }))

    expect(screen.getByRole("button", { name: "提交锚点题，确定测评路线" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "提交锚点题，确定测评路线" }))

    expect(await screen.findByRole("button", { name: "提交整套测评" })).toBeDisabled()
    expect(screen.getByText("完整题：统计文件成绩。")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "A. open()" }))
    const fullCode = screen.getByLabelText("第 2 题代码答案")
    await userEvent.clear(fullCode)
    await userEvent.type(fullCode, "def stats():\n    return 1")
    expect(screen.getByRole("button", { name: "提交整套测评" })).toBeEnabled()
  }, 15000)
})
