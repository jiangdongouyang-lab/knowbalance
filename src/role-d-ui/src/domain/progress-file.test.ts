import { describe, expect, test } from "vitest"
import { demoHandoff } from "../data/demo-handoff"
import { adaptHandoff } from "./adapt-handoff"
import { exportProgressJson, importProgressJson } from "./progress-file"

const session = adaptHandoff(demoHandoff)

describe("progress-file", () => {
  test("round-trips a versioned Week 1 progress JSON file", () => {
    const json = exportProgressJson(session, "2026-07-21T15:00:00.000Z")
    const parsed = JSON.parse(json)

    expect(parsed).toMatchObject({
      format: "knowbalance-progress",
      version: 1,
      exportedAt: "2026-07-21T15:00:00.000Z",
    })
    expect(importProgressJson(json)).toEqual({ ok: true, session })
  })

  test.each([
    ["invalid JSON", "not-json"],
    ["wrong format", JSON.stringify({ format: "other", version: 1, session })],
    ["unsupported version", JSON.stringify({ format: "knowbalance-progress", version: 2, session })],
    ["malformed session", JSON.stringify({ format: "knowbalance-progress", version: 1, session: { ...session, retrieval: null } })],
    ["stale citation", JSON.stringify({
      format: "knowbalance-progress",
      version: 1,
      session: {
        ...session,
        artifacts: [{ ...session.artifacts[0], evidenceStatus: "grounded", citations: [{ sourceId: "K404", factId: "F404" }] }],
      },
    })],
  ])("rejects %s without returning a replacement session", (_label, json) => {
    const result = importProgressJson(json)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})
