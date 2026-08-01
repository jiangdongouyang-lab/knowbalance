import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { resolve, join } from "node:path"
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"
import { generateRoleCForRoleDWithRuntime, submitRoleCAssessment } from "../role-d-integration/role-c-service"
import type { GenerateRoleCForRoleDInput } from "../role-d-integration/contracts"
import type { SubmitRoleCAssessmentInput } from "../role-d-integration/role-c-service"
import {
  resolveRoleCProviderMode,
  resolveRoleCRuntimeDataDirectory,
  resolveRoleCRuntimeEnvironment,
} from "../role-d-integration/role-c-runtime-env"
import {
  createDockerPythonCodeRunnerFromEnv,
  NodeDockerCommandExecutor,
  type CodeRunner,
  type DockerCommandExecutor,
} from "../role-c-content"

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
      if (request.url === "/api/role-c/submit" && !isRoleCSubmissionRequest(body)) {
        return sendError(response, 400, "ROLE_C_SUBMISSION_INVALID")
      }
      if (request.url === "/api/role-c/generate" && !isRoleCRequest(body)) {
        return sendError(response, 400, "ROLE_C_REQUEST_INVALID")
      }
      const result = request.url === "/api/role-c/submit"
        ? await submitRoleCAssessment(
            body as SubmitRoleCAssessmentInput,
            roleCRuntimeOptions(),
          )
        : await generateRoleCForRoleDWithRuntime(
            body as GenerateRoleCForRoleDInput,
            roleCRuntimeOptions(),
          )
      response.statusCode = result.status === "ready" || result.status === "completed" || result.status === "needs_review" ? 200 : 422
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.end(JSON.stringify(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : "ROLE_C_API_FAILED"
      const status = error instanceof SyntaxError || message === "ROLE_C_REQUEST_TOO_LARGE"
        ? message === "ROLE_C_REQUEST_TOO_LARGE" ? 413 : 400
        : 500
      sendError(response, status, message)
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

function sendError(
  response: ServerResponse,
  status: number,
  error: string,
): void {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.end(JSON.stringify({ error }))
}

function roleCRuntimeOptions() {
  const projectDirectory = resolve(__dirname, "../..")
  const envFile = join(projectDirectory, ".env.role-c.local")
  let privateEnv = ""
  try { privateEnv = readFileSync(envFile, "utf8") } catch { /* optional local env */ }
  const env = resolveRoleCRuntimeEnvironment(process.env, privateEnv)
  const providerMode = resolveRoleCProviderMode(env)
  return {
    providerMode,
    allowDeterministicFallback:
      env.ROLE_C_PROVIDER_MODE?.trim().toLocaleLowerCase() === "deterministic",
    env,
    cwd: projectDirectory,
    dataDirectory: resolveRoleCRuntimeDataDirectory(env, projectDirectory),
    dockerRunnerFactory: createRoleDNodeDockerRunner,
  }
}

export async function createRoleDNodeDockerRunner(
  env: Record<string, string | undefined> = process.env,
  executor?: DockerCommandExecutor,
): Promise<CodeRunner> {
  return createDockerPythonCodeRunnerFromEnv(env, {
    executor: executor ?? new NodeDockerCommandExecutor(),
  })
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
  if (!isRecord(value)) return false
  const record = value
  return typeof record.runId === "string"
    && record.runId.length > 0
    && typeof record.kbVersion === "string"
    && record.kbVersion.length > 0
    && isLearnerProfile(record.profile)
    && isRagResult(record.ragResult)
    && isLearningPathNode(record.pathNode)
}

function isLearnerProfile(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.learner_id === "string"
    && ["beginner", "basic", "intermediate", "integrated"].includes(
      String(value.level),
    )
    && isStringArray(value.known_concepts)
    && isStringArray(value.weak_concepts)
    && typeof value.goal === "string"
}

function isRagResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.query === "string"
    && Number.isSafeInteger(value.topK)
    && Array.isArray(value.results)
    && value.results.every(isRagResultItem)
}

function isRagResultItem(value: unknown): boolean {
  if (!isRecord(value)) return false
  const sourceId = value.sourceId ?? value.source_id
  if (typeof sourceId !== "string" || sourceId.length === 0) return false
  if (!Array.isArray(value.facts) || !value.facts.every((fact) =>
    isRecord(fact)
      && typeof (fact.sourceId ?? fact.source_id) === "string"
      && typeof (fact.factId ?? fact.fact_id) === "string"
      && typeof fact.content === "string")) return false
  return typeof value.title === "string"
    && ["beginner", "basic", "intermediate", "integrated"].includes(
      String(value.difficulty),
    )
    && typeof value.score === "number"
    && typeof value.reason === "string"
    && typeof value.snippet === "string"
    && Array.isArray(value.examples)
    && isStringArray(value.practiceTasks)
    && Array.isArray(value.quizItems)
    && typeof value.file === "string"
    && isRetrievalTrace(value.retrievalTrace)
}

function isRetrievalTrace(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.scoreBreakdown)) return false
  const scoreBreakdown = value.scoreBreakdown
  return isStringArray(value.matchedKeywords)
    && isStringArray(value.matchedFields)
    && typeof value.difficultyMatch === "boolean"
    && ["keyword", "title", "facts", "practiceTasks", "difficulty", "bonus"]
      .every((key) => typeof scoreBreakdown[key] === "number")
}

function isLearningPathNode(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.assessment_blueprint)) return false
  const blueprint = value.assessment_blueprint
  return value.schema_version === "1.0"
    && typeof value.node_id === "string"
    && isStringArray(value.target_source_ids)
    && isStringArray(value.prerequisite_source_ids)
    && typeof value.goal === "string"
    && Array.isArray(value.objectives)
    && value.objectives.every((objective) =>
      isRecord(objective)
        && typeof objective.objective_id === "string"
        && typeof objective.source_id === "string"
        && isStringArray(objective.required_fact_ids)
        && ["recognize", "explain", "trace", "apply", "debug", "create"]
          .includes(String(objective.observable_behavior))
        && ["core", "supporting"].includes(String(objective.importance)))
    && ["tier_1_count", "tier_2_count", "tier_3_count"].every((key) =>
      Number.isSafeInteger(blueprint[key]))
    && isStringArray(blueprint.required_modalities)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}
