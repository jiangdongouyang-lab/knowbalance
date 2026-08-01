import { describe, expect, test } from "vitest"
import { adaptLearnerProfile } from "../../../role-c-content/contracts/profile-adapter"
import {
  adaptRagResult,
  projectPublicRagEvidencePack,
} from "../../../role-c-content/contracts/evidence-pack"
import { loadKnowledgeBase } from "../../../knowledge/loader"
import {
  createLearningPlan,
  evaluatePlanDiagnosis,
  type RoleCRequester,
} from "./create-learning-plan"

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

  test("uses only the exact A-authored target quizzes without supplementing adjacent concepts", async () => {
    const plan = await createLearningPlan({
      ...input,
      knownConcepts: ["Python 是什么"],
      weakConcepts: ["变量"],
      goal: "学会变量与赋值，能用变量保存和更新数据",
      selfRating: "beginner",
    })

    expect(plan.diagnosis.items).toHaveLength(1)
    expect(plan.diagnosis.items[0]).toMatchObject({ sourceId: "K002", question: "变量赋值在 Python 中使用哪个符号？" })
    expect(new Set(plan.diagnosis.items.map((item) => item.question)).size).toBe(plan.diagnosis.items.length)
    expect(plan.diagnosis.items.map((item) => item.sourceId)).not.toEqual(expect.arrayContaining(["K003", "K007", "K009", "K013"]))
  })

  test("attaches official Role C resources only after the final diagnosis evidence is available", async () => {
    const plan = await createLearningPlan(input)
    expect(plan.session.artifacts).toEqual([])
    const answers = Object.fromEntries(plan.diagnosis.items.map((item) => [item.id, item.answer]))
    const updated = await evaluatePlanDiagnosis(plan, answers)

    expect(updated.session.artifacts.map((artifact) => artifact.kind)).toEqual(["lesson", "lab", "assessment"])
    expect(updated.session.artifacts.every((artifact) => artifact.status === "real")).toBe(true)
    expect(updated.session.artifacts.find((artifact) => artifact.kind === "assessment")?.items).toHaveLength(5)
    expect(updated.session.workflow.some((event) => event.agent === "concept-tutor" && event.status === "completed")).toBe(true)
    expect(updated.session.workflow.some((event) => event.agent === "code-lab" && event.status === "completed")).toBe(true)
    expect(updated.session.workflow.some((event) => event.agent === "tiered-evaluator" && event.status === "completed")).toBe(true)
  })

  test("marks path nodes completed from B concept provenance source IDs", async () => {
    const plan = await createLearningPlan(input)

    expect(plan.session.path.find((node) => node.id === "K009")?.status).toBe("completed")
    expect(plan.session.path.find((node) => node.id === "K002")?.status).not.toBe("completed")
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

  test("builds D's final session and path from C's recovered answer-free profile", async () => {
    let recoveredTargetTitle = ""
    const recoveringC: RoleCRequester = async (request) => {
      const pathNode = request.pathNode
      if (!pathNode) throw new Error("test requires the formal B path")
      const targetSourceId = pathNode.target_source_ids[0]!
      recoveredTargetTitle = request.ragResult.results.find((item) =>
        item.sourceId === targetSourceId)?.title ?? targetSourceId
      const profileSnapshot = adaptLearnerProfile({
        learner_id: request.profile.learner_id,
        level: "integrated",
        known_concepts: [recoveredTargetTitle],
        weak_concepts: [],
        goal: request.profile.goal,
      }, {
        profile_version: "PROFILE-RECOVERED-V2",
        provenance_ref: "role-b:recovery",
      })
      const finalEvidence = projectPublicRagEvidencePack(adaptRagResult(
        request.ragResult,
        { kb_version: request.kbVersion, rag_version: "test-recovery-v1" },
      ))
      return {
        status: "ready",
        artifacts: [],
        workflow: [],
        runId: request.runId,
        learningSession: {
          sessionId: `${request.runId}-SESSION-1`,
          formId: `${request.runId}-FORM-1`,
          attemptNo: 1,
        },
        finalContext: {
          profileSnapshot,
          profileVersion: profileSnapshot.profile_version,
          pathNode,
          evidencePack: finalEvidence,
        },
      }
    }
    const plan = await createLearningPlan(input, recoveringC)
    const answers = Object.fromEntries(plan.diagnosis.items.map((item) => [item.id, item.answer]))
    const updated = await evaluatePlanDiagnosis(plan, answers, recoveringC)

    expect(updated.session.profile).toMatchObject({
      learnerId: input.learnerId,
      profileVersion: "PROFILE-RECOVERED-V2",
      level: "integrated",
      knownConcepts: [recoveredTargetTitle],
      weakConcepts: [],
      goal: input.goal,
    })
    expect(updated.session.view.selfRatingDraft).toBe("integrated")
    expect(updated.session.path.find((node) => node.title === recoveredTargetTitle)?.status)
      .toBe("completed")
  })

  test("keeps an objectively incorrect concept out of completed path nodes", async () => {
    const learnerInput = {
      ...input,
      selfRating: "integrated" as const,
      knownConcepts: ["变量", "基本数据类型", "条件判断", "for循环", "列表", "函数定义与调用"],
      weakConcepts: ["循环", "列表", "函数"],
      goal: "完成成绩统计程序，使用循环遍历列表，并用函数计算平均成绩",
    }
    const blockedC = async ({ runId }: { runId: string }) => ({
      status: "blocked" as const,
      artifacts: [],
      workflow: [],
      runId,
      reason: "测试中不执行 C",
    })
    const plan = await createLearningPlan(learnerInput, blockedC)
    const answers = Object.fromEntries(plan.diagnosis.items.map((item) => [
      item.id,
      item.sourceId === "K002" ? "错误答案" : item.answer,
    ]))

    const updated = await evaluatePlanDiagnosis(plan, answers, blockedC)
    const variableNode = updated.session.path.find((node) => node.id === "K002")

    expect(updated.session.profile.weakConcepts).toContain("变量与赋值")
    expect(variableNode?.status).not.toBe("completed")
    expect(variableNode?.reason).toContain("客观诊断答错")
  })

  test("keeps an exact target with no authored choice as an explicit empty diagnosis", async () => {
    const plan = await createLearningPlan({
      ...input,
      knownConcepts: [],
      weakConcepts: ["Python 是什么"],
      goal: "了解 Python 是什么",
      selfRating: "beginner",
    })

    expect(plan.diagnosis.availability).toBe("unavailable")
    expect(plan.diagnosis.items).toEqual([])
    expect(plan.diagnosis.unavailableReason).toContain("不产生客观诊断证据")
  })

  test("orders pending path nodes by knowledge-base prerequisites before the final project", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const plan = await createLearningPlan({
      learnerId: "student-path-order",
      educationContext: "大二非计算机专业",
      timeBudget: "每周 4 小时",
      selfRating: "basic",
      priorLanguages: ["Python"],
      knownConcepts: ["Python 是什么", "变量"],
      weakConcepts: ["循环", "列表"],
      goal: "完成成绩统计程序，计算平均分、最高分和最低分",
    })

    const pathIds = new Set(plan.session.path.map((node) => node.id))
    const nodeById = new Map(plan.session.path.map((node) => [node.id, node]))
    // 规则：任何节点的前置知识如果也出现在路径中且尚未完成，必须排在该节点之前
    for (const node of plan.session.path) {
      const item = knowledgeBase.items.find((candidate) => candidate.sourceId === node.id)
      for (const prereqId of item?.prerequisites ?? []) {
        const prereqNode = nodeById.get(prereqId)
        if (prereqNode && prereqNode.status !== "completed" && pathIds.has(prereqId)) {
          expect(plan.session.path.indexOf(prereqNode)).toBeLessThan(plan.session.path.indexOf(node))
        }
      }
    }

    // 综合项目的前置知识未完成时，综合项目不能是当前学习节点
    const k018Prereqs = new Set(knowledgeBase.items.find((item) => item.sourceId === "K018")?.prerequisites ?? [])
    const pendingK018Prereqs = plan.session.path.filter((node) => k018Prereqs.has(node.id) && node.status !== "completed")
    expect(pendingK018Prereqs.length).toBeGreaterThan(0)
    expect(plan.session.path.find((node) => node.id === "K018")?.status).not.toBe("current")
  })

  test("calls C zero times before diagnosis and once after submit or skip", async () => {
    let calls = 0
    const blockedC = async ({ runId }: { runId: string }) => {
      calls += 1
      return { status: "blocked" as const, artifacts: [], workflow: [], runId, reason: "test" }
    }
    const plan = await createLearningPlan(input, blockedC)
    expect(calls).toBe(0)
    const answers = Object.fromEntries(plan.diagnosis.items.map((item) => [item.id, item.answer]))
    await evaluatePlanDiagnosis(plan, answers, blockedC)
    expect(calls).toBe(1)
  })

  test("skips an unavailable diagnosis without creating incorrect objective evidence", async () => {
    let requestedProfile: { known_concepts: string[]; weak_concepts: string[] } | undefined
    const blockedC = async ({ runId, profile }: { runId: string; profile: { known_concepts: string[]; weak_concepts: string[] } }) => {
      requestedProfile = profile
      return { status: "blocked" as const, artifacts: [], workflow: [], runId, reason: "test" }
    }
    const plan = await createLearningPlan({
      ...input,
      knownConcepts: [],
      weakConcepts: ["Python 是什么"],
      goal: "了解 Python 是什么",
      selfRating: "beginner",
    }, blockedC)

    const updated = await evaluatePlanDiagnosis(plan, {}, blockedC)
    expect(updated.session.view.diagnosisSubmitted).toBe(true)
    expect(updated.session.diagnosis.items).toEqual([])
    expect(requestedProfile?.known_concepts).not.toContain("Python 是什么")
    expect(requestedProfile?.weak_concepts).toContain("Python 是什么")
  })

  test.each(["画一只猫", "学习装饰器", "学习量子计算电路"])("rejects diagnosis for an unrelated goal: %s", async (goal) => {
    await expect(createLearningPlan({
      ...input,
      goal,
      knownConcepts: [],
      weakConcepts: [],
      selfRating: "beginner",
    }, async ({ runId }) => ({ status: "blocked", artifacts: [], workflow: [], runId, reason: "unsupported" }))).rejects.toThrow("没有语义相关的可诊断知识点")
  })
})
