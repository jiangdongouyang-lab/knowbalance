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
import {
  ModelProviderUnavailableError,
  UnsupportedTargetError,
} from "../contracts/model-gateway"
import { DeterministicConceptContentProvider } from "./deterministic-concept-provider"
import { buildDeterministicAssessmentDraft } from "./deterministic-assessment-provider"
import {
  isPassingCountTargetSet,
  PASSING_COUNT_HIDDEN_CASES,
  PASSING_COUNT_REFERENCE_SOLUTION,
  PASSING_COUNT_STARTER_CODE,
  passingCountExecutionContract,
} from "./deterministic-passing-count-template"

/** Offline reference Provider for the two reproducible Python-basics templates. */
export class DeterministicCodeLabContentProvider implements RoleCContentProvider {
  private readonly concept = new DeterministicConceptContentProvider()

  generateConceptLesson(request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>> {
    return this.concept.generateConceptLesson(request)
  }

  async generateCodeLab(request: CodeLabRequest): Promise<CodeLabDraft> {
    const objectiveIds = request.generation_spec.targets.map((target) => target.objective_id)
    const targetSourceIds = request.generation_spec.targets.map(
      (target) => target.source_id,
    )
    if (isPassingCountTargetSet(targetSourceIds)) {
      return ensureRequiredFactCoverage(
        request,
        buildPassingCountCodeLabDraft(request),
      )
    }
    if (!sameOrderedTargets(
      targetSourceIds,
      ["K007", "K009", "K018"],
    )) {
      throw new UnsupportedTargetError(
        "code-lab",
        targetSourceIds,
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
      description: `${fact.content} ${[
        "确认函数会遍历并处理输入中的全部成绩",
        "确认函数能处理只包含一个成绩的列表",
        "确认函数返回可继续使用的平均值结果",
      ][index] ?? "确认当前目标对应的函数行为"}`,
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
      { test_id: "HT-O2-SINGLE", input: [91], expected: 91, objective_id: objectiveIds[1] ?? objectiveIds[0], weight: 0.2, comparison: numeric() },
      { test_id: "HT-O2-MIXED", input: [0, 50, 100, 70], expected: 55, objective_id: objectiveIds[1] ?? objectiveIds[0], weight: 0.2, comparison: numeric() },
      { test_id: "HT-O3-DECIMAL", input: [73.5, 86.5], expected: 80, objective_id: objectiveIds[2] ?? objectiveIds.at(-1)!, weight: 0.2, comparison: numeric() },
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
        objective_ids: [
          objectiveIds[1] ?? objectiveIds[0],
          objectiveIds[2] ?? objectiveIds.at(-1)!,
        ],
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
    const groups = objectiveIds.map((objectiveId) => {
      const tests = hiddenTests.filter((test) => test.objective_id === objectiveId)
      return {
        group_id: `GROUP-${objectiveId}`,
        objective_id: objectiveId,
        test_ids: tests.map((test) => test.test_id),
        weight: tests.reduce((sum, test) => sum + test.weight, 0),
      }
    })

    return ensureRequiredFactCoverage(request, {
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
    })
  }

  async generateAssessment(request: Parameters<RoleCContentProvider["generateAssessment"]>[0]): Promise<AssessmentDraft> {
    return buildDeterministicAssessmentDraft(request)
  }
}

function buildPassingCountCodeLabDraft(
  request: CodeLabRequest,
): CodeLabDraft {
  const objectiveIds = request.generation_spec.targets.map(
    (target) => target.objective_id,
  )
  const facts = request.generation_spec.targets.map((target) => {
    const source = request.evidence_pack.results.find(
      (entry) => entry.source_id === target.source_id,
    )
    const fact = source?.facts.find(
      (entry) => target.required_fact_ids.includes(entry.fact_id),
    )
    if (!source || !fact) {
      throw new ModelProviderUnavailableError(
        `code-lab 缺少目标事实 ${target.source_id}`,
      )
    }
    return { target, source, fact }
  })
  const labId = stableId("LAB", {
    spec_id: request.generation_spec.spec_id,
    objective_ids: objectiveIds,
    template: "passing-count-v1",
    seed: request.generation_spec.policies.seed,
  })
  const testSuiteId = stableId("TS", {
    lab_id: labId,
    version: "passing-count-v1",
  })
  const instructionFocus = [
    "用 for 逐项读取成绩，不跳过列表中的任何元素",
    "把 scores 作为一组有序成绩处理，并让空列表自然得到零",
    "用 if 判断 score 是否达到 pass_mark，只累计满足条件的项目",
  ]
  const publicInputs = [
    { args: [[55, 70, 88], 60] },
    { args: [[], 75] },
    { args: [[69, 70, 71], 70] },
  ]
  const publicBehaviors = [
    "函数应检查列表中的每项成绩并返回正确的达标人数",
    "空成绩列表应返回零且不产生异常",
    "等于阈值的成绩也应计入达标人数",
  ]
  const instructions: CodeLabPublicPayload["instructions"] = facts.map(
    ({ target, source, fact }, index) => ({
      block_id: `${target.objective_id}-LAB-INSTRUCTION`,
      block_type: "paragraph",
      text: passingCountAdaptiveInstruction(
        request,
        source.title,
        fact.content,
        instructionFocus[index] ?? instructionFocus[0]!,
      ),
      claims: [
        claim(
          `${target.objective_id}-LAB-CLAIM`,
          fact.content,
          cite(fact.source_id, fact.fact_id, "supports"),
        ),
      ],
    }),
  )
  const publicTests: CodeLabPublicPayload["public_tests"] = facts.map(
    ({ target, fact }, index) => ({
      test_id: `${target.objective_id}-PUBLIC-${index + 1}`,
      objective_id: target.objective_id,
      description: `${fact.content} 验证达标人数统计的对应步骤。`,
      input: publicInputs[index] ?? publicInputs[0]!,
      expected_behavior:
        publicBehaviors[index] ?? "结果应符合任务说明",
      citations: [
        cite(fact.source_id, fact.fact_id, "derived_from"),
      ],
    }),
  )
  const hintText = [
    [
      "先确认循环变量会依次取得 scores 中的每个成绩。",
      "在循环体内处理当前 score，不要对列表切片或提前结束。",
      "保持 for score in scores 的完整遍历，再在循环内判断是否累计。",
    ],
    [
      "count 应在遍历前从零开始。",
      "列表只负责保存输入成绩，不要把固定长度写进答案。",
      "每遇到一个达标元素才增加 count，空列表会保留初始值。",
    ],
    [
      "比较当前 score 与 pass_mark。",
      "边界值等于 pass_mark 时也属于达标。",
      "条件成立时，将计数器增加一次。",
    ],
  ]
  const hintLadders = facts.map(({ target, fact }, index) => ({
    objective_id: target.objective_id,
    hints: [1, 2, 3].map((level) => ({
      hint_level: level as 1 | 2 | 3,
      text: hintText[index]?.[level - 1] ?? hintText[0]![level - 1]!,
      citations: [
        cite(fact.source_id, fact.fact_id, "derived_from"),
      ],
    })),
  }))
  const usedEvidence = deduplicate([
    ...instructions.flatMap((block) =>
      "claims" in block
        ? block.claims.flatMap((entry) => entry.citations)
        : []),
    ...publicTests.flatMap((test) => test.citations),
    ...hintLadders.flatMap((ladder) =>
      ladder.hints.flatMap((hint) => hint.citations)),
  ])
  const hiddenTests: CodeLabSecurePayload["hidden_tests"] =
    PASSING_COUNT_HIDDEN_CASES.map((testCase) => ({
      test_id: `HT-COUNT-${testCase.id}`,
      input: structuredClone(testCase.input),
      expected: testCase.expected,
      objective_id:
        objectiveIds[testCase.objective_index] ?? objectiveIds[0]!,
      weight: 0.2,
      comparison: { kind: "exact" as const },
    }))
  const mutations: CodeLabSecurePayload["mutation_variants"] = [
    {
      mutation_id: "MUT-COUNT-SKIP-LAST",
      code: [
        "def count_passing_scores(scores, pass_mark):",
        "    count = 0",
        "    for score in scores[:-1]:",
        "        if score >= pass_mark:",
        "            count += 1",
        "    return count",
      ].join("\n"),
      objective_ids: [objectiveIds[0]!],
      misconception_tag: "skips_last_list_item",
      must_fail_test_ids: ["HT-COUNT-LAST_ITEM"],
    },
    {
      mutation_id: "MUT-COUNT-EVERY-ITEM",
      code: [
        "def count_passing_scores(scores, pass_mark):",
        "    count = 0",
        "    for score in scores:",
        "        if score >= pass_mark:",
        "            pass",
        "        count += 1",
        "    return count",
      ].join("\n"),
      objective_ids: [objectiveIds[1]!],
      misconception_tag: "counts_every_list_item",
      must_fail_test_ids: ["HT-COUNT-MIXED_LIST"],
    },
    {
      mutation_id: "MUT-COUNT-REVERSED-CONDITION",
      code: [
        "def count_passing_scores(scores, pass_mark):",
        "    count = 0",
        "    for score in scores:",
        "        if score < pass_mark:",
        "            count += 1",
        "        else:",
        "            pass",
        "    return count",
      ].join("\n"),
      objective_ids: [objectiveIds[2]!],
      misconception_tag: "reverses_passing_condition",
      must_fail_test_ids: ["HT-COUNT-BOUNDARY"],
    },
    {
      mutation_id: "MUT-COUNT-FIXED-MARK",
      code: [
        "def count_passing_scores(scores, pass_mark):",
        "    count = 0",
        "    for score in scores:",
        "        if score >= 60:",
        "            count += 1",
        "        else:",
        "            pass",
        "    return count",
      ].join("\n"),
      objective_ids: [objectiveIds[2]!],
      misconception_tag: "ignores_pass_mark_argument",
      must_fail_test_ids: ["HT-COUNT-CUSTOM_MARK"],
    },
  ]
  const groups = objectiveIds.map((objectiveId) => {
    const tests = hiddenTests.filter(
      (test) => test.objective_id === objectiveId,
    )
    return {
      group_id: `GROUP-${objectiveId}`,
      objective_id: objectiveId,
      test_ids: tests.map((test) => test.test_id),
      weight: tests.reduce((sum, test) => sum + test.weight, 0),
    }
  })
  const executionContract = passingCountExecutionContract()

  return {
    public_draft: {
      payload: {
        lab_id: labId,
        title: "成绩达标人数统计实验",
        objective_ids: objectiveIds,
        instructions,
        execution_contract: executionContract,
        starter_code: PASSING_COUNT_STARTER_CODE,
        public_tests: publicTests,
        hint_ladders: hintLadders,
        reflection_questions: [
          "为什么等于 pass_mark 的成绩也应计为达标？",
          "空列表输入时，count 为什么能保持为零？",
        ],
        objective_coverage: objectiveIds.map(
          (objectiveId, index) => ({
            objective_id: objectiveId,
            instruction_block_ids: [
              `${objectiveId}-LAB-INSTRUCTION`,
            ],
            public_test_ids: [
              publicTests[index]?.test_id ?? publicTests[0]!.test_id,
            ],
          }),
        ),
        used_evidence: usedEvidence,
      },
    },
    secure_draft: {
      payload: {
        lab_id: labId,
        test_suite_id: testSuiteId,
        execution_contract: structuredClone(executionContract),
        reference_solution: PASSING_COUNT_REFERENCE_SOLUTION,
        hidden_tests: hiddenTests,
        scoring_groups: groups,
        misconception_map: hiddenTests.map((test) => ({
          failed_test_id: test.test_id,
          misconception_tag:
            test.objective_id === objectiveIds[0]
              ? "incomplete_iteration"
              : test.objective_id === objectiveIds[1]
                ? "list_case_handling"
                : "incorrect_condition_boundary",
        })),
        mutation_variants: mutations,
        objective_coverage: objectiveIds.map((objectiveId) => ({
          objective_id: objectiveId,
          hidden_test_ids: hiddenTests
            .filter((test) => test.objective_id === objectiveId)
            .map((test) => test.test_id),
          scoring_group_ids: [`GROUP-${objectiveId}`],
          mutation_ids: mutations
            .filter((mutation) =>
              mutation.objective_ids.includes(objectiveId))
            .map((mutation) => mutation.mutation_id),
        })),
      },
    },
  }
}

function sameOrderedTargets(
  actual: string[],
  expected: string[],
): boolean {
  return actual.length === expected.length
    && actual.every((sourceId, index) => sourceId === expected[index])
}

function ensureRequiredFactCoverage(
  request: CodeLabRequest,
  draft: CodeLabDraft,
): CodeLabDraft {
  const result = structuredClone(draft)
  const payload = result.public_draft.payload
  const coverageByObjective = new Map(
    payload.objective_coverage.map((entry) => [entry.objective_id, entry]),
  )
  for (const target of request.generation_spec.targets) {
    const source = request.evidence_pack.results.find((entry) =>
      entry.source_id === target.source_id)
    const facts = target.required_fact_ids.map((factId) =>
      source?.facts.find((fact) => fact.fact_id === factId))
    if (!source || facts.some((fact) => !fact)) {
      throw new ModelProviderUnavailableError(
        `code-lab 缺少目标必要事实 ${target.source_id}`,
      )
    }
    const blockId = coverageByObjective.get(target.objective_id)
      ?.instruction_block_ids[0]
    const block = payload.instructions.find((entry) =>
      entry.block_id === blockId)
    if (!block || block.block_type !== "paragraph") {
      throw new ModelProviderUnavailableError(
        `code-lab 缺少目标说明块 ${target.objective_id}`,
      )
    }
    for (const fact of facts) {
      if (!fact) continue
      const alreadyCited = block.claims.some((entry) =>
        entry.citations.some((citation) =>
          citation.source_id === fact.source_id
            && citation.fact_id === fact.fact_id))
      if (!alreadyCited) {
        block.claims.push(claim(
          `${target.objective_id}-LAB-CLAIM-${fact.fact_id}`,
          fact.content,
          cite(fact.source_id, fact.fact_id, "supports"),
        ))
      }
      if (!block.text.includes(fact.content)) {
        block.text = `${block.text}\n${fact.content}`
      }
    }
  }
  payload.used_evidence = deduplicate([
    ...payload.instructions.flatMap((block) =>
      "claims" in block
        ? block.claims.flatMap((entry) => entry.citations)
        : []),
    ...payload.public_tests.flatMap((test) => test.citations),
    ...payload.hint_ladders.flatMap((ladder) =>
      ladder.hints.flatMap((hint) => hint.citations)),
  ])
  return result
}

function adaptiveInstruction(request: CodeLabRequest, title: string, fact: string): string {
  const scaffold = request.generation_spec.learner_adaptation.scaffold_level >= 2
    ? "保留 total、count 和循环骨架，只补全关键步骤"
    : "根据合同自行实现完整函数"
  return `围绕“${title}”完成平均值函数；${scaffold}。实验依据：${fact}`
}

function passingCountAdaptiveInstruction(
  request: CodeLabRequest,
  title: string,
  fact: string,
  focus: string,
): string {
  const scaffold =
    request.generation_spec.learner_adaptation.scaffold_level >= 2
      ? "保留函数、count 和循环骨架，只补全判断与累计步骤"
      : "根据输入输出合同自行实现完整函数"
  return `围绕“${title}”完成达标人数统计；${focus}；${scaffold}。实验依据：${fact}`
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
