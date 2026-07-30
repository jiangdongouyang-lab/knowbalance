export const ROLE_C_HTTP_TIMEOUT_MS = 120_000

export class RoleCHttpTimeoutError extends Error {
  constructor() {
    super("ROLE_C_HTTP_TIMEOUT")
    this.name = "RoleCHttpTimeoutError"
  }
}

export async function fetchRoleCWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = ROLE_C_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    timeoutMs,
  )
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new RoleCHttpTimeoutError()
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
