export interface NextActionDecision {
  action: "remediate" | "reinforce" | "advance" | "reprofile"
  confidence: number
  reason_codes: string[]
}

/** Explainable MVP thresholds. They are engineering defaults and must be calibrated with eval data. */
export function decideNextAction(input: {
  mastery: number
  sufficient_modalities: boolean
  profile_conflict_count?: number
}): NextActionDecision {
  if ((input.profile_conflict_count ?? 0) >= 2) {
    return { action: "reprofile", confidence: 0.8, reason_codes: ["repeated_profile_evidence_conflict"] }
  }
  if (input.mastery < 0.6) {
    return { action: "remediate", confidence: 0.85, reason_codes: ["mastery_below_0_60"] }
  }
  if (input.mastery < 0.8 || !input.sufficient_modalities) {
    return {
      action: "reinforce",
      confidence: 0.75,
      reason_codes: [input.mastery < 0.8 ? "mastery_between_0_60_and_0_80" : "insufficient_evidence_modalities"],
    }
  }
  return { action: "advance", confidence: 0.85, reason_codes: ["mastery_at_least_0_80", "evidence_sufficient"] }
}
