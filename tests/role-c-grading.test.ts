import { describe, expect, test } from "bun:test"
import {
  gradeSubmission,
  decideNextAction,
  type AssessmentSecureArtifact,
  type SubmissionEnvelope,
} from "../src/role-c-content"

const secureArtifact: AssessmentSecureArtifact = {
  schema_version: "1.0",
  run_id: "RUN-GRADE",
  artifact_id: "ART-ASSESS-SECURE",
  artifact_type: "assessment_secure",
  agent: "tiered-evaluator",
  status: "ready",
  versions: {
    profile_version: "p1", kb_version: "kb1", rag_version: "rag1", prompt_version: "prompt1",
    model_config_hash: "model1", schema_version: "1.0",
  },
  seed: 1,
  input_refs: [],
  citations: [],
  quality: {
    schema_ok: true, citation_coverage: 1, objective_coverage: 1, alignment_score: 1, answer_key_verified: true,
  },
  payload: {
    form_id: "FORM-01",
    option_order_seed: 1,
    items: [
      {
        item_id: "I1", objective_id: "O1", modality: "mcq", max_score: 1,
        answer_spec: { kind: "exact_set", accepted: ["opt_correct"], normalization: ["trim", "casefold"] },
        correct_option_id: "opt_correct", misconception_by_option: {}, evidence_weight: 1,
      },
      {
        item_id: "I2", objective_id: "O2", modality: "short_answer", max_score: 1,
        answer_spec: { kind: "numeric", target: 85, abs_tolerance: 0.01, rel_tolerance: 0 },
        misconception_by_option: {}, evidence_weight: 1,
      },
      {
        item_id: "I3", objective_id: "O3", modality: "code", max_score: 2,
        answer_spec: { kind: "code", test_suite_id: "TS-01" },
        misconception_by_option: {}, evidence_weight: 1,
      },
    ],
  },
  trace_ref: "TRACE-01",
}

const submission: SubmissionEnvelope = {
  schema_version: "1.0",
  submission_id: "SUB-01",
  run_id: "RUN-GRADE",
  learner_id_hash: "learner-hash",
  form_id: "FORM-01",
  attempt_no: 1,
  answers: [
    { item_id: "I1", selected_option_id: " OPT_CORRECT ", hint_level_used: 0 },
    { item_id: "I2", text_response: "85.005", hint_level_used: 1 },
    { item_id: "I3", code_response: "print('not executed on host')", hint_level_used: 0 },
  ],
}

describe("role C deterministic grading boundary", () => {
  test("grades exact and numeric items but blocks code without an isolated runner", async () => {
    const grade = await gradeSubmission(submission, secureArtifact)
    expect(grade.status).toBe("blocked")
    expect(grade.item_results[0]).toMatchObject({ raw_score: 1, grader_confidence: 1, feedback_code: "correct" })
    expect(grade.item_results[1]).toMatchObject({ raw_score: 1, grader_confidence: 1, feedback_code: "correct" })
    expect(grade.item_results[2]).toMatchObject({ raw_score: 0, grader_confidence: 0, feedback_code: "code_runner_unavailable" })
    expect(grade.unresolved_item_ids).toEqual(["I3"])
  })

  test("uses explicit MVP next-action thresholds", () => {
    expect(decideNextAction({ mastery: 0.5, sufficient_modalities: true }).action).toBe("remediate")
    expect(decideNextAction({ mastery: 0.7, sufficient_modalities: true }).action).toBe("reinforce")
    expect(decideNextAction({ mastery: 0.9, sufficient_modalities: true }).action).toBe("advance")
    expect(decideNextAction({ mastery: 0.9, sufficient_modalities: true, profile_conflict_count: 2 }).action).toBe("reprofile")
  })
})
