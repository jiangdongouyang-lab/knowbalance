import type { WorkerDefinition } from "../agents/types"

export function buildWorkerStubPrompt(definition: WorkerDefinition): string {
  if (["concept-tutor", "code-lab", "tiered-evaluator"].includes(definition.name)) {
    return buildRagGroundedWorkerPrompt(definition)
  }

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

function buildRagGroundedWorkerPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in a personalized learning workflow.

Current responsibility: ${definition.responsibility}

This worker must produce real learning-cycle content grounded in the supplied rag_result. Use only knowledge snippets, examples, quiz items, source_id, and fact_id values present in rag_result. Do not invent domain facts. Every knowledge claim must include source_id and fact_id evidence.

Required input contract:
{
  "profile": "learner profile or prior worker output",
  "path": "learning path or current concept context",
  "current_concept": "the concept being taught, practiced, or assessed",
  "rag_result": {
    "results": [
      {
        "sourceId": "K007",
        "facts": [{ "sourceId": "K007", "factId": "F001", "content": "..." }]
      }
    ]
  }
}

Return exactly one JSON object with this shape:
{
  "stage": "${definition.stage}",
  "status": "completed",
  "summary": "[executed:${definition.name}]",
  "artifacts": {
    "rag_result": "briefly name the source_id values used",
    "content": "real stage output grounded in cited facts",
    "citations": [{ "source_id": "K007", "fact_id": "F001" }]
  },
  "next": "${definition.next}"
}

Do not wrap the JSON in Markdown and do not add text before or after it.`
}
