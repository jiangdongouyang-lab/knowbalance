import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { WorkerName } from "./types"

export interface LearnerMemorySnapshot {
  schema_version: "1.0"
  learner_id: string
  mastery_by_source_id: Record<string, number>
  mastered_source_ids: string[]
  weak_source_ids: string[]
  completed_sessions: string[]
  recent_errors: Array<{ source_id: string; pattern: string; count: number }>
  updated_at: string
}

export type PersistenceEvent =
  | {
      event_type: "mastery_update"
      source: WorkerName | "learning-orchestrator"
      source_id: string
      mastery: number
      evidence: string
    }
  | {
      event_type: "learned_user_fact"
      source: WorkerName | "learning-orchestrator"
      key: string
      value: string
      evidence: string
    }
  | {
      event_type: "session_completed"
      source: WorkerName | "learning-orchestrator"
      session_id: string
      summary: string
    }

export interface MemorySummaryForProfile {
  claimed_known: string[]
  claimed_weak: string[]
  quotes: Array<{ field: string; text: string }>
}

export async function loadLearnerMemory(rootDir: string, learnerId: string): Promise<LearnerMemorySnapshot> {
  try {
    return JSON.parse(await readFile(memoryPath(rootDir, learnerId), "utf8")) as LearnerMemorySnapshot
  } catch {
    return emptyMemory(learnerId)
  }
}

export async function saveLearnerMemory(rootDir: string, snapshot: LearnerMemorySnapshot): Promise<string> {
  const dir = join(rootDir, "learner-memory")
  await mkdir(dir, { recursive: true })
  const path = memoryPath(rootDir, snapshot.learner_id)
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
  return path
}

export function appendPersistenceEvents(
  snapshot: LearnerMemorySnapshot,
  events: PersistenceEvent[],
  now = new Date().toISOString(),
): LearnerMemorySnapshot {
  const next = structuredClone(snapshot)
  for (const event of events) {
    if (event.event_type === "mastery_update") {
      const mastery = clamp(event.mastery)
      next.mastery_by_source_id[event.source_id] = mastery
    }
    if (event.event_type === "session_completed" && !next.completed_sessions.includes(event.session_id)) {
      next.completed_sessions.push(event.session_id)
    }
  }
  next.mastered_source_ids = Object.entries(next.mastery_by_source_id)
    .filter(([, mastery]) => mastery >= 0.8)
    .map(([sourceId]) => sourceId)
    .sort()
  next.weak_source_ids = Object.entries(next.mastery_by_source_id)
    .filter(([, mastery]) => mastery <= 0.4)
    .map(([sourceId]) => sourceId)
    .sort()
  next.updated_at = now
  return next
}

export function memorySummaryForProfile(snapshot: LearnerMemorySnapshot): MemorySummaryForProfile {
  return {
    claimed_known: [...snapshot.mastered_source_ids],
    claimed_weak: [...snapshot.weak_source_ids],
    quotes: [{ field: "learner_memory", text: `learner memory ${snapshot.learner_id}: mastered=${snapshot.mastered_source_ids.join(",")}; weak=${snapshot.weak_source_ids.join(",")}` }],
  }
}

export function memoryPath(rootDir: string, learnerId: string): string {
  return join(rootDir, "learner-memory", `${safeLearnerId(learnerId)}.json`)
}

function emptyMemory(learnerId: string): LearnerMemorySnapshot {
  return {
    schema_version: "1.0",
    learner_id: learnerId,
    mastery_by_source_id: {},
    mastered_source_ids: [],
    weak_source_ids: [],
    completed_sessions: [],
    recent_errors: [],
    updated_at: "",
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function safeLearnerId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}
