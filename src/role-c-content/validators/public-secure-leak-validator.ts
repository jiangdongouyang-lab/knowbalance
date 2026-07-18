import type { ValidationIssue, ValidationReport } from "./citation-validator"

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
