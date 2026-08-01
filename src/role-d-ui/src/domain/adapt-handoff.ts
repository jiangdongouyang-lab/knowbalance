import { normalizeUnifiedHandoff } from "../../../contracts/unified"
import type { RoleDSession } from "./types"

type LooseRecord = Record<string, any>

/**
 * Role D compatibility entrypoint.
 *
 * A/B/C/D payloads are normalized by the repository-wide unified boundary;
 * callers can keep the historical adaptHandoff name while consuming schema 1.0.
 */
export function adaptHandoff(input: LooseRecord): RoleDSession {
  return normalizeUnifiedHandoff(input)
}
