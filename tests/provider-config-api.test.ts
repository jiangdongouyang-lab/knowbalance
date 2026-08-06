import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createLearningOrchestratorApiHandler } from "../src/orchestration/learning-orchestrator-api"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("local provider configuration API", () => {
  test("stores a local model configuration without ever returning the API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-config-"))
    roots.push(root)
    const environment: Record<string, string | undefined> = {}
    const handle = createLearningOrchestratorApiHandler({ data_root: root, provider_environment: environment })

    const initial = await handle(new Request("http://127.0.0.1/orchestrator/provider-config"))
    expect(initial.status).toBe(200)
    await expect(initial.json()).resolves.toEqual({
      configured: false,
      provider_mode: "model",
      endpoint: "",
      model_id: "",
    })

    const saved = await handle(new Request("http://127.0.0.1/orchestrator/provider-config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:4175",
      },
      body: JSON.stringify({
        endpoint: "https://api.deepseek.com/chat/completions",
        model_id: "deepseek-chat",
        api_key: "test-secret-that-must-not-return",
      }),
    }))
    expect(saved.status).toBe(200)
    const savedBody = await saved.json() as Record<string, unknown>
    expect(savedBody).toEqual({
      configured: true,
      provider_mode: "model",
      endpoint: "https://api.deepseek.com/chat/completions",
      model_id: "deepseek-chat",
    })
    expect(JSON.stringify(savedBody)).not.toContain("test-secret")
    expect(environment.ROLE_C_MODEL_API_KEY).toBe("test-secret-that-must-not-return")

    const persisted = await readFile(join(root, "provider-config.json"), "utf8")
    expect(persisted).toContain("test-secret-that-must-not-return")
  })

  test("rejects provider changes sent to a non-loopback host", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-config-"))
    roots.push(root)
    const handle = createLearningOrchestratorApiHandler({ data_root: root, provider_environment: {} })
    const response = await handle(new Request("http://example.com/orchestrator/provider-config", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://example.com" },
      body: JSON.stringify({ endpoint: "https://api.example.com/v1/chat/completions", model_id: "model", api_key: "secret" }),
    }))
    expect(response.status).toBe(403)
  })
})
