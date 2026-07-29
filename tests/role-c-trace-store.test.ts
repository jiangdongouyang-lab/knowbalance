import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentTraceEvent } from "../src/role-c-content"
import {
  InMemoryAgentTraceStore,
  JsonlAgentTraceStore,
} from "../src/role-c-content"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe("Role C JSONL trace persistence", () => {
  test("serializes concurrent writers and rejects a duplicate sequence", async () => {
    const path = await tracePath()
    const first = new JsonlAgentTraceStore(path)
    const second = new JsonlAgentTraceStore(path)

    const writes = await Promise.allSettled([
      first.append([traceEvent(1)]),
      second.append([traceEvent(1)]),
    ])

    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await first.read("RUN-TRACE-1")).toEqual([traceEvent(1)])
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1)
  })

  test("validates persisted events and strict per-run ordering on read", async () => {
    const path = await tracePath()
    await writeFile(
      path,
      `${JSON.stringify(traceEvent(2))}\n${JSON.stringify(traceEvent(1))}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
    const store = new JsonlAgentTraceStore(path)

    await expect(store.read("RUN-TRACE-1")).rejects.toThrow(
      "TRACE_SEQUENCE_NOT_APPEND_ONLY",
    )
  })

  test("reports malformed JSON instead of returning a partial trace", async () => {
    const path = await tracePath()
    await writeFile(path, `${JSON.stringify(traceEvent(1))}\n{broken\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    const store = new JsonlAgentTraceStore(path)

    await expect(store.read("RUN-TRACE-1")).rejects.toThrow(
      "INVALID_TRACE_JSON_LINE:2",
    )
  })
})

describe("Role C in-memory trace persistence", () => {
  test("rejects an invalid batch without retaining its valid prefix", async () => {
    const store = new InMemoryAgentTraceStore()

    await expect(store.append([traceEvent(1), traceEvent(1)]))
      .rejects.toThrow("TRACE_SEQUENCE_NOT_APPEND_ONLY")

    expect(await store.read("RUN-TRACE-1")).toEqual([])
  })
})

function traceEvent(seq: number): AgentTraceEvent {
  return {
    schema_version: "1.0",
    seq,
    event_type: "c.agent.ready",
    run_id: "RUN-TRACE-1",
    agent: "concept-tutor",
    status: "success",
    input_refs: ["SPEC-TRACE-1"],
    output_ref: `ART-TRACE-${seq}`,
    summary: "内容生成完成",
  }
}

async function tracePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "role-c-trace-"))
  temporaryDirectories.push(directory)
  return join(directory, "traces.jsonl")
}
