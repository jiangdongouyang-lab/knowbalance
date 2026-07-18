import {
  C_SCHEMA_VERSION,
  stableId,
  type ArtifactVersions,
  type LearnerLevel,
  type SchemaVersion,
} from "./common"
import type { EvidenceGapRequest, RagEvidencePack } from "./evidence-pack"
import type { LearnerProfileSnapshot, LearningObjective, LearningPathNode } from "./profile-adapter"

export interface DifficultyVector {
  domain_complexity: number
  cognitive_demand: number
  reasoning_steps: number
  code_complexity: number
  prerequisite_load: number
  scaffold_strength: number
}

export interface AssessmentBlueprint {
  tier_1_count: number
  tier_2_count: number
  tier_3_count: number
  required_modalities: Array<"mcq" | "true_false" | "trace" | "short_answer" | "code">
}

export interface GenerationSpec {
  schema_version: SchemaVersion
  spec_id: string
  run_id: string
  evidence_ref: string
  versions: ArtifactVersions
  profile_ref: {
    profile_id: string
    profile_version: string
  }
  path_node: Omit<LearningPathNode, "schema_version" | "objectives">
  targets: LearningObjective[]
  learner_adaptation: {
    level: LearnerLevel
    known_concepts: string[]
    weak_concepts: string[]
    preferred_contexts: string[]
    scaffold_level: 0 | 1 | 2 | 3
    reading_density: "low" | "medium" | "high"
    accommodations: string[]
  }
  difficulty: DifficultyVector
  assessment_blueprint: AssessmentBlueprint
  policies: {
    external_knowledge_allowed: false
    citation_required: true
    max_semantic_revision: 1
    max_tool_retry: 2
    seed: number
  }
}

export interface BuildGenerationSpecInput {
  run_id: string
  profile_snapshot: LearnerProfileSnapshot
  path_node: LearningPathNode
  evidence_pack: RagEvidencePack
  versions: Omit<ArtifactVersions, "profile_version" | "kb_version" | "rag_version" | "schema_version">
  seed?: number
  difficulty?: Partial<DifficultyVector>
  assessment_blueprint?: Partial<AssessmentBlueprint>
}

export type BuildGenerationSpecResult =
  | { ok: true; spec: GenerationSpec }
  | { ok: false; code: "INVALID_INPUT" | "MISSING_EVIDENCE" | "WEAK_EVIDENCE"; errors: string[]; gap_request: EvidenceGapRequest }

export function buildGenerationSpec(input: BuildGenerationSpecInput): BuildGenerationSpecResult {
  const errors = validateInputShape(input)
  const sourceIds = new Set(input.evidence_pack.results.map((item) => item.source_id))
  const factKeys = new Set(
    input.evidence_pack.results.flatMap((item) =>
      item.facts.map((fact) => `${fact.source_id}:${fact.fact_id}`),
    ),
  )

  const missingSources = input.path_node.target_source_ids.filter((sourceId) => !sourceIds.has(sourceId))
  const missingFacts = input.path_node.objectives.flatMap((objective) =>
    objective.required_fact_ids
      .filter((factId) => !factKeys.has(`${objective.source_id}:${factId}`))
      .map((factId) => `${objective.source_id}:${factId}`),
  )

  if (input.evidence_pack.match_status === "no_match" || missingSources.length > 0 || missingFacts.length > 0) {
    const details = [
      ...errors,
      ...(missingSources.length > 0 ? [`缺少知识点：${missingSources.join("、")}`] : []),
      ...(missingFacts.length > 0 ? [`缺少事实：${missingFacts.join("、")}`] : []),
    ]
    return {
      ok: false,
      code: "MISSING_EVIDENCE",
      errors: details,
      gap_request: createGapRequest(input, "fact", details.join("；") || "RAG 未命中"),
    }
  }

  if (input.evidence_pack.match_status === "weak") {
    return {
      ok: false,
      code: "WEAK_EVIDENCE",
      errors: ["RAG 仅弱匹配，当前证据不足以发布事实性教学内容"],
      gap_request: createGapRequest(input, "strong_match", "当前检索只有难度或其他弱信号，需要重写 query 或补充证据"),
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      errors,
      gap_request: createGapRequest(input, "knowledge_item", errors.join("；")),
    }
  }

  const defaults = adaptationDefaults(input.profile_snapshot.level)
  const seed = input.seed ?? 0
  const versions: ArtifactVersions = {
    ...input.versions,
    profile_version: input.profile_snapshot.profile_version,
    kb_version: input.evidence_pack.kb_version,
    rag_version: input.evidence_pack.rag_version,
    schema_version: C_SCHEMA_VERSION,
  }
  const specIdentity = {
    run_id: input.run_id,
    profile_id: input.profile_snapshot.profile_id,
    profile_version: input.profile_snapshot.profile_version,
    path_node_id: input.path_node.node_id,
    retrieval_id: input.evidence_pack.retrieval_id,
    seed,
  }

  return {
    ok: true,
    spec: {
      schema_version: C_SCHEMA_VERSION,
      spec_id: stableId("SPEC", specIdentity),
      run_id: input.run_id,
      evidence_ref: input.evidence_pack.retrieval_id,
      versions,
      profile_ref: {
        profile_id: input.profile_snapshot.profile_id,
        profile_version: input.profile_snapshot.profile_version,
      },
      path_node: {
        node_id: input.path_node.node_id,
        target_source_ids: [...input.path_node.target_source_ids],
        prerequisite_source_ids: [...input.path_node.prerequisite_source_ids],
        goal: input.path_node.goal,
      },
      targets: input.path_node.objectives.map((objective) => ({
        ...objective,
        required_fact_ids: [...objective.required_fact_ids],
      })),
      learner_adaptation: {
        level: input.profile_snapshot.level,
        known_concepts: [...input.profile_snapshot.known_concepts],
        weak_concepts: [...input.profile_snapshot.weak_concepts],
        preferred_contexts: [...input.profile_snapshot.preferred_contexts],
        scaffold_level: defaults.scaffold_level,
        reading_density: defaults.reading_density,
        accommodations: [...input.profile_snapshot.accommodations],
      },
      difficulty: { ...defaults.difficulty, ...input.difficulty },
      assessment_blueprint: {
        tier_1_count: input.assessment_blueprint?.tier_1_count ?? 2,
        tier_2_count: input.assessment_blueprint?.tier_2_count ?? 2,
        tier_3_count: input.assessment_blueprint?.tier_3_count ?? 1,
        required_modalities: input.assessment_blueprint?.required_modalities ?? ["mcq", "trace", "code"],
      },
      policies: {
        external_knowledge_allowed: false,
        citation_required: true,
        max_semantic_revision: 1,
        max_tool_retry: 2,
        seed,
      },
    },
  }
}

function validateInputShape(input: BuildGenerationSpecInput): string[] {
  const errors: string[] = []
  if (!input.run_id.trim()) errors.push("run_id 不能为空")
  if (!input.profile_snapshot.profile_version.trim()) errors.push("profile_version 不能为空")
  if (!input.path_node.node_id.trim()) errors.push("path_node.node_id 不能为空")
  if (!input.path_node.goal.trim()) errors.push("path_node.goal 不能为空")
  if (input.path_node.target_source_ids.length === 0) errors.push("target_source_ids 不能为空")
  if (input.path_node.objectives.length === 0) errors.push("objectives 不能为空")
  for (const objective of input.path_node.objectives) {
    if (!input.path_node.target_source_ids.includes(objective.source_id)) {
      errors.push(`目标 ${objective.objective_id} 的 source_id 不在 target_source_ids 中`)
    }
    if (objective.required_fact_ids.length === 0) {
      errors.push(`目标 ${objective.objective_id} 缺少 required_fact_ids`)
    }
  }
  return errors
}

function createGapRequest(
  input: BuildGenerationSpecInput,
  missingType: EvidenceGapRequest["missing_type"],
  reason: string,
): EvidenceGapRequest {
  const requiredFacts = input.path_node.objectives.flatMap((objective) =>
    objective.required_fact_ids.map((factId) => ({ source_id: objective.source_id, fact_id: factId })),
  )
  const uniqueRequiredFacts = [
    ...new Map(requiredFacts.map((fact) => [`${fact.source_id}:${fact.fact_id}`, fact])).values(),
  ]
  return {
    schema_version: C_SCHEMA_VERSION,
    request_id: stableId("EGR", { run_id: input.run_id, node_id: input.path_node.node_id, missingType, reason }),
    run_id: input.run_id,
    target_source_ids: [...input.path_node.target_source_ids],
    missing_type: missingType,
    reason,
    learner_level: input.profile_snapshot.level,
    required_facts: uniqueRequiredFacts,
  }
}

function adaptationDefaults(level: LearnerLevel): {
  scaffold_level: 0 | 1 | 2 | 3
  reading_density: "low" | "medium" | "high"
  difficulty: DifficultyVector
} {
  const byLevel = {
    beginner: { scaffold_level: 3 as const, reading_density: "low" as const, base: 1 },
    basic: { scaffold_level: 2 as const, reading_density: "medium" as const, base: 2 },
    intermediate: { scaffold_level: 1 as const, reading_density: "medium" as const, base: 3 },
    integrated: { scaffold_level: 0 as const, reading_density: "high" as const, base: 4 },
  }
  const selected = byLevel[level]
  return {
    scaffold_level: selected.scaffold_level,
    reading_density: selected.reading_density,
    difficulty: {
      domain_complexity: selected.base,
      cognitive_demand: selected.base,
      reasoning_steps: selected.base,
      code_complexity: Math.max(0, selected.base - 1),
      prerequisite_load: Math.max(0, selected.base - 1),
      scaffold_strength: selected.scaffold_level,
    },
  }
}
