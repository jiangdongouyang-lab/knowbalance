import type { KnowledgeDifficulty } from "../../knowledge/types"

export const C_SCHEMA_VERSION = "1.0" as const

export type SchemaVersion = typeof C_SCHEMA_VERSION
export type LearnerLevel = KnowledgeDifficulty
export type ArtifactStatus = "ready" | "blocked" | "failed"
export type CitationRelation = "supports" | "derived_from" | "prerequisite"
export type RoleCAgentName = "concept-tutor" | "code-lab" | "tiered-evaluator"

export interface EvidenceRef {
  source_id: string
  fact_id: string
}

export interface CitationRef extends EvidenceRef {
  relation: CitationRelation
}

export interface ArtifactVersions {
  profile_version: string
  kb_version: string
  rag_version: string
  prompt_version: string
  model_config_hash: string
  schema_version: SchemaVersion
  runner_image_digest?: string
}

export interface ArtifactQuality {
  schema_ok: boolean
  citation_coverage: number
  objective_coverage: number
  alignment_score: number
  execution_verified?: boolean
  answer_key_verified?: boolean
}

export interface ArtifactEnvelope<TPayload> {
  schema_version: SchemaVersion
  run_id: string
  artifact_id: string
  artifact_type:
    | "concept_lesson"
    | "code_lab_public"
    | "code_lab_secure"
    | "assessment_public"
    | "assessment_secure"
    | "grade_result"
  agent: RoleCAgentName
  status: ArtifactStatus
  blocked_reason?: BlockedReason
  failure_reason?: FailureReason
  versions: ArtifactVersions
  seed: number
  input_refs: string[]
  citations: CitationRef[]
  quality: ArtifactQuality
  payload: TPayload | null
  trace_ref: string
}

export interface BlockedReason {
  code:
    | "BLOCKED_MISSING_EVIDENCE"
    | "BLOCKED_WEAK_EVIDENCE"
    | "BLOCKED_EVIDENCE_CONFLICT"
    | "BLOCKED_INVALID_CITATION"
    | "BLOCKED_PUBLIC_SECURE_LEAK"
    | "BLOCKED_ALIGNMENT_FAILURE"
    | "BLOCKED_EXECUTION_UNVERIFIED"
    | "BLOCKED_ANSWER_KEY_UNVERIFIED"
    | "BLOCKED_PROVIDER_UNAVAILABLE"
    | "BLOCKED_INVALID_OUTPUT"
  message: string
  details?: string[]
}

export interface FailureReason {
  code: "PROVIDER_ERROR" | "SECURE_STORE_ERROR"
  message: string
}

/** Stable, non-cryptographic identifier helper. Do not use it for security decisions. */
export function stableId(prefix: string, value: unknown): string {
  const input = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}
