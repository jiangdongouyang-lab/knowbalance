import { describe, expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { contentHash } from "../src/role-c-content/contracts/common"
import {
  adaptiveLearningLoopJournalPathMode,
  AtomicFileAdaptiveLearningLoopJournal,
  type AdaptiveLearningLoopJournalEntry,
} from "../src/role-c-content/reliability/adaptive-learning-loop-journal"

describe("Role C adaptive learning loop journal", () => {
  test("persists checkpoints privately and reloads them through a new adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "role-c-adaptive-journal-"))
    try {
      const executionKey = "adaptive-restart-execution"
      const initial = entry(executionKey, 0, {
        phase: "STARTED",
        recovery_operations: {},
      })
      await new AtomicFileAdaptiveLearningLoopJournal({
        root_directory: root,
      }).withExclusive(executionKey, async (transaction) => {
        await transaction.save(initial, undefined)
      })

      const restarted = new AtomicFileAdaptiveLearningLoopJournal({
        root_directory: root,
      })
      await restarted.withExclusive(executionKey, async (transaction) => {
        const loaded = await transaction.load()
        expect(loaded).toEqual(initial)
        const generatedState = {
          phase: "GENERATED",
          candidate_id: "candidate-1",
        }
        await transaction.save({
          ...loaded!,
          revision: 1,
          state_hash: contentHash(generatedState),
          state: generatedState,
        }, 0)
      })

      const replay = await new AtomicFileAdaptiveLearningLoopJournal({
        root_directory: root,
      }).withExclusive(executionKey, (transaction) => transaction.load())
      expect(replay?.revision).toBe(1)
      expect(replay?.state).toEqual({
        phase: "GENERATED",
        candidate_id: "candidate-1",
      })

      const executionDirectory = join(root, "executions")
      const [recordName] = (await readdir(executionDirectory))
        .filter((name) => name.endsWith(".json"))
      expect(recordName).toBeTruthy()
      expectPrivateMode(await adaptiveLearningLoopJournalPathMode(root), "directory")
      expectPrivateMode(
        await adaptiveLearningLoopJournalPathMode(executionDirectory),
        "directory",
      )
      expectPrivateMode(
        await adaptiveLearningLoopJournalPathMode(
          join(executionDirectory, recordName!),
        ),
        "file",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("serializes separate adapters and rejects a tampered checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "role-c-adaptive-lock-"))
    try {
      const executionKey = "adaptive-shared-execution"
      let producers = 0
      const execute = (
        journal: AtomicFileAdaptiveLearningLoopJournal,
      ) => journal.withExclusive(executionKey, async (transaction) => {
        const existing = await transaction.load()
        if (existing) return existing
        producers += 1
        await Bun.sleep(20)
        const created = entry(executionKey, 0, {
          phase: "PUBLISHED",
          producer: producers,
        })
        await transaction.save(created, undefined)
        return created
      })
      const [left, right] = await Promise.all([
        execute(new AtomicFileAdaptiveLearningLoopJournal({
          root_directory: root,
          lock_timeout_ms: 2_000,
        })),
        execute(new AtomicFileAdaptiveLearningLoopJournal({
          root_directory: root,
          lock_timeout_ms: 2_000,
        })),
      ])
      expect(producers).toBe(1)
      expect(right).toEqual(left)

      const executionDirectory = join(root, "executions")
      const [recordName] = (await readdir(executionDirectory))
        .filter((name) => name.endsWith(".json"))
      const recordPath = join(executionDirectory, recordName!)
      const stored = JSON.parse(await readFile(recordPath, "utf8"))
      stored.entry.state = { phase: "STARTED", tampered: true }
      await writeFile(recordPath, JSON.stringify(stored), {
        encoding: "utf8",
        mode: 0o600,
      })
      await expect(
        new AtomicFileAdaptiveLearningLoopJournal({
          root_directory: root,
        }).withExclusive(executionKey, (transaction) => transaction.load()),
      ).rejects.toMatchObject({ code: "INTEGRITY_ERROR" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function expectPrivateMode(mode: number, kind: "directory" | "file"): void {
  if (platform() === "win32") {
    // Windows/MSYS reports POSIX permission bits as read/write masks even after chmod.
    expect([0o700, 0o600, 0o666]).toContain(mode)
    return
  }
  expect(mode).toBe(kind === "directory" ? 0o700 : 0o600)
}

function entry(
  executionKey: string,
  revision: number,
  state: unknown,
): AdaptiveLearningLoopJournalEntry {
  return {
    journal_version: "1.0",
    execution_key: executionKey,
    source_key: "adaptive-source",
    request_hash: "adaptive-request",
    revision,
    state_hash: contentHash(state),
    state: structuredClone(state),
  }
}
