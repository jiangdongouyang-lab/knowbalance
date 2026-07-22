import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  ConceptTutorRequest,
  RoleCContentProvider,
  TieredEvaluatorRequest,
} from "../agents/types"
import type {
  AssessmentItemPublic,
  AssessmentItemSecure,
  AssessmentPublicPayload,
  AssessmentSecurePayload,
  ConceptLessonPayload,
  PublicOption,
} from "../contracts/artifacts"
import { stableId, type CitationRef } from "../contracts/common"
import { ModelProviderUnavailableError } from "../contracts/model-gateway"

/** Deterministic K007/K009/K018 Author used as an executable gold reference. */
export class DeterministicAssessmentContentProvider implements RoleCContentProvider {
  async generateAssessment(request: TieredEvaluatorRequest): Promise<AssessmentDraft> {
    return buildDeterministicAssessmentDraft(request)
  }

  async generateConceptLesson(): Promise<ArtifactDraft<ConceptLessonPayload>> {
    throw new ModelProviderUnavailableError("请使用 deterministic concept Provider")
  }

  async generateCodeLab(): Promise<CodeLabDraft> {
    throw new ModelProviderUnavailableError("请使用 deterministic code-lab Provider")
  }
}

export function buildDeterministicAssessmentDraft(request: TieredEvaluatorRequest): AssessmentDraft {
  const spec = request.generation_spec
  const blueprint = spec.assessment_blueprint
  if (spec.targets.length !== 3 ||
    blueprint.tier_1_count !== 2 || blueprint.tier_2_count !== 2 || blueprint.tier_3_count !== 1) {
    throw new ModelProviderUnavailableError("阶段 3 离线 assessment 金标仅支持 K007/K009/K018 的 2/2/1 蓝图")
  }
  const [o1, o2, o3] = spec.targets
  const required: AssessmentItemPublic["modality"][] = ["mcq", "trace", "code"]
  if (required.some((modality) => !blueprint.required_modalities.includes(modality))) {
    throw new ModelProviderUnavailableError("阶段 3 离线 assessment 金标要求 mcq、trace、code 三种题型")
  }
  const facts = [o1, o2, o3].map((target) => {
    const source = request.evidence_pack.results.find((entry) => entry.source_id === target.source_id)
    const fact = source?.facts.find((entry) => target.required_fact_ids.includes(entry.fact_id))
    if (!source || !fact) throw new ModelProviderUnavailableError(`assessment 缺少目标事实 ${target.source_id}`)
    return { target, fact }
  })
  const citeFor = (index: number): CitationRef => ({
    source_id: facts[index].fact.source_id,
    fact_id: facts[index].fact.fact_id,
    relation: "derived_from",
  })
  const formId = stableId("FORM", { spec_id: spec.spec_id, seed: spec.policies.seed, version: "assessment-gold-v1" })
  const codeSuiteId = stableId("TS", { form_id: formId, item: "average-score" })
  const [mcqPosition, trueFalsePosition] = seededShuffle([0, 1], spec.policies.seed)

  const mcqOptions = arrangeOptions([
    { option_id: "opt_iterate", text: "依次处理列表中的每个元素" },
    { option_id: "opt_import", text: "从网络安装新的第三方包" },
    { option_id: "opt_branch", text: "只在条件为真时执行一次" },
    { option_id: "opt_literal", text: "把所有结果直接写成固定常量" },
  ], "opt_iterate", mcqPosition, spec.policies.seed + 11)
  const trueFalseOptions = arrangeOptions([
    { option_id: "opt_true", text: "正确" },
    { option_id: "opt_false", text: "错误" },
  ], "opt_true", trueFalsePosition, spec.policies.seed + 17)

  const publicItems: AssessmentItemPublic[] = [
    publicItem("ITEM-O1-T1-MCQ", "FAMILY-O1-ITERATION", "V1", 1, o1.objective_id, 1, "mcq", "for 循环在本实验中最适合承担哪项任务？", 1, [citeFor(0)], { options: mcqOptions }),
    publicItem("ITEM-O2-T1-TF", "FAMILY-O2-LIST", "V1", 2, o2.objective_id, 1, "true_false", "判断：列表中的元素具有确定的先后顺序。", 1, [citeFor(1)], { options: trueFalseOptions }),
    publicItem("ITEM-O1-T2-TRACE", "FAMILY-O1-TRACE", "V1", 3, o1.objective_id, 2, "trace", "执行 total = 0；随后依次对 [3, 5] 中的每个值执行 total += value。最终 total 是多少？", 2, [citeFor(0)]),
    publicItem("ITEM-O2-T2-SHORT", "FAMILY-O2-APPLICATION", "V1", 4, o2.objective_id, 2, "short_answer", "简要说明列表如何保存一组成绩，并支持程序按顺序逐项处理。", 2, [citeFor(1)]),
    publicItem("ITEM-O3-T3-CODE", "FAMILY-O3-CODE", "V1", 5, o3.objective_id, 3, "code", "补全 average_score(scores)，遍历非空成绩列表并返回保留小数的平均值。", 4, [citeFor(2)], {
      starter_code: "def average_score(scores):\n    total = 0\n    count = 0\n    for score in scores:\n        # TODO\n        pass\n    return None",
    }),
  ]

  const secureItems: AssessmentItemSecure[] = [
    secureItem(publicItems[0], {
      kind: "exact_set",
      accepted: ["opt_iterate"],
      normalization: ["trim", "casefold", "unicode", "collapse_whitespace"],
    }, 0.65, "opt_iterate", {
      opt_import: "requests_external_capability",
      opt_branch: "confuses_iteration_with_condition",
      opt_literal: "hardcodes_result",
    }),
    secureItem(publicItems[1], {
      kind: "exact_set",
      accepted: ["opt_true"],
      normalization: ["trim", "casefold", "unicode", "collapse_whitespace"],
    }, 0.65, "opt_true", { opt_false: "does_not_recognize_list_order" }),
    secureItem(publicItems[2], {
      kind: "numeric",
      target: 8,
      abs_tolerance: 0,
      rel_tolerance: 0,
    }, 0.8),
    secureItem(publicItems[3], {
      kind: "concept_rubric",
      criteria: [
        { criterion_id: "CR-COLLECTION", description: "说明列表保存一组成绩", weight: 0.34, required_evidence: ["列表", "成绩"] },
        { criterion_id: "CR-ORDER", description: "说明列表元素具有顺序", weight: 0.33, required_evidence: ["顺序"] },
        { criterion_id: "CR-ITERATE", description: "说明可逐项处理列表元素", weight: 0.33, required_evidence: ["逐"] },
      ],
      contradictions: ["列表没有顺序", "不能逐项"],
    }, 0.85),
    secureItem(publicItems[4], { kind: "code", test_suite_id: codeSuiteId }, 1),
  ]
  const citations = deduplicate(publicItems.flatMap((item) => item.citations))
  const objectiveIds = spec.targets.map((target) => target.objective_id)
  const publicCoverage = objectiveIds.map((objectiveId) => {
    const items = publicItems.filter((item) => item.objective_id === objectiveId)
    return { objective_id: objectiveId, item_ids: items.map((item) => item.item_id), modalities: unique(items.map((item) => item.modality)) }
  })
  const secureCoverage = objectiveIds.map((objectiveId) => {
    const items = secureItems.filter((item) => item.objective_id === objectiveId)
    return { objective_id: objectiveId, item_ids: items.map((item) => item.item_id), answer_kinds: unique(items.map((item) => item.answer_spec.kind)) }
  })

  const publicPayload: AssessmentPublicPayload = {
    form_id: formId,
    title: "循环、列表与成绩统计分阶测评",
    objective_ids: objectiveIds,
    items: publicItems,
    submission_policy: { max_attempts: 3, formative: true },
    routing: {
      anchor_item_ids: publicItems.filter((item) => item.tier <= 2).slice(0, 3).map((item) => item.item_id),
      rules: [
        { route_id: "ROUTE-REMEDIATE", min_anchor_score_ratio: 0, max_anchor_score_ratio: 0.4, action: "remediate", reveal_tiers: [1] },
        { route_id: "ROUTE-REINFORCE", min_anchor_score_ratio: 0.4, max_anchor_score_ratio: 0.8, action: "reinforce", reveal_tiers: [1, 2] },
        { route_id: "ROUTE-ADVANCE", min_anchor_score_ratio: 0.8, max_anchor_score_ratio: 1, action: "advance", reveal_tiers: [2, 3] },
      ],
    },
    objective_coverage: publicCoverage,
    used_evidence: citations,
  }
  const securePayload: AssessmentSecurePayload = {
    form_id: formId,
    items: secureItems,
    option_order_seed: spec.policies.seed,
    code_test_suites: [{
      test_suite_id: codeSuiteId,
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
      hidden_tests: [
        { test_id: "AT-O3-BASIC", input: [80, 90, 70], expected: 80, objective_id: o3.objective_id, weight: 0.25, comparison: numeric() },
        { test_id: "AT-O3-SINGLE", input: [100], expected: 100, objective_id: o3.objective_id, weight: 0.25, comparison: numeric() },
        { test_id: "AT-O3-DECIMAL", input: [72.5, 87.5], expected: 80, objective_id: o3.objective_id, weight: 0.25, comparison: numeric() },
        { test_id: "AT-O3-FRACTION", input: [1, 2], expected: 1.5, objective_id: o3.objective_id, weight: 0.25, comparison: numeric() },
      ],
    }],
    objective_coverage: secureCoverage,
  }
  return { public_draft: { payload: publicPayload }, secure_draft: { payload: securePayload } }
}

function publicItem(
  itemId: string,
  familyId: string,
  variantId: string,
  displayNo: number,
  objectiveId: string,
  tier: 1 | 2 | 3,
  modality: AssessmentItemPublic["modality"],
  prompt: string,
  maxScore: number,
  citations: CitationRef[],
  extra: Partial<Pick<AssessmentItemPublic, "options" | "starter_code">> = {},
): AssessmentItemPublic {
  return {
    item_id: itemId,
    family_id: familyId,
    variant_id: variantId,
    display_no: displayNo,
    objective_id: objectiveId,
    tier,
    modality,
    prompt,
    max_score: maxScore,
    citations,
    ...extra,
  }
}

function secureItem(
  item: AssessmentItemPublic,
  answerSpec: AssessmentItemSecure["answer_spec"],
  evidenceWeight: number,
  correctOptionId?: string,
  misconceptionByOption: Record<string, string> = {},
): AssessmentItemSecure {
  return {
    item_id: item.item_id,
    objective_id: item.objective_id,
    tier: item.tier,
    modality: item.modality,
    max_score: item.max_score,
    answer_spec: answerSpec,
    ...(correctOptionId ? { correct_option_id: correctOptionId } : {}),
    misconception_by_option: misconceptionByOption,
    evidence_weight: evidenceWeight,
  }
}

function arrangeOptions(
  options: Array<{ option_id: string; text: string }>,
  correctId: string,
  correctPosition: number,
  seed: number,
): PublicOption[] {
  const correct = options.find((option) => option.option_id === correctId)!
  const distractors = seededShuffle(options.filter((option) => option.option_id !== correctId), seed)
  const arranged = [...distractors]
  arranged.splice(correctPosition, 0, correct)
  return arranged.map((option, index) => ({ ...option, label: "ABCD"[index] }))
}

function seededShuffle<T>(values: T[], seed: number): T[] {
  const output = [...values]
  let state = (seed >>> 0) || 0x9e3779b9
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const target = state % (index + 1)
    ;[output[index], output[target]] = [output[target], output[index]]
  }
  return output
}

function numeric() {
  return { kind: "numeric" as const, abs_tolerance: 1e-9, rel_tolerance: 1e-9 }
}

function deduplicate(citations: CitationRef[]): CitationRef[] {
  return [...new Map(citations.map((entry) => [`${entry.source_id}:${entry.fact_id}:${entry.relation}`, entry])).values()]
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
