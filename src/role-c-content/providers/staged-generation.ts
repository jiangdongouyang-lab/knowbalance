import type {
  AssessmentItemPublic,
  AssessmentItemSecure,
  AssessmentPublicPayload,
  AssessmentSecurePayload,
  CodeLabPublicPayload,
  CodeLabSecurePayload,
  ConceptLessonPayload,
  RenderBlock,
} from "../contracts/artifacts"
import { stableId, type CitationRef } from "../contracts/common"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import { ModelOutputValidationError } from "../contracts/model-gateway"
import { claimTextMatchesFact } from "../validators/claim-grounding"
import type { CodeLabRequest, ConceptTutorRequest } from "../agents/types"

export interface ConceptSegmentRequest extends ConceptTutorRequest {
  segment_index: number
  segment_count: number
}

export interface AssessmentItemPlan {
  item_id: string
  family_id: string
  variant_id: string
  display_no: number
  objective_id: string
  tier: 1 | 2 | 3
  modality: AssessmentItemPublic["modality"]
  max_score: number
}

export function splitConceptRequest(
  request: ConceptTutorRequest,
  groupSize: number,
): ConceptSegmentRequest[] {
  const groups = chunk(request.generation_spec.targets, groupSize)
  return groups.map((targets, index) => {
    const targetSources = unique(targets.map((target) => target.source_id))
    const prerequisiteSources = index === 0
      ? request.generation_spec.path_node.prerequisite_source_ids
      : []
    const includedSources = new Set([...targetSources, ...prerequisiteSources])
    const results = request.evidence_pack.results
      .filter((entry) => includedSources.has(entry.source_id))
      .map((entry) => structuredClone(entry))
    const retrievalId = stableId("RAGSEG", {
      retrieval_id: request.evidence_pack.retrieval_id,
      objective_ids: targets.map((target) => target.objective_id),
      index,
    })
    const spec: GenerationSpec = {
      ...structuredClone(request.generation_spec),
      spec_id: stableId("SPECSEG", {
        spec_id: request.generation_spec.spec_id,
        objective_ids: targets.map((target) => target.objective_id),
        index,
      }),
      evidence_ref: retrievalId,
      path_node: {
        ...structuredClone(request.generation_spec.path_node),
        target_source_ids: targetSources,
        prerequisite_source_ids: [...prerequisiteSources],
      },
      targets: structuredClone(targets),
    }
    const evidencePack: RagEvidencePack = {
      ...structuredClone(request.evidence_pack),
      retrieval_id: retrievalId,
      query: `${request.evidence_pack.query} [concept segment ${index + 1}/${groups.length}]`,
      top_k: results.length,
      results,
    }
    return {
      ...request,
      generation_spec: spec,
      evidence_pack: evidencePack,
      segment_index: index,
      segment_count: groups.length,
    }
  })
}

export function mergeConceptSegments(
  request: ConceptTutorRequest,
  payloads: ConceptLessonPayload[],
): ConceptLessonPayload {
  if (payloads.length === 0) {
    throw new ModelOutputValidationError("concept.merge", ["没有可聚合的目标组输出"])
  }
  const segments = payloads.map((payload, index) => namespaceConceptPayload(payload, index))
  const merged: ConceptLessonPayload = {
    title: segments.length === 1 ? segments[0].title : `${segments[0].title}（组合讲义）`,
    objective_ids: request.generation_spec.targets.map((target) => target.objective_id),
    prerequisite_bridge: segments[0].prerequisite_bridge,
    explanation_blocks: segments.flatMap((segment) => segment.explanation_blocks),
    worked_examples: segments.flatMap((segment) => segment.worked_examples),
    misconceptions: segments.flatMap((segment) => segment.misconceptions),
    micro_checks: segments.flatMap((segment) => segment.micro_checks),
    hint_ladders: segments.flatMap((segment) => segment.hint_ladders),
    summary: segments.flatMap((segment) => segment.summary),
    objective_coverage: segments.flatMap((segment) => segment.objective_coverage),
    used_evidence: [],
  }
  merged.used_evidence = collectConceptCitations(merged)
  return merged
}

/** Freezes objective identity and rebuilds bookkeeping fields from authored content. */
export function normalizeConceptSegment(
  request: ConceptTutorRequest,
  payload: ConceptLessonPayload,
): ConceptLessonPayload {
  const normalized = structuredClone(payload)
  normalized.prerequisite_bridge = normalizePrerequisiteBridges(
    normalized.prerequisite_bridge,
    request,
  )
  freezeClaimTexts([
    ...normalized.prerequisite_bridge,
    ...normalized.explanation_blocks,
    ...normalized.worked_examples,
    ...normalized.summary,
  ], request.evidence_pack)
  normalized.objective_ids = request.generation_spec.targets.map((target) => target.objective_id)
  const allBlocks = [
    ...normalized.prerequisite_bridge,
    ...normalized.explanation_blocks,
    ...normalized.worked_examples,
    ...normalized.micro_checks,
    ...normalized.summary,
  ]
  const validIds = new Set(allBlocks.map((block) => block.block_id))
  normalized.objective_coverage = request.generation_spec.targets.map((target) => {
    const existing = normalized.objective_coverage.find((entry) => entry.objective_id === target.objective_id)
    const groundedIds = allBlocks.filter((block) => citationsFromBlock(block).some((citation) =>
      citation.source_id === target.source_id && target.required_fact_ids.includes(citation.fact_id),
    )).map((block) => block.block_id)
    return {
      objective_id: target.objective_id,
      block_ids: unique([
        ...(existing?.block_ids ?? []).filter((id) => validIds.has(id)),
        ...groundedIds,
      ]),
    }
  })
  normalized.used_evidence = collectConceptCitations(normalized)
  return normalized
}

export function buildLabIdentity(spec: GenerationSpec) {
  const labId = stableId("LAB", {
    spec_id: spec.spec_id,
    seed: spec.policies.seed,
    version: "code-lab-staged-v1",
  })
  return {
    lab_id: labId,
    test_suite_id: stableId("TS", { lab_id: labId, version: "code-lab-staged-v1" }),
  }
}

export function normalizeCodeLabPublic(
  request: CodeLabRequest,
  payload: CodeLabPublicPayload,
  labId: string,
): CodeLabPublicPayload {
  const normalized = structuredClone(payload)
  normalized.lab_id = labId
  normalized.objective_ids = request.generation_spec.targets.map((target) => target.objective_id)
  freezeClaimTexts(normalized.instructions, request.evidence_pack)
  normalized.public_tests = normalized.public_tests.map((test) => {
    const target = targetForCitations(request.generation_spec, test.citations)
    return target ? { ...test, objective_id: target.objective_id } : test
  })
  normalized.hint_ladders = normalized.hint_ladders.map((ladder) => {
    const target = targetForCitations(
      request.generation_spec,
      ladder.hints.flatMap((hint) => hint.citations),
    )
    return target ? { ...ladder, objective_id: target.objective_id } : ladder
  })
  normalized.objective_coverage = request.generation_spec.targets.flatMap((target) => {
    const existing = payload.objective_coverage.find((entry) => entry.objective_id === target.objective_id)
    const instructionIds = new Set(payload.instructions.map((block) => block.block_id))
    const groundedInstructionIds = normalized.instructions.filter((block) => citationsFromBlock(block).some((citation) =>
      citation.source_id === target.source_id && target.required_fact_ids.includes(citation.fact_id),
    )).map((block) => block.block_id)
    const publicTestIds = new Set(normalized.public_tests
      .filter((test) => test.objective_id === target.objective_id)
      .map((test) => test.test_id))
    const instructionBlockIds = unique([
      ...(existing?.instruction_block_ids ?? []).filter((id) => instructionIds.has(id)),
      ...groundedInstructionIds,
    ])
    const testIds = [...publicTestIds]
    if (instructionBlockIds.length === 0 || testIds.length === 0) return []
    return [{
      objective_id: target.objective_id,
      instruction_block_ids: instructionBlockIds,
      public_test_ids: testIds,
    }]
  })
  normalized.used_evidence = collectCodeLabCitations(normalized)
  return normalized
}

export function normalizeCodeLabSecure(
  spec: GenerationSpec,
  payload: CodeLabSecurePayload,
  publicPayload: CodeLabPublicPayload,
  suiteId: string,
): CodeLabSecurePayload {
  const normalized = structuredClone(payload)
  normalized.lab_id = publicPayload.lab_id
  normalized.test_suite_id = suiteId
  normalized.execution_contract = structuredClone(publicPayload.execution_contract)
  const totalWeight = normalized.hidden_tests.reduce((sum, test) => sum + test.weight, 0)
  if (Number.isFinite(totalWeight) && totalWeight > 0) {
    normalized.hidden_tests = normalized.hidden_tests.map((test) => ({
      ...test,
      weight: test.weight / totalWeight,
    }))
  }
  normalized.scoring_groups = spec.targets.flatMap((target) => {
    const tests = normalized.hidden_tests.filter((test) => test.objective_id === target.objective_id)
    if (tests.length === 0) return []
    return [{
      group_id: stableId("GROUP", { test_suite_id: suiteId, objective_id: target.objective_id }),
      objective_id: target.objective_id,
      test_ids: tests.map((test) => test.test_id),
      weight: tests.reduce((sum, test) => sum + test.weight, 0),
    }]
  })
  normalized.objective_coverage = spec.targets.flatMap((target) => {
    const hiddenTestIds = unique(normalized.hidden_tests
      .filter((test) => test.objective_id === target.objective_id)
      .map((test) => test.test_id))
    const scoringGroupIds = unique(normalized.scoring_groups
      .filter((group) => group.objective_id === target.objective_id)
      .map((group) => group.group_id))
    const mutationIds = unique(normalized.mutation_variants
      .filter((mutation) => mutation.objective_ids.includes(target.objective_id))
      .map((mutation) => mutation.mutation_id))
    if (hiddenTestIds.length === 0 || scoringGroupIds.length === 0 || mutationIds.length === 0) return []
    return [{
      objective_id: target.objective_id,
      hidden_test_ids: hiddenTestIds,
      scoring_group_ids: scoringGroupIds,
      mutation_ids: mutationIds,
    }]
  })
  return normalized
}

export function buildAssessmentItemPlan(spec: GenerationSpec): AssessmentItemPlan[] {
  const tiers: Array<1 | 2 | 3> = [
    ...Array.from({ length: spec.assessment_blueprint.tier_1_count }, () => 1 as const),
    ...Array.from({ length: spec.assessment_blueprint.tier_2_count }, () => 2 as const),
    ...Array.from({ length: spec.assessment_blueprint.tier_3_count }, () => 3 as const),
  ]
  const tierOffsets = new Map<number, number>()
  const modalities = tiers.map((tier) => {
    const offset = tierOffsets.get(tier) ?? 0
    tierOffsets.set(tier, offset + 1)
    if (tier === 1) return (["mcq", "true_false"] as const)[offset % 2]
    if (tier === 2) return (["trace", "short_answer"] as const)[offset % 2]
    return "code" as const
  })
  ensureRequiredModalities(modalities, tiers, spec.assessment_blueprint.required_modalities)

  const assignments = assignObjectives(spec, modalities)
  return tiers.map((tier, index) => {
    const objective = assignments[index]
    const modality = modalities[index]
    const identity = { spec_id: spec.spec_id, index, objective_id: objective.objective_id, tier, modality }
    return {
      item_id: stableId("ITEM", identity),
      family_id: stableId("FAMILY", { objective_id: objective.objective_id, modality }),
      variant_id: stableId("VARIANT", { ...identity, seed: spec.policies.seed }),
      display_no: index + 1,
      objective_id: objective.objective_id,
      tier,
      modality,
      max_score: tier === 1 ? 1 : tier === 2 ? 2 : 4,
    }
  })
}

export function buildAssessmentFormId(spec: GenerationSpec): string {
  return stableId("FORM", {
    spec_id: spec.spec_id,
    seed: spec.policies.seed,
    version: "assessment-staged-v1",
  })
}

export function validateAssessmentPublicAgainstPlan(
  payload: AssessmentPublicPayload,
  plan: AssessmentItemPlan[],
): string[] {
  const issues: string[] = []
  if (payload.items.length !== plan.length) {
    issues.push(`items 数量应为 ${plan.length}，实际 ${payload.items.length}`)
    return issues
  }
  payload.items.forEach((item, index) => {
    const expected = plan[index]
    if (item.modality !== expected.modality) {
      issues.push(`items[${index}].modality 应为 ${expected.modality}`)
    }
    if ((expected.modality === "mcq" || expected.modality === "true_false") && !item.options) {
      issues.push(`items[${index}] 选择题缺少 options`)
    }
    if (expected.modality === "code" && !item.starter_code) {
      issues.push(`items[${index}] 代码题缺少 starter_code`)
    }
  })
  return issues
}

export function normalizeAssessmentPublic(
  spec: GenerationSpec,
  payload: AssessmentPublicPayload,
  plan: AssessmentItemPlan[],
  formId: string,
): AssessmentPublicPayload {
  const items = payload.items.map((item, index): AssessmentItemPublic => {
    const expected = plan[index]
    const options = item.options?.map((option, optionIndex) => ({
      ...option,
      option_id: stableId("OPTION", { item_id: expected.item_id, option_index: optionIndex }),
      label: "ABCD"[optionIndex],
    }))
    return {
      ...structuredClone(item),
      ...expected,
      ...(options ? { options } : {}),
    }
  })
  return {
    form_id: formId,
    title: payload.title,
    objective_ids: spec.targets.map((target) => target.objective_id),
    items,
    submission_policy: { max_attempts: 3, formative: true },
    routing: deterministicRouting(items),
    objective_coverage: assessmentPublicCoverage(spec, items),
    used_evidence: deduplicate(items.flatMap((item) => item.citations)),
  }
}

export function validateAssessmentSecureAgainstPublic(
  payload: AssessmentSecurePayload,
  publicPayload: AssessmentPublicPayload,
): string[] {
  const issues: string[] = []
  if (payload.items.length !== publicPayload.items.length) {
    issues.push(`secure items 数量应为 ${publicPayload.items.length}，实际 ${payload.items.length}`)
  }
  const codeCount = publicPayload.items.filter((item) => item.modality === "code").length
  if (payload.code_test_suites.length !== codeCount) {
    issues.push(`code_test_suites 数量应为 ${codeCount}，实际 ${payload.code_test_suites.length}`)
  }
  return issues
}

export function normalizeAssessmentPair(
  spec: GenerationSpec,
  publicPayload: AssessmentPublicPayload,
  securePayload: AssessmentSecurePayload,
): { public_payload: AssessmentPublicPayload; secure_payload: AssessmentSecurePayload } {
  const codeItems = publicPayload.items.filter((item) => item.modality === "code")
  const suites = securePayload.code_test_suites.map((suite, index) => ({
    ...structuredClone(suite),
    test_suite_id: stableId("TS", { form_id: publicPayload.form_id, item_id: codeItems[index].item_id }),
  }))
  const suiteByItemId = new Map(codeItems.map((item, index) => [item.item_id, suites[index].test_suite_id]))
  const secureItems = securePayload.items.map((item, index): AssessmentItemSecure => {
    const publicItem = publicPayload.items[index]
    const base = {
      ...structuredClone(item),
      item_id: publicItem.item_id,
      objective_id: publicItem.objective_id,
      tier: publicItem.tier,
      modality: publicItem.modality,
      max_score: publicItem.max_score,
    }
    if (publicItem.modality === "code") {
      return {
        ...base,
        answer_spec: { kind: "code", test_suite_id: suiteByItemId.get(publicItem.item_id)! },
        misconception_by_option: {},
      }
    }
    if (publicItem.modality === "mcq" || publicItem.modality === "true_false") {
      return {
        ...base,
        answer_spec: {
          kind: "exact_set",
          accepted: base.correct_option_id ? [base.correct_option_id] : [],
          normalization: ["trim", "casefold", "unicode", "collapse_whitespace"],
        },
      }
    }
    const { correct_option_id: _correct, ...nonChoice } = base
    return { ...nonChoice, misconception_by_option: {} }
  })
  const normalizedPublic = reorderChoiceOptions(publicPayload, secureItems, spec.policies.seed)
  const normalizedSecure: AssessmentSecurePayload = {
    form_id: normalizedPublic.form_id,
    items: secureItems,
    option_order_seed: spec.policies.seed,
    code_test_suites: suites,
    objective_coverage: assessmentSecureCoverage(spec, secureItems),
  }
  return { public_payload: normalizedPublic, secure_payload: normalizedSecure }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), values.length || 1))
  const output = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      output[index] = await mapper(values[index], index)
    }
  }))
  return output
}

function namespaceConceptPayload(payload: ConceptLessonPayload, index: number): ConceptLessonPayload {
  const prefix = `SEG${index + 1}`
  const blockMap = new Map<string, string>()
  const mapBlock = (block: RenderBlock): RenderBlock => {
    const mappedId = `${prefix}-${block.block_id}`
    blockMap.set(block.block_id, mappedId)
    const clone = structuredClone(block)
    clone.block_id = mappedId
    if ("claims" in clone) {
      clone.claims = clone.claims.map((claim) => ({ ...claim, claim_id: `${prefix}-${claim.claim_id}` }))
    }
    if (clone.block_type === "quiz") {
      clone.item_id = `${prefix}-${clone.item_id}`
      clone.options = clone.options?.map((option) => ({ ...option, option_id: `${prefix}-${option.option_id}` }))
    }
    return clone
  }
  const prerequisite = payload.prerequisite_bridge.map(mapBlock)
  const explanations = payload.explanation_blocks.map(mapBlock)
  const examples = payload.worked_examples.map(mapBlock)
  const checks = payload.micro_checks.map((block) => mapBlock(block) as typeof block)
  const summary = payload.summary.map(mapBlock)
  return {
    ...structuredClone(payload),
    prerequisite_bridge: prerequisite,
    explanation_blocks: explanations,
    worked_examples: examples,
    misconceptions: payload.misconceptions.map((entry) => ({
      ...structuredClone(entry),
      misconception_tag: `${prefix}-${entry.misconception_tag}`,
    })),
    micro_checks: checks,
    summary,
    objective_coverage: payload.objective_coverage.map((entry) => ({
      ...structuredClone(entry),
      block_ids: entry.block_ids.map((id) => blockMap.get(id) ?? `${prefix}-${id}`),
    })),
  }
}

function collectConceptCitations(payload: ConceptLessonPayload): CitationRef[] {
  const blocks = [
    ...payload.prerequisite_bridge,
    ...payload.explanation_blocks,
    ...payload.worked_examples,
    ...payload.micro_checks,
    ...payload.summary,
  ]
  return deduplicate([
    ...blocks.flatMap(citationsFromBlock),
    ...payload.misconceptions.flatMap((entry) => entry.citations),
    ...payload.hint_ladders.flatMap((entry) => entry.hints.flatMap((hint) => hint.citations)),
  ])
}

function collectCodeLabCitations(payload: CodeLabPublicPayload): CitationRef[] {
  return deduplicate([
    ...payload.instructions.flatMap(citationsFromBlock),
    ...payload.public_tests.flatMap((test) => test.citations),
    ...payload.hint_ladders.flatMap((entry) => entry.hints.flatMap((hint) => hint.citations)),
  ])
}

function citationsFromBlock(block: RenderBlock): CitationRef[] {
  if ("claims" in block) return block.claims.flatMap((claim) => claim.citations)
  if ("citations" in block) return block.citations
  return []
}

function normalizePrerequisiteBridges(
  blocks: RenderBlock[],
  request: ConceptTutorRequest,
): RenderBlock[] {
  const prerequisiteSources = new Set(request.generation_spec.path_node.prerequisite_source_ids)
  const factsBySource = new Map(request.evidence_pack.results
    .filter((entry) => prerequisiteSources.has(entry.source_id) && entry.facts.length > 0)
    .map((entry) => [entry.source_id, entry.facts[0]] as const))
  const normalized = blocks.map((block) => {
    const clone = structuredClone(block)
    if ("claims" in clone) {
      clone.claims = clone.claims.map((claim) => ({
        ...claim,
        citations: claim.citations.map((citation) => prerequisiteSources.has(citation.source_id)
          ? { ...citation, relation: "prerequisite" as const }
          : citation),
      }))
    }
    if ("citations" in clone) {
      clone.citations = clone.citations.map((citation) => prerequisiteSources.has(citation.source_id)
        ? { ...citation, relation: "prerequisite" as const }
        : citation)
    }
    return clone
  })
  const covered = new Set(normalized.flatMap(citationsFromBlock)
    .filter((citation) => citation.relation === "prerequisite")
    .map((citation) => citation.source_id))
  for (const [sourceId, fact] of factsBySource) {
    if (covered.has(sourceId)) continue
    const identity = {
      spec_id: request.generation_spec.spec_id,
      source_id: sourceId,
      fact_id: fact.fact_id,
    }
    normalized.push({
      block_id: stableId("PREREQ-BLOCK", identity),
      block_type: "paragraph",
      text: `先修知识连接：${fact.content}`,
      claims: [{
        claim_id: stableId("PREREQ-CLAIM", identity),
        text: fact.content,
        citations: [{ source_id: sourceId, fact_id: fact.fact_id, relation: "prerequisite" }],
      }],
    })
  }
  return normalized
}

function freezeClaimTexts(blocks: RenderBlock[], evidence: RagEvidencePack): void {
  const facts = new Map(evidence.results.flatMap((entry) =>
    entry.facts.map((fact) => [`${fact.source_id}:${fact.fact_id}`, fact.content] as const),
  ))
  for (const block of blocks) {
    if (!("claims" in block)) continue
    block.claims = block.claims.map((claim) => {
      const fact = claim.citations.map((citation) => facts.get(`${citation.source_id}:${citation.fact_id}`))
        .find((content): content is string => Boolean(content))
      if (!fact) return claim
      return claimTextMatchesFact(claim.text, fact)
        ? { ...claim, text: claim.text.trim() }
        : { ...claim, text: fact }
    })
  }
}

function ensureRequiredModalities(
  modalities: AssessmentItemPublic["modality"][],
  tiers: Array<1 | 2 | 3>,
  required: AssessmentItemPublic["modality"][],
): void {
  const preferredTier: Record<AssessmentItemPublic["modality"], 1 | 2 | 3> = {
    mcq: 1,
    true_false: 1,
    trace: 2,
    short_answer: 2,
    code: 3,
  }
  for (const modality of required) {
    if (modalities.includes(modality)) continue
    const replaceable = modalities.findIndex((current, index) =>
      tiers[index] === preferredTier[modality]
      && (!required.includes(current) || modalities.filter((entry) => entry === current).length > 1),
    )
    const fallback = modalities.findIndex((current) =>
      !required.includes(current) || modalities.filter((entry) => entry === current).length > 1,
    )
    const index = replaceable >= 0 ? replaceable : fallback
    if (index < 0) throw new ModelOutputValidationError("assessment.plan", [`无法安置必需题型 ${modality}`])
    modalities[index] = modality
  }
}

function assignObjectives(
  spec: GenerationSpec,
  modalities: AssessmentItemPublic["modality"][],
): GenerationSpec["targets"] {
  const assignments: Array<GenerationSpec["targets"][number] | undefined> = Array(modalities.length)
  const core = spec.targets.filter((target) => target.importance === "core")
    .sort((left, right) => compatibleCount(left.observable_behavior, modalities) - compatibleCount(right.observable_behavior, modalities))
  for (const target of core) {
    const index = modalities.findIndex((modality, slot) => !assignments[slot] && modalityMeasures(target.observable_behavior, modality))
    if (index < 0) {
      throw new ModelOutputValidationError("assessment.plan", [
        `蓝图没有可直接测量核心目标 ${target.objective_id}/${target.observable_behavior} 的题型槽位`,
      ])
    }
    assignments[index] = target
  }
  let cursor = 0
  for (let index = 0; index < assignments.length; index += 1) {
    if (assignments[index]) continue
    const compatible = spec.targets.filter((target) => modalityMeasures(target.observable_behavior, modalities[index]))
    const pool = compatible.length > 0 ? compatible : spec.targets
    assignments[index] = pool[cursor % pool.length]
    cursor += 1
  }
  return assignments as GenerationSpec["targets"]
}

function compatibleCount(
  behavior: GenerationSpec["targets"][number]["observable_behavior"],
  modalities: AssessmentItemPublic["modality"][],
): number {
  return modalities.filter((modality) => modalityMeasures(behavior, modality)).length
}

function modalityMeasures(
  behavior: GenerationSpec["targets"][number]["observable_behavior"],
  modality: AssessmentItemPublic["modality"],
): boolean {
  const allowed: Record<typeof behavior, AssessmentItemPublic["modality"][]> = {
    recognize: ["mcq", "true_false", "trace", "short_answer", "code"],
    explain: ["short_answer"],
    trace: ["trace", "code"],
    apply: ["trace", "short_answer", "code"],
    debug: ["code"],
    create: ["code"],
  }
  return allowed[behavior].includes(modality)
}

function targetForCitations(spec: GenerationSpec, citations: CitationRef[]) {
  return spec.targets.find((target) => citations.some((citation) =>
    citation.source_id === target.source_id && target.required_fact_ids.includes(citation.fact_id),
  ))
}

function deterministicRouting(items: AssessmentItemPublic[]): AssessmentPublicPayload["routing"] {
  const anchors = items.filter((item) => item.tier <= 2).slice(0, 3).map((item) => item.item_id)
  if (anchors.length === 0) anchors.push(items[0].item_id)
  return {
    anchor_item_ids: anchors,
    rules: [
      { route_id: "ROUTE-REMEDIATE", min_anchor_score_ratio: 0, max_anchor_score_ratio: 0.4, action: "remediate", reveal_tiers: [1] },
      { route_id: "ROUTE-REINFORCE", min_anchor_score_ratio: 0.4, max_anchor_score_ratio: 0.8, action: "reinforce", reveal_tiers: [1, 2] },
      { route_id: "ROUTE-ADVANCE", min_anchor_score_ratio: 0.8, max_anchor_score_ratio: 1, action: "advance", reveal_tiers: [2, 3] },
    ],
  }
}

function assessmentPublicCoverage(spec: GenerationSpec, items: AssessmentItemPublic[]) {
  return spec.targets.flatMap((target) => {
    const selected = items.filter((item) => item.objective_id === target.objective_id)
    if (selected.length === 0) return []
    return [{
      objective_id: target.objective_id,
      item_ids: selected.map((item) => item.item_id),
      modalities: unique(selected.map((item) => item.modality)),
    }]
  })
}

function assessmentSecureCoverage(spec: GenerationSpec, items: AssessmentItemSecure[]) {
  return spec.targets.flatMap((target) => {
    const selected = items.filter((item) => item.objective_id === target.objective_id)
    if (selected.length === 0) return []
    return [{
      objective_id: target.objective_id,
      item_ids: selected.map((item) => item.item_id),
      answer_kinds: unique(selected.map((item) => item.answer_spec.kind)),
    }]
  })
}

function reorderChoiceOptions(
  payload: AssessmentPublicPayload,
  secureItems: AssessmentItemSecure[],
  seed: number,
): AssessmentPublicPayload {
  let ordinal = 0
  const secureById = new Map(secureItems.map((item) => [item.item_id, item]))
  const items = payload.items.map((item) => {
    if (!item.options) return structuredClone(item)
    const correctId = secureById.get(item.item_id)?.correct_option_id
    const correct = item.options.find((option) => option.option_id === correctId)
    if (!correct) return structuredClone(item)
    const others = item.options.filter((option) => option.option_id !== correctId)
    const targetPosition = (positiveModulo(seed, item.options.length) + ordinal) % item.options.length
    ordinal += 1
    const options = [...others]
    options.splice(targetPosition, 0, correct)
    return { ...structuredClone(item), options: options.map((option, index) => ({ ...option, label: "ABCD"[index] })) }
  })
  return { ...structuredClone(payload), items }
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function deduplicate(citations: CitationRef[]): CitationRef[] {
  return [...new Map(citations.map((entry) => [
    `${entry.source_id}:${entry.fact_id}:${entry.relation}`,
    structuredClone(entry),
  ])).values()]
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const normalized = Math.max(1, Math.floor(size))
  const output: T[][] = []
  for (let index = 0; index < values.length; index += normalized) {
    output.push(values.slice(index, index + normalized))
  }
  return output
}
