import { describe, expect, test } from "bun:test"
import {
  ModelBackedCrossArtifactCritic,
  ModelBackedGradeFeedbackGenerator,
  type ModelGateway,
} from "../src/role-c-content"

class CapturingGateway implements ModelGateway {
  readonly model_id = "fixture-model"
  readonly model_config_hash = "fixture-model-config"
  readonly inputs: unknown[] = []
  constructor(private readonly outputs: unknown[]) {}
  async generateStructured<T>(request: { input: unknown }): Promise<T> {
    this.inputs.push(structuredClone(request.input))
    return structuredClone(this.outputs.shift()) as T
  }
}

describe("role C model-backed auxiliary stages", () => {
  test("generates feedback only from frozen public score fields and preserves item contracts", async () => {
    const gateway = new CapturingGateway([{
      generated_after_score_freeze: true,
      mode: "formative",
      summary: "先巩固循环追踪，再完成同族练习。",
      item_feedback: [{
        item_id: "I1",
        feedback_code: "incorrect",
        message: "当前推导还没有覆盖全部迭代步骤。",
        next_step: "回看目标 O1 的逐轮变量示例。",
      }],
    }])
    const generator = new ModelBackedGradeFeedbackGenerator(gateway)
    const feedback = await generator.generate({
      mode: "formative",
      frozen_score: {
        submission_id: "SUB-1", form_id: "FORM-1", score_frozen: true,
        raw_score: 0, max_score: 1, evidence_score: 0,
      },
      recommendation: { action: "remediate", confidence: 0.8, reason_codes: ["low_evidence"] },
      item_results: [{
        item_id: "I1", objective_id: "O1", raw_score: 0, max_score: 1,
        feedback_code: "incorrect", misconception_tags: ["iteration_trace"],
      }],
    })
    expect(feedback.item_feedback[0]?.feedback_code).toBe("incorrect")
    const serialized = JSON.stringify(gateway.inputs[0])
    for (const forbidden of ["answer_spec", "correct_option_id", "hidden_tests", "reference_solution"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test("critic receives no secure payload and can return only known evidence references", async () => {
    const gateway = new CapturingGateway([{
      checks: [{
        target_artifact_id: "ART-ASSESS",
        objective_id: "O1",
        issue_type: "missing_assessment",
        severity: "critical",
        evidence_refs: ["O1"],
        proposed_action: "补充与目标直接对应的题目。",
      }],
    }])
    const critic = new ModelBackedCrossArtifactCritic(gateway)
    const objections = await critic.review({
      spec: {
        spec_id: "SPEC-1",
        targets: [{ objective_id: "O1", source_id: "K007", required_fact_ids: ["F001"], observable_behavior: "trace", importance: "core" }],
        path_node: { node_id: "PATH-1", target_source_ids: ["K007"], prerequisite_source_ids: [], goal: "追踪循环" },
        difficulty: { domain_complexity: 1, cognitive_demand: 1, reasoning_steps: 1, code_complexity: 1, prerequisite_load: 0, scaffold_strength: 2 },
      } as any,
      concept: {
        artifact_id: "ART-CONCEPT", status: "ready", quality: {},
        payload: { objective_coverage: [{ objective_id: "O1", block_ids: ["BLOCK-O1"] }] },
      } as any,
      lab: {
        artifact_id: "ART-LAB", status: "ready", quality: { execution_verified: true },
        payload: { instructions: [{ block_id: "LAB-BLOCK" }], public_tests: [{ test_id: "PT-1" }] },
      } as any,
      assessment: {
        artifact_id: "ART-ASSESS", status: "ready", quality: { answer_key_verified: true },
        payload: { items: [{ item_id: "ITEM-1" }] },
      } as any,
      lab_secure: {
        artifact_id: "ART-LAB-SECURE", quality: { execution_verified: true },
        payload: { reference_solution: "PRIVATE_REFERENCE_MARKER" },
      } as any,
      assessment_secure: {
        artifact_id: "ART-ASSESS-SECURE", quality: { answer_key_verified: true },
        payload: { answer_spec: "PRIVATE_ANSWER_MARKER" },
      } as any,
    })
    expect(objections).toHaveLength(1)
    expect(objections[0]).toMatchObject({ from_agent: "cross-artifact-gate", objective_id: "O1" })
    const serialized = JSON.stringify(gateway.inputs[0])
    expect(serialized).not.toContain("PRIVATE_REFERENCE_MARKER")
    expect(serialized).not.toContain("PRIVATE_ANSWER_MARKER")
  })
})
