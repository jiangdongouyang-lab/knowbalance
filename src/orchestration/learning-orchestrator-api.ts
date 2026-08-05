import { join } from "node:path"
import { runLearningOrchestrator } from "./learning-orchestrator-runner"
import {
  InteractiveSessionError,
  InteractiveSessionStore,
  publicSessionView,
  type InteractiveSessionRecord,
} from "./interactive-session"
import type { LearnerRequest, OrchestrationMode } from "./types"

interface RunRequestBody {
  root_dir?: string
  run_id?: string
  session_id?: string
  mode?: OrchestrationMode
  learner_request?: LearnerRequest
}

interface SessionRequestBody {
  session_id?: string
  run_id?: string
  mode?: OrchestrationMode
  learner_request?: LearnerRequest
}

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: string[]
  }
}

export interface LearningOrchestratorApiOptions {
  data_root?: string
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
}

export function createLearningOrchestratorApiHandler(
  options: LearningOrchestratorApiOptions = {},
): (request: Request) => Promise<Response> {
  const dataRoot = options.data_root ?? join(process.cwd(), ".tmp", "orchestrator")
  const sessions = new InteractiveSessionStore(dataRoot)

  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          status: "ok",
          service: "learning-orchestrator",
          endpoints: [
            "GET /health",
            "POST /orchestrator/runs",
            "POST /orchestrator/sessions",
            "GET /orchestrator/sessions/:id",
            "POST /orchestrator/sessions/:id/commands",
            "GET /orchestrator/sessions/:id/events",
          ],
        })
      }

      if (request.method === "POST" && url.pathname === "/orchestrator/runs") {
        const body = await parseJson<RunRequestBody>(request)
        const validationErrors = validateRunRequestBody(body)
        if (validationErrors.length > 0) {
          return errorResponse(400, "INVALID_ORCHESTRATOR_REQUEST", "Invalid learning orchestrator request", validationErrors)
        }

        const result = await runLearningOrchestrator({
          root_dir: dataRoot,
          run_id: body.run_id,
          session_id: body.session_id,
          mode: body.mode!,
          learner_request: body.learner_request!,
        })

        return jsonResponse({
          run_id: result.summary.run_id,
          session_id: result.summary.session_id,
          mode: result.summary.mode,
          status: result.summary.status,
          completed_steps: result.summary.completed_steps,
          total_steps: result.summary.total_steps,
          blocked_stage: result.summary.blocked_stage,
          failed_stage: result.summary.failed_stage,
          summary_json: result.ledger.summary_json_path,
          summary_md: result.ledger.summary_md_path,
          latest_json: result.ledger.latest_json_path,
          latest_md: result.ledger.latest_md_path,
        })
      }

      if (request.method === "POST" && url.pathname === "/orchestrator/sessions") {
        const principal = requirePrincipal(request)
        const body = await parseJson<SessionRequestBody>(request)
        const errors = validateSessionRequestBody(body)
        if (errors.length > 0) {
          return errorResponse(400, "INVALID_SESSION_REQUEST", "Invalid learning orchestrator session request", errors)
        }
        if (body.learner_request!.learner_id !== principal) {
          throw new InteractiveSessionError("LEARNER_IDENTITY_MISMATCH", "Authenticated learner does not match learner_request", 403)
        }
        const record = await sessions.create({
          session_id: body.session_id,
          run_id: body.run_id,
          mode: body.mode!,
          learner_request: body.learner_request!,
          owner_id: principal,
        })
        return jsonResponse(publicSessionView(record), 201)
      }

      const sessionMatch = url.pathname.match(/^\/orchestrator\/sessions\/([A-Za-z0-9_-]+)$/)
      if (request.method === "GET" && sessionMatch) {
        const record = await sessions.load(sessionMatch[1]!)
        assertOwner(record, requirePrincipal(request))
        return jsonResponse(publicSessionView(record))
      }

      const eventsMatch = url.pathname.match(/^\/orchestrator\/sessions\/([A-Za-z0-9_-]+)\/events$/)
      if (request.method === "GET" && eventsMatch) {
        const record = await sessions.load(eventsMatch[1]!)
        assertOwner(record, requirePrincipal(request))
        return jsonResponse({ session_id: record.session_id, events: record.events })
      }

      const commandMatch = url.pathname.match(/^\/orchestrator\/sessions\/([A-Za-z0-9_-]+)\/commands$/)
      if (request.method === "POST" && commandMatch) {
        const record = await sessions.load(commandMatch[1]!)
        assertOwner(record, requirePrincipal(request))
        const command = await parseJson<import("./interactive-session").InteractiveSessionCommand>(request)
        return jsonResponse(await sessions.command(commandMatch[1]!, command))
      }

      return errorResponse(404, "NOT_FOUND", `No learning-orchestrator route for ${request.method} ${url.pathname}`)
    } catch (error) {
      if (error instanceof InteractiveSessionError) {
        return errorResponse(error.http_status, error.code, error.message, error.details)
      }
      if (error instanceof SyntaxError) {
        return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON")
      }
      return errorResponse(500, "ORCHESTRATOR_INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected orchestrator error")
    }
  }
}

export const handleLearningOrchestratorApiRequest = createLearningOrchestratorApiHandler()

export function startLearningOrchestratorApiServer(
  options: { port?: number; hostname?: string; data_root?: string } = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: createLearningOrchestratorApiHandler({ data_root: options.data_root }),
  })
}

function validateRunRequestBody(body: RunRequestBody): string[] {
  const errors: string[] = []
  if (body.mode !== "scaffold" && body.mode !== "deterministic") errors.push("mode must be scaffold or deterministic")
  validateLearnerRequest(body.learner_request, errors)
  return errors
}

function validateSessionRequestBody(body: SessionRequestBody): string[] {
  const errors: string[] = []
  if (body.mode !== "deterministic") errors.push("interactive sessions currently require deterministic mode")
  validateLearnerRequest(body.learner_request, errors)
  return errors
}

function validateLearnerRequest(value: LearnerRequest | undefined, errors: string[]): void {
  if (!value || typeof value !== "object") {
    errors.push("learner_request is required")
  } else if (!value.goal || typeof value.goal !== "string") {
    errors.push("learner_request.goal is required")
  }
}

function requirePrincipal(request: Request): string {
  const authorization = request.headers.get("authorization")
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{1,120})$/)
  if (!match) throw new InteractiveSessionError("UNAUTHENTICATED", "A bearer learner identity is required", 401)
  return match[1]!
}

function assertOwner(record: InteractiveSessionRecord, principal: string): void {
  if (record.owner_id !== principal) throw new InteractiveSessionError("SESSION_FORBIDDEN", "Session belongs to another learner", 403)
}

const MAX_JSON_BODY_BYTES = 1_000_000

async function parseJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") {
    throw new InteractiveSessionError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json", 415)
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new InteractiveSessionError("PAYLOAD_TOO_LARGE", "JSON request body is too large", 413)
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new InteractiveSessionError("PAYLOAD_TOO_LARGE", "JSON request body is too large", 413)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new SyntaxError("invalid JSON") }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractiveSessionError("INVALID_SESSION_REQUEST", "JSON request body must be an object", 400)
  }
  return value as T
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS })
}

function errorResponse(status: number, code: string, message: string, details?: string[]): Response {
  const body: ErrorBody = { error: { code, message, details } }
  return jsonResponse(body, status)
}
