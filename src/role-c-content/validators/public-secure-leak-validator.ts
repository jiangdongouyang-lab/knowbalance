import type { ValidationIssue, ValidationReport } from "./citation-validator"
import type {
  AssessmentPublicPayload,
  AssessmentSecurePayload,
  CodeLabPublicPayload,
  CodeLabSecurePayload,
} from "../contracts/artifacts"

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "answer",
  "answer_spec",
  "correct_answer",
  "correct_option_id",
  "hidden_test",
  "hidden_tests",
  "reference_solution",
  "solution",
  "scoring_groups",
  "misconception_by_option",
  "option_order_seed",
])

export function validatePublicArtifactNoSecrets(value: unknown): ValidationReport {
  const issues: ValidationIssue[] = []
  visit(value, "$", issues)
  return { ok: issues.length === 0, issues }
}

/** Checks value-level leaks that key-name scanning cannot detect. */
export function validateCodeLabPublicSecureSeparation(
  publicPayload: CodeLabPublicPayload,
  securePayload: CodeLabSecurePayload,
): ValidationReport {
  const issues = [...validatePublicArtifactNoSecrets(publicPayload).issues]
  const publicText = JSON.stringify(publicPayload)
  const publicStrings = collectStrings(publicPayload)
  const normalizedStarter = normalizeCode(publicPayload.starter_code)
  const normalizedReference = normalizeCode(securePayload.reference_solution)

  if (normalizedReference && publicStrings.some((value) => normalizeCode(value).includes(normalizedReference))) {
    issues.push(issue("reference_solution_leak", "$.public", "公开产物包含完整参考实现内容"))
  }
  if (normalizedStarter && normalizedStarter === normalizedReference) {
    issues.push(issue("starter_equals_reference", "$.starter_code", "starter code 与参考实现等价"))
  }
  if (publicText.includes(securePayload.test_suite_id)) {
    issues.push(issue("test_suite_id_leak", "$.public", "公开产物包含私有 test_suite_id"))
  }
  for (const test of securePayload.hidden_tests) {
    if (publicText.includes(test.test_id)) {
      issues.push(issue("hidden_test_id_leak", "$.public", `公开产物包含隐藏测试 ID ${test.test_id}`))
    }
  }
  for (const mutation of securePayload.mutation_variants) {
    const normalizedMutation = normalizeCode(mutation.code)
    if (normalizedMutation && publicStrings.some((value) => normalizeCode(value).includes(normalizedMutation))) {
      issues.push(issue("mutation_code_leak", "$.public", `公开产物包含错误变体 ${mutation.mutation_id}`))
    }
  }
  return { ok: issues.length === 0, issues }
}

/** Assessment option IDs are public by design; only answer relationships and test material are secret. */
export function validateAssessmentPublicSecureSeparation(
  publicPayload: AssessmentPublicPayload,
  securePayload: AssessmentSecurePayload,
): ValidationReport {
  const issues = [...validatePublicArtifactNoSecrets(publicPayload).issues]
  const publicText = JSON.stringify(publicPayload)
  const publicStrings = collectStrings(publicPayload)
  for (const suite of securePayload.code_test_suites) {
    if (publicText.includes(suite.test_suite_id)) {
      issues.push(issue("test_suite_id_leak", "$.public", `公开测评包含私有测试套件 ${suite.test_suite_id}`))
    }
    const reference = normalizeCode(suite.reference_solution)
    if (reference && publicStrings.some((value) => normalizeCode(value).includes(reference))) {
      issues.push(issue("reference_solution_leak", "$.public", `公开测评包含测试套件 ${suite.test_suite_id} 的参考实现`))
    }
    for (const test of suite.hidden_tests) {
      if (publicText.includes(test.test_id)) {
        issues.push(issue("hidden_test_id_leak", "$.public", `公开测评包含隐藏测试 ID ${test.test_id}`))
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

function collectStrings(value: unknown): string[] {
  const strings: string[] = []
  visitValue(value)
  return strings

  function visitValue(current: unknown): void {
    if (typeof current === "string") {
      strings.push(current)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visitValue)
      return
    }
    if (!current || typeof current !== "object") return
    Object.values(current as Record<string, unknown>).forEach(visitValue)
  }
}

function visit(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`, issues))
    return
  }
  if (!value || typeof value !== "object") return

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase()
    const childPath = `${path}.${key}`
    if (FORBIDDEN_PUBLIC_KEYS.has(normalizedKey)) {
      issues.push({
        code: "public_secure_leak",
        path: childPath,
        message: `公开产物包含私有字段 ${key}`,
        severity: "critical",
      })
    }
    visit(child, childPath, issues)
  }
}

function normalizeCode(value: string): string {
  return value.replace(/#[^\n]*/g, "").replace(/\s+/g, "").trim()
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: "critical" }
}
