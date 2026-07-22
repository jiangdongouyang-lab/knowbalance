import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  ConceptTutorRequest,
  RoleCContentProvider,
} from "../agents/types"
import type {
  Claim,
  ConceptLessonPayload,
  RenderBlock,
} from "../contracts/artifacts"
import type { CitationRef } from "../contracts/common"
import { ModelProviderUnavailableError } from "../contracts/model-gateway"

/**
 * Offline reference Provider used by demos and deterministic tests. It is deliberately
 * conservative: locked claims reproduce evidence facts while adaptive text changes only
 * presentation and scaffolding.
 */
export class DeterministicConceptContentProvider implements RoleCContentProvider {
  async generateConceptLesson(
    request: ConceptTutorRequest,
  ): Promise<ArtifactDraft<ConceptLessonPayload>> {
    const evidenceBySource = new Map(request.evidence_pack.results.map((item) => [item.source_id, item]))
    const explanationBlocks: RenderBlock[] = []
    const workedExamples: RenderBlock[] = []
    const microChecks: ConceptLessonPayload["micro_checks"] = []
    const misconceptions: ConceptLessonPayload["misconceptions"] = []
    const hintLadders: ConceptLessonPayload["hint_ladders"] = []
    const summary: RenderBlock[] = []
    const objectiveCoverage: ConceptLessonPayload["objective_coverage"] = []
    const citations: CitationRef[] = []

    for (const target of request.generation_spec.targets) {
      const source = evidenceBySource.get(target.source_id)
      const fact = source?.facts.find((candidate) => target.required_fact_ids.includes(candidate.fact_id))
      if (!source || !fact) throw new ModelProviderUnavailableError(`缺少目标事实 ${target.source_id}`)
      const support = citation(fact.source_id, fact.fact_id, "supports")
      const derived = citation(fact.source_id, fact.fact_id, "derived_from")
      citations.push(support, derived)
      const claim = createClaim(`${target.objective_id}-CLAIM`, fact.content, support)
      const explanationId = `${target.objective_id}-EXPLANATION`
      const exampleId = `${target.objective_id}-EXAMPLE`
      const checkId = `${target.objective_id}-CHECK`

      explanationBlocks.push({
        block_id: explanationId,
        block_type: "paragraph",
        text: adaptiveExplanation(request, source.title, fact.content),
        claims: [claim],
      })
      const example = source.examples[0]
      workedExamples.push(example
        ? {
            block_id: exampleId,
            block_type: "code",
            language: "python",
            code: example.code,
            caption: `${source.title}：${example.title}`,
            claims: [createClaim(`${target.objective_id}-EXAMPLE-CLAIM`, fact.content, support)],
          }
        : {
            block_id: exampleId,
            block_type: "paragraph",
            text: `围绕“${request.generation_spec.path_node.goal}”应用该核心事实：${fact.content}`,
            claims: [createClaim(`${target.objective_id}-EXAMPLE-CLAIM`, fact.content, support)],
          })
      microChecks.push({
        block_id: checkId,
        block_type: "quiz",
        item_id: `${target.objective_id}-MICRO-01`,
        prompt: `请结合当前学习目标，用自己的话说明这条核心事实：${fact.content}`,
        citations: [derived],
      })
      misconceptions.push({
        misconception_tag: `overlooks_${target.source_id.toLocaleLowerCase()}_${fact.fact_id.toLocaleLowerCase()}`,
        explanation: `学习时需要避免只记形式而忽略核心事实：${fact.content}`,
        objective_id: target.objective_id,
        citations: [support],
      })
      hintLadders.push({
        objective_id: target.objective_id,
        hints: [
          { hint_level: 1, text: `先回忆核心事实：${fact.content}`, citations: [support] },
          { hint_level: 2, text: `把这条事实与“${request.generation_spec.path_node.goal}”联系起来。`, citations: [derived] },
          { hint_level: 3, text: `从示例中定位直接体现“${fact.content}”的部分。`, citations: [support] },
        ],
      })
      summary.push({
        block_id: `${target.objective_id}-SUMMARY`,
        block_type: "paragraph",
        text: `本目标需要保留的核心结论：${fact.content}`,
        claims: [createClaim(`${target.objective_id}-SUMMARY-CLAIM`, fact.content, support)],
      })
      objectiveCoverage.push({
        objective_id: target.objective_id,
        block_ids: [explanationId, exampleId, checkId],
      })
    }

    const prerequisiteBridge = request.generation_spec.path_node.prerequisite_source_ids.flatMap((sourceId) => {
      const source = evidenceBySource.get(sourceId)
      const fact = source?.facts[0]
      if (!source || !fact) return []
      const prerequisite = citation(fact.source_id, fact.fact_id, "prerequisite")
      citations.push(prerequisite)
      return [{
        block_id: `PREREQ-${sourceId}`,
        block_type: "paragraph" as const,
        text: `开始本节前，先连接已有知识“${source.title}”：${fact.content}`,
        claims: [createClaim(`PREREQ-${sourceId}-CLAIM`, fact.content, prerequisite)],
      }]
    })

    return {
      payload: {
        title: request.generation_spec.path_node.goal,
        objective_ids: request.generation_spec.targets.map((target) => target.objective_id),
        prerequisite_bridge: prerequisiteBridge,
        explanation_blocks: explanationBlocks,
        worked_examples: workedExamples,
        misconceptions,
        micro_checks: microChecks,
        hint_ladders: hintLadders,
        summary,
        objective_coverage: objectiveCoverage,
        used_evidence: deduplicate(citations),
      },
    }
  }

  async generateCodeLab(): Promise<CodeLabDraft> {
    throw new ModelProviderUnavailableError("离线参考 Provider 只实现 concept-tutor")
  }

  async generateAssessment(): Promise<AssessmentDraft> {
    throw new ModelProviderUnavailableError("离线参考 Provider 只实现 concept-tutor")
  }
}

function adaptiveExplanation(
  request: ConceptTutorRequest,
  title: string,
  fact: string,
): string {
  const adaptation = request.generation_spec.learner_adaptation
  const density = adaptation.reading_density === "low"
    ? "先用一句话掌握"
    : adaptation.reading_density === "high"
      ? "先确认边界，再结合规则和示例迁移"
      : "结合规则和示例理解"
  const level = adaptation.level === "beginner"
    ? "从直观含义开始"
    : adaptation.level === "integrated"
      ? "压缩基础说明并关注综合应用"
      : "从已有基础继续"
  const weakFocus = adaptation.weak_concepts.length > 0
    ? `，重点关注薄弱点：${adaptation.weak_concepts.join("、")}`
    : ""
  const knownBridge = adaptation.known_concepts.length > 0
    ? `，连接已掌握内容：${adaptation.known_concepts.slice(0, 2).join("、")}`
    : ""
  const context = adaptation.preferred_contexts[0]
    ? `，优先放入“${adaptation.preferred_contexts[0]}”场景`
    : ""
  const scaffold = adaptation.scaffold_level >= 2 ? "，保留分步脚手架" : "，减少步骤提示"
  const accommodation = adaptation.accommodations.length > 0 ? "，并遵循已登记的学习支持要求" : ""
  return `${level}，${density}“${title}”${knownBridge}${weakFocus}${context}${scaffold}${accommodation}。核心事实：${fact}`
}

function createClaim(claimId: string, text: string, source: CitationRef): Claim {
  return { claim_id: claimId, text, citations: [source] }
}

function citation(
  sourceId: string,
  factId: string,
  relation: CitationRef["relation"],
): CitationRef {
  return { source_id: sourceId, fact_id: factId, relation }
}

function deduplicate(citations: CitationRef[]): CitationRef[] {
  return [...new Map(citations.map((entry) => [
    `${entry.source_id}:${entry.fact_id}:${entry.relation}`,
    entry,
  ])).values()]
}
