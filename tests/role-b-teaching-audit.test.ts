// 测试: B 角色 Week2 教学审核 + 仲裁机制
// 覆盖: 四项审核维度 + 边界情况 + 仲裁合并逻辑
import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { auditTeaching } from "../src/role-b-profile/teaching-audit/auditor"
import { arbitrate } from "../src/role-b-profile/teaching-audit/arbitrator"
import type { LearnerProfile } from "../src/role-b-profile/types"
import type { KnowledgeBase } from "../src/knowledge/types"

let kb: KnowledgeBase

async function getKB(): Promise<KnowledgeBase> {
  if (!kb) kb = await loadKnowledgeBase()
  return kb
}

function makeProfile(overrides: Partial<LearnerProfile> = {}): LearnerProfile {
  return {
    learner_id: "test-learner-001",
    level: "beginner",
    known_concepts: ["变量", "数据类型"],
    weak_concepts: ["循环", "列表"],
    goal: "学会循环遍历数据",
    ...overrides,
  }
}

describe("teaching audit", () => {
  test("difficulty_alignment: beginner learner with beginner content passes", async () => {
    const kb = await getKB()
    // K007(for 循环, beginner) + K009(列表, basic), prereqs=K002+K003(known)
    // goal="学会循环遍历数据" matches K007 keywords
    const result = auditTeaching({
      artifactId: "test-1",
      learnerProfile: makeProfile(),
      knowledgeBase: kb,
      citedSourceIds: ["K007", "K009"],
    })
    expect(result.checks.difficulty.verdict).toBe("aligned")
    expect(result.checks.difficulty.contentMaxDifficulty).toBe("basic")
    expect(result.status).toBe("pass")
  })

  test("difficulty_alignment: beginner learner with integrated content is misaligned", async () => {
    const kb = await getKB()
    // K018(综合项目, integrated), prereqs need K007+K009+K013 — but difficulty is the blocking issue
    const result = auditTeaching({
      artifactId: "test-2",
      learnerProfile: makeProfile(),
      knowledgeBase: kb,
      citedSourceIds: ["K018"],
    })
    expect(result.checks.difficulty.verdict).toBe("misaligned")
    expect(result.status).toBe("reject")
  })

  test("difficulty_alignment: basic learner with intermediate content is within +1 range", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-3",
      learnerProfile: makeProfile({ level: "basic", known_concepts: ["变量", "数据类型", "条件判断", "循环", "列表", "函数定义与调用"] }),
      knowledgeBase: kb,
      citedSourceIds: ["K015"],  // 文件读写(intermediate), basic+1=intermediate
    })
    expect(result.checks.difficulty.verdict).toBe("aligned")
  })

  test("prerequisite: K007(for 循环) with all prereqs known → aligned", async () => {
    const kb = await getKB()
    // K007 prereqs = [K002, K003]; both in known_concepts
    const result = auditTeaching({
      artifactId: "test-4",
      learnerProfile: makeProfile({ known_concepts: ["变量", "数据类型", "条件判断"] }),
      knowledgeBase: kb,
      citedSourceIds: ["K007"],
    })
    expect(result.checks.prerequisite.verdict).toBe("aligned")
  })

  test("prerequisite: K018 requires K007+K009+K013 which learner doesn't know", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-5",
      learnerProfile: makeProfile({ known_concepts: ["变量", "数据类型"] }),
      knowledgeBase: kb,
      citedSourceIds: ["K018"],
    })
    expect(result.checks.prerequisite.verdict).toBe("misaligned")
    expect(result.status).toBe("reject")
  })

  test("prerequisite: prerequisite being taught in the same batch does not count as missing", async () => {
    const kb = await getKB()
    // K018 needs K007+K009+K013; K007+K009+K013 are all in the teaching batch
    // K013 itself needs K006(条件判断) — must also be in the batch
    const result = auditTeaching({
      artifactId: "test-6",
      learnerProfile: makeProfile({ known_concepts: ["变量", "数据类型"] }),
      knowledgeBase: kb,
      citedSourceIds: ["K005", "K006", "K007", "K009", "K013", "K018"],
    })
    // K018 prereqs: K007(taught) + K009(taught) + K013(taught), K013 prereq: K006(taught) → all covered by batch
    expect(result.checks.prerequisite.verdict).toBe("aligned")
  })

  test("weak_concept: content covers learner's weak point 循环", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-7",
      learnerProfile: makeProfile({ weak_concepts: ["循环"] }),
      knowledgeBase: kb,
      citedSourceIds: ["K007"],  // for 循环 → covers 循环
    })
    expect(result.checks.weakConcept.verdict).toBe("aligned")
    expect(result.checks.weakConcept.coveredWeakConcepts).toContain("循环")
  })

  test("weak_concept: content misses all weak points → revise", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-8",
      learnerProfile: makeProfile({
        weak_concepts: ["循环", "列表"],
        goal: "学会循环遍历数据",  // match K001? 不匹配也没关系，goal变为revise
      }),
      knowledgeBase: kb,
      citedSourceIds: ["K001", "K002"],  // Python是什么、变量——跟薄弱点无关
    })
    expect(result.checks.weakConcept.verdict).toBe("incomplete")
    expect(result.checks.weakConcept.uncoveredWeakConcepts).toContain("循环")
    expect(result.checks.weakConcept.uncoveredWeakConcepts).toContain("列表")
    // weak concept incomplete → revise; goal 不匹配 → revise; 最终 revise
    expect(result.status).toBe("revise")
  })

  test("weak_concept: empty weak concepts is aligned", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-9",
      learnerProfile: makeProfile({ weak_concepts: [] }),
      knowledgeBase: kb,
      citedSourceIds: ["K007"],
    })
    expect(result.checks.weakConcept.verdict).toBe("aligned")
  })

  test("goal: content keywords match learner's goal", async () => {
    const kb = await getKB()
    // K007 keywords: ["循环","遍历","重复执行"] → matches "学会循环遍历数据"
    const result = auditTeaching({
      artifactId: "test-10",
      learnerProfile: makeProfile({ goal: "学会循环遍历数据" }),
      knowledgeBase: kb,
      citedSourceIds: ["K007", "K009"],
    })
    expect(result.checks.goal.verdict).toBe("aligned")
  })

  test("goal: content unrelated to learner's goal → revise", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-11",
      learnerProfile: makeProfile({ goal: "完成一个成绩统计小程序" }),
      knowledgeBase: kb,
      citedSourceIds: ["K001", "K003"],  // Python是什么 + 基本数据类型
    })
    expect(result.checks.goal.verdict).toBe("misaligned")
    // goal misaligned → revise (not reject, because content can be adjusted)
    expect(result.status).toBe("revise")
  })

  test("all checks pass → status is pass", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-12",
      learnerProfile: makeProfile({
        level: "beginner",
        known_concepts: ["变量", "数据类型", "条件判断"],
        weak_concepts: ["循环"],
        goal: "学会循环遍历数据",
      }),
      knowledgeBase: kb,
      // K007 for 循环(beginner), prereq=K002+K003(both known), covers weak 循环, goal matches
      citedSourceIds: ["K007"],
    })
    expect(result.status).toBe("pass")
    expect(result.revisionHints).toEqual([])
  })

  test("status is reject when prerequisite check fails", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-13",
      learnerProfile: makeProfile({ known_concepts: [] }),
      knowledgeBase: kb,
      citedSourceIds: ["K018"],
    })
    expect(result.status).toBe("reject")
  })

  test("status is revise when only weak concept is incomplete", async () => {
    const kb = await getKB()
    // K001 (Python是什么, beginner, no prereqs) + goal "学会循环遍历数据" → goal不匹配
    const result = auditTeaching({
      artifactId: "test-14",
      learnerProfile: makeProfile({
        level: "beginner",
        known_concepts: ["变量", "数据类型", "条件判断"],
        weak_concepts: ["循环", "列表"],
        goal: "学会循环遍历数据",
      }),
      knowledgeBase: kb,
      citedSourceIds: ["K001"],
    })
    // weak concept incomplete + goal misaligned → revise
    expect(result.status).toBe("revise")
    expect(result.revisionHints.length).toBeGreaterThan(0)
  })

  test("empty cited source IDs produces proper error messages", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-15",
      learnerProfile: makeProfile(),
      knowledgeBase: kb,
      citedSourceIds: [],
    })
    expect(result.checks.difficulty.verdict).toBe("misaligned")
    expect(result.checks.goal.verdict).toBe("misaligned")
    // empty items → difficulty misaligned (no target items) → but it's "difficulty_alignment" so reject
    expect(result.status).toBe("reject")
  })

  test("summary is in Chinese and mentions failed dimensions", async () => {
    const kb = await getKB()
    const result = auditTeaching({
      artifactId: "test-16",
      learnerProfile: makeProfile({ level: "beginner", known_concepts: [] }),
      knowledgeBase: kb,
      citedSourceIds: ["K018"],
    })
    expect(result.summary).toContain("驳回")
    expect(result.summary.length).toBeGreaterThan(0)
  })
})

describe("arbitration", () => {
  test("dual pass → pass", () => {
    const result = arbitrate({
      artifactId: "arb-1",
      factAuditStatus: "pass",
      teachingAuditStatus: "pass",
      revisionRound: 0,
    })
    expect(result.decision).toBe("pass")
    expect(result.reason).toContain("通过")
  })

  test("fact reject + teaching pass → reject", () => {
    const result = arbitrate({
      artifactId: "arb-2",
      factAuditStatus: "reject",
      teachingAuditStatus: "pass",
      revisionRound: 0,
    })
    expect(result.decision).toBe("reject")
    expect(result.canRevise).toBe(false)
  })

  test("fact pass + teaching revise → revise (round 0)", () => {
    const result = arbitrate({
      artifactId: "arb-3",
      factAuditStatus: "pass",
      teachingAuditStatus: "revise",
      revisionRound: 0,
    })
    expect(result.decision).toBe("revise")
    expect(result.canRevise).toBe(true)
  })

  test("fact revise + teaching revise → revise (round 1)", () => {
    const result = arbitrate({
      artifactId: "arb-4",
      factAuditStatus: "revise",
      teachingAuditStatus: "revise",
      revisionRound: 1,
    })
    expect(result.decision).toBe("revise")
    expect(result.canRevise).toBe(true)
  })

  test("fact revise → reject when at max round (round 2)", () => {
    const result = arbitrate({
      artifactId: "arb-5",
      factAuditStatus: "revise",
      teachingAuditStatus: "pass",
      revisionRound: 2,
    })
    expect(result.decision).toBe("reject")
    expect(result.canRevise).toBe(false)
    expect(result.reason).toContain("超出上限")
  })

  test("teach reject → reject regardless of fact", () => {
    const result = arbitrate({
      artifactId: "arb-6",
      factAuditStatus: "pass",
      teachingAuditStatus: "reject",
      revisionRound: 0,
    })
    expect(result.decision).toBe("reject")
  })

  test("round 0 revise returns canRevise true", () => {
    const result = arbitrate({
      artifactId: "arb-7",
      factAuditStatus: "revise",
      teachingAuditStatus: "pass",
      revisionRound: 0,
    })
    expect(result.canRevise).toBe(true)
    expect(result.maxRevisionRounds).toBe(2)
  })
})
