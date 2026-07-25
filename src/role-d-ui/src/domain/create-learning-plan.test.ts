import { describe, expect, test } from "vitest"
import { createLearningPlan, evaluatePlanDiagnosis } from "./create-learning-plan"

const input = {
  learnerId: "student-project-001",
  educationContext: "大二非计算机专业",
  timeBudget: "每周 4 小时",
  selfRating: "basic" as const,
  knownConcepts: ["变量", "列表"],
  weakConcepts: ["循环"],
  goal: "完成成绩统计程序",
}

describe("createLearningPlan", () => {
  test("runs the real B profile synthesis and A retrieval for new learner input", async () => {
    const plan = await createLearningPlan(input)

    expect(plan.source).toBe("real-ab")
    expect(plan.session.profile.learnerId).toBe("student-project-001")
    expect(plan.session.profile.goal).toBe("完成成绩统计程序")
    expect(plan.session.profile.knownConcepts).toEqual(expect.arrayContaining(["变量", "列表"]))
    expect(plan.session.retrieval.items.length).toBeGreaterThan(0)
    expect(plan.session.retrieval.items.map((item) => item.sourceId)).toEqual(expect.arrayContaining(["K018"]))
    expect(plan.session.view.currentStage).toBe("diagnosis")
    expect(plan.diagnosis.items.length).toBeGreaterThanOrEqual(3)
    expect(plan.diagnosis.items.length).toBeLessThanOrEqual(5)
    expect(new Set(plan.diagnosis.items.map((item) => item.sourceId)).size).toBe(plan.diagnosis.items.length)
    expect(plan.diagnosis.items.every((item) => item.options.length > 1)).toBe(true)
  })

  test("attaches official Role C real lesson, lab, and five-tiered assessment items", async () => {
    const plan = await createLearningPlan(input)

    expect(plan.session.artifacts.map((artifact) => artifact.kind)).toEqual(["lesson", "lab", "assessment"])
    expect(plan.session.artifacts.every((artifact) => artifact.status === "real")).toBe(true)
    expect(plan.session.artifacts.find((artifact) => artifact.kind === "assessment")?.items).toHaveLength(5)
    expect(plan.session.workflow.some((event) => event.agent === "concept-tutor" && event.status === "completed")).toBe(true)
    expect(plan.session.workflow.some((event) => event.agent === "code-lab" && event.status === "completed")).toBe(true)
    expect(plan.session.workflow.some((event) => event.agent === "tiered-evaluator" && event.status === "completed")).toBe(true)
  })

  test("marks path nodes completed from B concept provenance source IDs", async () => {
    const plan = await createLearningPlan(input)

    expect(plan.session.path.find((node) => node.id === "K009")?.status).toBe("completed")
    expect(plan.session.path.find((node) => node.id === "K002")?.status).toBe("completed")
    expect(plan.session.path.find((node) => node.id === "K007")?.status).not.toBe("completed")
    expect(plan.session.path.map((node) => node.status)).toEqual([...plan.session.path.map((node) => node.status)].sort((left, right) => ({ completed: 0, current: 1, upcoming: 2 })[left] - ({ completed: 0, current: 1, upcoming: 2 })[right]))
  })

  test("feeds all selected diagnosis answers back through B and reruns A", async () => {
    const plan = await createLearningPlan(input)
    const answers = Object.fromEntries(plan.diagnosis.items.map((item, index) => [item.id, index === 0 ? item.answer : "一定是错误答案"]))
    const updated = await evaluatePlanDiagnosis(plan, answers)

    expect(updated.session.view.diagnosisSubmitted).toBe(true)
    expect(updated.session.profile.knownConcepts).toContain(plan.diagnosis.items[0]?.concept)
    expect(updated.session.profile.weakConcepts).toEqual(expect.arrayContaining(plan.diagnosis.items.slice(1).map((item) => item.concept)))
    expect(updated.session.retrieval.items.length).toBeGreaterThan(0)
  })

  test("skips short-answer items until it finds a real knowledge-base choice question", async () => {
    const plan = await createLearningPlan({
      ...input,
      knownConcepts: [],
      weakConcepts: ["Python 是什么"],
      goal: "了解 Python 是什么",
      selfRating: "beginner",
    })

    expect(plan.session.retrieval.items[0]?.sourceId).toBe("K001")
    expect(plan.diagnosis.items.length).toBeGreaterThan(0)
    expect(plan.diagnosis.items.every((item) => item.options.length > 1)).toBe(true)
    expect(plan.diagnosis.items[0]?.sourceId).not.toBe("K001")
  })

  test.each(["画一只猫", "学习装饰器"])("rejects diagnosis for an unrelated goal: %s", async (goal) => {
    await expect(createLearningPlan({
      ...input,
      goal,
      knownConcepts: [],
      weakConcepts: [],
      selfRating: "beginner",
    }, async ({ runId }) => ({ status: "blocked", artifacts: [], workflow: [], runId, reason: "unsupported" }))).rejects.toThrow("没有语义相关的可诊断知识点")
  })
})
