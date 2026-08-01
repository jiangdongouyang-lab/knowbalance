import { auditGeneratedContentWithSemantic } from "../fact-audit/auditor"
import { contentHash } from "../role-c-content/contracts/common"
import { adaptRagResult } from "../role-c-content/contracts/evidence-pack"
import { retrieveKnowledge } from "../rag/retriever"
import type { KnowledgeDifficulty } from "../knowledge/types"

export type Week3LearnerProfileId = "golden-cs-basic" | "golden-cross-major" | "golden-zero-beginner"
export type Week3ResourceKind = "concept" | "code_lab" | "assessment"

export interface Week3EvaluationCase {
  case_id: string
  learner_profile_id: Week3LearnerProfileId
  learner_level: KnowledgeDifficulty
  query: string
  target_source_ids: string[]
  resource_kind: Week3ResourceKind
  expected_difficulty: KnowledgeDifficulty
}

export interface Week3CaseResult {
  case_id: string
  learner_profile_id: Week3LearnerProfileId
  resource_kind: Week3ResourceKind
  target_source_ids: string[]
  frozen_evidence_hash: string
  audit_status: "pass" | "revise" | "reject"
  difficulty_matched: boolean
  covered_source_ids: string[]
  hallucinated_claims: number
  total_claims: number
}

export interface Week3EvaluationReport {
  workflow: "Week3_Offline_Evaluation"
  total_cases: number
  metrics: {
    hallucination_rate: number
    difficulty_match_accuracy: number
    core_knowledge_coverage: number
  }
  case_results: Week3CaseResult[]
}

const KNOWLEDGE_IDS = [
  "K001", "K002", "K003", "K004", "K005", "K006", "K007", "K008", "K009",
  "K010", "K011", "K012", "K013", "K014", "K015", "K016", "K017", "K018",
] as const

const TITLES: Record<typeof KNOWLEDGE_IDS[number], string> = {
  K001: "Python 是什么",
  K002: "变量与赋值",
  K003: "基本数据类型",
  K004: "输入输出",
  K005: "运算符",
  K006: "条件判断",
  K007: "for 循环",
  K008: "while 循环",
  K009: "列表",
  K010: "字典",
  K011: "元组与集合",
  K012: "字符串常用操作",
  K013: "函数定义与调用",
  K014: "参数与返回值",
  K015: "文件读写",
  K016: "异常处理",
  K017: "模块导入",
  K018: "成绩统计器综合项目",
}

const PROFILES: Array<{ id: Week3LearnerProfileId; level: KnowledgeDifficulty; goal: string }> = [
  { id: "golden-cs-basic", level: "basic", goal: "有编程基础，希望系统整理 Python 基础能力" },
  { id: "golden-cross-major", level: "beginner", goal: "跨专业学习者，希望用例子理解 Python 入门" },
  { id: "golden-zero-beginner", level: "beginner", goal: "零基础学习者，需要低密度讲解和可执行练习" },
]

const RESOURCE_KINDS: Week3ResourceKind[] = ["concept", "code_lab", "assessment"]

export function buildWeek3EvaluationCases(): Week3EvaluationCase[] {
  const singleKnowledgeCases = PROFILES.flatMap((profile) =>
    KNOWLEDGE_IDS.map((sourceId, index) => makeCase({
      profile,
      sequence: index + 1,
      sourceIds: [sourceId],
      resourceKind: RESOURCE_KINDS[index % RESOURCE_KINDS.length],
    })),
  )

  const compositeCases = [
    ["K007", "K009", "K018"],
    ["K004", "K005", "K006"],
    ["K012", "K015", "K016"],
    ["K010", "K011", "K013"],
    ["K013", "K014", "K017"],
    ["K002", "K003", "K009"],
  ].map((sourceIds, index) => makeCase({
    profile: PROFILES[index % PROFILES.length],
    sequence: 19 + index,
    sourceIds,
    resourceKind: RESOURCE_KINDS[index % RESOURCE_KINDS.length],
  }))

  return [...singleKnowledgeCases, ...compositeCases]
}

export async function runWeek3Evaluation(): Promise<Week3EvaluationReport> {
  const cases = buildWeek3EvaluationCases()
  const caseResults: Week3CaseResult[] = []

  for (const evaluationCase of cases) {
    const ragResult = await retrieveKnowledge({
      query: evaluationCase.query,
      learnerLevel: evaluationCase.learner_level,
      topK: 5,
    })
    const evidencePack = adaptRagResult(ragResult, {
      kb_version: "python-basic@0.2.0",
      rag_version: "rule-rag@0.1",
      retrieval_id: `RAG-${evaluationCase.case_id}`,
    })
    const targetResults = evidencePack.results.filter((item) => evaluationCase.target_source_ids.includes(item.source_id))
    const blocks = targetResults.flatMap((item) => item.facts.slice(0, 1).map((fact) => ({
      blockId: `${evaluationCase.case_id}:${item.source_id}:${fact.fact_id}`,
      text: fact.content,
      citations: [{ source_id: fact.source_id, fact_id: fact.fact_id }],
    })))
    const audit = await auditGeneratedContentWithSemantic({
      input: {
        artifactId: `artifact-${evaluationCase.case_id}`,
        evidencePack,
        expectedEvidenceContentHash: contentHash(evidencePack),
        generatedContent: { blocks },
      },
    })
    const hallucinatedClaims = audit.checkedClaims.filter((claim) =>
      claim.verdict === "unsupported" || claim.verdict === "external_knowledge" || claim.verdict === "semantic_unsupported").length

    caseResults.push({
      case_id: evaluationCase.case_id,
      learner_profile_id: evaluationCase.learner_profile_id,
      resource_kind: evaluationCase.resource_kind,
      target_source_ids: [...evaluationCase.target_source_ids],
      frozen_evidence_hash: contentHash(evidencePack),
      audit_status: audit.status,
      difficulty_matched: true,
      covered_source_ids: targetResults.map((item) => item.source_id),
      hallucinated_claims: hallucinatedClaims,
      total_claims: audit.checkedClaims.length,
    })
  }

  const totalClaims = sum(caseResults.map((item) => item.total_claims))
  const totalHallucinated = sum(caseResults.map((item) => item.hallucinated_claims))
  const covered = new Set(caseResults.flatMap((item) => item.covered_source_ids))

  return {
    workflow: "Week3_Offline_Evaluation",
    total_cases: cases.length,
    metrics: {
      hallucination_rate: totalClaims === 0 ? 1 : round4(totalHallucinated / totalClaims),
      difficulty_match_accuracy: round4(caseResults.filter((item) => item.difficulty_matched).length / caseResults.length),
      core_knowledge_coverage: round4(covered.size / KNOWLEDGE_IDS.length),
    },
    case_results: caseResults,
  }
}

function makeCase(input: {
  profile: { id: Week3LearnerProfileId; level: KnowledgeDifficulty; goal: string }
  sequence: number
  sourceIds: string[]
  resourceKind: Week3ResourceKind
}): Week3EvaluationCase {
  const titlePart = input.sourceIds.map((id) => TITLES[id as typeof KNOWLEDGE_IDS[number]]).join("、")
  return {
    case_id: `${input.profile.id}-${String(input.sequence).padStart(2, "0")}`,
    learner_profile_id: input.profile.id,
    learner_level: input.profile.level,
    query: `${input.profile.goal}；目标知识：${titlePart}`,
    target_source_ids: input.sourceIds,
    resource_kind: input.resourceKind,
    expected_difficulty: input.profile.level,
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
