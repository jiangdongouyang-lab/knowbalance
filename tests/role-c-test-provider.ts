import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  CodeLabRequest,
  ConceptTutorRequest,
  RoleCContentProvider,
  TieredEvaluatorRequest,
} from "../src/role-c-content/agents/types"
import type { Claim, ConceptLessonPayload } from "../src/role-c-content/contracts/artifacts"
import type { CitationRef } from "../src/role-c-content/contracts/common"
import { stableId } from "../src/role-c-content/contracts/common"

function cite(sourceId: string, factId: string, relation: CitationRef["relation"]): CitationRef {
  return { source_id: sourceId, fact_id: factId, relation }
}
function makeClaim(claimId: string, text: string, c: CitationRef): Claim {
  return { claim_id: claimId, text, citations: [c] }
}
function dedupe(citations: CitationRef[]): CitationRef[] {
  return [...new Map(citations.map((c) => [`${c.source_id}:${c.fact_id}:${c.relation}`, c])).values()]
}

/**
 * 测试用 RoleCContentProvider。为 K007/K009/K018 生成结构合法的内容。
 */
export class TestRoleCContentProvider implements RoleCContentProvider {
  async generateConceptLesson(request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>> {
    const targets = request.generation_spec.targets
    const bySource = new Map(request.evidence_pack.results.map((r) => [r.source_id, r]))
    const citations: CitationRef[] = []

    const blocks = targets.map((t, i) => {
      const src = bySource.get(t.source_id)!
      const fact = src.facts.find((f) => t.required_fact_ids.includes(f.fact_id)) ?? src.facts[0]!
      const c = cite(fact.source_id, fact.fact_id, "supports")
      citations.push(c, cite(fact.source_id, fact.fact_id, "derived_from"))
      return { t, src, fact, c }
    })

    return {
      payload: {
        title: request.generation_spec.path_node.goal,
        objective_ids: targets.map((t) => t.objective_id),
        prerequisite_bridge: request.generation_spec.path_node.prerequisite_source_ids.flatMap((sid) => {
          const src = bySource.get(sid); if (!src) return []
          const f = src.facts[0]!; const c = cite(f.source_id, f.fact_id, "prerequisite")
          citations.push(c)
          return [{ block_id: `PREREQ-${sid}`, block_type: "paragraph" as const, text: `[测试] ${src.title}`, claims: [makeClaim(`PREREQ-${sid}`, f.content, c)] }]
        }),
        explanation_blocks: blocks.map((b, i) => ({ block_id: `${b.t.objective_id}-EXPL`, block_type: "paragraph" as const, text: `[测试讲解] ${b.src.title}：${b.fact.content}`, claims: [makeClaim(`${b.t.objective_id}-CLAIM-${i}`, b.fact.content, b.c)] })),
        worked_examples: blocks.map((b, i) => {
          const ex = b.src.examples[0]
          return ex ? { block_id: `${b.t.objective_id}-EX`, block_type: "code" as const, language: "python", code: ex.code, caption: ex.title, claims: [makeClaim(`${b.t.objective_id}-EX-CLAIM`, b.fact.content, b.c)] }
            : { block_id: `${b.t.objective_id}-EX`, block_type: "paragraph" as const, text: `[测试示例] ${b.fact.content}`, claims: [makeClaim(`${b.t.objective_id}-EX-CLAIM`, b.fact.content, b.c)] }
        }),
        micro_checks: blocks.map((b, i) => ({ block_id: `${b.t.objective_id}-CHK`, block_type: "quiz" as const, item_id: `${b.t.objective_id}-MICRO-01`, prompt: `[测试检测] 关于“${b.src.title}”的选择`, options: [{ option_id: "opt_a", label: "A", text: b.fact.content }, { option_id: "opt_b", label: "B", text: "无关" }], citations: [b.c] })),
        misconceptions: blocks.map((b, i) => ({ misconception_tag: `test_misconception_${i}`, explanation: `[测试误区] ${b.src.title}`, objective_id: b.t.objective_id, citations: [b.c] })),
        hint_ladders: blocks.map((b) => ({ objective_id: b.t.objective_id, hints: [1, 2, 3].map((lvl) => ({ hint_level: lvl as 1 | 2 | 3, text: `[提示L${lvl}] ${b.fact.content}`, citations: [b.c] })) })),
        summary: blocks.map((b, i) => ({ block_id: `${b.t.objective_id}-SUM`, block_type: "paragraph" as const, text: `[测试总结] ${b.src.title} 核心：${b.fact.content}`, claims: [makeClaim(`${b.t.objective_id}-SUM-CLAIM`, b.fact.content, b.c)] })),
        objective_coverage: blocks.map((b) => ({ objective_id: b.t.objective_id, block_ids: [`${b.t.objective_id}-EXPL`, `${b.t.objective_id}-EX`, `${b.t.objective_id}-CHK`] })),
        used_evidence: dedupe(citations),
      },
    }
  }

  async generateCodeLab(request: CodeLabRequest): Promise<CodeLabDraft> {
    const oids = request.generation_spec.targets.map((t) => t.objective_id)
    const labId = stableId("LAB-TEST", { spec_id: request.generation_spec.spec_id, test: "test-provider" })
    const tsId = stableId("TS-TEST", { lab_id: labId })
    const inst = request.generation_spec.targets.map((t) => {
      const src = request.evidence_pack.results.find((r) => r.source_id === t.source_id)!
      const f = src.facts.find((x) => t.required_fact_ids.includes(x.fact_id)) ?? src.facts[0]!
      return { block_id: `${t.objective_id}-LAB`, block_type: "paragraph" as const, text: `[测试实验] ${src.title}`, claims: [makeClaim(`${t.objective_id}-LAB-CLAIM`, f.content, cite(f.source_id, f.fact_id, "supports"))] }
    })
    const hts = oids.map((oid, i) => ({ test_id: `HT-TEST-${oid}`, input: [[10, 20, 30], [91], [0, 50, 100], [73.5, 86.5], [1, 2]][i] ?? [60, 80], expected: [20, 91, 50, 80, 1.5][i] ?? 60, objective_id: oid, weight: 0.2, comparison: { kind: "numeric" as const, abs_tolerance: 1e-9, rel_tolerance: 1e-9 } }))
    return {
      public_draft: { payload: { lab_id: labId, title: "[测试] 实验", objective_ids: oids, instructions: inst, execution_contract: { language: "python", execution_mode: "function" as const, entry_point: "solution", allowed_imports: [], input_contract: { type: "list[number]", constraints: [] }, output_contract: { type: "number", constraints: [] }, resource_limits: { timeout_ms: 2000, memory_mb: 128, max_output_bytes: 20000 } }, starter_code: "def solution(data):\n    pass", public_tests: oids.map((oid, i) => ({ test_id: `PT-TEST-${oid}`, objective_id: oid, description: `[测试] 公开测试`, input: [[80, 90]][i] ?? [60], expected_behavior: "结果应为数值", citations: [] })), hint_ladders: oids.map((oid) => ({ objective_id: oid, hints: [1, 2, 3].map((l) => ({ hint_level: l as 1 | 2 | 3, text: `[提示L${l}]`, citations: [] })) })), reflection_questions: ["[测试反思]"], objective_coverage: oids.map((oid, i) => ({ objective_id: oid, instruction_block_ids: [`${oid}-LAB`], public_test_ids: [`PT-TEST-${oid}`] })), used_evidence: [] } },
      secure_draft: { payload: { lab_id: labId, test_suite_id: tsId, execution_contract: { language: "python", execution_mode: "function" as const, entry_point: "solution", allowed_imports: [], input_contract: { type: "list[number]", constraints: [] }, output_contract: { type: "number", constraints: [] }, resource_limits: { timeout_ms: 2000, memory_mb: 128, max_output_bytes: 20000 } }, reference_solution: "def solution(data):\n    return sum(data)/len(data)", hidden_tests: hts, scoring_groups: oids.map((oid) => ({ group_id: `G-${oid}`, objective_id: oid, test_ids: hts.filter((h) => h.objective_id === oid).map((h) => h.test_id), weight: 1 })), misconception_map: [], mutation_variants: [], objective_coverage: oids.map((oid) => ({ objective_id: oid, hidden_test_ids: hts.filter((h) => h.objective_id === oid).map((h) => h.test_id), scoring_group_ids: [`G-${oid}`], mutation_ids: [] })) } },
    }
  }

  async generateAssessment(request: TieredEvaluatorRequest): Promise<AssessmentDraft> {
    const spec = request.generation_spec
    const oids = spec.targets.map((t) => t.objective_id)
    const bp = spec.assessment_blueprint
    const total = bp.tier_1_count + bp.tier_2_count + bp.tier_3_count
    const items: any[] = []
    for (let i = 0; i < total; i++) {
      const tier: 1 | 2 | 3 = i < bp.tier_1_count ? 1 : i < bp.tier_1_count + bp.tier_2_count ? 2 : 3
      const m = bp.required_modalities
      const mod = tier === 3 && m.includes("code") ? "code" : tier === 2 && m.includes("trace") ? "trace" : m.includes("mcq") ? "mcq" : "short_answer"
      const oid = oids[i % oids.length]!
      items.push({
        item_id: `ITEM-TEST-${i}`, family_id: `FAM-TEST-${i}`, variant_id: `VAR-TEST-${i}`, display_no: i + 1,
        objective_id: oid, tier, modality: mod as any,
        prompt: `[测试题目${i + 1}]`, options: mod === "mcq" ? [{ option_id: "opt_a", label: "A", text: "A" }, { option_id: "opt_b", label: "B", text: "B" }] : undefined,
        max_score: tier === 1 ? 2 : tier === 2 ? 4 : 6, citations: [],
      })
    }
    return {
      public_draft: { payload: { form_id: `FORM-TEST-${spec.spec_id}`, title: "[测试] 测评", items, routing: { anchor_item_ids: items.slice(0, 2).map((it: any) => it.item_id), rules: [{ score_low: 0, score_high: 0.4, action: "remediate" as const, reveal_tiers: [1] as Array<1 | 2 | 3> }, { score_low: 0.4, score_high: 0.8, action: "reinforce" as const, reveal_tiers: [1, 2] as Array<1 | 2 | 3> }, { score_low: 0.8, score_high: 1, action: "advance" as const, reveal_tiers: [1, 2, 3] as Array<1 | 2 | 3> }] }, objective_coverage: oids.map((oid) => ({ objective_id: oid, modalities: spec.assessment_blueprint.required_modalities, item_ids: items.filter((it: any) => it.objective_id === oid).map((it: any) => it.item_id) })), used_evidence: [] } as any },
      secure_draft: { payload: { form_id: `FORM-TEST-${spec.spec_id}`, items: items.map((it: any) => ({ item_id: it.item_id, objective_id: it.objective_id, tier: it.tier, modality: it.modality, max_score: it.max_score, answer_spec: it.modality === "mcq" ? null : null, correct_option_id: it.modality === "mcq" ? "opt_a" : null, misconception_by_option: it.modality === "mcq" ? { opt_b: "test" } : {} as any, evidence_weight: 1 })), code_test_suites: items.filter((it: any) => it.modality === "code").map((it: any) => ({ test_suite_id: `TS-TEST-${it.item_id}`, item_id: it.item_id, execution_contract: { language: "python" as const, execution_mode: "function" as const, entry_point: "solution", allowed_imports: [], input_contract: { type: "list[number]", constraints: [] }, output_contract: { type: "number", constraints: [] }, resource_limits: { timeout_ms: 2000, memory_mb: 128, max_output_bytes: 20000 } }, reference_solution: "def solution(d):\n    return sum(d)/len(d)", hidden_tests: [{ test_id: "HT-CODE-TEST", input: { args: [[1, 2, 3]], kwargs: {} }, expected: 2, comparison: { kind: "numeric" as const, abs_tolerance: 1e-9, rel_tolerance: 1e-9 } }], scoring_groups: [{ group_id: `G-CODE-${it.item_id}`, objective_id: it.objective_id, test_ids: ["HT-CODE-TEST"], weight: 1 }], misconception_map: [], objective_coverage: [] })) } as any },
    }
  }
}
