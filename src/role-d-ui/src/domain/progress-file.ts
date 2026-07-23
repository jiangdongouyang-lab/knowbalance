import { isValidRoleDSession } from "./session-store"
import type { RoleDSession } from "./types"

const PROGRESS_FORMAT = "knowbalance-progress"
const PROGRESS_VERSION = 1

interface ProgressFile {
  format: typeof PROGRESS_FORMAT
  version: typeof PROGRESS_VERSION
  exportedAt: string
  session: RoleDSession
}

export type ProgressImportResult =
  | { ok: true; session: RoleDSession }
  | { ok: false; error: string }

export function exportProgressJson(session: RoleDSession, exportedAt = new Date().toISOString()): string {
  const progress: ProgressFile = {
    format: PROGRESS_FORMAT,
    version: PROGRESS_VERSION,
    exportedAt,
    session,
  }
  return JSON.stringify(progress, null, 2)
}

export function importProgressJson(json: string): ProgressImportResult {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, error: "文件不是有效的 JSON。" }
  }
  if (!isRecord(value) || value.format !== PROGRESS_FORMAT) {
    return { ok: false, error: "这不是 KnowBalance 进度文件。" }
  }
  if (value.version !== PROGRESS_VERSION) {
    return { ok: false, error: "进度文件版本不兼容。" }
  }
  if (typeof value.exportedAt !== "string" || !isValidRoleDSession(value.session)) {
    return { ok: false, error: "进度文件内容损坏或字段不完整。" }
  }
  return { ok: true, session: value.session }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}