import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export class InteractiveSessionRepository {
  private readonly commandQueues = new Map<string, Promise<unknown>>()

  constructor(readonly data_root: string) {}

  sessionPath(sessionId: string): string {
    return join(this.data_root, "sessions", safeSessionId(sessionId), "state.json")
  }

  async loadJson<T>(sessionId: string): Promise<T> {
    return JSON.parse(await readFile(this.sessionPath(sessionId), "utf8")) as T
  }

  async loadOptionalJson<T>(sessionId: string): Promise<T | null> {
    try {
      return await this.loadJson<T>(sessionId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  async saveJson(sessionId: string, value: unknown): Promise<void> {
    const path = this.sessionPath(sessionId)
    await mkdir(join(this.data_root, "sessions", safeSessionId(sessionId)), { recursive: true })
    await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(`${path}.tmp`, path)
  }

  async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const safe = safeSessionId(sessionId)
    const previous = this.commandQueues.get(safe) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(operation)
    this.commandQueues.set(safe, queued)
    try {
      return await queued
    } finally {
      if (this.commandQueues.get(safe) === queued) this.commandQueues.delete(safe)
    }
  }

  async withFileLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const safe = safeSessionId(sessionId)
    const dir = join(this.data_root, "sessions", safe)
    const lockPath = join(dir, ".lock")
    await mkdir(dir, { recursive: true })
    let handle: import("node:fs/promises").FileHandle | null = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        handle = await open(lockPath, "wx")
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    if (!handle) throw new Error(`Unable to acquire session lock ${safe}`)
    try {
      return await operation()
    } finally {
      await handle.close()
      await rm(lockPath, { force: true })
    }
  }
}

export function safeSessionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new Error("session_id may only contain letters, numbers, _ and -")
  }
  return value
}
