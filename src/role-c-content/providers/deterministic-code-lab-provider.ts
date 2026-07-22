import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  CodeLabRequest,
  ConceptTutorRequest,
  RoleCContentProvider,
} from "../agents/types"
import type {
  Claim,
  CodeLabPublicPayload,
  CodeLabSecurePayload,
  ConceptLessonPayload,
} from "../contracts/artifacts"
import { stableId, type CitationRef } from "../contracts/common"
import { ModelProviderUnavailableError } from "../contracts/model-gateway"
import { DeterministicConceptContentProvider } from "./deterministic-concept-provider"
import { buildDeterministicAssessmentDraft } from "./deterministic-assessment-provider"

/** Offline K018 reference Provider used for reproducible stage-two demos and tests. */
export class DeterministicCodeLabContentProvider implements RoleCContentProvider {
  private readonly concept = new DeterministicConceptContentProvider()

  generateConceptLesson(request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>> {
    return this.concept.generateConceptLesson(request)
  }

  async generateCodeLab(request: CodeLabRequest): Promise<CodeLabDraft> {
    const objectiveIds = request.generation_spec.targets.map((target) => target.objective_id)
    if (objectiveIds.length !== 3) {
      throw new ModelProviderUnavailableError(
        "阶段 2 离线 code-lab 基准实现仅支持包含 3 个目标的 K018 金标任务",
      )
    }
    const facts = request.generation_spec.targets.map((target) => {
      const source = request.evidence_pack.results.find((entry) => entry.source_id === target.source_id)
      const fact = source?.facts.find((entry) => target.required_fact_ids.includes(entry.fact_id))
      if (!source || !fact) throw new ModelProviderUnavailableError(`code-lab 缺少目标事实 ${target.source_id}`)
      return { target, source, fact }
    })
    const labId = stableId("LAB", {
      spec_id: request.generation_spec.spec_id,
      objective_ids: objectiveIds,
      seed: request.generation_spec.policies.seed,
    })
    const testSuiteId = stableId("TS", { lab_id: labId, version: "score-average-v1" })
    const instructions: CodeLabPublicPayload["instructions"] = facts.map(({ target, source, fact }) => ({
      block_id: `${target.objective_id}-LAB-INSTRUCTION`,
      block_type: "paragraph",
      text: adaptiveInstruction(request, source.title, fact.content),
      claims: [claim(`${target.objective_id}-LAB-CLAIM`, fact.content, cite(fact.source_id, fact.fact_id, "supports"))],
    }))
    const publicTests: CodeLabPublicPayload["public_tests"] = facts.map(({ target, fact }, index) => ({
      test_id: `${target.objective_id}-PUBLIC-${index + 1}`,
      objective_id: target.objective_id,
      description: [
        "确认函数会遍历并处理输入中的全部成绩",
        "确认函数能处理只包含一个成绩的列表",
        "确认函数返回可继续使用的平均值结果",
      ][index] ?? "确认当前目标对应的函数行为",
      input: [[80, 90, 70], [100], [72.5, 87.5]][index] ?? [60, 80, 100],
      expected_behavior: [
        "输入中的每个成绩都应参与平均值计算",
        "单元素列表的结果应等于该元素",
        "结果应为数值，并保留必要的小数精度",
      ][index] ?? "结果应符合任务说明",
      citations: [cite(fact.source_id, fact.fact_id, "derived_from")],
    }))
    const hintLadders = facts.map(({ target, fact }) => ({
      objective_id: target.objective_id,
      hints: [
        { hint_level: 1 as const, text: `先定位与“${fact.content}”对应的变量和循环。`, citations: [cite(fact.source_id, fact.fact_id, "supports")] },
        { hint_level: 2 as const, text: "逐轮记录 total 和 count 的变化。", citations: [cite(fact.source_id, fact.fact_id, "derived_from")] },
        { hint_level: 3 as const, text: "循环中分别累计成绩和数量，循环后再计算比值。", citations: [cite(fact.source_id, fact.fact_id, "derived_from")] },
      ],
    }))
    const usedEvidence = deduplicate([
      ...instructions.flatMap((block) => "claims" in block ? block.claims.flatMap((entry) => entry.citations) : []),
      ...publicTests.flatMap((test) => test.citations),
      ...hintLadders.flatMap((ladder) => ladder.hints.flatMap((hint) => hint.citations)),
    ])

    const hiddenTests: CodeLabSecurePayload["hidden_tests"] = [
      { test_id: "HT-O1-ALL", input: [10, 20, 30, 40], expected: 25, objective_id: objectiveIds[0], weight: 0.2, comparison: numeric() },
      { test_id: "HT-O2-SINGLE", input: [100], expected: 100, objective_id: objectiveIds[1] ?? objectiveIds[0], weight: 0.2, comparison: numeric() },
      { test_id: "HT-O2-MIXED", input: [0, 50, 100, 50], expected: 50, objective_id: objectiveIds[1] ?? objectiveIds[0], weight: 0.2, comparison: numeric() },
      { test_id: "HT-O3-DECIMAL", input: [72.5, 87.5], expected: 80, objective_id: objectiveIds[2] ?? objectiveIds.at(-1)!, weight: 0.2, comparison: numeric() },
      { test_id: "HT-O3-FRACTION", input: [1, 2], expected: 1.5, objective_id: objectiveIds[2] ?? objectiveIds.at(-1)!, weight: 0.2, comparison: numeric() },
    ]
    const mutations: CodeLabSecurePayload["mutation_variants"] = [
      {
        mutation_id: "MUT-OVERWRITE-TOTAL",
        code: "def average_score(scores):\n    total = 0\n    count = 0\n    for score in scores:\n        total = score\n        count += 1\n    return total / count",
        objective_ids: [objectiveIds[0]],
        misconception_tag: "overwrites_instead_of_accumulates",
        must_fail_test_ids: ["HT-O1-ALL"],
      },
      {
        mutation_id: "MUT-SKIP-LAST",
        code: "def average_score(scores):\n    total = 0\n    count = 0\n    for score in scores[:-1]:\n        total += score\n        count += 1\n    return total / count",
        objective_ids: [objectiveIds[1] ?? objectiveIds[0]],
        misconception_tag: "skips_last_list_item",
        must_fail_test_ids: ["HT-O2-MIXED"],
      },
      {
        mutation_id: "MUT-HARDCODED",
        code: "def average_score(scores):\n    return 80",
        objective_ids: [objectiveIds[2] ?? objectiveIds.at(-1)!],
        misconception_tag: "hardcodes_visible_example",
        must_fail_test_ids: ["HT-O2-SINGLE", "HT-O2-MIXED"],
      },
      {
        mutation_id: "MUT-INTEGER-DIVISION",
        code: "def average_score(scores):\n    total = 0\n    count = 0\n    for score in scores:\n        total += score\n        count += 1\n    return total // count",
        objective_ids: [objectiveIds[2] ?? objectiveIds.at(-1)!],
        misconception_tag: "uses_integer_division",
        must_fail_test_ids: ["HT-O3-FRACTION"],
      },
    ]
    const groups = objectiveIds.map((objectiveId, index) => {
      const tests = hiddenTests.filter((test) => test.objective_id === objectiveId)
      return {
        group_id: `GROUP-${objectiveId}`,
        objective_id: objectiveId,
        test_ids: tests.map((test) => test.test_id),
        weight: tests.reduce((sum, test) => sum + test.weight, 0),
      }
    })

    return {
      public_draft: {
        payload: {
          lab_id: labId,
          title: "成绩列表平均值实验",
          objective_ids: objectiveIds,
          instructions,
          execution_contract: {
            language: "python",
            execution_mode: "function",
            entry_point: "average_score",
            allowed_imports: [],
            input_contract: { type: "list[number]", constraints: ["length >= 1"] },
            output_contract: { type: "number", constraints: ["preserve fractional result"] },
            resource_limits: { timeout_ms: 2000, memory_mb: 128, max_output_bytes: 20000 },
          },
          starter_code: "def average_score(scores):\n    total = 0\n    count = 0\n    for score in scores:\n        # TODO: 累计当前成绩和元素数量\n        pass\n    # TODO: 返回平均值\n    return None",
          public_tests: publicTests,
          hint_ladders: hintLadders,
          reflection_questions: ["为什么累计总分时还需要记录元素数量？", "哪类错误会导致最后一个成绩未参与计算？"],
          objective_coverage: objectiveIds.map((objectiveId, index) => ({
            objective_id: objectiveId,
            instruction_block_ids: [`${objectiveId}-LAB-INSTRUCTION`],
            public_test_ids: [publicTests[index]?.test_id ?? publicTests[0].test_id],
          })),
          used_evidence: usedEvidence,
        },
      },
      secure_draft: {
        payload: {
          lab_id: labId,
          test_suite_id: testSuiteId,
          execution_contract: {
            language: "python",
            execution_mode: "function",
            entry_point: "average_score",
            allowed_imports: [],
            input_contract: { type: "list[number]", constraints: ["length >= 1"] },
            output_contract: { type: "number", constraints: ["preserve fractional result"] },
            resource_limits: { timeout_ms: 2000, memory_mb: 128, max_output_bytes: 20000 },
          },
          reference_solution: "def average_score(scores):\n    total = 0\n    count = 0\n    for score in scores:\n        total += score\n        count += 1\n    return total / count",
          hidden_tests: hiddenTests,
          scoring_groups: groups,
          misconception_map: hiddenTests.map((test) => ({
            failed_test_id: test.test_id,
            misconception_tag: test.objective_id === objectiveIds[0]
              ? "incomplete_iteration"
              : test.objective_id === objectiveIds[1]
                ? "list_case_handling"
                : "incorrect_average_result",
          })),
          mutation_variants: mutations,
          objective_coverage: objectiveIds.map((objectiveId) => ({
            objective_id: objectiveId,
            hidden_test_ids: hiddenTests.filter((test) => test.objective_id === objectiveId).map((test) => test.test_id),
            scoring_group_ids: [`GROUP-${objectiveId}`],
            mutation_ids: mutations.filter((mutation) => mutation.objective_ids.includes(objectiveId)).map((mutation) => mutation.mutation_id),
          })),
        },
      },
    }
  }

  async generateAssessment(request: Parameters<RoleCContentProvider["generateAssessment"]>[0]): Promise<AssessmentDraft> {
    return buildDeterministicAssessmentDraft(request)
  }
}

function adaptiveInstruction(request: CodeLabRequest, title: string, fact: string): string {
  const scaffold = request.generation_spec.learner_adaptation.scaffold_level >= 2
    ? "保留 total、count 和循环骨架，只补全关键步骤"
    : "根据合同自行实现完整函数"
  return `围绕“${title}”完成平均值函数；${scaffold}。实验依据：${fact}`
}

function cite(sourceId: string, factId: string, relation: CitationRef["relation"]): CitationRef {
  return { source_id: sourceId, fact_id: factId, relation }
}

function claim(claimId: string, text: string, citation: CitationRef): Claim {
  return { claim_id: claimId, text, citations: [citation] }
}

function numeric() {
  return { kind: "numeric" as const, abs_tolerance: 1e-9, rel_tolerance: 1e-9 }
}

function deduplicate(citations: CitationRef[]): CitationRef[] {
  return [...new Map(citations.map((entry) => [
    `${entry.source_id}:${entry.fact_id}:${entry.relation}`,
    entry,
  ])).values()]
}
