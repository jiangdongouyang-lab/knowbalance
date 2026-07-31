import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ROLE_C_RUNTIME_DATA_DIRECTORY,
  resolveRoleCProviderMode,
  resolveRoleCRuntimeDataDirectory,
  resolveRoleCRuntimeEnvironment,
} from "../src/role-d-integration/role-c-runtime-env"
import { resolve } from "node:path"

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

  test("requires an explicit deterministic choice when model settings also exist", () => {
    expect(resolveRoleCProviderMode({})).toBe("unconfigured")
    expect(resolveRoleCProviderMode({
      ROLE_C_PROVIDER_MODE: "deterministic",
      ROLE_C_MODEL_ENDPOINT: "https://example.test/v1/chat/completions",
      ROLE_C_MODEL_ID: "configured-model",
    })).toBe("deterministic")
    expect(resolveRoleCProviderMode({
      ROLE_C_PROVIDER_MODE: "model",
    })).toBe("model")
    expect(() => resolveRoleCProviderMode({
      ROLE_C_PROVIDER_MODE: "automatic",
    })).toThrow("ROLE_C_PROVIDER_MODE 只允许 model 或 deterministic")
  })

  test("resolves a stable Git-ignored default runtime directory and configured overrides", () => {
    const projectDirectory = resolve("/tmp", "knowbalance-project")
    expect(resolveRoleCRuntimeDataDirectory({}, projectDirectory)).toBe(
      resolve(projectDirectory, DEFAULT_ROLE_C_RUNTIME_DATA_DIRECTORY),
    )
    expect(resolveRoleCRuntimeDataDirectory({
      ROLE_C_RUNTIME_DATA_DIR: "runtime/custom-role-c",
    }, projectDirectory)).toBe(resolve(projectDirectory, "runtime/custom-role-c"))
    expect(resolveRoleCRuntimeDataDirectory({
      ROLE_C_RUNTIME_DATA_DIR: resolve("/tmp", "external-role-c-runtime"),
    }, projectDirectory)).toBe(resolve("/tmp", "external-role-c-runtime"))
  })
})
