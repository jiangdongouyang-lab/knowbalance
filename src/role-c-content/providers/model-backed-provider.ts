import type {
  ArtifactDraft,
  AssessmentDraft,
  CodeLabDraft,
  CodeLabRequest,
  ConceptTutorRequest,
  RoleCContentProvider,
  TieredEvaluatorRequest,
} from "../agents/types"
import { buildConceptTutorModelInput } from "../context/concept-context"
import { buildCodeLabModelInput } from "../context/code-lab-context"
import { buildAssessmentAuthorModelInput } from "../context/assessment-context"
import type {
  AssessmentPublicPayload,
  AssessmentSecurePayload,
  CodeLabPublicPayload,
  CodeLabSecurePayload,
  ConceptLessonPayload,
} from "../contracts/artifacts"
import { contentHash } from "../contracts/common"
import {
  ModelGatewayError,
  ModelOutputValidationError,
  ModelProviderUnavailableError,
  type ModelGateway,
} from "../contracts/model-gateway"
import {
  CONCEPT_TUTOR_PROMPT_VERSION,
  CONCEPT_TUTOR_SYSTEM_PROMPT,
  conceptTutorRepairPrompt,
} from "../prompts/concept-tutor.v1"
import {
  CODE_LAB_PROMPT_VERSION,
  CODE_LAB_SYSTEM_PROMPT,
  codeLabRepairPrompt,
} from "../prompts/code-lab.v1"
import {
  EVALUATOR_AUTHOR_PROMPT_VERSION,
  EVALUATOR_AUTHOR_SYSTEM_PROMPT,
  evaluatorAuthorRepairPrompt,
} from "../prompts/evaluator-author.v1"
import {
  ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT,
  ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT,
  CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT,
  CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT,
  CONCEPT_SEGMENT_SYSTEM_PROMPT,
  STAGED_AUTHOR_PROMPT_VERSION,
  stagedRepairPrompt,
} from "../prompts/staged-authors.v1"
import { validateCodeLabDraftStructure, validateCodeLabPublicStage } from "../validators/code-lab-validator"
import { validateAssessmentDraftStructure, validateAssessmentPublicStage } from "../validators/assessment-validator"
import { validateConceptLesson } from "../validators/concept-validator"
import {
  getRoleCModelOutputSchema,
  getRoleCModelOutputSchemaFragment,
  validateRoleCSchemaFragment,
  type RoleCSchemaFile,
} from "../validators/runtime-schema-validator"
import {
  buildAssessmentFormId,
  buildAssessmentItemPlan,
  buildLabIdentity,
  mapWithConcurrency,
  mergeConceptSegments,
  normalizeAssessmentPair,
  normalizeAssessmentPublic,
  normalizeCodeLabPublic,
  normalizeCodeLabSecure,
  normalizeConceptSegment,
  splitConceptRequest,
  validateAssessmentPublicAgainstPlan,
  validateAssessmentSecureAgainstPublic,
} from "./staged-generation"

export interface ModelBackedProviderOptions {
  /** Staged is the production path; monolithic remains available for compatibility and benchmarks. */
  generation_strategy?: "staged" | "monolithic"
  /** Production defaults to one targeted repair; diagnostics may explicitly disable it. */
  max_repair_attempts?: 0 | 1
  concept_temperature?: number
  concept_max_tokens?: number
  concept_group_size?: number
  concept_concurrency?: number
  concept_segment_max_tokens?: number
  code_lab_temperature?: number
  code_lab_max_tokens?: number
  code_lab_public_max_tokens?: number
  code_lab_secure_max_tokens?: number
  assessment_temperature?: number
  assessment_max_tokens?: number
  assessment_public_max_tokens?: number
  assessment_secure_max_tokens?: number
}

interface StructuredStage<T> {
  task: string
  system_prompt: string
  input: unknown
  output_schema_id: string
  output_schema: Record<string, unknown>
  temperature: number
  max_tokens: number
  idempotency_identity: Record<string, unknown>
  max_repairs: number
  validate: (value: T) => string[]
}

/** Model-backed Provider. Stages are internal; public Role C contracts remain unchanged. */
export class ModelBackedRoleCContentProvider implements RoleCContentProvider {
  private readonly generationStrategy: "staged" | "monolithic"
  private readonly maxRepairAttempts: 0 | 1
  private readonly conceptTemperature: number
  private readonly conceptMaxTokens: number
  private readonly conceptGroupSize: number
  private readonly conceptConcurrency: number
  private readonly conceptSegmentMaxTokens: number
  private readonly codeLabTemperature: number
  private readonly codeLabMaxTokens: number
  private readonly codeLabPublicMaxTokens: number
  private readonly codeLabSecureMaxTokens: number
  private readonly assessmentTemperature: number
  private readonly assessmentMaxTokens: number
  private readonly assessmentPublicMaxTokens: number
  private readonly assessmentSecureMaxTokens: number

  constructor(
    private readonly gateway: ModelGateway,
    options: ModelBackedProviderOptions = {},
  ) {
    this.generationStrategy = options.generation_strategy ?? "staged"
    this.maxRepairAttempts = options.max_repair_attempts ?? 1
    this.conceptTemperature = options.concept_temperature ?? 0.2
    this.conceptMaxTokens = options.concept_max_tokens ?? 4_500
    this.conceptGroupSize = positiveInteger(options.concept_group_size, 1, "concept_group_size")
    this.conceptConcurrency = positiveInteger(options.concept_concurrency, 1, "concept_concurrency")
    this.conceptSegmentMaxTokens = positiveInteger(options.concept_segment_max_tokens, 3_500, "concept_segment_max_tokens")
    this.codeLabTemperature = options.code_lab_temperature ?? 0.2
    this.codeLabMaxTokens = options.code_lab_max_tokens ?? 7_000
    this.codeLabPublicMaxTokens = positiveInteger(options.code_lab_public_max_tokens, 3_500, "code_lab_public_max_tokens")
    this.codeLabSecureMaxTokens = positiveInteger(options.code_lab_secure_max_tokens, 5_000, "code_lab_secure_max_tokens")
    this.assessmentTemperature = options.assessment_temperature ?? 0.15
    this.assessmentMaxTokens = options.assessment_max_tokens ?? 8_000
    this.assessmentPublicMaxTokens = positiveInteger(options.assessment_public_max_tokens, 4_500, "assessment_public_max_tokens")
    this.assessmentSecureMaxTokens = positiveInteger(options.assessment_secure_max_tokens, 5_500, "assessment_secure_max_tokens")
  }

  async generateConceptLesson(
    request: ConceptTutorRequest,
  ): Promise<ArtifactDraft<ConceptLessonPayload>> {
    assertVersionCompatibility(request, this.gateway)
    if (this.generationStrategy === "monolithic") return this.generateConceptLessonMonolithic(request)

    const maxRepairs = boundedRepairs(this.maxRepairAttempts, request)
    const segments = splitConceptRequest(request, this.conceptGroupSize)
    const payloads = await mapWithConcurrency(segments, this.conceptConcurrency, async (segment) => {
      const modelInput = buildConceptTutorModelInput(segment)
      const payload = await this.generateStage<ConceptLessonPayload>({
        task: "role-c.concept-tutor.segment",
        system_prompt: CONCEPT_SEGMENT_SYSTEM_PROMPT,
        input: {
          ...modelInput,
          segment: {
            index: segment.segment_index,
            count: segment.segment_count,
            objective_ids: segment.generation_spec.targets.map((target) => target.objective_id),
          },
        },
        output_schema_id: "role_c_concept_lesson_segment_v1",
        output_schema: getRoleCModelOutputSchema("concept_lesson_payload.schema.json"),
        temperature: this.conceptTemperature,
        max_tokens: this.conceptSegmentMaxTokens,
        idempotency_identity: {
          spec_id: segment.generation_spec.spec_id,
          evidence_ref: segment.generation_spec.evidence_ref,
          prompt_version: STAGED_AUTHOR_PROMPT_VERSION,
          model_config_hash: this.gateway.model_config_hash,
          seed: segment.generation_spec.policies.seed,
        },
        max_repairs: maxRepairs,
        validate: (payload) => validationIssues(validateConceptLesson({
          payload: normalizeConceptSegment(segment, payload),
          spec: segment.generation_spec,
          evidence: segment.evidence_pack,
        })),
      })
      return normalizeConceptSegment(segment, payload)
    })
    const payload = mergeConceptSegments(request, payloads)
    const validation = validateConceptLesson({
      payload,
      spec: request.generation_spec,
      evidence: request.evidence_pack,
    })
    if (!validation.ok) {
      throw new ModelOutputValidationError("concept.merge", validationIssues(validation))
    }
    return { payload }
  }

  async generateCodeLab(request: CodeLabRequest): Promise<CodeLabDraft> {
    assertVersionCompatibility(request, this.gateway, CODE_LAB_PROMPT_VERSION)
    if (this.generationStrategy === "monolithic") return this.generateCodeLabMonolithic(request)

    const modelInput = buildCodeLabModelInput(request)
    const identity = buildLabIdentity(request.generation_spec)
    const maxRepairs = boundedRepairs(this.maxRepairAttempts, request)
    const publicPayload = await this.generateStage<CodeLabPublicPayload>({
      task: "role-c.code-lab.public",
      system_prompt: CODE_LAB_PUBLIC_STAGE_SYSTEM_PROMPT,
      input: {
        ...modelInput,
        staged_contract: {
          lab_id: identity.lab_id,
          objective_ids: request.generation_spec.targets.map((target) => target.objective_id),
        },
      },
      output_schema_id: "role_c_code_lab_public_payload_v1",
      output_schema: fragment("code_lab_draft.schema.json", "/$defs/public_payload"),
      temperature: this.codeLabTemperature,
      max_tokens: this.codeLabPublicMaxTokens,
      idempotency_identity: {
        spec_id: request.generation_spec.spec_id,
        concept_artifact_id: request.concept_artifact.artifact_id,
        stage: "public",
        prompt_version: STAGED_AUTHOR_PROMPT_VERSION,
      },
      max_repairs: maxRepairs,
      validate: (payload) => {
        const schema = validateRoleCSchemaFragment("code_lab_draft.schema.json", "/$defs/public_payload", payload)
        if (!schema.ok) return validationIssues(schema)
        const normalized = normalizeCodeLabPublic(request, payload, identity.lab_id)
        return validationIssues(validateCodeLabPublicStage(request, normalized))
      },
    })
    const normalizedPublic = normalizeCodeLabPublic(request, publicPayload, identity.lab_id)
    const securePayload = await this.generateStage<CodeLabSecurePayload>({
      task: "role-c.code-lab.secure",
      system_prompt: CODE_LAB_SECURE_STAGE_SYSTEM_PROMPT,
      input: {
        contract: modelInput.contract,
        evidence: modelInput.evidence,
        concept: modelInput.concept,
        public_payload: normalizedPublic,
        staged_contract: {
          lab_id: identity.lab_id,
          test_suite_id: identity.test_suite_id,
          execution_contract: normalizedPublic.execution_contract,
        },
        revision_objections: modelInput.revision_objections,
      },
      output_schema_id: "role_c_code_lab_secure_payload_v1",
      output_schema: fragment("code_lab_draft.schema.json", "/$defs/secure_payload"),
      temperature: this.codeLabTemperature,
      max_tokens: this.codeLabSecureMaxTokens,
      idempotency_identity: {
        spec_id: request.generation_spec.spec_id,
        lab_id: identity.lab_id,
        public_hash: contentHash(normalizedPublic),
        stage: "secure",
        prompt_version: STAGED_AUTHOR_PROMPT_VERSION,
      },
      max_repairs: maxRepairs,
      validate: (payload) => {
        const schema = validateRoleCSchemaFragment("code_lab_draft.schema.json", "/$defs/secure_payload", payload)
        if (!schema.ok) return validationIssues(schema)
        const normalized = normalizeCodeLabSecure(
          request.generation_spec,
          payload,
          normalizedPublic,
          identity.test_suite_id,
        )
        return validationIssues(validateCodeLabDraftStructure(request, {
          public_draft: { payload: normalizedPublic },
          secure_draft: { payload: normalized },
        }))
      },
    })
    return {
      public_draft: { payload: normalizedPublic },
      secure_draft: {
        payload: normalizeCodeLabSecure(
          request.generation_spec,
          securePayload,
          normalizedPublic,
          identity.test_suite_id,
        ),
      },
    }
  }

  async generateAssessment(request: TieredEvaluatorRequest): Promise<AssessmentDraft> {
    assertVersionCompatibility(request, this.gateway, EVALUATOR_AUTHOR_PROMPT_VERSION)
    if (this.generationStrategy === "monolithic") return this.generateAssessmentMonolithic(request)

    const modelInput = buildAssessmentAuthorModelInput(request)
    const plan = buildAssessmentItemPlan(request.generation_spec)
    const formId = buildAssessmentFormId(request.generation_spec)
    const maxRepairs = boundedRepairs(this.maxRepairAttempts, request)
    const publicPayload = await this.generateStage<AssessmentPublicPayload>({
      task: "role-c.tiered-evaluator.public",
      system_prompt: ASSESSMENT_PUBLIC_STAGE_SYSTEM_PROMPT,
      input: {
        ...modelInput,
        staged_contract: {
          form_id: formId,
          objective_ids: request.generation_spec.targets.map((target) => target.objective_id),
          item_plan: plan,
        },
      },
      output_schema_id: "role_c_assessment_public_payload_v1",
      output_schema: fragment("assessment_draft.schema.json", "/$defs/public_payload"),
      temperature: this.assessmentTemperature,
      max_tokens: this.assessmentPublicMaxTokens,
      idempotency_identity: {
        spec_id: request.generation_spec.spec_id,
        concept_artifact_id: request.concept_artifact.artifact_id,
        stage: "public",
        prompt_version: STAGED_AUTHOR_PROMPT_VERSION,
      },
      max_repairs: maxRepairs,
      validate: (payload) => {
        const schema = validateRoleCSchemaFragment("assessment_draft.schema.json", "/$defs/public_payload", payload)
        if (!schema.ok) return validationIssues(schema)
        const planIssues = validateAssessmentPublicAgainstPlan(payload, plan)
        if (planIssues.length > 0) return planIssues
        const normalized = normalizeAssessmentPublic(request.generation_spec, payload, plan, formId)
        return validationIssues(validateAssessmentPublicStage(request, normalized))
      },
    })
    const normalizedPublic = normalizeAssessmentPublic(request.generation_spec, publicPayload, plan, formId)
    const securePayload = await this.generateStage<AssessmentSecurePayload>({
      task: "role-c.tiered-evaluator.secure",
      system_prompt: ASSESSMENT_SECURE_STAGE_SYSTEM_PROMPT,
      input: {
        contract: modelInput.contract,
        evidence: modelInput.evidence,
        upstream: modelInput.upstream,
        public_payload: normalizedPublic,
        staged_contract: {
          form_id: formId,
          option_order_seed: request.generation_spec.policies.seed,
          item_plan: plan,
        },
        revision_objections: modelInput.revision_objections,
      },
      output_schema_id: "role_c_assessment_secure_payload_v1",
      output_schema: fragment("assessment_draft.schema.json", "/$defs/secure_payload"),
      temperature: this.assessmentTemperature,
      max_tokens: this.assessmentSecureMaxTokens,
      idempotency_identity: {
        spec_id: request.generation_spec.spec_id,
        form_id: formId,
        public_hash: contentHash(normalizedPublic),
        stage: "secure",
        prompt_version: STAGED_AUTHOR_PROMPT_VERSION,
      },
      max_repairs: maxRepairs,
      validate: (payload) => {
        const schema = validateRoleCSchemaFragment("assessment_draft.schema.json", "/$defs/secure_payload", payload)
        if (!schema.ok) return validationIssues(schema)
        const crossIssues = validateAssessmentSecureAgainstPublic(payload, normalizedPublic)
        if (crossIssues.length > 0) return crossIssues
        const normalized = normalizeAssessmentPair(request.generation_spec, normalizedPublic, payload)
        return validationIssues(validateAssessmentDraftStructure(request, {
          public_draft: { payload: normalized.public_payload },
          secure_draft: { payload: normalized.secure_payload },
        }))
      },
    })
    const normalized = normalizeAssessmentPair(request.generation_spec, normalizedPublic, securePayload)
    return {
      public_draft: { payload: normalized.public_payload },
      secure_draft: { payload: normalized.secure_payload },
    }
  }

  private async generateStage<T>(stage: StructuredStage<T>): Promise<T> {
    let issues: string[] = []
    for (let attempt = 0; attempt <= stage.max_repairs; attempt += 1) {
      let value: T
      try {
        value = await this.gateway.generateStructured<T>({
          task: stage.task,
          system_prompt: attempt === 0
            ? stage.system_prompt
            : stagedRepairPrompt(stage.system_prompt, issues),
          input: attempt === 0 ? stage.input : { ...asRecord(stage.input), validator_report: issues },
          output_schema_id: stage.output_schema_id,
          output_schema: stage.output_schema,
          temperature: stage.temperature,
          max_tokens: stage.max_tokens,
          idempotency_key: idempotencyKey({
            ...stage.idempotency_identity,
            model_config_hash: this.gateway.model_config_hash,
            input_hash: contentHash(stage.input),
            attempt,
          }),
        })
      } catch (error) {
        if (
          attempt < stage.max_repairs
          && error instanceof ModelGatewayError
          && ["INVALID_JSON", "INVALID_RESPONSE", "OUTPUT_TRUNCATED"].includes(error.code)
        ) {
          issues = [`模型输出格式错误：${error.message}`]
          continue
        }
        throw error
      }
      issues = stage.validate(value)
      if (issues.length === 0) return value
    }
    throw new ModelOutputValidationError(stage.task, issues)
  }

  private async generateConceptLessonMonolithic(
    request: ConceptTutorRequest,
  ): Promise<ArtifactDraft<ConceptLessonPayload>> {
    const modelInput = buildConceptTutorModelInput(request)
    const schema = getRoleCModelOutputSchema("concept_lesson_payload.schema.json")
    const maxRepairs = boundedRepairs(this.maxRepairAttempts, request)
    let payload: unknown
    let issues: string[] = []
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      try {
        payload = await this.gateway.generateStructured<unknown>({
          task: "role-c.concept-tutor.generate",
          system_prompt: attempt === 0 ? CONCEPT_TUTOR_SYSTEM_PROMPT : conceptTutorRepairPrompt(issues),
          input: attempt === 0 ? modelInput : { ...modelInput, validator_report: issues },
          output_schema_id: "role_c_concept_lesson_payload_v1",
          output_schema: schema,
          temperature: this.conceptTemperature,
          max_tokens: this.conceptMaxTokens,
          idempotency_key: idempotencyKey({
            spec_id: request.generation_spec.spec_id,
            evidence_ref: request.generation_spec.evidence_ref,
            prompt_version: CONCEPT_TUTOR_PROMPT_VERSION,
            model_config_hash: this.gateway.model_config_hash,
            seed: request.generation_spec.policies.seed,
            input_hash: contentHash(modelInput),
            attempt,
          }),
        })
      } catch (error) {
        if (repairable(error, attempt, maxRepairs)) {
          issues = [`模型输出格式错误：${(error as Error).message}`]
          continue
        }
        throw error
      }
      const validation = validateConceptLesson({ payload, spec: request.generation_spec, evidence: request.evidence_pack })
      if (validation.ok) return { payload: payload as ConceptLessonPayload }
      issues = validationIssues(validation)
    }
    return { payload: payload as ConceptLessonPayload }
  }

  private async generateCodeLabMonolithic(request: CodeLabRequest): Promise<CodeLabDraft> {
    const modelInput = buildCodeLabModelInput(request)
    const schema = getRoleCModelOutputSchema("code_lab_draft.schema.json")
    const maxRepairs = boundedRepairs(this.maxRepairAttempts, request)
    let draft: unknown
    let issues: string[] = []
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      try {
        draft = await this.gateway.generateStructured<unknown>({
          task: "role-c.code-lab.generate",
          system_prompt: attempt === 0 ? CODE_LAB_SYSTEM_PROMPT : codeLabRepairPrompt(issues),
          input: attempt === 0 ? modelInput : { ...modelInput, validator_report: issues },
          output_schema_id: "role_c_code_lab_draft_v1",
          output_schema: schema,
          temperature: this.codeLabTemperature,
          max_tokens: this.codeLabMaxTokens,
          idempotency_key: idempotencyKey({
            spec_id: request.generation_spec.spec_id,
            concept_artifact_id: request.concept_artifact.artifact_id,
            evidence_ref: request.generation_spec.evidence_ref,
            prompt_version: CODE_LAB_PROMPT_VERSION,
            model_config_hash: this.gateway.model_config_hash,
            seed: request.generation_spec.policies.seed,
            input_hash: contentHash(modelInput),
            attempt,
          }),
        })
      } catch (error) {
        if (repairable(error, attempt, maxRepairs)) {
          issues = [`模型输出格式错误：${(error as Error).message}`]
          continue
        }
        throw error
      }
      const validation = validateCodeLabDraftStructure(request, draft as CodeLabDraft)
      if (validation.ok) return draft as CodeLabDraft
      issues = validationIssues(validation)
    }
    return draft as CodeLabDraft
  }

  private async generateAssessmentMonolithic(request: TieredEvaluatorRequest): Promise<AssessmentDraft> {
    const modelInput = buildAssessmentAuthorModelInput(request)
    const schema = getRoleCModelOutputSchema("assessment_draft.schema.json")
    const maxRepairs = boundedRepairs(this.maxRepairAttempts, request)
    let draft: unknown
    let issues: string[] = []
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      try {
        draft = await this.gateway.generateStructured<unknown>({
          task: "role-c.tiered-evaluator.author",
          system_prompt: attempt === 0 ? EVALUATOR_AUTHOR_SYSTEM_PROMPT : evaluatorAuthorRepairPrompt(issues),
          input: attempt === 0 ? modelInput : { ...modelInput, validator_report: issues },
          output_schema_id: "role_c_assessment_draft_v1",
          output_schema: schema,
          temperature: this.assessmentTemperature,
          max_tokens: this.assessmentMaxTokens,
          idempotency_key: idempotencyKey({
            spec_id: request.generation_spec.spec_id,
            concept_artifact_id: request.concept_artifact.artifact_id,
            evidence_ref: request.generation_spec.evidence_ref,
            prompt_version: EVALUATOR_AUTHOR_PROMPT_VERSION,
            model_config_hash: this.gateway.model_config_hash,
            seed: request.generation_spec.policies.seed,
            input_hash: contentHash(modelInput),
            attempt,
          }),
        })
      } catch (error) {
        if (repairable(error, attempt, maxRepairs)) {
          issues = [`模型输出格式错误：${(error as Error).message}`]
          continue
        }
        throw error
      }
      const validation = validateAssessmentDraftStructure(request, draft as AssessmentDraft)
      if (validation.ok) return draft as AssessmentDraft
      issues = validationIssues(validation)
    }
    return draft as AssessmentDraft
  }
}

function fragment(file: RoleCSchemaFile, pointer: string): Record<string, unknown> {
  return getRoleCModelOutputSchemaFragment(file, pointer)
}

function validationIssues(report: { issues: Array<{ path: string; message: string }> }): string[] {
  return report.issues.map((entry) => `${entry.path}: ${entry.message}`)
}

function boundedRepairs(
  configured: 0 | 1,
  request: ConceptTutorRequest | CodeLabRequest,
): number {
  return Math.min(configured, request.generation_spec.policies.max_semantic_revision)
}

function repairable(error: unknown, attempt: number, maxRepairs: number): boolean {
  return attempt < maxRepairs
    && error instanceof ModelGatewayError
    && ["INVALID_JSON", "INVALID_RESPONSE"].includes(error.code)
}

function idempotencyKey(value: unknown): string {
  return `IDEMP-${contentHash(value).slice("sha256:".length)}`
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`${name} 必须是正整数`)
  return selected
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { stage_input: value }
}

function assertVersionCompatibility(
  request: ConceptTutorRequest | CodeLabRequest,
  gateway: ModelGateway,
  promptVersion = CONCEPT_TUTOR_PROMPT_VERSION,
): void {
  if (request.generation_spec.versions.prompt_version !== promptVersion) {
    throw new ModelProviderUnavailableError(
      `GenerationSpec prompt_version=${request.generation_spec.versions.prompt_version}，当前 Provider 要求 ${promptVersion}`,
    )
  }
  if (request.generation_spec.versions.model_config_hash !== gateway.model_config_hash) {
    throw new ModelProviderUnavailableError(
      "GenerationSpec.model_config_hash 与当前 ModelGateway 不一致，请重新构建 Spec",
    )
  }
}
