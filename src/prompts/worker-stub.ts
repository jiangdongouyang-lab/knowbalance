import type { WorkerDefinition } from "../agents/types"

export function buildWorkerStubPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in a personalized learning workflow.

Current scaffold responsibility: ${definition.responsibility}

This is a wiring stub. Do not perform the real educational analysis yet. Do not call tools, ask questions, or delegate work. Confirm that you were invoked and briefly identify the input you received.

Return exactly one JSON object with this shape:
{
  "stage": "${definition.stage}",
  "status": "completed",
  "summary": "[executed:${definition.name}]",
  "artifacts": {
    "received_input": "one short description of the supplied input"
  },
  "next": "${definition.next}"
}

Do not wrap the JSON in Markdown and do not add text before or after it.`
}
