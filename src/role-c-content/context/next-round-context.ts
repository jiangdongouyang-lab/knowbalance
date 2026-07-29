import type { NextRoundGenerationContext } from "../agents/types"

/**
 * Projects the shared next-round context onto the objectives visible to one model call.
 * A segmented call without a focused objective receives no focus directive and keeps
 * its normal locked-target coverage.
 */
export function projectNextRoundContext(
  context: NextRoundGenerationContext | undefined,
  visibleObjectiveIds: readonly string[],
): NextRoundGenerationContext | undefined {
  if (!context) return undefined
  const visible = new Set(visibleObjectiveIds)
  const focusObjectiveIds = context.focus_objective_ids.filter((objectiveId) =>
    visible.has(objectiveId),
  )
  if (focusObjectiveIds.length === 0) return undefined
  return {
    ...structuredClone(context),
    focus_objective_ids: focusObjectiveIds,
  }
}
