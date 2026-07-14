import type { AgentConfig } from "@opencode-ai/sdk/v2"
import { buildWorkerStubPrompt } from "../prompts/worker-stub"
import type { WorkerDefinition, WorkflowAgentName } from "./types"

export const WORKER_DEFINITIONS = [
  {
    name: "background-collector",
    stage: "background_collection",
    description: "Collects learner background and learning-goal context.",
    responsibility: "Acknowledge execution of learner background collection.",
    next: "await_evidence",
  },
  {
    name: "self-assessor",
    stage: "self_assessment",
    description: "Collects the learner's own skill and confidence assessment.",
    responsibility: "Acknowledge execution of skill self-assessment.",
    next: "await_evidence",
  },
  {
    name: "objective-diagnostician",
    stage: "objective_diagnosis",
    description: "Runs an objective knowledge and skill diagnosis.",
    responsibility: "Acknowledge execution of objective diagnosis.",
    next: "build_profile",
  },
  {
    name: "profile-builder",
    stage: "profile_building",
    description: "Synthesizes background, self-assessment, and diagnostic evidence.",
    responsibility: "Acknowledge execution of learner profile construction.",
    next: "plan_path",
  },
  {
    name: "path-planner",
    stage: "path_planning",
    description: "Plans a personalized learning path from the learner profile.",
    responsibility: "Acknowledge execution of learning-path planning.",
    next: "teach_concept",
  },
  {
    name: "concept-tutor",
    stage: "concept_instruction",
    description: "Generates personalized concept instruction for the current path step.",
    responsibility: "Acknowledge execution of personalized concept-note generation.",
    next: "run_code_lab",
  },
  {
    name: "code-lab",
    stage: "code_lab",
    description: "Prepares and runs an executable code experiment.",
    responsibility: "Acknowledge execution of the code experiment stage.",
    next: "run_assessment",
  },
  {
    name: "tiered-evaluator",
    stage: "tiered_assessment",
    description: "Runs a tiered assessment and recommends progression.",
    responsibility: "Acknowledge execution of tiered assessment.",
    next: "continue",
  },
] as const satisfies readonly WorkerDefinition[]

export function createWorkerAgents(): Record<
  Exclude<WorkflowAgentName, "learning-orchestrator">,
  AgentConfig
> {
  return WORKER_DEFINITIONS.reduce(
    (agents, definition) => {
      agents[definition.name] = {
        description: definition.description,
        mode: "subagent",
        temperature: 0.1,
        tools: { "*": false },
        permission: { "*": "deny" },
        prompt: buildWorkerStubPrompt(definition),
      }
      return agents
    },
    {} as Record<Exclude<WorkflowAgentName, "learning-orchestrator">, AgentConfig>,
  )
}
