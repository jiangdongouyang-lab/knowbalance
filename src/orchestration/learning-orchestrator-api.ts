import { join } from "node:path"
import { runLearningOrchestrator } from "./learning-orchestrator-runner"
import type { LearnerRequest, OrchestrationMode } from "./types"

interface RunRequestBody {
  root_dir?: string
  run_id?: string
  session_id?: string
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

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

export async function handleLearningOrchestratorApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      status: "ok",
      service: "learning-orchestrator",
      endpoints: ["GET /health", "POST /orchestrator/runs"],
    })
  }

  if (request.method === "POST" && url.pathname === "/orchestrator/runs") {
    let body: RunRequestBody
    try {
      body = await request.json()
    } catch {
      return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON")
    }

    const validationErrors = validateRunRequestBody(body)
    if (validationErrors.length > 0) {
      return errorResponse(400, "INVALID_ORCHESTRATOR_REQUEST", "Invalid learning orchestrator request", validationErrors)
    }

    const result = await runLearningOrchestrator({
      root_dir: body.root_dir ?? join(process.cwd(), ".tmp", "orchestrator"),
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

  return errorResponse(404, "NOT_FOUND", `No learning-orchestrator route for ${request.method} ${url.pathname}`)
}

export function startLearningOrchestratorApiServer(options: { port?: number; hostname?: string } = {}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: options.port ?? 8787,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: handleLearningOrchestratorApiRequest,
  })
}

function validateRunRequestBody(body: RunRequestBody): string[] {
  const errors: string[] = []
  if (body.mode !== "scaffold" && body.mode !== "deterministic") {
    errors.push("mode must be scaffold or deterministic")
  }
  if (!body.learner_request || typeof body.learner_request !== "object") {
    errors.push("learner_request is required")
  } else {
    if (!body.learner_request.goal || typeof body.learner_request.goal !== "string") {
      errors.push("learner_request.goal is required")
    }
  }
  return errors
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS,
  })
}

function errorResponse(status: number, code: string, message: string, details?: string[]): Response {
  const body: ErrorBody = { error: { code, message, details } }
  return jsonResponse(body, status)
}
