// Role C content generation pipeline; the directory already identifies the owning role.
import type {
  AssessmentPublicArtifact,
  AssessmentArtifactPair,
  CodeLabArtifactPair,
  CodeLabPublicArtifact,
  ConceptLessonArtifact,
} from "../contracts/artifacts"
import type { SecureArtifact, SecureArtifactStore } from "../security/secure-artifact-store"
import type { BlockedReason, FailureReason } from "../contracts/common"
import type { AgentTraceEvent } from "../contracts/learning-evidence-event"
import { newTraceEvent } from "../contracts/learning-evidence-event"
import type { GenerationSpec } from "../contracts/generation-spec"
import type { FactAuditPacket, FactAuditPort, RagEvidencePack } from "../contracts/evidence-pack"
import type { RoleCAgents } from "../agents/types"
import {
  reportFromObjections,
  validateCrossArtifactAlignment,
  type CrossArtifactCritic,
  type AlignmentReport,
} from "../validators/alignment-validator"
import { detectEvidenceConflicts, validateSpecEvidence } from "../validators/evidence-validator"
import { transitionCState, type CPipelineState } from "./state-machine"
import type { ContentCache } from "../reliability/content-cache"
import { pipelineInputHash } from "../reliability/content-cache"
import type { CPipelineCheckpoint, CPipelineCheckpointStore } from "../reliability/checkpoint-store"
import type { AgentTraceStore } from "../reliability/trace-store"
import { validateRoleCSchema } from "../validators/runtime-schema-validator"
import { validatePublicArtifactNoSecrets } from "../validators/public-secure-leak-validator"

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
  fact_audit_packets: FactAuditPacket[]
  blocked_reason?: BlockedReason
  failure_reason?: FailureReason
}

export interface CPipelineOptions {
  critic?: CrossArtifactCritic
  fact_audit_port?: FactAuditPort
  cache?: ContentCache<CPipelineResult>
  checkpoint_store?: CPipelineCheckpointStore
  trace_store?: AgentTraceStore
  /** Internal continuation offset; callers normally leave this unset. */
  trace_seq_start?: number
}

export async function runCPipeline(
  input: CPipelineInput,
  agents: RoleCAgents,
  secureStore: SecureArtifactStore,
  options: CPipelineOptions = {},
): Promise<CPipelineResult> {
  const inputHash = pipelineInputHash(input)
  const cacheKey = secureStore.namespace_id
    ? pipelineInputHash({ input, secure_store_namespace: secureStore.namespace_id })
    : undefined
  try {
    const cached = cacheKey ? await options.cache?.get(cacheKey) : undefined
    if (cached) {
      if (cached.status !== "ready" || cached.secure_refs.length !== 2) {
        throw new Error("CACHED_PIPELINE_RESULT_INVALID")
      }
      const secureArtifacts = await Promise.all(cached.secure_refs.map((ref) => secureStore.get(ref, {
        principal: "role-c-pipeline",
        run_id: input.generation_spec.run_id,
      })))
      if (cachedResultIssues(cached, input, secureArtifacts).length > 0) {
        throw new Error("CACHED_PIPELINE_RESULT_INVALID")
      }
      return cached
    }
  } catch {
    // Cache/ref validation is an optimization. A stale entry must regenerate through the full trust path.
  }
  let traceSeqStart = options.trace_seq_start ?? 1
  try {
    const prior = await options.trace_store?.read(input.generation_spec.run_id)
    if (prior?.length) traceSeqStart = Math.max(...prior.map((event) => event.seq)) + 1
  } catch { /* return trace remains available even if persistence is unavailable */ }
  const result = await runCPipelineCore(input, agents, secureStore, { ...options, trace_seq_start: traceSeqStart }, inputHash)
  try { if (options.trace_store) await options.trace_store.append(result.trace_events) } catch { /* result still carries the complete trace */ }
  if (result.status === "ready") {
    try { if (cacheKey) await options.cache?.put(cacheKey, result) } catch { /* cache is non-authoritative */ }
    try { await options.checkpoint_store?.delete(inputHash) } catch { /* stale input-hashed checkpoint is safe */ }
  }
  return result
}

async function runCPipelineCore(
  input: CPipelineInput,
  agents: RoleCAgents,
  secureStore: SecureArtifactStore,
  options: CPipelineOptions,
  inputHash: string,
): Promise<CPipelineResult> {
  let state: CPipelineState = "PLANNED"
  const trace: AgentTraceEvent[] = []
  let seq = options.trace_seq_start ?? 1
  const startedAt = new Map<string, number>()
  const pushTrace = (event: Omit<AgentTraceEvent, "schema_version" | "seq">): void => {
    if (event.event_type === "c.agent.started" && event.agent) startedAt.set(event.agent, performance.now())
    const duration = event.event_type === "c.agent.ready" && event.agent && startedAt.has(event.agent)
      ? Math.max(0, Math.round((performance.now() - startedAt.get(event.agent)!) * 1000) / 1000)
      : undefined
    trace.push(newTraceEvent({
      seq,
      occurred_at: new Date().toISOString(),
      versions: input.generation_spec.versions,
      ...(event.agent ? { attempt: event.attempt ?? 1 } : {}),
      ...(duration !== undefined ? { duration_ms: duration } : {}),
      ...event,
    }))
    seq += 1
  }

  const inputSchemaIssues = [
    ...validateRoleCSchema("generation_spec.schema.json", input.generation_spec).issues,
    ...validateRoleCSchema("rag_evidence_pack.schema.json", input.evidence_pack).issues,
  ]
  if (inputSchemaIssues.length > 0) {
    state = transitionCState(state, "BLOCKED")
    const blockedReason: BlockedReason = {
      code: "BLOCKED_INVALID_OUTPUT",
      message: "Role C 入口消息未通过运行时 Schema",
      details: inputSchemaIssues.map((entry) => `${entry.path}:${entry.message}`),
    }
    pushTrace({
      event_type: "c.pipeline.blocked",
      run_id: input.generation_spec.run_id,
      status: "blocked",
      input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
      summary: blockedReason.message,
      validator_results: [{ validator: "runtime-input-schema", ok: false, issue_count: inputSchemaIssues.length }],
    })
    return blockedResult(input.generation_spec, state, trace, blockedReason)
  }

  const conflictReport = detectEvidenceConflicts(input.evidence_pack, input.generation_spec.run_id)
  if (!conflictReport.ok) {
    if (options.fact_audit_port) {
      try {
        await options.fact_audit_port.sendFactAudits(conflictReport.audit_packets)
      } catch (error) {
        state = transitionCState(state, "FAILED")
        const failure: FailureReason = { code: "PROVIDER_ERROR", message: `FactAudit 发送失败：${errorMessage(error)}` }
        pushTrace({
          event_type: "c.pipeline.failed",
          run_id: input.generation_spec.run_id,
          status: "failed",
          input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
          summary: failure.message,
        })
        return failedResult(
          input.generation_spec,
          state,
          trace,
          failure,
          {},
          conflictReport.audit_packets,
        )
      }
    }
    state = transitionCState(state, "BLOCKED")
    const blockedReason: BlockedReason = {
      code: "BLOCKED_EVIDENCE_CONFLICT",
      message: "evidence_pack 存在事实归属或内容冲突，已生成人工核验包",
      details: conflictReport.issues.map((entry) => entry.message),
    }
    pushTrace({
      event_type: "c.pipeline.blocked",
      run_id: input.generation_spec.run_id,
      status: "blocked",
      input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
      summary: blockedReason.message,
      validator_results: [{ validator: "evidence-conflict", ok: false, issue_count: conflictReport.issues.length }],
    })
    return blockedResult(input.generation_spec, state, trace, blockedReason, {}, conflictReport.audit_packets)
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
    validator_results: [{ validator: "spec-evidence", ok: true, issue_count: 0 }],
  })
  state = transitionCState(state, "GENERATING")

  let checkpoint: CPipelineCheckpoint | undefined
  try {
    const loaded = await options.checkpoint_store?.load(inputHash)
    checkpoint = loaded && checkpointIssues(loaded, input, inputHash).length === 0 ? loaded : undefined
  } catch { checkpoint = undefined }

  pushTrace({
    event_type: "c.agent.started",
    run_id: input.generation_spec.run_id,
    agent: "concept-tutor",
    status: "started",
    input_refs: [input.generation_spec.spec_id, input.evidence_pack.retrieval_id],
    summary: "concept-tutor 开始生成讲义",
    ...(checkpoint ? { retry_kind: "resume" as const } : {}),
  })
  let concept: ConceptLessonArtifact
  try {
    concept = checkpoint?.concept ?? await agents.concept_tutor.generate({
      generation_spec: input.generation_spec,
      evidence_pack: input.evidence_pack,
    })
    if (!checkpoint && concept.status === "ready") {
      try { await options.checkpoint_store?.save({ input_hash: inputHash, stage: "concept_ready", concept }) } catch { /* checkpoint is non-authoritative */ }
    }
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
    validator_results: [{ validator: "concept-structure-grounding", ok: true, issue_count: 0 }],
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
      ...(checkpoint?.stage === "branches_ready" ? { retry_kind: "resume" as const } : {}),
    })
  }
  let labPair: CodeLabArtifactPair
  let assessmentPair: AssessmentArtifactPair
  try {
    if (checkpoint?.stage === "branches_ready" && checkpoint.code_lab && checkpoint.assessment) {
      labPair = checkpoint.code_lab
      assessmentPair = checkpoint.assessment
    } else {
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
      if ([labPair.public_artifact, labPair.secure_artifact, assessmentPair.public_artifact, assessmentPair.secure_artifact]
        .every((artifact) => artifact.status === "ready")) {
        try {
          await options.checkpoint_store?.save({
            input_hash: inputHash,
            stage: "branches_ready",
            concept,
            code_lab: labPair,
            assessment: assessmentPair,
          })
        } catch { /* checkpoint is non-authoritative */ }
      }
    }
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

  let publicArtifacts = {
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
    validator_results: [{ validator: "code-lab-structure-execution", ok: true, issue_count: 0 }],
  })
  pushTrace({
    event_type: "c.agent.ready",
    run_id: input.generation_spec.run_id,
    agent: "tiered-evaluator",
    status: "success",
    input_refs: assessmentPair.public_artifact.input_refs,
    output_ref: assessmentPair.public_artifact.artifact_id,
    summary: "tiered-evaluator public/secure 产物已通过发布前门禁",
    validator_results: [{ validator: "assessment-structure-answer", ok: true, issue_count: 0 }],
  })

  state = transitionCState(state, "VALIDATING")
  const alignmentInput = {
    spec: input.generation_spec,
    concept,
    lab: labPair.public_artifact,
    assessment: assessmentPair.public_artifact,
    lab_secure: labPair.secure_artifact,
    assessment_secure: assessmentPair.secure_artifact,
  }
  let criticObjections = validateCrossArtifactAlignment(alignmentInput).objections
  if (options.critic) {
    try {
      criticObjections = [...criticObjections, ...await options.critic.review(alignmentInput)]
    } catch (error) {
      state = transitionCState(state, "FAILED")
      const failure: FailureReason = { code: "PROVIDER_ERROR", message: `cross-artifact critic 失败：${errorMessage(error)}` }
      pushTrace({
        event_type: "c.pipeline.failed",
        run_id: input.generation_spec.run_id,
        status: "failed",
        input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
        summary: failure.message,
      })
      return failedResult(
        input.generation_spec,
        state,
        trace,
        failure,
        publicArtifacts,
      )
    }
  }
  let alignmentReport = reportFromObjections(input.generation_spec, criticObjections)
  if (!alignmentReport.ok) {
    state = transitionCState(state, "REVISING")
    pushTrace({
      event_type: "c.validation.failed",
      run_id: input.generation_spec.run_id,
      status: "started",
      input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
      summary: `跨产物门禁发现 ${alignmentReport.objections.length} 项问题，开始唯一一次定向修订`,
      retry_kind: "semantic_revision",
      attempt: 1,
      validator_results: [{ validator: "cross-artifact-critic", ok: false, issue_count: alignmentReport.objections.length }],
    })

    const conceptNeedsRevision = alignmentReport.objections.some((entry) => entry.target_artifact_id === concept.artifact_id)
    const labNeedsRevision = conceptNeedsRevision || alignmentReport.objections.some((entry) =>
      entry.target_artifact_id === labPair.public_artifact.artifact_id || entry.target_artifact_id === labPair.secure_artifact.artifact_id)
    const assessmentNeedsRevision = conceptNeedsRevision || alignmentReport.objections.some((entry) =>
      entry.target_artifact_id === assessmentPair.public_artifact.artifact_id || entry.target_artifact_id === assessmentPair.secure_artifact.artifact_id)
    try {
      if (conceptNeedsRevision) {
        concept = await agents.concept_tutor.generate({
          generation_spec: input.generation_spec,
          evidence_pack: input.evidence_pack,
          revision_objections: alignmentReport.objections.filter((entry) => entry.target_artifact_id === concept.artifact_id),
        })
      }
      const branches: Promise<void>[] = []
      if (labNeedsRevision) branches.push(agents.code_lab.generate({
        generation_spec: input.generation_spec,
        evidence_pack: input.evidence_pack,
        concept_artifact: concept,
        revision_objections: alignmentReport.objections.filter((entry) =>
          entry.target_artifact_id === labPair.public_artifact.artifact_id || entry.target_artifact_id === labPair.secure_artifact.artifact_id),
      }).then((pair) => { labPair = pair }))
      if (assessmentNeedsRevision) branches.push(agents.tiered_evaluator.generate({
        generation_spec: input.generation_spec,
        evidence_pack: input.evidence_pack,
        concept_artifact: concept,
        code_lab_summary: labPair.public_artifact.payload ? {
          lab_id: labPair.public_artifact.payload.lab_id,
          objective_ids: [...labPair.public_artifact.payload.objective_ids],
          execution_verified: labPair.public_artifact.quality.execution_verified === true,
        } : undefined,
        revision_objections: alignmentReport.objections.filter((entry) =>
          entry.target_artifact_id === assessmentPair.public_artifact.artifact_id || entry.target_artifact_id === assessmentPair.secure_artifact.artifact_id),
      }).then((pair) => { assessmentPair = pair }))
      await Promise.all(branches)
    } catch (error) {
      state = transitionCState(state, "FAILED")
      const failure: FailureReason = { code: "PROVIDER_ERROR", message: errorMessage(error) }
      pushTrace({
        event_type: "c.pipeline.failed",
        run_id: input.generation_spec.run_id,
        status: "failed",
        input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
        summary: `定向修订失败：${failure.message}`,
        retry_kind: "semantic_revision",
        attempt: 1,
      })
      return failedResult(input.generation_spec, state, trace, failure, publicArtifacts)
    }

    publicArtifacts = { concept_lesson: concept, code_lab: labPair.public_artifact, assessment: assessmentPair.public_artifact }
    const revisedBlocked = [concept, labPair.public_artifact, labPair.secure_artifact, assessmentPair.public_artifact, assessmentPair.secure_artifact]
      .find((artifact) => artifact.status !== "ready")
    if (revisedBlocked) {
      state = transitionCState(state, "BLOCKED")
      const blockedReason = revisedBlocked.blocked_reason
        ?? { code: "BLOCKED_INVALID_OUTPUT" as const, message: "定向修订产物未通过自身门禁" }
      pushTrace({
        event_type: "c.pipeline.blocked",
        run_id: input.generation_spec.run_id,
        agent: revisedBlocked.agent,
        status: "blocked",
        input_refs: revisedBlocked.input_refs,
        output_ref: revisedBlocked.artifact_id,
        summary: blockedReason.message,
        retry_kind: "semantic_revision",
        attempt: 1,
      })
      return blockedResult(
        input.generation_spec,
        state,
        trace,
        blockedReason,
        publicArtifacts,
      )
    }
    state = transitionCState(state, "VALIDATING")
    const revisedAlignmentInput = {
      spec: input.generation_spec,
      concept,
      lab: labPair.public_artifact,
      assessment: assessmentPair.public_artifact,
      lab_secure: labPair.secure_artifact,
      assessment_secure: assessmentPair.secure_artifact,
    }
    let revisedObjections = validateCrossArtifactAlignment(revisedAlignmentInput).objections
    if (options.critic) {
      try { revisedObjections = [...revisedObjections, ...await options.critic.review(revisedAlignmentInput)] } catch (error) {
        state = transitionCState(state, "FAILED")
        const failure: FailureReason = { code: "PROVIDER_ERROR", message: `修订后 critic 失败：${errorMessage(error)}` }
        pushTrace({
          event_type: "c.pipeline.failed",
          run_id: input.generation_spec.run_id,
          status: "failed",
          input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
          summary: failure.message,
          retry_kind: "semantic_revision",
          attempt: 1,
        })
        return failedResult(
          input.generation_spec,
          state,
          trace,
          failure,
          publicArtifacts,
        )
      }
    }
    alignmentReport = reportFromObjections(input.generation_spec, revisedObjections)
    if (!alignmentReport.ok) {
      state = transitionCState(state, "BLOCKED")
      const blockedReason: BlockedReason = {
        code: "BLOCKED_ALIGNMENT_FAILURE",
        message: "唯一一次定向修订后仍存在关键对齐问题",
        details: alignmentReport.objections.map((entry) => `${entry.objective_id}:${entry.issue_type}`),
      }
      pushTrace({
        event_type: "c.pipeline.blocked",
        run_id: input.generation_spec.run_id,
        status: "blocked",
        input_refs: [concept.artifact_id, labPair.public_artifact.artifact_id, assessmentPair.public_artifact.artifact_id],
        summary: blockedReason.message,
      })
      return { ...blockedResult(input.generation_spec, state, trace, blockedReason, publicArtifacts), alignment_report: alignmentReport }
    }
  }

  for (const artifact of [concept, labPair.public_artifact, labPair.secure_artifact, assessmentPair.public_artifact, assessmentPair.secure_artifact]) {
    artifact.quality.alignment_score = alignmentReport.alignment_score
  }

  let secureRefs: string[]
  try {
    secureRefs = await secureStore.putBatch(
      [labPair.secure_artifact, assessmentPair.secure_artifact],
      { principal: "role-c-pipeline", run_id: input.generation_spec.run_id },
    )
    if (secureRefs.length !== 2 || new Set(secureRefs).size !== 2) {
      try { await secureStore.deleteBatch(secureRefs, { principal: "role-c-pipeline", run_id: input.generation_spec.run_id }) } catch { /* bad store result is already fatal */ }
      throw new Error("secure store 未原子返回两份不同的私有产物引用")
    }
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
    fact_audit_packets: [],
  }
}

function cachedResultIssues(
  cached: CPipelineResult,
  input: CPipelineInput,
  secureArtifacts: SecureArtifact[],
): string[] {
  const issues: string[] = []
  if (cached.status !== "ready" || cached.state !== "READY") issues.push("cached result 未处于 READY")
  if (cached.generation_spec.run_id !== input.generation_spec.run_id
    || cached.generation_spec.spec_id !== input.generation_spec.spec_id
    || cached.generation_spec.evidence_ref !== input.evidence_pack.retrieval_id) {
    issues.push("cached result 与当前输入身份不一致")
  }
  const publicArtifacts = [
    [cached.public_artifacts.concept_lesson, "concept_artifact.schema.json"],
    [cached.public_artifacts.code_lab, "code_lab_public.schema.json"],
    [cached.public_artifacts.assessment, "assessment_public.schema.json"],
  ] as const
  for (const [artifact, schema] of publicArtifacts) {
    if (!artifact || artifact.status !== "ready" || artifact.run_id !== input.generation_spec.run_id) {
      issues.push(`${schema} 缺失或身份无效`)
      continue
    }
    issues.push(...validateRoleCSchema(schema, artifact).issues.map((entry) => `${schema}:${entry.path}`))
    issues.push(...validatePublicArtifactNoSecrets(artifact).issues.map((entry) => `${schema}:${entry.path}`))
  }
  if (secureArtifacts.length !== 2
    || !sameStringSet(secureArtifacts.map((artifact) => artifact.artifact_type), ["code_lab_secure", "assessment_secure"])) {
    issues.push("cached secure refs 未解析为一份实验和一份测评私有产物")
  }
  if (!cached.alignment_report?.ok) issues.push("cached result 缺少通过的 alignment report")
  for (const event of cached.trace_events) {
    if (event.run_id !== input.generation_spec.run_id || !validateRoleCSchema("agent_trace_event.schema.json", event).ok) {
      issues.push("cached trace 无效")
    }
  }
  return issues
}

function checkpointIssues(
  checkpoint: CPipelineCheckpoint,
  input: CPipelineInput,
  inputHash: string,
): string[] {
  const issues: string[] = []
  if (checkpoint.input_hash !== inputHash) issues.push("checkpoint input_hash 不一致")
  const artifacts: Array<[unknown, "concept_artifact.schema.json" | "code_lab_public.schema.json" | "code_lab_secure.schema.json" | "assessment_public.schema.json" | "assessment_secure.schema.json"]> = [
    [checkpoint.concept, "concept_artifact.schema.json"],
  ]
  if (checkpoint.stage === "branches_ready") {
    if (!checkpoint.code_lab || !checkpoint.assessment) issues.push("branches_ready checkpoint 缺少分支")
    else artifacts.push(
      [checkpoint.code_lab.public_artifact, "code_lab_public.schema.json"],
      [checkpoint.code_lab.secure_artifact, "code_lab_secure.schema.json"],
      [checkpoint.assessment.public_artifact, "assessment_public.schema.json"],
      [checkpoint.assessment.secure_artifact, "assessment_secure.schema.json"],
    )
  }
  for (const [value, schema] of artifacts) {
    const artifact = value as { run_id?: string; status?: string; input_refs?: string[] }
    if (artifact.run_id !== input.generation_spec.run_id || artifact.status !== "ready"
      || !artifact.input_refs?.includes(input.generation_spec.spec_id)
      || !validateRoleCSchema(schema, value).ok) {
      issues.push(`${schema} checkpoint 产物无效`)
    }
  }
  return issues
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === left.length && rightSet.size === right.length
    && leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value))
}

function failedResult(
  spec: GenerationSpec,
  state: CPipelineState,
  trace: AgentTraceEvent[],
  reason: FailureReason,
  publicArtifacts: CPipelineResult["public_artifacts"] = {},
  factAuditPackets: FactAuditPacket[] = [],
): CPipelineResult {
  return {
    status: "failed",
    state,
    generation_spec: spec,
    public_artifacts: publicArtifacts,
    secure_refs: [],
    trace_events: trace,
    fact_audit_packets: factAuditPackets,
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
  factAuditPackets: FactAuditPacket[] = [],
): CPipelineResult {
  return {
    status: "blocked",
    state,
    generation_spec: spec,
    public_artifacts: publicArtifacts,
    secure_refs: [],
    trace_events: trace,
    fact_audit_packets: factAuditPackets,
    blocked_reason: reason,
  }
}
