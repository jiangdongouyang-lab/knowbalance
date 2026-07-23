import type { RoleDSession, WorkflowEventView } from "./types"

export function applyWorkflowEvent(session: RoleDSession, event: WorkflowEventView): RoleDSession {
  const existingIndex = session.workflow.findIndex((item) => item.id === event.id)
  const workflow = existingIndex < 0
    ? [...session.workflow, event]
    : session.workflow.map((item, index) => index === existingIndex ? event : item)

  return {
    ...session,
    eventMode: "live",
    updatedAt: new Date().toISOString(),
    workflow,
  }
}
