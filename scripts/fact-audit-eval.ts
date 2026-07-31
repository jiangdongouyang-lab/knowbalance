import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { auditGeneratedContent, auditGeneratedContentWithSemantic, type SemanticAuditPort } from "../src/fact-audit/auditor"
import { LlmSemanticAuditJudge } from "../src/fact-audit/semantic-llm-judge"
import { OpenAICompatibleModelGateway } from "../src/role-c-content/contracts/model-gateway"
import { retrieveKnowledge } from "../src/rag/retriever"

const fixturePath = join("tests", "fixtures", "fact-audit-eval", "cases.json")
const useLlmJudge = process.argv.includes("--llm-judge")
const raw = await readFile(fixturePath, "utf8")
const suite = JSON.parse(raw) as {
  suite_id: string
  description: string
  cases: Array<{
    case_id: string
    category: string
    expected_status: "pass" | "revise" | "reject"
    semantic_verdict?: "supported" | "unsupported" | "uncertain"
    artifact: { artifactId: string; blocks: Array<{ blockId: string; text: string; citations: Array<{ source_id: string; fact_id: string; relation?: string }> }> }
  }>
}

const semanticAuditPort = useLlmJudge ? createLlmJudgeFromEnv() : null
const ragResult = await retrieveKnowledge({
  query: "初学者，不会循环，需要完成成绩统计程序",
  learnerLevel: "beginner",
  topK: 3,
})

const summary = {
  suite_id: suite.suite_id,
  judge_mode: useLlmJudge ? "llm" : "fixture",
  judge_model: useLlmJudge ? process.env.ROLE_A_JUDGE_MODEL_ID ?? null : null,
  total_cases: suite.cases.length,
  pass: 0,
  revise: 0,
  reject: 0,
  category_counts: {} as Record<string, number>,
  mismatches: [] as Array<{ case_id: string; expected_status: string; actual_status: string }>,
  semantic_cases: 0,
  semantic_unsupported: 0,
  semantic_mutation_rejected: 0,
  metrics: {
    accuracy: 0,
    hallucination_recall: 0,
    false_reject_rate: 0,
    unsupported_leak_rate: 0,
    semantic_mutation_caught: 0,
  },
}

for (const item of suite.cases) {
  summary.category_counts[item.category] = (summary.category_counts[item.category] ?? 0) + 1
  const input = {
    artifactId: item.artifact.artifactId,
    ragResult,
    generatedContent: { blocks: item.artifact.blocks.map((block) => ({
      blockId: block.blockId,
      text: block.text,
      citations: block.citations.map((citation) => ({ source_id: citation.source_id, fact_id: citation.fact_id })),
    })) },
  }

  const shouldRunSemantic = item.semantic_verdict || useLlmJudge
  const audit = shouldRunSemantic
    ? await auditGeneratedContentWithSemantic({
        input,
        semanticAuditPort: semanticAuditPort ?? fixtureSemanticAuditPort(item.semantic_verdict),
      })
    : auditGeneratedContent(input)

  summary[audit.status] += 1
  if (shouldRunSemantic) {
    summary.semantic_cases += 1
    if (audit.status === "reject") summary.semantic_unsupported += 1
    if (item.category === "semantic_mutation" && audit.status === "reject") summary.semantic_mutation_rejected += 1
  }
  if (audit.status !== item.expected_status) {
    summary.mismatches.push({ case_id: item.case_id, expected_status: item.expected_status, actual_status: audit.status })
  }
}

const correct = suite.cases.length - summary.mismatches.length
const problematic = suite.cases.filter((item) => item.expected_status !== "pass")
const leaked = suite.cases.filter((item) => {
  const mismatch = summary.mismatches.find((entry) => entry.case_id === item.case_id)
  return item.expected_status !== "pass" && mismatch?.actual_status === "pass"
})
const falseRejected = suite.cases.filter((item) => {
  const mismatch = summary.mismatches.find((entry) => entry.case_id === item.case_id)
  return item.expected_status === "pass" && mismatch && mismatch.actual_status !== "pass"
})
const semanticMutations = suite.cases.filter((item) => item.category === "semantic_mutation")

summary.metrics = {
  accuracy: ratio(correct, suite.cases.length),
  hallucination_recall: ratio(problematic.length - leaked.length, problematic.length),
  false_reject_rate: ratio(falseRejected.length, suite.cases.filter((item) => item.expected_status === "pass").length),
  unsupported_leak_rate: ratio(leaked.length, problematic.length),
  semantic_mutation_caught: ratio(summary.semantic_mutation_rejected, semanticMutations.length),
}

console.log(JSON.stringify(summary, null, 2))

function createLlmJudgeFromEnv(): SemanticAuditPort {
  const endpoint = process.env.ROLE_A_JUDGE_ENDPOINT
  const model = process.env.ROLE_A_JUDGE_MODEL_ID
  const apiKey = process.env.ROLE_A_JUDGE_API_KEY
  if (!endpoint || !model || !apiKey) {
    throw new Error("LLM Judge 配置缺失：需要 ROLE_A_JUDGE_ENDPOINT、ROLE_A_JUDGE_MODEL_ID、ROLE_A_JUDGE_API_KEY")
  }
  return new LlmSemanticAuditJudge(new OpenAICompatibleModelGateway({
    endpoint,
    model,
    api_key: apiKey,
    response_format: responseFormatFromEnv(process.env.ROLE_A_JUDGE_RESPONSE_FORMAT),
    schema_strict: process.env.ROLE_A_JUDGE_SCHEMA_STRICT !== "false",
    auth_scheme: process.env.ROLE_A_JUDGE_AUTH_SCHEME ?? "Bearer",
    timeout_ms: positiveInteger(process.env.ROLE_A_JUDGE_TIMEOUT_MS, 60_000),
    max_transport_retries: nonNegativeInteger(process.env.ROLE_A_JUDGE_MAX_RETRIES, 1),
  }))
}

function fixtureSemanticAuditPort(verdict: "supported" | "unsupported" | "uncertain" = "supported"): SemanticAuditPort {
  return {
    async auditClaim() {
      if (verdict === "supported") return { verdict: "supported", confidence: 0.99, reason: "fixture semantic support" }
      if (verdict === "unsupported") return { verdict: "unsupported", confidence: 0.99, reason: "fixture semantic rejection" }
      return { verdict: "uncertain", confidence: 0.5, reason: "fixture semantic uncertainty" }
    },
  }
}

function responseFormatFromEnv(value: string | undefined): "json_schema" | "json_object" | "text_json" {
  if (!value) return "json_object"
  if (value === "json_schema" || value === "json_object" || value === "text_json") return value
  throw new Error("ROLE_A_JUDGE_RESPONSE_FORMAT 必须为 json_schema、json_object 或 text_json")
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 600_000) throw new Error("ROLE_A_JUDGE_TIMEOUT_MS 必须为 100..600000 的整数")
  return parsed
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 5) throw new Error("ROLE_A_JUDGE_MAX_RETRIES 必须为 0..5 的整数")
  return parsed
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Number((numerator / denominator).toFixed(4))
}
