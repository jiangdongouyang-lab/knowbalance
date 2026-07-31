import { describe, expect, test } from "bun:test"
import {
  resolveRoleCProviderMode,
  resolveRoleCRuntimeEnvironment,
} from "../src/role-d-integration/role-c-runtime-env"

describe("Role D Role C runtime environment", () => {
  test("uses the private Role C env file when Vite's Node child did not inherit Bun --env-file values", () => {
    const env = resolveRoleCRuntimeEnvironment({ PATH: "D:/software/docker-desktop/resources/bin" }, [
      "ROLE_C_MODEL_ENDPOINT=https://api.deepseek.com/chat/completions",
      "ROLE_C_MODEL_ID=deepseek-chat",
      "ROLE_C_MODEL_API_KEY=secret-value",
      "ROLE_C_DOCKER_BINARY=docker",
    ].join("\n"))

    expect(resolveRoleCProviderMode(env)).toBe("model")
    expect(env.ROLE_C_MODEL_ID).toBe("deepseek-chat")
    expect(env.ROLE_C_MODEL_API_KEY).toBe("secret-value")
    expect(env.PATH).toContain("docker-desktop")
  })

  test("keeps explicit process values ahead of private file defaults", () => {
    const env = resolveRoleCRuntimeEnvironment({
      ROLE_C_MODEL_ENDPOINT: "https://override.example/v1/chat/completions",
      ROLE_C_MODEL_ID: "override-model",
    }, [
      "ROLE_C_MODEL_ENDPOINT=https://api.deepseek.com/chat/completions",
      "ROLE_C_MODEL_ID=deepseek-chat",
    ].join("\n"))

    expect(env.ROLE_C_MODEL_ENDPOINT).toContain("override.example")
    expect(env.ROLE_C_MODEL_ID).toBe("override-model")
  })
})
