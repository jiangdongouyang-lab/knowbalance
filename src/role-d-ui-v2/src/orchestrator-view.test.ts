import { describe, expect, test } from "bun:test"
import { answersToSubmission, pageForSession } from "./orchestrator-view"

describe("orchestrator UI state mapping", () => {
  test("routes main Agent gates and resources to learner pages", () => {
    expect(pageForSession({ status: "waiting_for_user", current_stage: "objective_diagnosis", waiting_for: { type: "diagnosis_answers" } })).toBe("diagnosis")
    expect(pageForSession({ status: "waiting_for_user", current_stage: "assessment", waiting_for: { type: "assessment_answers" }, learning_resources: { concept_lesson: {} } })).toBe("lesson")
    expect(pageForSession({ status: "completed", current_stage: "completed", feedback: {} })).toBe("feedback")
    expect(pageForSession({ status: "blocked", current_stage: "blocked" })).toBe("feedback")
  })

  test("routes a new assessment round ahead of the previous round feedback", () => {
    expect(pageForSession({ feedback: { final_decision: { action: "remediate" } }, current_stage: "assessment", waiting_for: { type: "assessment_answers" }, learning_resources: { concept_lesson: {} } })).toBe("lesson")
    expect(pageForSession({ feedback: { final_decision: { action: "reinforce" } }, current_stage: "assessment", waiting_for: { type: "assessment_answers" } })).toBe("assessment")
  })

  test("maps public answers to the formal submission contract", () => {
    const items = [
      { item_id: "mcq", modality: "mcq", options: [{ option_id: "A" }] },
      { item_id: "text", modality: "short_answer" },
      { item_id: "code", modality: "code" },
    ]
    expect(answersToSubmission(items, { mcq: "A", text: "解释", code: "print(1)" })).toEqual([
      { item_id: "mcq", selected_option_id: "A", hint_level_used: 0 },
      { item_id: "text", text_response: "解释", hint_level_used: 0 },
      { item_id: "code", code_response: "print(1)", hint_level_used: 0 },
    ])
  })
})
