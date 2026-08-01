import type {
  GenerateRoleCForRoleDInput,
  RoleCForRoleDResult,
} from "../../../role-d-integration/contracts"
import { ROLE_C_API_PATHS } from "../../../role-d-integration/contracts"

export type RoleCContentRequest = GenerateRoleCForRoleDInput

export async function requestRoleCContent(input: RoleCContentRequest): Promise<RoleCForRoleDResult> {
  try {
    const response = await fetch(ROLE_C_API_PATHS.generate, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    const payload = await response.json() as RoleCForRoleDResult | { error?: string }
    if ("status" in payload && (payload.status === "ready" || payload.status === "blocked" || payload.status === "failed")) {
      return payload as RoleCForRoleDResult
    }
    if (!response.ok) {
      return blocked(input.runId, "failed", "error" in payload ? payload.error ?? "Role C 服务调用失败" : "Role C 服务调用失败")
    }
    return payload as RoleCForRoleDResult
  } catch (error) {
    return blocked(input.runId, "failed", error instanceof Error ? error.message : "Role C 服务不可用")
  }
}

function blocked(runId: string, status: "blocked" | "failed", reason: string): RoleCForRoleDResult {
  return { status, artifacts: [], workflow: [], runId, reason }
}
