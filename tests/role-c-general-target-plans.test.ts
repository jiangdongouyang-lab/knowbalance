import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import {
  buildAssessmentItemPlan,
  buildCodeLabObjectivePlan,
  buildCodeLabSecurePlan,
  type GenerationSpec,
} from "../src/role-c-content"

describe("Role C target-agnostic staged plans", () => {
  test("derives every plan identity and citation from arbitrary knowledge targets", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const groups = [1, 2, 3].flatMap((size) =>
      knowledgeBase.items.map((_, index) =>
        Array.from({ length: size }, (__, offset) =>
          knowledgeBase.items[(index + offset) % knowledgeBase.items.length]!)))

    for (const [groupIndex, items] of groups.entries()) {
      const spec = specFor(items.map((item, index) => ({
        sourceId: item.sourceId,
        factIds: item.facts.map((fact) => fact.factId),
        objectiveId: `OBJ-${groupIndex + 1}-${index + 1}`,
      })), groupIndex)
      const objectivePlan = buildCodeLabObjectivePlan(spec)
      const securePlan = buildCodeLabSecurePlan(spec, `SUITE-${groupIndex + 1}`)
      const assessmentPlan = buildAssessmentItemPlan(spec)

      expect(objectivePlan.map((entry) => entry.objective_id)).toEqual(
        spec.targets.map((target) => target.objective_id),
      )
      expect(objectivePlan.map((entry) => entry.source_id)).toEqual(
        spec.targets.map((target) => target.source_id),
      )
      objectivePlan.forEach((entry, index) => {
        expect(entry.citations.map((citation) => citation.fact_id)).toEqual(
          spec.targets[index]!.required_fact_ids,
        )
      })
      expect(securePlan.hidden_tests).toHaveLength(spec.targets.length)
      expect(new Set(securePlan.hidden_tests.map((entry) => entry.objective_id))).toEqual(
        new Set(spec.targets.map((target) => target.objective_id)),
      )
      expect(securePlan.mutation_variants).toEqual([])
      expect(assessmentPlan).toHaveLength(3)
      expect(assessmentPlan.every((entry) =>
        spec.targets.some((target) => target.objective_id === entry.objective_id))).toBe(true)
    }
  })
})

function specFor(
  targets: Array<{ sourceId: string; factIds: string[]; objectiveId: string }>,
  index: number,
): GenerationSpec {
  return {
    schema_version: "1.0",
    spec_id: `SPEC-GENERAL-${index + 1}`,
    run_id: `RUN-GENERAL-${index + 1}`,
    evidence_ref: `RAG-GENERAL-${index + 1}`,
    evidence_content_hash: `sha256:${"1".repeat(64)}`,
    versions: {
      schema_version: "1.0",
      prompt_version: "test",
      model_config_hash: "test",
      profile_version: "test",
      kb_version: "test",
      rag_version: "test",
    },
    profile_ref: {
      profile_id: "PROFILE-TEST",
      profile_version: "test",
      profile_content_hash: `sha256:${"2".repeat(64)}`,
    },
    path_node: {
      node_id: `PATH-GENERAL-${index + 1}`,
      target_source_ids: targets.map((target) => target.sourceId),
      prerequisite_source_ids: [],
      goal: "通用目标组合",
    },
    targets: targets.map((target, targetIndex) => ({
      objective_id: target.objectiveId,
      source_id: target.sourceId,
      required_fact_ids: target.factIds,
      observable_behavior: (["recognize", "trace", "create"] as const)[targetIndex % 3],
      importance: "core",
    })),
    learner_adaptation: {
      level: "basic",
      known_concepts: [],
      weak_concepts: [],
      preferred_contexts: [],
      scaffold_level: 2,
      reading_density: "medium",
      accommodations: [],
    },
    difficulty: {
      domain_complexity: 2,
      cognitive_demand: 2,
      reasoning_steps: 2,
      code_complexity: 2,
      prerequisite_load: 1,
      scaffold_strength: 2,
    },
    assessment_blueprint: {
      tier_1_count: 1,
      tier_2_count: 1,
      tier_3_count: 1,
      required_modalities: ["mcq", "trace", "code"],
    },
    policies: {
      external_knowledge_allowed: false,
      citation_required: true,
      max_semantic_revision: 1,
      max_tool_retry: 2,
      seed: 42,
    },
  }
}
