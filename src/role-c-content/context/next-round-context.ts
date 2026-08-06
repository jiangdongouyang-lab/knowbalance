import type { NextRoundGenerationContext } from "../agents/types"

export interface ProjectedNextRoundContext extends NextRoundGenerationContext {
  teaching_strategy: "reduce_load" | "same_difficulty_new_variant" | "hold_current_path"
}

/**
 * Projects the shared next-round context onto the objectives visible to one model call.
 * A segmented call without a focused objective receives no focus directive and keeps
 * its normal locked-target coverage.
 */
export function projectNextRoundContext(
  context: NextRoundGenerationContext | undefined,
  visibleObjectiveIds: readonly string[],
): ProjectedNextRoundContext | undefined {
  if (!context) return undefined
  const visible = new Set(visibleObjectiveIds)
  const focusObjectiveIds = context.focus_objective_ids.filter((objectiveId) =>
    visible.has(objectiveId),
  )
  if (focusObjectiveIds.length === 0) return undefined
  return {
    ...structuredClone(context),
    focus_objective_ids: focusObjectiveIds,
    teaching_strategy: context.action === "remediate"
      ? "reduce_load"
      : context.action === "reinforce"
        ? "same_difficulty_new_variant"
        : "hold_current_path",
  }
}
