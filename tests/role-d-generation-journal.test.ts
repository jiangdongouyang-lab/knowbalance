import { describe, expect, test } from "bun:test"
import {
  SingleFlightRunJournal,
} from "../src/role-d-integration/single-flight-run-journal"

describe("Role D local generation single-flight journal", () => {
  test("shares one binding and generation across concurrent retries", async () => {
    const journal =
      new SingleFlightRunJournal<{ id: number }, { values: string[] }>()
    let bindingCount = 0
    let generationCount = 0
    let resolveGeneration:
      ((value: { values: string[] }) => void) | undefined
    const pending = new Promise<{ values: string[] }>((resolve) => {
      resolveGeneration = resolve
    })
    const execution = {
      runId: "RUN-SINGLE-FLIGHT",
      requestHash: "HASH-1",
      createBinding: () => ({ id: ++bindingCount }),
      generate: async (binding: { id: number }) => {
        generationCount += 1
        expect(binding.id).toBe(1)
        return pending
      },
    }

    const first = journal.execute(execution)
    const second = journal.execute(execution)
    await Promise.resolve()
    expect(bindingCount).toBe(1)
    expect(generationCount).toBe(1)
    resolveGeneration?.({ values: ["ready"] })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult).not.toBe(secondResult)
    firstResult.values.push("caller mutation")
    expect(await journal.execute(execution)).toEqual({
      values: ["ready"],
    })
    expect(generationCount).toBe(1)
  })

  test("rejects a conflicting run and permits retry after failure", async () => {
    const journal =
      new SingleFlightRunJournal<{ id: number }, { ok: true }>()
    let bindingCount = 0
    let shouldFail = true
    const base = {
      runId: "RUN-RETRY",
      requestHash: "HASH-1",
      createBinding: () => ({ id: ++bindingCount }),
      generate: async () => {
        if (shouldFail) throw new Error("temporary")
        return { ok: true as const }
      },
    }

    await expect(journal.execute(base)).rejects.toThrow("temporary")
    shouldFail = false
    expect(await journal.execute(base)).toEqual({ ok: true })
    expect(bindingCount).toBe(2)
    await expect(journal.execute({
      ...base,
      requestHash: "HASH-CONFLICT",
    })).rejects.toThrow("ROLE_B_GENERATION_RUN_CONFLICT")
  })

  test("does not retain a resolved result rejected by the caller policy", async () => {
    const journal =
      new SingleFlightRunJournal<object, { status: "blocked" | "ready" }>()
    let calls = 0
    const execution = {
      runId: "RUN-RESOLVED-RETRY",
      requestHash: "HASH-RESOLVED-RETRY",
      createBinding: () => ({}),
      generate: async () => ({
        status: ++calls === 1 ? "blocked" as const : "ready" as const,
      }),
      shouldRetainResult: (
        result: { status: "blocked" | "ready" },
      ) => result.status === "ready",
    }

    expect(await journal.execute(execution)).toEqual({
      status: "blocked",
    })
    expect(await journal.execute(execution)).toEqual({
      status: "ready",
    })
    expect(await journal.execute(execution)).toEqual({
      status: "ready",
    })
    expect(calls).toBe(2)
  })
})
