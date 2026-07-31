import type { WorkflowEventView } from "./types"

export function arrangeWorkflowForDisplay(events: WorkflowEventView[]): WorkflowEventView[] {
  const normalized = events.map(normalizeEvent)
  const terminalConcept = [...normalized].reverse().find((event: WorkflowEventView) =>
    event.agent === "concept-tutor" && event.status === "blocked")
  const arranged = terminalConcept
    ? normalized.filter((event) => !(event.agent === "concept-tutor" && event.status === "running"))
    : normalized
  for (let index = 0; index < arranged.length - 1; index += 1) {
    if (arranged[index]!.stage === "定制讲义生成" && arranged[index + 1]!.stage === "定制讲义准备") {
      const current = arranged[index]!
      arranged[index] = arranged[index + 1]!
      arranged[index + 1] = current
      index += 1
    }
  }
  return arranged
}

function normalizeEvent(event: WorkflowEventView): WorkflowEventView {
  if (event.agent === "concept-tutor") {
    if (event.status === "blocked") return { ...event, stage: "定制讲义受阻" }
    if (event.summary.includes("讲义产物已就绪")) return { ...event, stage: "定制讲义准备" }
    if (event.summary.includes("开始生成讲义")) return { ...event, stage: "定制讲义生成" }
  }
  if (event.stage === "审核恢复" && event.status === "blocked") {
    return { ...event, agent: "C recovery-loop", stage: "审核恢复受阻" }
  }
  return event
}