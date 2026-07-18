import type {
  AssessmentPublicPayload,
  AssessmentSecurePayload,
  CodeLabPublicPayload,
  CodeLabSecurePayload,
  ConceptLessonPayload,
} from "../contracts/artifacts"
import {
  C_SCHEMA_VERSION,
  stableId,
  type ArtifactEnvelope,
  type ArtifactQuality,
  type BlockedReason,
  type CitationRef,
  type RoleCAgentName,
} from "../contracts/common"
import type { GenerationSpec } from "../contracts/generation-spec"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import { validateCitations } from "../validators/citation-validator"
import { validatePublicArtifactNoSecrets } from "../validators/public-secure-leak-validator"
import type { ArtifactDraft } from "./types"

type RoleCArtifactType = ArtifactEnvelope<unknown>["artifact_type"]

export function finalizeDraft<TPayload>(input: {
  spec: GenerationSpec
  evidence: RagEvidencePack
  agent: RoleCAgentName
  artifact_type: RoleCArtifactType
  draft: ArtifactDraft<TPayload>
  input_refs: string[]
  public_payload: boolean
  objective_ids: string[]
  execution_verified?: boolean
  answer_key_verified?: boolean
}): ArtifactEnvelope<TPayload> {
  const citationReport = validateCitations(input.draft.citations, input.evidence)
  if (!citationReport.ok) {
    return blockedEnvelope(input, {
      code: "BLOCKED_INVALID_CITATION",
      message: "产物包含本次 evidence_pack 中不存在的引用",
      details: citationReport.issues.map((issue) => issue.message),
    })
  }

  if (input.public_payload) {
    const leakReport = validatePublicArtifactNoSecrets(input.draft.payload)
    if (!leakReport.ok) {
      return blockedEnvelope(input, {
        code: "BLOCKED_PUBLIC_SECURE_LEAK",
        message: "公开产物包含答案、隐藏测试或其他私有字段",
        details: leakReport.issues.map((issue) => `${issue.path}: ${issue.message}`),
      })
    }
  }

  if (input.execution_verified === false) {
    return blockedEnvelope(input, {
      code: "BLOCKED_EXECUTION_UNVERIFIED",
      message: "代码实验尚未由可信执行器验证，当前保持 blocked",
    })
  }

  if (input.answer_key_verified === false) {
    return blockedEnvelope(input, {
      code: "BLOCKED_ANSWER_KEY_UNVERIFIED",
      message: "测评答案规范尚未验证，当前保持 blocked",
    })
  }

  const quality = qualityFromDraft(input.spec, input.draft, input.objective_ids, {
    execution_verified: input.execution_verified,
    answer_key_verified: input.answer_key_verified,
  })
  const artifactId = stableId("ART", {
    spec_id: input.spec.spec_id,
    artifact_type: input.artifact_type,
    seed: input.spec.policies.seed,
  })
  return {
    schema_version: C_SCHEMA_VERSION,
    run_id: input.spec.run_id,
    artifact_id: artifactId,
    artifact_type: input.artifact_type,
    agent: input.agent,
    status: "ready",
    versions: input.spec.versions,
    seed: input.spec.policies.seed,
    input_refs: [...input.input_refs],
    citations: input.draft.citations.map((citation) => ({ ...citation })),
    quality,
    payload: input.draft.payload,
    trace_ref: stableId("TRACE", { artifact_id: artifactId }),
  }
}

export function providerBlockedEnvelope<TPayload>(input: {
  spec: GenerationSpec
  evidence: RagEvidencePack
  agent: RoleCAgentName
  artifact_type: RoleCArtifactType
  input_refs: string[]
  message: string
}): ArtifactEnvelope<TPayload> {
  return blockedEnvelope(
    {
      ...input,
      draft: { payload: null as TPayload, citations: [], factual_claim_count: 0, cited_claim_count: 0 },
      public_payload: true,
      objective_ids: [],
    },
    { code: "BLOCKED_PROVIDER_UNAVAILABLE", message: input.message },
  )
}

export function invalidOutputEnvelope<TPayload>(input: {
  spec: GenerationSpec
  evidence: RagEvidencePack
  agent: RoleCAgentName
  artifact_type: RoleCArtifactType
  input_refs: string[]
  message: string
}): ArtifactEnvelope<TPayload> {
  return blockedEnvelope(
    {
      ...input,
      draft: { payload: null as TPayload, citations: [], factual_claim_count: 0, cited_claim_count: 0 },
      public_payload: true,
      objective_ids: [],
    },
    { code: "BLOCKED_INVALID_OUTPUT", message: input.message },
  )
}

export function isConceptLessonPayload(value: unknown): value is ConceptLessonPayload {
  return hasString(value, "title") &&
    hasStringArray(value, "objective_ids") &&
    hasArray(value, "prerequisite_bridge") &&
    hasArray(value, "explanation_blocks") &&
    hasArray(value, "worked_examples") &&
    hasArray(value, "misconceptions") &&
    hasArray(value, "micro_checks") &&
    hasArray(value, "hint_ladders") &&
    hasArray(value, "summary") &&
    hasArray(value, "objective_coverage") &&
    hasArray(value, "used_evidence")
}

export function isCodeLabPublicPayload(value: unknown): value is CodeLabPublicPayload {
  return hasString(value, "lab_id") &&
    hasString(value, "title") &&
    hasStringArray(value, "objective_ids") &&
    hasArray(value, "instructions") &&
    hasObject(value, "execution_contract") &&
    hasString(value, "starter_code") &&
    hasArray(value, "public_tests") &&
    hasArray(value, "hint_ladders") &&
    hasArray(value, "reflection_questions") &&
    hasArray(value, "used_evidence")
}

export function isCodeLabSecurePayload(value: unknown): value is CodeLabSecurePayload {
  return hasString(value, "lab_id") &&
    hasString(value, "reference_solution") &&
    hasArray(value, "hidden_tests") &&
    hasArray(value, "scoring_groups") &&
    hasArray(value, "misconception_map")
}

export function isAssessmentPublicPayload(value: unknown): value is AssessmentPublicPayload {
  return hasString(value, "form_id") &&
    hasString(value, "title") &&
    hasStringArray(value, "objective_ids") &&
    hasArray(value, "items") &&
    hasObject(value, "submission_policy")
}

export function isAssessmentSecurePayload(value: unknown): value is AssessmentSecurePayload {
  return hasString(value, "form_id") && hasArray(value, "items") && hasNumber(value, "option_order_seed")
}

function blockedEnvelope<TPayload>(
  input: {
    spec: GenerationSpec
    evidence: RagEvidencePack
    agent: RoleCAgentName
    artifact_type: RoleCArtifactType
    draft: ArtifactDraft<TPayload>
    input_refs: string[]
    public_payload: boolean
    objective_ids: string[]
    execution_verified?: boolean
    answer_key_verified?: boolean
  },
  reason: BlockedReason,
): ArtifactEnvelope<TPayload> {
  const artifactId = stableId("ART", {
    spec_id: input.spec.spec_id,
    artifact_type: input.artifact_type,
    blocked: reason.code,
  })
  return {
    schema_version: C_SCHEMA_VERSION,
    run_id: input.spec.run_id,
    artifact_id: artifactId,
    artifact_type: input.artifact_type,
    agent: input.agent,
    status: "blocked",
    blocked_reason: reason,
    versions: input.spec.versions,
    seed: input.spec.policies.seed,
    input_refs: [...input.input_refs],
    citations: [],
    quality: {
      schema_ok: false,
      citation_coverage: 0,
      objective_coverage: 0,
      alignment_score: 0,
      execution_verified: input.execution_verified,
      answer_key_verified: input.answer_key_verified,
    },
    payload: null,
    trace_ref: stableId("TRACE", { artifact_id: artifactId }),
  }
}

function qualityFromDraft<TPayload>(
  spec: GenerationSpec,
  draft: ArtifactDraft<TPayload>,
  objectiveIds: string[],
  verification: Pick<ArtifactQuality, "execution_verified" | "answer_key_verified">,
): ArtifactQuality {
  const requiredObjectives = new Set(spec.targets.map((target) => target.objective_id))
  const covered = new Set(objectiveIds.filter((objectiveId) => requiredObjectives.has(objectiveId)))
  const objectiveCoverage = requiredObjectives.size === 0 ? 1 : covered.size / requiredObjectives.size
  const citationCoverage = draft.factual_claim_count === 0
    ? 1
    : Math.min(1, draft.cited_claim_count / draft.factual_claim_count)
  return {
    schema_ok: true,
    citation_coverage: citationCoverage,
    objective_coverage: objectiveCoverage,
    alignment_score: objectiveCoverage,
    ...verification,
  }
}

function hasString(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string")
}

function hasArray(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[key]))
}

function hasObject(value: unknown, key: string): boolean {
  const child = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
  return Boolean(child && typeof child === "object" && !Array.isArray(child))
}

function hasNumber(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "number")
}

function hasStringArray(value: unknown, key: string): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>)[key]) &&
    ((value as Record<string, unknown>)[key] as unknown[]).every((entry) => typeof entry === "string"),
  )
}
