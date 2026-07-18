export interface CodeExecutionRequest {
  language: "python"
  code: string
  test_suite_id: string
  timeout_ms: number
  memory_mb: number
  max_output_bytes: number
  network_allowed: false
}

export interface CodeExecutionResult {
  status: "passed" | "failed" | "timeout" | "runner_error"
  passed_tests: number
  total_tests: number
  score_ratio: number
  failure_codes: string[]
  runner_image_digest: string
}

/** Must be backed by a separate no-network container/VM. Never implement with Node vm or host shell. */
export interface CodeRunner {
  execute(request: CodeExecutionRequest): Promise<CodeExecutionResult>
}

export class CodeRunnerUnavailableError extends Error {
  constructor(message = "未配置隔离 CodeRunner，暂时无法对学习者代码给出可信判分") {
    super(message)
    this.name = "CodeRunnerUnavailableError"
  }
}
