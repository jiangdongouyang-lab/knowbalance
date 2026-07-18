import { createCodeLabAgent } from "./agents/code-lab"
import { createConceptTutorAgent } from "./agents/concept-tutor"
import { createTieredEvaluatorAgent } from "./agents/tiered-evaluator"
import type { RoleCAgents, RoleCContentProvider } from "./agents/types"

export * from "./agents"
export * from "./contracts"
export * from "./grading"
export * from "./mastery"
export * from "./orchestrator"
export * from "./security"
export * from "./validators"

export function createRoleCAgents(provider: RoleCContentProvider): RoleCAgents {
  return {
    concept_tutor: createConceptTutorAgent(provider),
    code_lab: createCodeLabAgent(provider),
    tiered_evaluator: createTieredEvaluatorAgent(provider),
  }
}
