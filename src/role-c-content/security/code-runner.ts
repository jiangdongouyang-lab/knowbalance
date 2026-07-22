import type { ExecutionContract, HiddenTest } from "../contracts/artifacts"
import { analyzePythonSource, PLATFORM_PYTHON_IMPORT_ALLOWLIST } from "./python-static-analyzer"

export interface RunnerTestSuite {
  test_suite_id: string
  execution_contract: ExecutionContract
  tests: HiddenTest[]
}

export interface CodeExecutionRequest {
  language: "python"
  code: string
  test_suite_id: string
  test_suite?: RunnerTestSuite
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

export interface CodeTestSuiteResolver {
  resolve(testSuiteId: string): Promise<RunnerTestSuite | undefined>
}

/** Must be backed by a separate no-network container/VM. Never implement with Node vm or host Python. */
export interface CodeRunner {
  readonly runner_image_digest: string
  execute(request: CodeExecutionRequest): Promise<CodeExecutionResult>
}

/** Retries infrastructure-only runner errors; learner failures/timeouts are never retried as success. */
export async function executeWithRunnerRetry(
  runner: CodeRunner,
  request: CodeExecutionRequest,
  maxToolRetries: number,
): Promise<CodeExecutionResult & { tool_attempts: number }> {
  const retries = Number.isFinite(maxToolRetries)
    ? Math.max(0, Math.min(2, Math.trunc(maxToolRetries)))
    : 0
  let last: CodeExecutionResult | undefined
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    last = await runner.execute(request)
    if (last.status !== "runner_error") return { ...last, tool_attempts: attempt }
  }
  return { ...last!, tool_attempts: retries + 1 }
}

export class CodeRunnerUnavailableError extends Error {
  constructor(message = "未配置隔离 CodeRunner，暂时无法对学习者代码给出可信判分") {
    super(message)
    this.name = "CodeRunnerUnavailableError"
  }
}

export interface ContainerCommandRequest {
  command: string
  args: string[]
  stdin: string
  timeout_ms: number
  max_output_bytes: number
}

export interface ContainerCommandResult {
  exit_code: number | null
  stdout: string
  stderr: string
  timed_out: boolean
  output_truncated: boolean
}

/** Injectable process boundary: tests inspect it without executing learner code. */
export interface ContainerCommandExecutor {
  run(request: ContainerCommandRequest): Promise<ContainerCommandResult>
}

export interface OciPythonCodeRunnerOptions {
  runtime_binary: string
  image: string
  executor?: ContainerCommandExecutor
  test_suite_resolver?: CodeTestSuiteResolver
  cpu_limit?: number
  pids_limit?: number
  tmpfs_mb?: number
}

export function createOciPythonCodeRunnerFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Pick<OciPythonCodeRunnerOptions, "executor" | "test_suite_resolver"> = {},
): OciPythonCodeRunner {
  const runtime = env.ROLE_C_RUNNER_RUNTIME
  const image = env.ROLE_C_RUNNER_IMAGE
  if (!runtime || !image) {
    throw new CodeRunnerUnavailableError("Runner 配置缺失：需要 ROLE_C_RUNNER_RUNTIME 和 digest-pinned ROLE_C_RUNNER_IMAGE")
  }
  return new OciPythonCodeRunner({
    runtime_binary: runtime,
    image,
    cpu_limit: optionalPositiveNumber(env.ROLE_C_RUNNER_CPUS, 0.5),
    pids_limit: optionalPositiveInteger(env.ROLE_C_RUNNER_PIDS, 32),
    tmpfs_mb: optionalPositiveInteger(env.ROLE_C_RUNNER_TMPFS_MB, 16),
    ...overrides,
  })
}

/**
 * Runs Python only inside a digest-pinned OCI image. The container has no network,
 * no capabilities, a read-only root, a non-root user, bounded CPU/memory/PIDs/output,
 * and receives no project mount or host secret.
 */
export class OciPythonCodeRunner implements CodeRunner {
  readonly runner_image_digest: string
  private readonly executor: ContainerCommandExecutor

  constructor(private readonly options: OciPythonCodeRunnerOptions) {
    if (!options.runtime_binary.trim()) throw new CodeRunnerUnavailableError("OCI runtime_binary 不能为空")
    const digest = options.image.match(/@((?:sha256):[a-f0-9]{64})$/)?.[1]
    if (!digest) {
      throw new CodeRunnerUnavailableError("Runner image 必须固定为 image@sha256:<64 hex>，不能使用可变 tag")
    }
    this.runner_image_digest = digest
    this.executor = options.executor ?? new BunContainerCommandExecutor()
  }

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    if (request.language !== "python" || request.network_allowed !== false) {
      return runnerError(this.runner_image_digest, "invalid_runner_policy")
    }
    const suite = request.test_suite ?? await this.options.test_suite_resolver?.resolve(request.test_suite_id)
    if (!suite || suite.test_suite_id !== request.test_suite_id) {
      return runnerError(this.runner_image_digest, "test_suite_unavailable")
    }
    if (suite.execution_contract.language !== "python") {
      return runnerError(this.runner_image_digest, "unsupported_language")
    }
    const staticIssues = analyzePythonSource(request.code, suite.execution_contract)
    if (staticIssues.length > 0) {
      return {
        status: "failed",
        passed_tests: 0,
        total_tests: suite.tests.length,
        score_ratio: 0,
        failure_codes: staticIssues.map((entry) => `static:${entry.code}`),
        runner_image_digest: this.runner_image_digest,
      }
    }
    const timeoutMs = Math.min(request.timeout_ms, suite.execution_contract.resource_limits.timeout_ms)
    const memoryMb = Math.min(request.memory_mb, suite.execution_contract.resource_limits.memory_mb)
    const maxOutputBytes = Math.min(request.max_output_bytes, suite.execution_contract.resource_limits.max_output_bytes)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || !Number.isSafeInteger(memoryMb) || memoryMb < 32) {
      return runnerError(this.runner_image_digest, "invalid_resource_limits")
    }
    const cpuSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const args = [
      "run",
      "--rm",
      "--interactive",
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.options.pids_limit ?? 32),
      "--memory", `${memoryMb}m`,
      "--memory-swap", `${memoryMb}m`,
      "--cpus", String(this.options.cpu_limit ?? 0.5),
      "--ulimit", `cpu=${cpuSeconds}:${cpuSeconds}`,
      "--ulimit", "nofile=64:64",
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${this.options.tmpfs_mb ?? 16}m`,
      "--user", "65534:65534",
      "--workdir", "/tmp",
      "--env", "PYTHONDONTWRITEBYTECODE=1",
      "--env", "PYTHONHASHSEED=0",
      this.options.image,
      "python",
      "-I",
      "-S",
      "-c",
      PYTHON_TEST_HARNESS,
    ]
    const result = await this.executor.run({
      command: this.options.runtime_binary,
      args,
      stdin: JSON.stringify({
        code: request.code,
        execution_contract: suite.execution_contract,
        tests: suite.tests,
        max_output_bytes: maxOutputBytes,
      }),
      timeout_ms: timeoutMs + 1_000,
      max_output_bytes: 64_000,
    })
    if (result.timed_out) {
      return {
        status: "timeout",
        passed_tests: 0,
        total_tests: suite.tests.length,
        score_ratio: 0,
        failure_codes: ["execution_timeout"],
        runner_image_digest: this.runner_image_digest,
      }
    }
    if (result.exit_code !== 0 || result.output_truncated) {
      if ([124, 137, 143].includes(result.exit_code ?? -1)) {
        return {
          status: result.exit_code === 137 ? "failed" : "timeout",
          passed_tests: 0,
          total_tests: suite.tests.length,
          score_ratio: 0,
          failure_codes: [result.exit_code === 137 ? "resource_limit_exceeded" : "execution_timeout"],
          runner_image_digest: this.runner_image_digest,
        }
      }
      return runnerError(this.runner_image_digest, result.output_truncated ? "runner_output_truncated" : "container_failed")
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as Partial<CodeExecutionResult>
      if (!isRunnerPayload(parsed, suite.tests.length)) {
        return runnerError(this.runner_image_digest, "invalid_runner_response")
      }
      return { ...parsed, runner_image_digest: this.runner_image_digest } as CodeExecutionResult
    } catch {
      return runnerError(this.runner_image_digest, "invalid_runner_json")
    }
  }
}

export class BunContainerCommandExecutor implements ContainerCommandExecutor {
  async run(request: ContainerCommandRequest): Promise<ContainerCommandResult> {
    let processHandle: ReturnType<typeof Bun.spawn>
    try {
      processHandle = Bun.spawn([request.command, ...request.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "" },
      })
    } catch (error) {
      return {
        exit_code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : "container runtime unavailable",
        timed_out: false,
        output_truncated: false,
      }
    }
    const stdin = processHandle.stdin
    const stdoutStream = processHandle.stdout
    const stderrStream = processHandle.stderr
    if (!stdin || typeof stdin === "number" || !stdoutStream || typeof stdoutStream === "number" || !stderrStream || typeof stderrStream === "number") {
      processHandle.kill()
      return {
        exit_code: null,
        stdout: "",
        stderr: "container runtime pipes unavailable",
        timed_out: false,
        output_truncated: false,
      }
    }
    stdin.write(request.stdin)
    stdin.end()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      processHandle.kill()
    }, request.timeout_ms)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(stdoutStream).text(),
      new Response(stderrStream).text(),
      processHandle.exited,
    ])
    clearTimeout(timer)
    const stdoutBytes = Buffer.byteLength(stdout)
    const stderrBytes = Buffer.byteLength(stderr)
    const outputTruncated = stdoutBytes + stderrBytes > request.max_output_bytes
    return {
      exit_code: exitCode,
      stdout: outputTruncated ? stdout.slice(0, request.max_output_bytes) : stdout,
      stderr: outputTruncated ? stderr.slice(0, request.max_output_bytes) : stderr,
      timed_out: timedOut,
      output_truncated: outputTruncated,
    }
  }
}

function isRunnerPayload(value: Partial<CodeExecutionResult>, expectedTests: number): boolean {
  const shapeOk = ["passed", "failed", "timeout", "runner_error"].includes(String(value.status)) &&
    Number.isSafeInteger(value.passed_tests) &&
    value.total_tests === expectedTests &&
    typeof value.score_ratio === "number" &&
    value.score_ratio >= 0 && value.score_ratio <= 1 &&
    Array.isArray(value.failure_codes) && value.failure_codes.every((entry) => typeof entry === "string")
  if (!shapeOk) return false
  if (value.status === "passed") return value.passed_tests === expectedTests && value.score_ratio === 1 && value.failure_codes!.length === 0
  if (value.status === "failed") return value.passed_tests! < expectedTests && value.score_ratio! < 1 && value.failure_codes!.length > 0
  if (value.status === "timeout") return value.score_ratio === 0 && value.failure_codes!.length > 0
  return false
}

function runnerError(digest: string, code: string): CodeExecutionResult {
  return {
    status: "runner_error",
    passed_tests: 0,
    total_tests: 0,
    score_ratio: 0,
    failure_codes: [code],
    runner_image_digest: digest,
  }
}

function optionalPositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new CodeRunnerUnavailableError("Runner 数值配置必须大于 0")
  return parsed
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = optionalPositiveNumber(value, fallback)
  if (!Number.isSafeInteger(parsed)) throw new CodeRunnerUnavailableError("Runner 整数配置必须为正整数")
  return parsed
}

const PYTHON_TEST_HARNESS = String.raw`
import contextlib
import ast
import io
import json
import math
import sys

payload = json.loads(sys.stdin.read())
code = payload["code"]
contract = payload["execution_contract"]
tests = payload["tests"]
limit = int(payload["max_output_bytes"])

class OutputLimitExceeded(Exception):
    pass

class LimitedWriter(io.TextIOBase):
    def __init__(self, byte_limit):
        self.byte_limit = byte_limit
        self.byte_count = 0
        self.parts = []
    def write(self, value):
        encoded = str(value).encode("utf-8")
        self.byte_count += len(encoded)
        if self.byte_count > self.byte_limit:
            raise OutputLimitExceeded()
        self.parts.append(str(value))
        return len(value)
    def getvalue(self):
        return "".join(self.parts)

def matches(actual, expected, comparison):
    if comparison["kind"] == "numeric":
        if isinstance(actual, bool) or not isinstance(actual, (int, float)):
            return False
        if isinstance(expected, bool) or not isinstance(expected, (int, float)):
            return False
        tolerance = max(
            float(comparison["abs_tolerance"]),
            abs(float(expected)) * float(comparison["rel_tolerance"]),
        )
        return math.isfinite(float(actual)) and abs(float(actual) - float(expected)) <= tolerance
    return actual == expected

compiled = None
compile_error = False
policy_error = False
try:
    tree = ast.parse(code, "submission.py", "exec")
    platform_allowed = set(${JSON.stringify(PLATFORM_PYTHON_IMPORT_ALLOWLIST)})
    allowed = {name.split(".")[0] for name in contract.get("allowed_imports", [])} & platform_allowed
    never_allowed = {"builtins", "ctypes", "importlib", "inspect", "marshal", "multiprocessing", "os", "pathlib", "pickle", "resource", "shutil", "signal", "socket", "subprocess", "sys", "threading"}
    blocked_calls = {"eval", "exec", "compile", "open", "breakpoint", "__import__", "globals", "locals", "vars", "getattr", "setattr", "delattr", "memoryview"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = {alias.name.split(".")[0] for alias in node.names}
            if any(root in never_allowed or root not in allowed for root in roots):
                policy_error = True
        if isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in never_allowed or root not in allowed:
                policy_error = True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in blocked_calls:
            policy_error = True
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            policy_error = True
    compiled = compile(tree, "submission.py", "exec")
except BaseException:
    compile_error = True

passed = 0
passed_weight = 0.0
total_weight = sum(float(test["weight"]) for test in tests)
failures = []

for test in tests:
    test_id = test["test_id"]
    if policy_error:
        failures.append(test_id + ":static_policy")
        continue
    if compile_error:
        failures.append(test_id + ":syntax_error")
        continue
    writer = LimitedWriter(limit)
    namespace = {"__name__": "__submission__"}
    try:
        with contextlib.redirect_stdout(writer), contextlib.redirect_stderr(writer):
            if contract["execution_mode"] == "function":
                exec(compiled, namespace, namespace)
                fn = namespace.get(contract.get("entry_point"))
                if not callable(fn):
                    raise LookupError("entry_point_missing")
                test_input = test.get("input")
                if isinstance(test_input, dict) and "args" in test_input:
                    actual = fn(*test_input.get("args", []), **test_input.get("kwargs", {}))
                else:
                    actual = fn(test_input)
            else:
                old_stdin = sys.stdin
                sys.stdin = io.StringIO(str(test.get("input", "")))
                try:
                    exec(compiled, namespace, namespace)
                finally:
                    sys.stdin = old_stdin
                actual = writer.getvalue()
        if matches(actual, test.get("expected"), test["comparison"]):
            passed += 1
            passed_weight += float(test["weight"])
        else:
            failures.append(test_id + ":assertion_failed")
    except OutputLimitExceeded:
        failures.append(test_id + ":output_limit")
    except BaseException as error:
        failures.append(test_id + ":runtime_" + type(error).__name__)

ratio = 0.0 if total_weight <= 0 else passed_weight / total_weight
print(json.dumps({
    "status": "passed" if passed == len(tests) else "failed",
    "passed_tests": passed,
    "total_tests": len(tests),
    "score_ratio": max(0.0, min(1.0, ratio)),
    "failure_codes": failures,
}))
`
