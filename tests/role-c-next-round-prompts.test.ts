import { describe, expect, test } from "bun:test"
import {
  ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT,
  ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT,
  buildAssessmentAuthorModelInput,
  buildCodeLabModelInput,
  buildConceptTutorModelInput,
  CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT,
  CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT,
  CODE_LAB_SYSTEM_PROMPT,
  CONCEPT_SEGMENT_SYSTEM_PROMPT,
  CONCEPT_TUTOR_SYSTEM_PROMPT,
  EVALUATOR_AUTHOR_SYSTEM_PROMPT,
  ROLE_C_NEXT_ROUND_CONTEXT_POLICY,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  type ConceptLessonArtifact,
  type GenerationSpec,
  type NextRoundGenerationContext,
  type RagEvidencePack,
} from "../src/role-c-content"

describe("Role C next-round authoring semantics", () => {
  test("applies one versioned next-round policy to all three author Agents and stages", () => {
    expect(ROLE_C_PROMPT_MANIFEST_VERSION).toBe("c-prompts-1.8.1")
    for (const prompt of [
      CONCEPT_TUTOR_SYSTEM_PROMPT,
      CODE_LAB_SYSTEM_PROMPT,
      EVALUATOR_AUTHOR_SYSTEM_PROMPT,
      CONCEPT_SEGMENT_SYSTEM_PROMPT,
      CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT,
      CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT,
      ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT,
      ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toContain(ROLE_C_NEXT_ROUND_CONTEXT_POLICY)
    }
  })

  test("locks focus coverage and the remediate, reinforce, and advance meanings", () => {
    expect(ROLE_C_NEXT_ROUND_CONTEXT_POLICY).toContain(
      "focus_objective_ids 只决定优先讲解、练习和检查的目标",
    )
    expect(ROLE_C_NEXT_ROUND_CONTEXT_POLICY).toContain(
      "所有 targets 仍须满足本 Agent 的完整覆盖要求",
    )
    expect(ROLE_C_NEXT_ROUND_CONTEXT_POLICY).toContain(
      "action=remediate 时，围绕 focus_objective_ids 拆小步骤、增加示例与提示、降低无关认知负荷",
    )
    expect(ROLE_C_NEXT_ROUND_CONTEXT_POLICY).toContain(
      "action=reinforce 时，围绕 focus_objective_ids 生成与 generation_spec.difficulty 同难度的新情境或新变式",
    )
    expect(ROLE_C_NEXT_ROUND_CONTEXT_POLICY).toContain(
      "action=advance 时，以当前 generation_spec.path_node、targets 和当前 evidence 为新节点的唯一知识边界",
    )
    expect(ROLE_C_NEXT_ROUND_CONTEXT_POLICY).toContain(
      "历史薄弱点只影响自适应呈现、脚手架与重点",
    )
  })

  test("passes the same focused context to all three model inputs without mutating it", () => {
    const fixture = modelInputFixture()
    const original = structuredClone(fixture.nextRoundContext)

    const concept = buildConceptTutorModelInput({
      generation_spec: fixture.spec,
      evidence_pack: fixture.evidence,
      next_round_context: fixture.nextRoundContext,
    })
    const lab = buildCodeLabModelInput({
      generation_spec: fixture.spec,
      evidence_pack: fixture.evidence,
      concept_artifact: fixture.concept,
      next_round_context: fixture.nextRoundContext,
    })
    const assessment = buildAssessmentAuthorModelInput({
      generation_spec: fixture.spec,
      evidence_pack: fixture.evidence,
      concept_artifact: fixture.concept,
      next_round_context: fixture.nextRoundContext,
    })

    expect(concept.upstream.next_round_context).toEqual(original)
    expect(lab.next_round_context).toEqual(original)
    expect(assessment.upstream.next_round_context).toEqual(original)
    expect(fixture.nextRoundContext).toEqual(original)
    expect(concept.upstream.next_round_context).not.toBe(fixture.nextRoundContext)
    expect(lab.next_round_context).not.toBe(fixture.nextRoundContext)
    expect(assessment.upstream.next_round_context).not.toBe(fixture.nextRoundContext)
  })

  test("does not apply another segment's focus directive to a locked non-focus objective", () => {
    const fixture = modelInputFixture()
    const nonFocusSpec = {
      ...structuredClone(fixture.spec),
      targets: [structuredClone(fixture.spec.targets[1])],
    }
    const input = buildConceptTutorModelInput({
      generation_spec: nonFocusSpec,
      evidence_pack: fixture.evidence,
      next_round_context: fixture.nextRoundContext,
    })

    expect(input.contract.targets.map((target) => target.objective_id)).toEqual(["O-SUPPORT"])
    expect(input.upstream.next_round_context).toBeUndefined()
  })
})

function modelInputFixture(): {
  spec: GenerationSpec
  evidence: RagEvidencePack
  concept: ConceptLessonArtifact
  nextRoundContext: NextRoundGenerationContext
} {
  const versions = {
    profile_version: "profile-v1",
    kb_version: "kb-v1",
    rag_version: "rag-v1",
    prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
    model_config_hash: "model-v1",
    schema_version: "1.0" as const,
  }
  const spec: GenerationSpec = {
    schema_version: "1.0",
    spec_id: "SPEC-NEXT-PROMPT",
    run_id: "RUN-NEXT-PROMPT",
    evidence_ref: "RAG-NEXT-PROMPT",
    evidence_content_hash: "evidence-hash",
    versions,
    profile_ref: {
      profile_id: "PROFILE-NEXT-PROMPT",
      profile_version: "profile-v1",
      profile_content_hash: "profile-hash",
    },
    path_node: {
      node_id: "NODE-NEXT",
      target_source_ids: ["K-NEXT"],
      prerequisite_source_ids: [],
      goal: "完成本轮目标",
    },
    targets: [
      {
        objective_id: "O-FOCUS",
        source_id: "K-NEXT",
        required_fact_ids: ["F-NEXT"],
        observable_behavior: "explain",
        importance: "core",
      },
      {
        objective_id: "O-SUPPORT",
        source_id: "K-NEXT",
        required_fact_ids: ["F-NEXT"],
        observable_behavior: "apply",
        importance: "supporting",
      },
    ],
    learner_adaptation: {
      level: "beginner",
      known_concepts: [],
      weak_concepts: ["O-FOCUS"],
      preferred_contexts: [],
      scaffold_level: 2,
      reading_density: "medium",
      accommodations: [],
    },
    difficulty: {
      domain_complexity: 1,
      cognitive_demand: 1,
      reasoning_steps: 2,
      code_complexity: 1,
      prerequisite_load: 0,
      scaffold_strength: 2,
    },
    assessment_blueprint: {
      tier_1_count: 1,
      tier_2_count: 1,
      tier_3_count: 1,
      required_modalities: ["mcq", "short_answer", "code"],
    },
    policies: {
      external_knowledge_allowed: false,
      citation_required: true,
      max_semantic_revision: 1,
      max_tool_retry: 2,
      seed: 17,
    },
  }
  const evidence: RagEvidencePack = {
    schema_version: "1.0",
    retrieval_id: "RAG-NEXT-PROMPT",
    query: "next prompt fixture",
    learner_level: "beginner",
    top_k: 1,
    match_status: "strong",
    kb_version: "kb-v1",
    rag_version: "rag-v1",
    results: [{
      source_id: "K-NEXT",
      title: "下一轮知识",
      difficulty: "beginner",
      rank_score: 1,
      match_reason: "fixture",
      snippet: "fixture",
      facts: [{ source_id: "K-NEXT", fact_id: "F-NEXT", content: "事实" }],
      examples: [],
      practice_tasks: [],
      quiz_seeds: [],
      source_file: "fixture.json",
      retrieval_trace: {
        matched_keywords: ["next"],
        matched_fields: ["title"],
        difficulty_match: true,
        score_breakdown: {
          keyword: 1,
          title: 1,
          facts: 1,
          practice_tasks: 0,
          difficulty: 1,
          bonus: 0,
        },
      },
    }],
  }
  const concept: ConceptLessonArtifact = {
    schema_version: "1.0",
    run_id: spec.run_id,
    artifact_id: "ART-CONCEPT-NEXT-PROMPT",
    artifact_type: "concept_lesson",
    agent: "concept-tutor",
    status: "ready",
    versions,
    seed: spec.policies.seed,
    input_refs: [spec.spec_id],
    citations: [],
    quality: {
      schema_ok: true,
      citation_coverage: 1,
      objective_coverage: 1,
      alignment_score: 1,
    },
    payload: {
      title: "下一轮讲义",
      objective_ids: spec.targets.map((target) => target.objective_id),
      prerequisite_bridge: [],
      explanation_blocks: [],
      worked_examples: [],
      misconceptions: [],
      micro_checks: [],
      hint_ladders: [],
      summary: [],
      objective_coverage: [],
      used_evidence: [],
    },
    trace_ref: "TRACE-CONCEPT-NEXT-PROMPT",
  }
  const nextRoundContext: NextRoundGenerationContext = {
    request_id: "NXR-PROMPT",
    parent_spec_id: "SPEC-PARENT",
    prior_feedback_ref: "DFR-PARENT",
    trigger_grade_artifact_id: "ART-GRADE-PARENT",
    action: "remediate",
    focus_objective_ids: ["O-FOCUS"],
    reason_codes: ["objective_accuracy_below_threshold"],
  }
  return { spec, evidence, concept, nextRoundContext }
}
