import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"
import { loadKnowledgeBase } from "../knowledge/loader"
import {
  continueRoleCAfterSubmission,
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessment,
  submitRoleCAssessment,
} from "../role-d-integration/role-c-service"
import {
  isRoleCContinuationHttpRequest,
  type GenerateRoleCForRoleDInput,
  type RoleCForRoleDResult,
  type RoleCContinuationHttpRequest,
} from "../role-d-integration/contracts"
import type {
  RouteRoleCAssessmentInput,
  SubmitRoleCAssessmentInput,
} from "../role-d-integration/role-c-service"
import {
  contentHash,
  createDockerPythonCodeRunnerFromEnv,
  NodeDockerCommandExecutor,
} from "../role-c-content"
import {
  SessionRoleBBridge,
  toRoleCContinuationContextFailure,
  type SessionRoleBGenerationBinding,
} from "../role-d-integration/session-role-b-bridge"
import {
  SingleFlightRunJournal,
} from "../role-d-integration/single-flight-run-journal"

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
  const roleBBridge = loadKnowledgeBase()
    .then((knowledgeBase) => new SessionRoleBBridge(knowledgeBase))
  const generationJournal = new SingleFlightRunJournal<
    SessionRoleBGenerationBinding,
    RoleCForRoleDResult
  >()

  const dispatch = async (url: string, body: unknown) => {
    if (url === "/api/role-c/continue") {
      if (!isRoleCContinueRequest(body)) {
        throw new Error("ROLE_C_CONTINUE_INVALID")
      }
      const bridge = await roleBBridge
      let nextProfileSnapshot
      try {
        nextProfileSnapshot = bridge.getOrFreezeContinuationSnapshot(
          body.sessionId,
          body.submissionId,
          body.learnerId,
        )
      } catch (error) {
        const failure = toRoleCContinuationContextFailure(error)
        if (failure) return failure
        throw error
      }
      const result = await continueRoleCAfterSubmission({
        sessionId: body.sessionId,
        submissionId: body.submissionId,
        learnerId: body.learnerId,
        nextProfileSnapshot,
      })
      if (result.status === "published") {
        bridge.bindPublishedSession(
          body.sessionId,
          result.role_d_handoff.learningSession.sessionId,
          body.learnerId,
        )
      }
      return result
    }
    if (url === "/api/role-c/submit") {
      if (!isRoleCSubmissionRequest(body)) {
        throw new Error("ROLE_C_SUBMISSION_INVALID")
      }
      return submitRoleCAssessment(body)
    }
    if (url === "/api/role-c/route") {
      if (!isRoleCRouteRequest(body)) {
        throw new Error("ROLE_C_ROUTE_INVALID")
      }
      return routeRoleCAssessment(body)
    }
    if (!isRoleCRequest(body)) {
      throw new Error("ROLE_C_REQUEST_INVALID")
    }

    const bridge = await roleBBridge
    const requestHash = contentHash({
      contract: "role-d-local-generate-request-v1",
      input: body,
    })
    return generationJournal.execute({
      runId: body.runId,
      requestHash,
      createBinding: () => bridge.createGenerationBinding({
        learnerIdHash: body.profile.learner_id,
        currentProfile: body.profile,
        profileVersion: `${body.runId}-profile-v1`,
        profileRevision: 1,
      }),
      generate: async (binding) => {
      const result = await generateRoleCForRoleDWithRuntime(
        body,
        {
          ...await roleCRuntimeOptions(),
          learningProgressPort: binding.progressPort,
        },
      )
      if (result.status === "ready") {
        bridge.bindGeneratedSession(
          result.learningSession.sessionId,
          binding,
        )
      }
      return result
      },
      shouldRetainResult: (result) => result.status === "ready",
    })
  }

  const middleware = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (![
      "/api/role-c/generate",
      "/api/role-c/route",
      "/api/role-c/submit",
      "/api/role-c/continue",
    ].includes(request.url ?? "")) return next()
    if (request.method !== "POST") {
      response.statusCode = 405
      return response.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }))
    }
    try {
      const body = await readJsonBody(request)
      const result = await dispatch(request.url!, body)
      response.statusCode = result.status === "ready"
        || result.status === "routed"
        || result.status === "completed"
        || result.status === "needs_review"
        || result.status === "published"
        || result.status === "awaiting_input"
        ? 200
        : 422
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

async function roleCRuntimeOptions() {
  const providerMode = process.env.ROLE_C_MODEL_ENDPOINT && process.env.ROLE_C_MODEL_ID
    ? "model" as const
    : "deterministic" as const
  return {
    providerMode,
    env: process.env,
    cwd: resolve(__dirname, "../.."),
    runner: await createDockerPythonCodeRunnerFromEnv(
      process.env,
      { executor: new NodeDockerCommandExecutor() },
    ),
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

function isRoleCRouteRequest(
  value: unknown,
): value is RouteRoleCAssessmentInput {
  if (!isRoleCSubmissionRequest(value)) return false
  const record = value as unknown as Record<string, unknown>
  return typeof record.routingRequestId === "string"
    && record.routingRequestId.length > 0
}

function isRoleCContinueRequest(
  value: unknown,
): value is RoleCContinuationHttpRequest {
  return isRoleCContinuationHttpRequest(value)
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
