import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { AgentTraceEvent } from "../contracts/learning-evidence-event"
import { validateRoleCSchema } from "../validators/runtime-schema-validator"

export interface AgentTraceStore {
  append(events: AgentTraceEvent[]): Promise<void>
  read(runId: string): Promise<AgentTraceEvent[]>
}

export class InMemoryAgentTraceStore implements AgentTraceStore {
  private readonly byRun = new Map<string, AgentTraceEvent[]>()
  async append(events: AgentTraceEvent[]): Promise<void> {
    for (const event of events) {
      assertTraceSafe(event)
      const prior = this.byRun.get(event.run_id) ?? []
      const last = prior.at(-1)
      if (last && event.seq <= last.seq) throw new Error("TRACE_SEQUENCE_NOT_APPEND_ONLY")
      prior.push(structuredClone(event))
      this.byRun.set(event.run_id, prior)
    }
  }
  async read(runId: string): Promise<AgentTraceEvent[]> { return structuredClone(this.byRun.get(runId) ?? []) }
}

/** One JSONL file per backend deployment; append-only sequence checks happen on read/write. */
export class JsonlAgentTraceStore implements AgentTraceStore {
  constructor(private readonly filePath: string) {}
  async append(events: AgentTraceEvent[]): Promise<void> {
    if (events.length === 0) return
    const existing = await this.readAll()
    const lastByRun = new Map<string, number>()
    existing.forEach((event) => lastByRun.set(event.run_id, Math.max(lastByRun.get(event.run_id) ?? 0, event.seq)))
    for (const event of events) {
      assertTraceSafe(event)
      if (event.seq <= (lastByRun.get(event.run_id) ?? 0)) throw new Error("TRACE_SEQUENCE_NOT_APPEND_ONLY")
      lastByRun.set(event.run_id, event.seq)
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await appendFile(this.filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 })
  }
  async read(runId: string): Promise<AgentTraceEvent[]> { return (await this.readAll()).filter((event) => event.run_id === runId) }
  private async readAll(): Promise<AgentTraceEvent[]> {
    try {
      return (await readFile(this.filePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentTraceEvent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }
}

function assertTraceSafe(event: AgentTraceEvent): void {
  const schema = validateRoleCSchema("agent_trace_event.schema.json", event)
  if (!schema.ok) throw new Error(`INVALID_TRACE_EVENT:${schema.issues.map((entry) => entry.path).join(",")}`)
  const serialized = JSON.stringify(event).toLowerCase()
  for (const forbidden of ["answer_spec", "correct_option_id", "hidden_tests", "reference_solution"]) {
    if (serialized.includes(forbidden)) throw new Error(`TRACE_SECRET_LEAK:${forbidden}`)
  }
}
