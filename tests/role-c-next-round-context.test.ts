import { describe, expect, test } from "bun:test"
import { projectNextRoundContext } from "../src/role-c-content/context/next-round-context"
import { buildConceptTutorModelInput } from "../src/role-c-content/context/concept-context"
import { buildCodeLabModelInput } from "../src/role-c-content/context/code-lab-context"

const baseContext = {
  request_id: "REQ-1",
  parent_spec_id: "SPEC-0",
  prior_feedback_ref: "FB-0",
  trigger_grade_artifact_id: "GRADE-0",
  focus_objective_ids: ["O1"],
  reason_codes: ["round_accuracy_below_remediation_threshold"],
}

describe("next round context projection", () => {
  test("distinguishes remediate and reinforce teaching strategies", () => {
    const remediate = projectNextRoundContext({ ...baseContext, action: "remediate" }, ["O1"])
    const reinforce = projectNextRoundContext({ ...baseContext, action: "reinforce" }, ["O1"])

    expect(remediate?.teaching_strategy).toBe("reduce_load")
    expect(reinforce?.teaching_strategy).toBe("same_difficulty_new_variant")
    expect(remediate).not.toEqual(reinforce)
  })

  test("keeps the projected strategy visible in both concept and code lab inputs", () => {
    const concept = buildConceptTutorModelInput({
      generation_spec: {
        spec_id: "SPEC-1",
        run_id: "RUN-1",
        path_node: { node_id: "NODE-1", target_source_ids: ["K007"], prerequisite_source_ids: [], goal: "goal", objectives: [{ objective_id: "O1", source_id: "K007", required_fact_ids: ["F1"], observable_behavior: "trace", importance: "core" }], assessment_blueprint: { tier_1_count: 1, tier_2_count: 0, tier_3_count: 0, required_modalities: ["mcq"] } },
        targets: [{ objective_id: "O1", source_id: "K007", required_fact_ids: ["F1"], observable_behavior: "trace", importance: "core" }],
        learner_adaptation: { scaffold_level: 1, reading_density: "medium" },
        difficulty: { domain_complexity: 1, cognitive_demand: 1, reasoning_steps: 1, code_complexity: 1, prerequisite_load: 1, scaffold_strength: 1 },
        policies: { seed: 7, max_semantic_revision: 1, max_tool_retry: 1 },
      },
      evidence_pack: { retrieval_id: "RAG-1", results: [] } as never,
      next_round_context: { ...baseContext, action: "remediate" },
    } as never)

    const lab = buildCodeLabModelInput({
      generation_spec: {
        spec_id: "SPEC-1",
        run_id: "RUN-1",
        path_node: { node_id: "NODE-1", target_source_ids: ["K007"], prerequisite_source_ids: [], goal: "goal", objectives: [{ objective_id: "O1", source_id: "K007", required_fact_ids: ["F1"], observable_behavior: "apply", importance: "core" }], assessment_blueprint: { tier_1_count: 1, tier_2_count: 0, tier_3_count: 0, required_modalities: ["mcq"] } },
        targets: [{ objective_id: "O1", source_id: "K007", required_fact_ids: ["F1"], observable_behavior: "apply", importance: "core" }],
        learner_adaptation: { scaffold_level: 1, reading_density: "medium" },
        difficulty: { domain_complexity: 1, cognitive_demand: 1, reasoning_steps: 1, code_complexity: 1, prerequisite_load: 1, scaffold_strength: 1 },
        policies: { seed: 7, max_semantic_revision: 1, max_tool_retry: 1 },
      },
      evidence_pack: { retrieval_id: "RAG-1", results: [] } as never,
      concept_artifact: { artifact_id: "CONCEPT-1", payload: { objective_coverage: [], misconceptions: [], objective_ids: [], explanation_blocks: [], worked_examples: [], summary: [] } } as never,
      next_round_context: { ...baseContext, action: "reinforce" },
    } as never)

    expect(concept.upstream.next_round_context?.teaching_strategy).toBe("reduce_load")
    expect(lab.next_round_context?.teaching_strategy).toBe("same_difficulty_new_variant")
  })
})
