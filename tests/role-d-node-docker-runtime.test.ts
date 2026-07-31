import { describe, expect, test } from "bun:test"
import type { DockerCommandExecutor, DockerCommandRequest } from "../src/role-c-content"
import { createRoleDNodeDockerRunner } from "../src/role-d-ui/vite.config"

describe("Role D Node Docker runtime", () => {
  test("creates C's Docker runner without relying on the Bun global", async () => {
    const digest = `sha256:${"a".repeat(64)}`
    const executor: DockerCommandExecutor = {
      async run(request: DockerCommandRequest) {
        expect(request.command).toBe("docker")
        expect(request.args).toEqual(["image", "inspect", "knowbalance-role-c-python-runner:1.0.0"])
        return {
          exit_code: 0,
          stdout: JSON.stringify([{
            Id: digest,
            Config: { Labels: { "io.knowbalance.role-c.runner": "1" } },
          }]),
          stderr: "",
          timed_out: false,
          output_truncated: false,
        }
      },
    }

    const runner = await createRoleDNodeDockerRunner({
      ROLE_C_DOCKER_BINARY: "docker",
      ROLE_C_DOCKER_IMAGE: "knowbalance-role-c-python-runner:1.0.0",
    }, executor)

    expect(runner.runner_image_digest).toBe(digest)
  })
})
