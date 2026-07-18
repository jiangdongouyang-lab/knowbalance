// Role C content generation pipeline; the directory already identifies the owning role.
import type {
  AssessmentPublicArtifact,
  AssessmentArtifactPair,
  AssessmentSecureArtifact,
  CodeLabArtifactPair,
  CodeLabPublicArtifact,
  CodeLabSecureArtifact,
  ConceptLessonArtifact,
} from "../contracts/artifacts"
import type { BlockedReason, FailureReason } from "../contracts/common"
import type { AgentTraceEvent } from "../contracts/learning-evidence-event"
import { newTraceEvent } from "../contracts/learning-evidence-event"
import type { GenerationSpec } from "../contracts/generation-spec"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { RoleCAgents } from "../agents/types"
import {
  validateCrossArtifactAlignment,
  type AlignmentReport,
} from "../validators/alignment-validator"
import { validateSpecEvidence } from "../validators/evidence-validator"
import { transitionCState, type CPipelineState } from "./state-machine"

export type SecureArtifact = CodeLabSecureArtifact | AssessmentSecureArtifact

/** D/backend must implement this. C never returns secure payloads to the public publication bundle. */
export interface SecureArtifactStore {
  put(artifact: SecureArtifact): Promise<string>
}

export interface CPipelineInput {
  generation_spec: GenerationSpec
  evidence_pack: RagEvidencePack
}

export interface CPipelineResult {
  status: "ready" | "blocked" | "failed"
  state: CPipelineState
  generation_spec: GenerationSpec
  public_artifacts: {
    concept_lesson?: ConceptLessonArtifact
    code_lab?: CodeLabPublicArtifact
    assessment?: AssessmentPublicArtifact
  }
  secure_refs: string[]
  alignment_report?: AlignmentReport
  trace_events: AgentTraceEvent[]
  blocked_reason?: BlockedReason
  failure_reason?: FailureReason
}

export async function runCPipeline(
  input: CPipelineInput,
  agents: RoleCAgents,
  secureStore: SecureArtifactStore,
): Promise<CPipelineResult> {
  let state: CPipelineState = "PLANNED"
  const trace: AgentTraceEvent[] = []
  let seq = 1
  const pushTrace = (event: Omit<AgentTraceEvent, "schema_version" | "seq">): void => {
    trace.push(newTraceEvent({ seq, ...event }))
    seq += 1
  }

  const evidenceReport = validateSpecEvidence(input.generation_spec, input.evidence_pack)
  if (!evidenceReport.ok) {
    state = transitionCState(state, "BLOCKED")
    const blockedReason: BlockedReason = {
      code: "BLOCKED_MISSING_EVIDENCE",
      message: "GenerationSpec 与 A 的 evidence_pack 不一致或证据不足",
      details: evidenceReport.issues.map((issue) => issue.message),
    }
    pushTrace({
      event_type: "c.pipeline.blocked",
      run_id: input.generation_spec.run_id,
      status: "blocked",
      input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
      summary: blockedReason.message,
    })
    return blockedResult(input.generation_spec, state, trace, blockedReason)
  }

  pushTrace({
    event_type: "c.spec.ready",
    run_id: input.generation_spec.run_id,
    status: "success",
    input_refs: [input.evidence_pack.retrieval_id],
    output_ref: input.generation_spec.spec_id,
    summary: "GenerationSpec 与 evidence_pack 已通过入口校验",
  })
  state = transitionCState(state, "GENERATING")

  pushTrace({
    event_type: "c.agent.started",
    run_id: input.generation_spec.run_id,
    agent: "concept-tutor",
    status: "started",
    input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
    summary: "concept-tutor 开始生成讲义",
  })
  let concept: ConceptLessonArtifact
  try {
    concept = await agents.concept_tutor.generate({
      generation_spec: input.generation_spec,
      evidence_pack: input.evidence_pack,
    })
  } catch (error) {
    state = transitionCState(state, "FAILED")
    const failure: FailureReason = { code: "PROVIDER_ERROR", message: errorMessage(error) }
    pushTrace({
      event_type: "c.pipeline.failed",
      run_id: input.generation_spec.run_id,
      agent: "concept-tutor",
      status: "failed",
      input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
      summary: failure.message,
    })
    return failedResult(input.generation_spec, state, trace, failure)
  }
  if (concept.status !== "ready") {
    state = transitionCState(state, "BLOCKED")
    pushTrace({
      event_type: "c.pipeline.blocked",
      run_id: input.generation_spec.run_id,
      agent: "concept-tutor",
      status: "blocked",
      input_refs: concept.input_refs,
      output_ref: concept.artifact_id,
      summary: concept.blocked_reason?.message ?? "concept-tutor 未就绪",
    })
    return blockedResult(
      input.generation_spec,
      state,
      trace,
      concept.blocked_reason ?? { code: "BLOCKED_PROVIDER_UNAVAILABLE", message: "concept-tutor 未就绪" },
      { concept_lesson: concept },
    )
  }
  pushTrace({
    event_type: "c.agent.ready",
    run_id: input.generation_spec.run_id,
    agent: "concept-tutor",
    status: "success",
    input_refs: concept.input_refs,
    output_ref: concept.artifact_id,
    summary: "concept-tutor 讲义产物已就绪",
  })

  // Both branches consume the same frozen spec and lesson. They do not edit each other.
  for (const agent of ["code-lab", "tiered-evaluator"] as const) {
    pushTrace({
      event_type: "c.agent.started",
      run_id: input.generation_spec.run_id,
      agent,
      status: "started",
      input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id, concept.artifact_id],
      summary: `${agent} 开始生成`,
    })
  }
  let labPair: CodeLabArtifactPair
  let assessmentPair: AssessmentArtifactPair
  try {
    const [generatedLab, generatedAssessment] = await Promise.all([
      agents.code_lab.generate({
        generation_spec: input.generation_spec,
        evidence_pack: input.evidence_pack,
        concept_artifact: concept,
      }),
      agents.tiered_evaluator.generate({
        generation_spec: input.generation_spec,
        evidence_pack: input.evidence_pack,
        concept_artifact: concept,
      }),
    ])
    labPair = generatedLab
    assessmentPair = generatedAssessment
  } catch (error) {
    state = transitionCState(state, "FAILED")
    const failure: FailureReason = { code: "PROVIDER_ERROR", message: errorMessage(error) }
    pushTrace({
      event_type: "c.pipeline.failed",
      run_id: input.generation_spec.run_id,
      status: "failed",
      input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id, concept.artifact_id],
      summary: failure.message,
    })
    return failedResult(input.generation_spec, state, trace, failure, { concept_lesson: concept })
  }

  const publicArtifacts = {
    concept_lesson: concept,
    code_lab: labPair.public_artifact,
    assessment: assessmentPair.public_artifact,
  }
  const blockedArtifact = [
    labPair.public_artifact,
    labPair.secure_artifact,
    assessmentPair.public_artifact,
    assessmentPair.secure_artifact,
  ].find((artifact) => artifact.status !== "ready")
  if (blockedArtifact) {
    state = transitionCState(state, "BLOCKED")
    pushTrace({
      event_type: "c.pipeline.blocked",
      run_id: input.generation_spec.run_id,
      agent: blockedArtifact.agent,
      status: "blocked",
      input_refs: blockedArtifact.input_refs,
      output_ref: blockedArtifact.artifact_id,
      summary: blockedArtifact.blocked_reason?.message ?? "C 分支产物未就绪",
    })
    return blockedResult(
      input.generation_spec,
      state,
      trace,
      blockedArtifact.blocked_reason ?? { code: "BLOCKED_PROVIDER_UNAVAILABLE", message: "C 分支产物未就绪" },
      publicArtifacts,
    )
  }

  pushTrace({
    event_type: "c.agent.ready",
    run_id: input.generation_spec.run_id,
    agent: "code-lab",
    status: "success",
    input_refs: labPair.public_artifact.input_refs,
    output_ref: labPair.public_artifact.artifact_id,
    summary: "code-lab public/secure 产物已通过发布前门禁",
  })
  pushTrace({
    event_type: "c.agent.ready",
    run_id: input.generation_spec.run_id,
    agent: "tiered-evaluator",
    status: "success",
    input_refs: assessmentPair.public_artifact.input_refs,
    output_ref: assessmentPair.public_artifact.artifact_id,
    summary: "tiered-evaluator public/secure 产物已通过发布前门禁",
  })

  state = transitionCState(state, "VALIDATING")
  const alignmentReport = validateCrossArtifactAlignment({
    spec: input.generation_spec,
    concept,
    lab: labPair.public_artifact,
    assessment: assessmentPair.public_artifact,
  })
  if (!alignmentReport.ok) {
    state = transitionCState(state, "BLOCKED")
    const blockedReason: BlockedReason = {
      code: "BLOCKED_ALIGNMENT_FAILURE",
      message: "目标—讲义—实验—测评未完全对齐",
      details: alignmentReport.objections.map((entry) => `${entry.objective_id}:${entry.issue_type}`),
    }
    pushTrace({
      event_type: "c.validation.failed",
      run_id: input.generation_spec.run_id,
      status: "blocked",
      input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
      summary: blockedReason.message,
    })
    return {
      ...blockedResult(input.generation_spec, state, trace, blockedReason, publicArtifacts),
      alignment_report: alignmentReport,
    }
  }

  let secureRefs: string[]
  try {
    secureRefs = await Promise.all([
      secureStore.put(labPair.secure_artifact),
      secureStore.put(assessmentPair.secure_artifact),
    ])
  } catch (error) {
    state = transitionCState(state, "FAILED")
    const failure: FailureReason = { code: "SECURE_STORE_ERROR", message: errorMessage(error) }
    pushTrace({
      event_type: "c.pipeline.failed",
      run_id: input.generation_spec.run_id,
      status: "failed",
      input_refs: [labPair.secure_artifact.artifact_id, assessmentPair.secure_artifact.artifact_id],
      summary: failure.message,
    })
    return failedResult(input.generation_spec, state, trace, failure, publicArtifacts)
  }
  state = transitionCState(state, "READY")
  pushTrace({
    event_type: "c.pipeline.ready",
    run_id: input.generation_spec.run_id,
    status: "success",
    input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
    summary: "公开产物已就绪；私有产物只返回安全存储引用",
  })
  return {
    status: "ready",
    state,
    generation_spec: input.generation_spec,
    public_artifacts: publicArtifacts,
    secure_refs: secureRefs,
    alignment_report: alignmentReport,
    trace_events: trace,
  }
}

function failedResult(
  spec: GenerationSpec,
  state: CPipelineState,
  trace: AgentTraceEvent[],
  reason: FailureReason,
  publicArtifacts: CPipelineResult["public_artifacts"] = {},
): CPipelineResult {
  return {
    status: "failed",
    state,
    generation_spec: spec,
    public_artifacts: publicArtifacts,
    secure_refs: [],
    trace_events: trace,
    failure_reason: reason,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "C 流水线发生未知错误"
}

function blockedResult(
  spec: GenerationSpec,
  state: CPipelineState,
  trace: AgentTraceEvent[],
  reason: BlockedReason,
  publicArtifacts: CPipelineResult["public_artifacts"] = {},
): CPipelineResult {
  return {
    status: "blocked",
    state,
    generation_spec: spec,
    public_artifacts: publicArtifacts,
    secure_refs: [],
    trace_events: trace,
    blocked_reason: reason,
  }
}
