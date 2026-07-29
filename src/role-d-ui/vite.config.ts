import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"
import { generateRoleCForRoleDWithRuntime, submitRoleCAssessment } from "../role-d-integration/role-c-service"
import type { GenerateRoleCForRoleDInput } from "../role-d-integration/contracts"
import type { SubmitRoleCAssessmentInput } from "../role-d-integration/role-c-service"

export default defineConfig({
  root: __dirname,
  plugins: [react(), roleCApiPlugin()],
  build: {
    outDir: resolve(__dirname, "../../dist/role-d-ui"),
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
})

function roleCApiPlugin(): Plugin {
  const middleware = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.url !== "/api/role-c/generate" && request.url !== "/api/role-c/submit") return next()
    if (request.method !== "POST") {
      response.statusCode = 405
      return response.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }))
    }
    try {
      const body = await readJsonBody(request)
      const result = request.url === "/api/role-c/submit"
        ? isRoleCSubmissionRequest(body)
          ? await submitRoleCAssessment(body)
          : (() => { throw new Error("ROLE_C_SUBMISSION_INVALID") })()
        : isRoleCRequest(body)
          ? await generateRoleCForRoleDWithRuntime(body, roleCRuntimeOptions())
          : (() => { throw new Error("ROLE_C_REQUEST_INVALID") })()
      response.statusCode = result.status === "ready" || result.status === "completed" || result.status === "needs_review" ? 200 : 422
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify(result))
    } catch (error) {
      response.statusCode = 500
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "ROLE_C_API_FAILED" }))
    }
  }
  return {
    name: "role-c-local-api",
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

function roleCRuntimeOptions() {
  const providerMode = process.env.ROLE_C_MODEL_ENDPOINT && process.env.ROLE_C_MODEL_ID
    ? "model" as const
    : "deterministic" as const
  return {
    providerMode,
    env: process.env,
    cwd: resolve(__dirname, "../.."),
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.length > 2_000_000) throw new Error("ROLE_C_REQUEST_TOO_LARGE")
  return JSON.parse(text)
}

function isRoleCSubmissionRequest(value: unknown): value is SubmitRoleCAssessmentInput {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.runId === "string" && record.runId.length > 0
    && typeof record.learnerId === "string" && record.learnerId.length > 0
    && typeof record.formId === "string" && record.formId.length > 0
    && typeof record.attemptNo === "number"
    && typeof record.submissionId === "string" && record.submissionId.length > 0
    && Array.isArray(record.answers)
    && record.answers.every(isSubmissionAnswer)
}

function isSubmissionAnswer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const answer = value as Record<string, unknown>
  const responseCount = [answer.selected_option_id, answer.text_response, answer.code_response]
    .filter((entry) => typeof entry === "string").length
  return typeof answer.item_id === "string"
    && (answer.hint_level_used === 0 || answer.hint_level_used === 1 || answer.hint_level_used === 2 || answer.hint_level_used === 3)
    && responseCount === 1
}

function isRoleCRequest(value: unknown): value is GenerateRoleCForRoleDInput {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.runId === "string"
    && record.runId.length > 0
    && typeof record.kbVersion === "string"
    && record.profile !== null
    && typeof record.profile === "object"
    && record.ragResult !== null
    && typeof record.ragResult === "object"
}