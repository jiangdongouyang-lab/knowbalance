import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeBase, KnowledgeItem } from "../src/knowledge/types"
import { retrieveKnowledge, type RagResult } from "../src/rag/retriever"
import { buildRagQuery } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  ROLE_C_PROMPT_MANIFEST_VERSION,
} from "../src/role-c-content"
import { modalityMeasuresBehavior } from "../src/role-c-content/contracts/assessment-measurement"
import { buildAssessmentItemPlan } from "../src/role-c-content/providers/staged-generation"
import { buildInitialRoleCContext } from "../src/role-d-integration/initial-learning-path"

describe("formal initial B/A to C path", () => {
  test("selects the dictionary goal instead of filling the path with high-scoring known concepts", async () => {
    const profile: LearnerProfile = {
      learner_id: "path-dict",
      level: "basic",
      known_concepts: ["变量", "数据类型", "for 循环", "列表"],
      weak_concepts: ["字典", "键值对"],
      goal: "使用字典统计每个单词出现的次数并按键查询",
    }
    const context = await buildContext(profile)
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.pathNode.target_source_ids).toEqual(["K010"])
    expect(context.pathNode.target_source_ids).not.toEqual(
      expect.arrayContaining(["K007", "K018"]),
    )
    expect(context.pathNode.prerequisite_source_ids).not.toContain("K009")
    expect(context.pathNode.objectives).toHaveLength(1)
    expect(context.pathNode.objectives[0]).toMatchObject({
      source_id: "K010",
      observable_behavior: "apply",
      importance: "core",
    })

    const pack = adaptRagResult(context.ragResult, {
      kb_version: (await loadKnowledgeBase()).version,
      rag_version: "initial-path-test",
    })
    const built = buildGenerationSpec({
      run_id: "RUN-PATH-DICT",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "v1" }),
      path_node: context.pathNode,
      evidence_pack: pack,
      versions: {
        prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
        model_config_hash: "path-test",
      },
    })
    expect(built.ok).toBe(true)
  })

  test("plans safe file-I/O content from KB metadata without a source-id branch", async () => {
    const profile: LearnerProfile = {
      learner_id: "path-file",
      level: "intermediate",
      known_concepts: ["Python 是什么", "变量与赋值", "基本数据类型", "字符串常用操作"],
      weak_concepts: ["文件读写", "read", "write"],
      goal: "读取文本内容，统计非空行并写出处理结果",
    }
    const context = await buildContext(profile)
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.pathNode.target_source_ids).toEqual(["K015"])
    expect(context.pathNode.assessment_blueprint.tier_2_count).toBeGreaterThan(0)
  })

  test("keeps the explicit function contract target when diagnosis weaknesses crowd the combined top five", async () => {
    const profile: LearnerProfile = {
      learner_id: "path-function-contract",
      level: "beginner",
      known_concepts: [],
      weak_concepts: [
        "函数定义与调用",
        "变量与赋值",
        "条件判断",
        "for 循环",
        "基本数据类型",
        "参数",
        "返回值",
      ],
      goal: "编写一个带参数和返回值的函数，根据原价和折扣计算最终价格",
    }
    const query = buildRagQuery(profile)
    const lowRecall = await retrieveKnowledge({
      query,
      learnerLevel: profile.level,
      topK: 5,
    })
    const wideRecall = await retrieveKnowledge({
      query,
      learnerLevel: profile.level,
      topK: 10,
    })
    expect(lowRecall.results.map((item) => item.sourceId)).not.toContain("K014")

    const knowledgeBase = await loadKnowledgeBase()
    const lowContext = await buildInitialRoleCContext({
      profile,
      ragResult: lowRecall,
      knowledgeBase,
    })
    const wideContext = await buildInitialRoleCContext({
      profile,
      ragResult: wideRecall,
      knowledgeBase,
    })
    expect(lowContext.ok).toBe(true)
    expect(wideContext.ok).toBe(true)
    if (!lowContext.ok || !wideContext.ok) return
    expect(lowContext.pathNode.target_source_ids).toEqual(["K014"])
    expect(wideContext.pathNode.target_source_ids).toEqual(
      lowContext.pathNode.target_source_ids,
    )
    expect(lowContext.pathNode.prerequisite_source_ids).toContain("K013")
  })

  test("preserves independent explicit targets instead of applying one global relative threshold", async () => {
    const profile: LearnerProfile = {
      learner_id: "path-independent-targets",
      level: "intermediate",
      known_concepts: [],
      weak_concepts: ["字典", "异常处理", "模块导入"],
      goal: "使用字典、异常处理和模块导入完成程序",
    }
    const context = await buildContext(profile)
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(new Set(context.pathNode.target_source_ids)).toEqual(new Set([
      "K010",
      "K016",
      "K017",
    ]))
    expect(context.pathNode.objectives).toHaveLength(3)
  })

  test("does not manufacture path evidence when A structured retrieval is empty", async () => {
    const profile: LearnerProfile = {
      learner_id: "path-exact-evidence",
      level: "basic",
      known_concepts: [],
      weak_concepts: ["参数", "返回值"],
      goal: "编写带参数和返回值的函数",
    }
    const initial = await retrieveKnowledge({
      query: "参数 返回值",
      learnerLevel: profile.level,
      topK: 1,
    })
    const observedTopK: number[] = []
    const observedQueries: string[] = []
    const context = await buildInitialRoleCContext({
      profile,
      ragResult: initial,
      knowledgeBase: await loadKnowledgeBase(),
      retrievalPort: {
        async retrieve(request) {
          observedTopK.push(request.topK ?? 0)
          observedQueries.push(request.query)
          return {
            query: request.query,
            learnerLevel: request.learnerLevel,
            topK: request.topK ?? 0,
            results: [],
          }
        },
        async retrieveStructuredEvidence() {
          return {
            results: [],
            missing_source_ids: [],
            missing_fact_refs: [],
          }
        },
      },
    })
    expect(context.ok).toBe(false)
    expect(observedTopK.length).toBe(3)
    expect(observedTopK.every((topK) => topK >= 1 && topK <= 10)).toBe(true)
    expect(observedQueries).toEqual([
      `学习目标：${profile.goal}`,
      "薄弱点：参数",
      "薄弱点：返回值",
    ])
    if (context.ok) return
    expect(context.code).toBe("MISSING_PATH_EVIDENCE")
    expect(context.reason).toContain("A 未返回 B 路径所需的精确证据")
  })

  test("expands a multi-level prerequisite graph dependency-first and refreshes every source through A", async () => {
    const profile: LearnerProfile = {
      learner_id: "path-project",
      level: "beginner",
      known_concepts: [],
      weak_concepts: ["循环", "列表", "函数"],
      goal: "从基础开始完成成绩统计器并计算平均分",
    }
    const context = await buildContext(profile)
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.pathNode.target_source_ids).toEqual(["K018"])
    const prerequisites = context.pathNode.prerequisite_source_ids
    expect(prerequisites).toEqual(expect.arrayContaining([
      "K001", "K002", "K003", "K005", "K006", "K007", "K009", "K013",
    ]))
    expect(prerequisites.indexOf("K002")).toBeLessThan(prerequisites.indexOf("K007"))
    expect(prerequisites.indexOf("K007")).toBeLessThan(prerequisites.indexOf("K013"))
    const evidenceIds = context.ragResult.results.map((item) => item.sourceId)
    expect(evidenceIds).toEqual(expect.arrayContaining([
      ...context.pathNode.target_source_ids,
      ...prerequisites,
    ]))
  })

  test("accepts a newly added knowledge source without changing planner code", async () => {
    const kb = await loadKnowledgeBase()
    const generatedItem: KnowledgeItem = {
      sourceId: "K777",
      title: "生成器基础",
      module: "python-basic",
      difficulty: "intermediate",
      prerequisites: [],
      keywords: ["生成器", "yield"],
      file: "K777_generator.md",
      snippet: "生成器可以逐项产生值。",
      facts: [
        { sourceId: "K777", factId: "F001", content: "生成器可以逐项产生值。" },
        { sourceId: "K777", factId: "F002", content: "生成器对象可以按需迭代。" },
        { sourceId: "K777", factId: "F003", content: "yield 会产生一个值并暂停函数。" },
        { sourceId: "K777", factId: "F004", content: "生成器有助于减少一次性内存占用。" },
        { sourceId: "K777", factId: "F005", content: "生成器耗尽后会停止迭代。" },
      ],
      examples: [{ title: "生成值", code: "def values():\n    yield 1", explanation: "逐项产生" }],
      practiceTasks: ["编写一个生成器"],
      quizItems: [{ level: 2, type: "mcq", question: "哪个关键字产生值？", options: ["yield", "break"], answer: "yield", sourceId: "K777", factId: "F001" }],
    }
    const extended: KnowledgeBase = {
      ...kb,
      items: [...kb.items, generatedItem],
      sources: [...kb.sources, generatedItem.file],
    }
    const ragResult: RagResult = {
      query: "生成器",
      learnerLevel: "intermediate",
      topK: 1,
      results: [{
        sourceId: "K777",
        source_id: "K777",
        title: generatedItem.title,
        difficulty: generatedItem.difficulty,
        score: 30,
        reason: "命中生成器",
        snippet: generatedItem.snippet,
        facts: generatedItem.facts,
        examples: generatedItem.examples,
        practiceTasks: generatedItem.practiceTasks,
        quizItems: generatedItem.quizItems,
        file: generatedItem.file,
        retrievalTrace: {
          matchedKeywords: ["生成器"],
          matchedFields: ["keywords", "practiceTasks"],
          difficultyMatch: true,
          scoreBreakdown: { keyword: 10, title: 5, facts: 3, practiceTasks: 2, difficulty: 3, bonus: 7 },
        },
        retrieval_trace: {
          matched_keywords: ["生成器"],
          matched_fields: ["keywords", "practiceTasks"],
          difficulty_match: true,
          score_breakdown: { keyword: 10, title: 5, facts: 3, practiceTasks: 2, difficulty: 3, bonus: 7 },
        },
      }],
    }
    const context = await buildInitialRoleCContext({
      profile: {
        learner_id: "path-new-source",
        level: "intermediate",
        known_concepts: [],
        weak_concepts: ["生成器", "yield"],
        goal: "使用生成器逐项生成数据",
      },
      ragResult,
      knowledgeBase: extended,
    })
    expect(context.ok).toBe(true)
    if (context.ok) {
      expect(context.pathNode.target_source_ids).toEqual(["K777"])
      expect(context.pathNode.objectives[0]!.required_fact_ids.length)
        .toBeGreaterThanOrEqual(1)
      expect(context.pathNode.objectives[0]!.required_fact_ids.length)
        .toBeLessThanOrEqual(3)
      expect(context.pathNode.objectives[0]!.required_fact_ids).toContain("F003")
    }
  })

  for (const targetCount of [18, 21, 30]) {
    test(`keeps every one of ${targetCount} generic core targets measurable within tier limits`, async () => {
      const { profile, ragResult, knowledgeBase } = syntheticMultiTargetInput(targetCount)
      const context = await buildInitialRoleCContext({
        profile,
        ragResult,
        knowledgeBase,
      })
      expect(context.ok).toBe(true)
      if (!context.ok) return

      expect(context.pathNode.objectives).toHaveLength(targetCount)
      expect(context.pathNode.objectives.every((objective) =>
        objective.importance === "core")).toBe(true)
      const blueprint = context.pathNode.assessment_blueprint
      const tierCounts = [
        blueprint.tier_1_count,
        blueprint.tier_2_count,
        blueprint.tier_3_count,
      ]
      expect(tierCounts.reduce((sum, count) => sum + count, 0)).toBe(targetCount)
      expect(Math.max(...tierCounts)).toBeLessThanOrEqual(20)
      expect(blueprint.tier_1_count + blueprint.tier_2_count).toBeGreaterThan(0)

      const built = buildGenerationSpec({
        run_id: `RUN-PATH-MULTI-${targetCount}`,
        profile_snapshot: adaptLearnerProfile(profile, { profile_version: "v1" }),
        path_node: context.pathNode,
        evidence_pack: adaptRagResult(context.ragResult, {
          kb_version: knowledgeBase.version,
          rag_version: "initial-path-multi-test",
        }),
        versions: {
          prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
          model_config_hash: "path-multi-test",
        },
      })
      expect(built.ok).toBe(true)
      if (!built.ok) return

      const behaviorByObjective = new Map(built.spec.targets.map((target) => [
        target.objective_id,
        target.observable_behavior,
      ]))
      const plan = buildAssessmentItemPlan(built.spec)
      expect(plan).toHaveLength(targetCount)
      expect(new Set(plan.map((item) => item.objective_id)).size).toBe(targetCount)
      for (const item of plan) {
        expect(modalityMeasuresBehavior(
          behaviorByObjective.get(item.objective_id)!,
          item.modality,
        )).toBe(true)
      }
    })
  }
})

function syntheticMultiTargetInput(targetCount: number): {
  profile: LearnerProfile
  ragResult: RagResult
  knowledgeBase: KnowledgeBase
} {
  const items = Array.from({ length: targetCount }, (_, index): KnowledgeItem => {
    const sequence = String(index + 1).padStart(2, "0")
    const sourceId = `K${String(501 + index).padStart(3, "0")}`
    return {
      sourceId,
      title: `批量处理概念 ${sequence}`,
      module: "synthetic-planner-test",
      difficulty: "intermediate",
      prerequisites: [],
      keywords: ["批量处理"],
      file: `${sourceId}.md`,
      snippet: `概念 ${sequence} 用于批量处理任务。`,
      facts: [{
        sourceId,
        factId: "F001",
        content: `批量处理概念 ${sequence} 的可验证事实。`,
      }],
      examples: [{
        title: `概念 ${sequence} 示例`,
        code: `result_${sequence} = "${sourceId}"`,
        explanation: `展示如何使用概念 ${sequence}。`,
      }],
      practiceTasks: [`使用概念 ${sequence} 完成批量处理`],
      quizItems: [{
        level: 2,
        type: "short_answer",
        question: `如何使用批量处理概念 ${sequence}？`,
        answer: `按照概念 ${sequence} 的可验证事实处理。`,
        sourceId,
        factId: "F001",
      }],
    }
  })
  const ragResults = items.map((item) => ({
    sourceId: item.sourceId,
    source_id: item.sourceId,
    title: item.title,
    difficulty: item.difficulty,
    score: 30,
    reason: "命中共享的批量处理学习意图",
    snippet: item.snippet,
    facts: item.facts,
    examples: item.examples,
    practiceTasks: item.practiceTasks,
    quizItems: item.quizItems,
    file: item.file,
    retrievalTrace: {
      matchedKeywords: ["批量处理"],
      matchedFields: ["keywords", "practiceTasks"],
      difficultyMatch: true,
      scoreBreakdown: {
        keyword: 10,
        title: 5,
        facts: 3,
        practiceTasks: 2,
        difficulty: 3,
        bonus: 7,
      },
    },
    retrieval_trace: {
      matched_keywords: ["批量处理"],
      matched_fields: ["keywords", "practiceTasks"],
      difficulty_match: true,
      score_breakdown: {
        keyword: 10,
        title: 5,
        facts: 3,
        practiceTasks: 2,
        difficulty: 3,
        bonus: 7,
      },
    },
  }))
  return {
    profile: {
      learner_id: `path-multi-${targetCount}`,
      level: "intermediate",
      known_concepts: [],
      weak_concepts: ["批量处理"],
      goal: "使用批量处理概念完成综合任务",
    },
    ragResult: {
      query: "批量处理",
      learnerLevel: "intermediate",
      topK: targetCount,
      results: ragResults,
    },
    knowledgeBase: {
      module: "synthetic-planner-test",
      version: "synthetic-v1",
      updatedAt: "2026-07-31",
      sources: items.map((item) => item.file),
      items,
    },
  }
}

async function buildContext(profile: LearnerProfile) {
  const ragResult = await retrieveKnowledge({
    query: buildRagQuery(profile),
    learnerLevel: profile.level,
    topK: 5,
  })
  return buildInitialRoleCContext({
    profile,
    ragResult,
    knowledgeBase: await loadKnowledgeBase(),
  })
}
