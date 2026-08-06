import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { runLearningOrchestrator } from "./learning-orchestrator-runner"
import {
  InteractiveSessionError,
  InteractiveSessionStore,
  publicSessionView,
  type InteractiveSessionRecord,
} from "./interactive-session"
import { validateOrchestratorApiBody, type RunRequestBody, type SessionRequestBody } from "./orchestrator-api-schema"

interface ErrorBody {
  error: {
    code: string
    message: string
    details?: string[]
  }
}

interface LocalProviderConfiguration {
  provider_mode: "model"
  endpoint: string
  model_id: string
  api_key: string
}

export interface LearningOrchestratorApiOptions {
  data_root?: string
  provider_config_path?: string
  provider_environment?: Record<string, string | undefined>
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
}

export function createLearningOrchestratorApiHandler(
  options: LearningOrchestratorApiOptions = {},
): (request: Request) => Promise<Response> {
  const dataRoot = options.data_root ?? join(process.cwd(), ".tmp", "orchestrator")
  const providerConfigPath = options.provider_config_path ?? join(dataRoot, "provider-config.json")
  const providerEnvironment = options.provider_environment ?? process.env
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
            "GET /orchestrator/provider-config",
            "PUT /orchestrator/provider-config",
            "POST /orchestrator/runs",
            "POST /orchestrator/sessions",
            "GET /orchestrator/sessions/:id",
            "POST /orchestrator/sessions/:id/commands",
            "GET /orchestrator/sessions/:id/events",
          ],
        })
      }

      if (url.pathname === "/orchestrator/provider-config") {
        requireLoopback(request)
        if (request.method === "GET") {
          const config = await readProviderConfiguration(providerConfigPath, providerEnvironment)
          return jsonResponse(providerPublicView(config))
        }
        if (request.method === "PUT") {
          const body = await parseJson<Record<string, unknown>>(request)
          const config = validateProviderConfiguration(body)
          await saveProviderConfiguration(providerConfigPath, config)
          applyProviderConfiguration(config, providerEnvironment)
          return jsonResponse(providerPublicView(config))
        }
      }

      if (request.method === "POST" && url.pathname === "/orchestrator/runs") {
        const body = await parseJson<RunRequestBody>(request)
        const validation = validateOrchestratorApiBody("run", body)
        if (!validation.ok) {
          return errorResponse(400, "INVALID_ORCHESTRATOR_REQUEST", "Invalid learning orchestrator request", validation.errors)
        }

        const result = await runLearningOrchestrator({
          root_dir: dataRoot,
          run_id: validation.value.run_id,
          session_id: validation.value.session_id,
          mode: validation.value.mode!,
          learner_request: validation.value.learner_request!,
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
        const validation = validateOrchestratorApiBody("session", body)
        if (!validation.ok) {
          return errorResponse(400, "INVALID_SESSION_REQUEST", "Invalid learning orchestrator session request", validation.errors)
        }
        if (validation.value.learner_request!.learner_id !== principal) {
          throw new InteractiveSessionError("LEARNER_IDENTITY_MISMATCH", "Authenticated learner does not match learner_request", 403)
        }
        const record = await sessions.create({
          session_id: validation.value.session_id,
          run_id: validation.value.run_id,
          mode: validation.value.mode!,
          learner_request: validation.value.learner_request!,
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
        const body = await parseJson<import("./interactive-session").InteractiveSessionCommand>(request)
        const validation = validateOrchestratorApiBody("command", body)
        if (!validation.ok) {
          return errorResponse(400, "INVALID_COMMAND", "Invalid learning orchestrator command", validation.errors)
        }
        return jsonResponse(await sessions.command(commandMatch[1]!, validation.value))
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
  options: { port?: number; hostname?: string; data_root?: string; provider_config_path?: string } = {},
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: createLearningOrchestratorApiHandler({ data_root: options.data_root, provider_config_path: options.provider_config_path }),
  })
}

function requireLoopback(request: Request): void {
  const hostname = new URL(request.url).hostname.toLowerCase()
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new InteractiveSessionError("LOCAL_CONFIGURATION_ONLY", "Provider configuration is available only on this machine", 403)
  }
}

async function readProviderConfiguration(path: string, environment: Record<string, string | undefined>): Promise<LocalProviderConfiguration | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LocalProviderConfiguration
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const endpoint = environment.ROLE_C_MODEL_ENDPOINT?.trim()
    const modelId = environment.ROLE_C_MODEL_ID?.trim()
    const apiKey = environment.ROLE_C_MODEL_API_KEY?.trim()
    return endpoint && modelId && apiKey ? { provider_mode: "model", endpoint, model_id: modelId, api_key: apiKey } : null
  }
}

function validateProviderConfiguration(body: Record<string, unknown>): LocalProviderConfiguration {
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : ""
  const modelId = typeof body.model_id === "string" ? body.model_id.trim() : ""
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : ""
  if (!endpoint || !modelId || !apiKey) throw new InteractiveSessionError("INVALID_PROVIDER_CONFIGURATION", "endpoint, model_id and api_key are required", 400)
  let parsed: URL
  try { parsed = new URL(endpoint) } catch { throw new InteractiveSessionError("INVALID_PROVIDER_CONFIGURATION", "endpoint must be an absolute http(s) URL", 400) }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new InteractiveSessionError("INVALID_PROVIDER_CONFIGURATION", "endpoint must use http or https", 400)
  return { provider_mode: "model", endpoint, model_id: modelId, api_key: apiKey }
}

async function saveProviderConfiguration(path: string, config: LocalProviderConfiguration): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
}

function applyProviderConfiguration(config: LocalProviderConfiguration, environment: Record<string, string | undefined>): void {
  environment.ROLE_C_PROVIDER_MODE = "model"
  environment.ROLE_C_MODEL_ENDPOINT = config.endpoint
  environment.ROLE_C_MODEL_ID = config.model_id
  environment.ROLE_C_MODEL_API_KEY = config.api_key
}

function providerPublicView(config: LocalProviderConfiguration | null) {
  return { configured: Boolean(config), provider_mode: "model", endpoint: config?.endpoint ?? "", model_id: config?.model_id ?? "" }
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
