import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"
import { generateRoleCForRoleD } from "../role-d-integration/role-c-service"
import type { GenerateRoleCForRoleDInput } from "../role-d-integration/contracts"

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
    if (request.url !== "/api/role-c/generate") return next()
    if (request.method !== "POST") {
      response.statusCode = 405
      return response.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }))
    }
    try {
      const body = await readJsonBody(request)
      if (!isRoleCRequest(body)) throw new Error("ROLE_C_REQUEST_INVALID")
      const result = await generateRoleCForRoleD(body)
      response.statusCode = result.status === "ready" ? 200 : 422
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.length > 2_000_000) throw new Error("ROLE_C_REQUEST_TOO_LARGE")
  return JSON.parse(text)
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