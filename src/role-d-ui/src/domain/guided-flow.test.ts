import { describe, expect, test } from "vitest"
import { advanceStage, furthestStage, isGuidedStage, retreatStage, STAGES } from "./guided-flow"

describe("guided learning flow", () => {
  test("follows the competition-aligned stage order", () => {
    expect(STAGES.map((stage) => stage.id)).toEqual([
      "onboarding",
      "diagnosis",
      "profile",
      "plan",
      "learning",
      "feedback",
    ])
  })

  test("advances and retreats without crossing boundaries", () => {
    expect(advanceStage("onboarding")).toBe("diagnosis")
    expect(advanceStage("feedback")).toBe("feedback")
    expect(retreatStage("diagnosis")).toBe("onboarding")
    expect(retreatStage("onboarding")).toBe("onboarding")
  })

  test("never relocks stages when a learner revisits an earlier step", () => {
    expect(furthestStage("plan", "diagnosis")).toBe("plan")
    expect(furthestStage("diagnosis", "profile")).toBe("profile")
  })

  test("recognizes only supported persisted stage ids", () => {
    expect(isGuidedStage("learning")).toBe(true)
    expect(isGuidedStage("dashboard")).toBe(false)
  })
})
