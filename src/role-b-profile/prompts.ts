// 输入: WorkerDefinition（来自 src/agents/workers.ts）
// 输出: B 角色 6 个 worker 的真实 prompt（替换 wiring stub）
// 设计原则:
//   1. 保留 [executed:<name>] 标记与 stage/status/next 信封
//   2. 引文接地: 每个非空字段必须有证据支撑，无证据置 null/空数组，禁止编造
//   3. 确定性轨是唯一可验证实现，LLM 轨是软约束
import type { WorkerDefinition } from "../agents/types"

export const ROLE_B_WORKER_NAMES = [
  "background-collector",
  "self-assessor",
  "objective-diagnostician",
  "profile-builder",
  "path-planner",
  "teaching-auditor",
] as const

export type RoleBWorkerName = (typeof ROLE_B_WORKER_NAMES)[number]

export function isRoleBWorker(name: string): name is RoleBWorkerName {
  return (ROLE_B_WORKER_NAMES as readonly string[]).includes(name)
}

const GROUNDING_RULES = `Grounding rules (anti-hallucination, same discipline as the knowledge-base source_id/fact_id rule):
- Extract only what the learner actually said. Every non-null extracted field must be backed by an entry in "quotes" with the learner's words copied verbatim.
- If the learner did not provide the information, output null (or an empty array). Never guess, never fill defaults, never invent.
- Do not call tools, ask questions, or delegate. Work only with the supplied input.`

const ENVELOPE_RULES = (definition: WorkerDefinition, artifactsShape: string): string => `Return exactly one JSON object with this shape:
{
  "stage": "${definition.stage}",
  "status": "completed",
  "summary": "[executed:${definition.name}]",
  "artifacts": ${artifactsShape},
  "next": "${definition.next}"
}

Do not wrap the JSON in Markdown and do not add text before or after it.`

export function buildRoleBWorkerPrompt(definition: WorkerDefinition): string {
  switch (definition.name) {
    case "background-collector":
      return buildBackgroundCollectorPrompt(definition)
    case "self-assessor":
      return buildSelfAssessorPrompt(definition)
    case "objective-diagnostician":
      return buildObjectiveDiagnosticianPrompt(definition)
    case "profile-builder":
      return buildProfileBuilderPrompt(definition)
    case "path-planner":
      return buildPathPlannerPrompt(definition)
    case "teaching-auditor":
      return buildTeachingAuditorPrompt(definition)
    default:
      throw new Error(`Not a role-B worker: ${definition.name}`)
  }
}

function buildBackgroundCollectorPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in the KnowBalance personalized learning workflow.

Responsibility: extract the learner's background evidence from the learner's own request text.

${GROUNDING_RULES}

Field guide:
- learner_id: an explicit identifier if the learner gave one, else null.
- education_context: grade / major / occupation context, else null.
- prior_languages: programming languages the learner says they used before.
- prior_topics: concept phrases the learner says they were exposed to (keep the learner's wording; downstream code maps them to knowledge-base vocabulary).
- goal_raw: the learning goal in the learner's words. If the goal is missing, set it to null so the orchestrator can ask via its question tool — never fabricate a goal.
- time_budget: available study time if stated, else null.

${ENVELOPE_RULES(
    definition,
    `{
    "evidence_type": "background",
    "learner_id": "string or null",
    "education_context": "string or null",
    "prior_languages": ["string"],
    "prior_topics": ["string"],
    "goal_raw": "string or null",
    "time_budget": "string or null",
    "quotes": [{ "field": "goal_raw", "text": "learner's verbatim words" }]
  }`,
  )}`
}

function buildSelfAssessorPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in the KnowBalance personalized learning workflow.

Responsibility: extract the learner's self-assessment evidence (how the learner rates their own level and which concepts they claim to know or find hard).

${GROUNDING_RULES}

Field guide:
- self_rating: one of "beginner" | "basic" | "intermediate" | "integrated" | null.
- claimed_known: concepts the learner claims to handle (learner's wording).
- claimed_weak: concepts the learner claims to struggle with (learner's wording).

${ENVELOPE_RULES(
    definition,
    `{
    "evidence_type": "self_assessment",
    "self_rating": "beginner | basic | intermediate | integrated | null",
    "claimed_known": ["string"],
    "claimed_weak": ["string"],
    "quotes": [{ "field": "claimed_weak", "text": "learner's verbatim words" }]
  }`,
  )}`
}

function buildObjectiveDiagnosticianPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in the KnowBalance personalized learning workflow.

Responsibility: record objective diagnostic evidence by grading the learner's actual answers against knowledge-base quiz items.

${GROUNDING_RULES}

Diagnosis rules:
- Every diagnosis item must reference a real knowledge-base quiz item with its source_id (K...) and fact_id (F...). Never invent questions, source_id, or fact_id values.
- Grade only answers that actually appear in the supplied input.
- verdict is one of "correct" | "incorrect" | "unanswered".

${ENVELOPE_RULES(
    definition,
    `{
    "evidence_type": "objective_diagnosis",
    "items": [
      {
        "source_id": "K007",
        "fact_id": "F001",
        "question": "the quiz question actually used",
        "learner_answer": "string or null",
        "verdict": "correct | incorrect | unanswered",
        "concept": "循环",
        "difficulty": "beginner"
      }
    ],
    "quotes": [{ "field": "items[0].learner_answer", "text": "learner's verbatim words" }]
  }`,
  )}`
}

function buildProfileBuilderPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in the KnowBalance personalized learning workflow.

Responsibility: merge the three upstream evidence results into the standard learner profile plus a ready-to-send rag_request.

${GROUNDING_RULES}

Merge rules (mirror src/role-b-profile/profile-synthesizer.ts):
1. Evidence strength: objective > self > background.
2. A concept the objective diagnosis marks incorrect goes to weak_concepts even if the learner claimed it as known.
3. Unverified self-claimed weak concepts stay weak.
4. level is conservative: incorrect answer caps level below tested difficulty (floor "beginner").
5. Prefer short knowledge-base style concept words (循环, 列表, 函数).
6. goal comes from background evidence goal_raw. Missing goal → blocked, orchestrator must ask via its question tool.
7. rag_request.query uses four-part format: 学习者水平：…；已掌握：…；薄弱点：…；学习目标：…
8. rag_request.top_k is 5.

${ENVELOPE_RULES(
    definition,
    `{
    "profile": {
      "learner_id": "string",
      "level": "beginner | basic | intermediate | integrated",
      "known_concepts": ["string"],
      "weak_concepts": ["string"],
      "goal": "string"
    },
    "provenance": { "level": { "value": "beginner", "source": "...", "rule": "..." }, "conflicts": [], "unmapped_concepts": [] },
    "rag_request": { "learner_profile": {}, "query": "学习者水平：…", "top_k": 5 }
  }`,
  )}`
}

function buildPathPlannerPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in the KnowBalance personalized learning workflow.

Responsibility: plan a personalized learning path based on the learner profile and knowledge-base evidence from A's RAG retrieval.

Grounding rules:
- Only reference source_id values that appear in the supplied RAG evidence pack. Never invent knowledge-base items.
- Only use prerequisite relationships that exist in the supplied data. Never assume prerequisites.
- If the evidence pack is empty or missing required items, return an empty nodes array — an honest empty path is better than a fabricated one.
- Do not call tools, ask questions, or delegate. Work only with the supplied input.

Rules (mirror src/role-b-profile/teaching-audit/formal-path.ts):
1. Identify which knowledge-base items the learner needs to reach their goal.
2. Exclude items already in known_concepts.
3. Prioritize items in weak_concepts.
4. Respect prerequisite ordering from the knowledge base.
5. Assign sequential stage_order starting from 1 with initial status "pending".
6. Match difficulty to learner level.

${ENVELOPE_RULES(
    definition,
    `{
    "path_type": "formal",
    "nodes": [
      {
        "stage_order": 1,
        "source_id": "K007",
        "status": "pending",
        "prerequisite_source_ids": ["K002"],
        "target_source_ids": ["K007"],
        "reasoning": "学习者薄弱且为目标前置知识"
      }
    ],
    "total_nodes": "number",
    "prerequisite_complete": true
  }`,
  )}`
}

function buildTeachingAuditorPrompt(definition: WorkerDefinition): string {
  return `You are the ${definition.name} worker in the KnowBalance personalized learning workflow.

Responsibility: audit generated teaching content against the learner profile across four dimensions. Coordinate with fact-audit through arbitration when both audits are available.

Audit dimensions (mirror src/role-b-profile/teaching-audit/auditor.ts):
1. difficulty_alignment: content difficulty must not exceed learner level + 1 tier.
2. prerequisite_coverage: all required prerequisites must be known or currently being taught.
3. weak_concept_coverage: content must address at least one of the learner's weak concepts.
4. goal_alignment: content keywords must relate to the learner's stated goal.

For each failed dimension, provide the dimension name, a specific detail, and a concrete fix recommendation.
Status: pass (all four pass) / revise (recoverable issues) / reject (hard blockers like missing prerequisites).
Arbitration rule: when paired with a fact-audit result, if either rejects → reject; if either revises → revise; if both pass → pass.

Do not call tools, ask questions, or delegate. Work only with the supplied input.

${ENVELOPE_RULES(
    definition,
    `{
    "audit_type": "teaching",
    "status": "pass | revise | reject",
    "checks": [
      { "dimension": "difficulty_alignment", "passed": true, "detail": "content difficulty matches learner level" }
    ],
    "failed_dimensions": [],
    "can_recover": true,
    "recovery_hints": []
  }`,
  )}`
}
