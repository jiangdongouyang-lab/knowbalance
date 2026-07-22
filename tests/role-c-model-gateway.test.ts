import { describe, expect, test } from "bun:test"
import {
  createRoleCModelGatewayFromEnv,
  ModelProviderUnavailableError,
  OpenAICompatibleModelGateway,
} from "../src/role-c-content"

const request = {
  task: "role-c.test",
  system_prompt: "system-only policy",
  input: { data: "untrusted learner text" },
  output_schema_id: "role_c_test",
  output_schema: {
    type: "object",
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
    additionalProperties: false,
  },
  temperature: 0,
  max_tokens: 100,
  idempotency_key: "IDEMP-TEST",
}

describe("role C OpenAI-compatible model gateway", () => {
  test("sends strict structured-output requests without putting data in the system prompt", async () => {
    let captured: RequestInit | undefined
    const usageEvents: unknown[] = []
    const gateway = new OpenAICompatibleModelGateway({
      endpoint: "https://model.invalid/chat/completions",
      api_key: "secret-key",
      model: "test-model",
      thinking: "disabled",
      max_transport_retries: 0,
      fetch_impl: async (_input, init) => {
        captured = init
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })
      },
      on_usage: (event) => usageEvents.push(event),
    })

    await expect(gateway.generateStructured<{ ok: boolean }>(request)).resolves.toEqual({ ok: true })
    const body = JSON.parse(String(captured?.body))
    expect(body.messages[0]).toEqual({ role: "system", content: "system-only policy" })
    expect(body.messages[1].content).toContain("untrusted learner text")
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.response_format.json_schema.schema).toEqual(request.output_schema)
    expect(body.thinking).toEqual({ type: "disabled" })
    expect(new Headers(captured?.headers).get("authorization")).toBe("Bearer secret-key")
    expect(new Headers(captured?.headers).get("idempotency-key")).toBe("IDEMP-TEST")
    expect(usageEvents).toHaveLength(1)
    expect(gateway.model_config_hash).not.toContain("secret-key")
  })

  test("retries transient HTTP failures within the configured bound", async () => {
    let calls = 0
    const gateway = new OpenAICompatibleModelGateway({
      endpoint: "https://model.invalid/chat/completions",
      model: "test-model",
      max_transport_retries: 1,
      fetch_impl: async () => {
        calls += 1
        return calls === 1
          ? new Response("temporary", { status: 503 })
          : Response.json({ choices: [{ message: { content: "{\"ok\":true}" } }] })
      },
    })

    await expect(gateway.generateStructured<{ ok: boolean }>(request)).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  test("retries transport failures and accepts fenced JSON in content arrays", async () => {
    let calls = 0
    let capturedBody: Record<string, unknown> | undefined
    const gateway = new OpenAICompatibleModelGateway({
      endpoint: "https://model.invalid/chat/completions",
      model: "test-model",
      response_format: "json_object",
      max_transport_retries: 1,
      fetch_impl: async (_input, init) => {
        calls += 1
        if (calls === 1) throw new TypeError("connection reset with private network detail")
        capturedBody = JSON.parse(String(init?.body))
        return Response.json({ choices: [{ message: { content: [{ type: "text", text: "```json\n{\"ok\":true}\n```" }] } }] })
      },
    })
    await expect(gateway.generateStructured<{ ok: boolean }>(request)).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(JSON.stringify(capturedBody)).toContain("不得自创字段名")
    expect(JSON.stringify(capturedBody)).toContain('\\\"required\\\":[\\\"ok\\\"]')
  })

  test("reports length-truncated structured output without a futile transport retry", async () => {
    let calls = 0
    const usageEvents: unknown[] = []
    const gateway = new OpenAICompatibleModelGateway({
      endpoint: "https://model.invalid/chat/completions",
      model: "test-model",
      max_transport_retries: 2,
      fetch_impl: async () => {
        calls += 1
        return Response.json({
          choices: [{ finish_reason: "length", message: { content: "{\"ok\":" } }],
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
        })
      },
      on_usage: (event) => usageEvents.push(event),
    })
    await expect(gateway.generateStructured(request)).rejects.toThrow("token 上限")
    expect(calls).toBe(1)
    expect(usageEvents).toHaveLength(1)
  })

  test("bounds retry and timeout configuration before any request is sent", () => {
    expect(() => new OpenAICompatibleModelGateway({
      endpoint: "https://model.invalid/chat/completions", model: "m", max_transport_retries: 100,
    })).toThrow("0..5")
    expect(() => createRoleCModelGatewayFromEnv({
      ROLE_C_MODEL_ENDPOINT: "https://model.invalid/chat/completions",
      ROLE_C_MODEL_ID: "m",
      ROLE_C_MODEL_TIMEOUT_MS: "1",
    })).toThrow("100..600000")
    expect(() => createRoleCModelGatewayFromEnv({
      ROLE_C_MODEL_ENDPOINT: "https://model.invalid/chat/completions",
      ROLE_C_MODEL_ID: "m",
      ROLE_C_MODEL_THINKING: "sometimes",
    })).toThrow("enabled 或 disabled")
  })

  test("requires explicit environment configuration and never supplies a hidden default model", () => {
    expect(() => createRoleCModelGatewayFromEnv({})).toThrow(ModelProviderUnavailableError)
    const gateway = createRoleCModelGatewayFromEnv({
      ROLE_C_MODEL_ENDPOINT: "https://model.invalid/chat/completions",
      ROLE_C_MODEL_ID: "configured-model",
      ROLE_C_MODEL_API_KEY: "configured-key",
      ROLE_C_MODEL_TIMEOUT_MS: "15000",
      ROLE_C_MODEL_MAX_RETRIES: "1",
    })
    expect(gateway.model_id).toBe("configured-model")
  })
})
