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
  const publicLearnerText = publicStrings.join("\n")
  const joinedPublicCode = normalizeCode(publicStrings.join("\n"))
  const normalizedStarter = normalizeCode(publicPayload.starter_code)
  const normalizedReference = normalizeCode(securePayload.reference_solution)

  if (normalizedReference && (
    publicStrings.some((value) =>
      normalizeCode(value).includes(normalizedReference))
    || joinedPublicCode.includes(normalizedReference)
    || containsDispersedCodeSecret(
      publicStrings,
      normalizedReference,
      normalizedStarter,
    )
  )) {
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
    if (containsValueSecret(publicStrings, publicLearnerText, test.input)
      || publicPayload.public_tests.some(
        (publicTest) => sameJsonValue(publicTest.input, test.input),
      )) {
      issues.push(issue(
        "hidden_test_input_leak",
        "$.public",
        `公开产物包含隐藏测试 ${test.test_id} 的输入值`,
      ))
    }
    if (containsExpectedSecret(
      publicStrings,
      publicLearnerText,
      test.expected,
    )) {
      issues.push(issue(
        "hidden_test_expected_leak",
        "$.public",
        `公开产物包含隐藏测试 ${test.test_id} 的预期值`,
      ))
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
  const publicLearnerText = publicStrings.join("\n")
  const joinedPublicCode = normalizeCode(publicStrings.join("\n"))
  const publicItems = new Map(
    publicPayload.items.map((item) => [item.item_id, item]),
  )
  for (const secureItem of securePayload.items) {
    const publicItem = publicItems.get(secureItem.item_id)
    if (!publicItem) continue
    const answerTokens: string[] = []
    if (secureItem.correct_option_id) {
      answerTokens.push(secureItem.correct_option_id)
      const correctOption = publicItem.options?.find(
        (option) => option.option_id === secureItem.correct_option_id,
      )
      if (correctOption) {
        answerTokens.push(correctOption.label, correctOption.text)
      }
    } else if (secureItem.answer_spec.kind === "numeric") {
      answerTokens.push(String(secureItem.answer_spec.target))
    } else if (secureItem.answer_spec.kind === "exact_set") {
      answerTokens.push(...secureItem.answer_spec.accepted)
    }
    if (
      secureItem.correct_option_id
        && containsLiteralToken(
          publicItem.prompt,
          secureItem.correct_option_id,
        )
      || containsExplicitAnswerRelation(publicItem.prompt, answerTokens)
    ) {
      issues.push(issue(
        "explicit_answer_leak",
        `$.items.${secureItem.item_id}.prompt`,
        "公开题干直接说明了正确答案",
      ))
    }
  }
  for (const suite of securePayload.code_test_suites) {
    if (publicText.includes(suite.test_suite_id)) {
      issues.push(issue("test_suite_id_leak", "$.public", `公开测评包含私有测试套件 ${suite.test_suite_id}`))
    }
    const reference = normalizeCode(suite.reference_solution)
    if (reference && (
      publicStrings.some((value) => normalizeCode(value).includes(reference))
      || joinedPublicCode.includes(reference)
      || containsDispersedCodeSecret(
        publicStrings,
        reference,
        normalizeCode(
          publicPayload.items
            .map((item) => item.starter_code ?? "")
            .join("\n"),
        ),
      )
    )) {
      issues.push(issue("reference_solution_leak", "$.public", `公开测评包含测试套件 ${suite.test_suite_id} 的参考实现`))
    }
    for (const test of suite.hidden_tests) {
      if (publicText.includes(test.test_id)) {
        issues.push(issue("hidden_test_id_leak", "$.public", `公开测评包含隐藏测试 ID ${test.test_id}`))
      }
      if (containsValueSecret(
        publicStrings,
        publicLearnerText,
        test.input,
      )) {
        issues.push(issue(
          "hidden_test_input_leak",
          "$.public",
          `公开测评包含隐藏测试 ${test.test_id} 的输入值`,
        ))
      }
      if (containsExpectedSecret(
        publicStrings,
        publicLearnerText,
        test.expected,
      )) {
        issues.push(issue(
          "hidden_test_expected_leak",
          "$.public",
          `公开测评包含隐藏测试 ${test.test_id} 的预期值`,
        ))
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
  if (typeof value === "string") {
    if (value.toLowerCase().includes("secure://role-c/")) {
      issues.push(issue("secure_ref_leak", path, "公开产物包含私有引用"))
    }
    return
  }
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

function containsStructuredSecret(
  publicText: string,
  value: unknown,
): boolean {
  if (!Array.isArray(value)
    && (!value || typeof value !== "object")) return false
  const serialized = JSON.stringify(value).replace(/\s+/g, "")
  return serialized.length >= 4
    && publicText.replace(/\s+/g, "").includes(serialized)
}

function containsValueSecret(
  publicStrings: string[],
  publicText: string,
  value: unknown,
): boolean {
  if (containsStructuredSecret(publicText, value)) return true
  const scalarSequence = flattenScalarTokens(value)
    .map(normalizeSemanticText)
    .join("")
  if (scalarSequence.length < 3) return false
  return publicStrings.some((text) =>
    normalizeSemanticText(text).includes(scalarSequence))
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function containsExpectedSecret(
  publicStrings: string[],
  publicText: string,
  value: unknown,
): boolean {
  if (typeof value === "string" && value.trim().length >= 8
    && publicText.toLocaleLowerCase().includes(
      JSON.stringify(value).slice(1, -1).toLocaleLowerCase(),
    )) {
    return true
  }
  const tokens = flattenScalarTokens(value)
    .map(normalizeSemanticText)
    .filter(Boolean)
  if (tokens.length === 0) return false
  const secret = tokens.join("")
  if (secret.length === 0) return false
  return publicStrings.some((text) => {
    const compact = normalizeSemanticText(text)
    if (!compact.includes(secret)) return false
    return [
      "输出",
      "结果",
      "返回",
      "预期",
      "应为",
      "等于",
      "满分",
      "output",
      "result",
      "return",
      "expected",
      "equals",
    ].some((marker) => compact.includes(normalizeSemanticText(marker)))
  })
}

function containsExplicitAnswerRelation(
  text: string,
  tokens: string[],
): boolean {
  const compact = text.normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "")
  return tokens
    .map((token) => token.normalize("NFKC").toLocaleLowerCase().trim())
    .filter(Boolean)
    .some((token) => {
      const escaped = escapeRegExp(token)
      const boundary = `(?![a-z0-9_])`
      return [
        `正确答案(?:是|为|选)?(?:选项)?${escaped}${boundary}`,
        `正确选项(?:id)?(?:是|为|选)?${escaped}${boundary}`,
        `答案(?:是|为|选)?(?:选项)?${escaped}${boundary}`,
        `应选(?:择)?(?:选项)?${escaped}${boundary}`,
        `correct(?:answer|option)(?:is|:|=)?${escaped}${boundary}`,
        `answer(?:is|:|=)${escaped}${boundary}`,
        `(?:评分器|判分器|系统|grader).*?(?:接受|认可|匹配|accepts?).*?${escaped}${boundary}`,
        `(?:选择|提交|填写|select|submit).*?${escaped}${boundary}.*?(?:满分|得分|通过|正确|fullscore|pass|correct)`,
        `${escaped}${boundary}.*?(?:会|可|将)?(?:获得|得到|判为|算作|gets?).*?(?:满分|得分|通过|正确|fullscore|pass|correct)`,
      ].some((pattern) => new RegExp(pattern, "u").test(compact))
    })
}

function containsLiteralToken(text: string, token: string): boolean {
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase()
  const normalizedToken = token.normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
  if (!normalizedToken) return false
  const escaped = escapeRegExp(normalizedToken)
  const needsBoundary = /^[a-z0-9_-]+$/u.test(normalizedToken)
  return new RegExp(
    `${needsBoundary ? "(?<![a-z0-9_-])" : ""}${escaped}${needsBoundary ? "(?![a-z0-9_-])" : ""}`,
    "u",
  ).test(normalizedText)
}

function containsDispersedCodeSecret(
  publicStrings: string[],
  normalizedReference: string,
  normalizedAllowedCode: string,
): boolean {
  const reference = normalizedReference.slice(0, 4_000)
  if (reference.length < 8) return false
  const candidates = publicStrings
    .map(normalizeCode)
    .filter((value) => value.length >= 8)
  if (normalizedAllowedCode.length >= 8) {
    candidates.push(normalizedAllowedCode)
  }
  if (candidates.length === 0) return false

  const reachable = new Uint8Array(reference.length + 1)
  reachable[0] = 1
  for (let start = 0; start < reference.length; start += 1) {
    if (reachable[start] !== 1) continue
    for (
      let end = start + 8;
      end <= reference.length;
      end += 1
    ) {
      const fragment = reference.slice(start, end)
      if (candidates.some((candidate) =>
        candidate.includes(fragment))) {
        reachable[end] = 1
      }
    }
  }
  return reachable[reference.length] === 1
}

function flattenScalarTokens(value: unknown): string[] {
  if (value === null) return ["null"]
  if (
    typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
  ) {
    return [String(value)]
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenScalarTokens)
  }
  if (!value || typeof value !== "object") return []
  return Object.values(value as Record<string, unknown>)
    .flatMap(flattenScalarTokens)
}

function normalizeSemanticText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: "critical" }
}
