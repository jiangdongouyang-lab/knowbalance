import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { loadKnowledgeBase } from "../knowledge/loader"
import { resolveLearningGoalSpec } from "../knowledge/curriculum"
import { selectDiagnosticItems } from "../knowledge/diagnostic-selector"
import { loadLearnerMemory } from "./learner-memory"
import { createScaffoldWorkerInvocation, runWorkerAdapter } from "./worker-adapters"
import { ORCHESTRATION_WORKER_SEQUENCE } from "./state-machine"
import { validateWorkerResult } from "./worker-contract"
import type { LearnerRequest, OrchestrationMode, WorkerName } from "./types"
import type { BackgroundEvidence, DiagnosisItem, ObjectiveDiagnosisEvidence, SelfAssessmentEvidence } from "../role-b-profile/types"
import type { AssessmentPublicArtifact, AssessmentSecureArtifact, SubmissionAnswer } from "../role-c-content/contracts/artifacts"
import type { NextRoundGenerationContext } from "../role-c-content/agents/types"
import type { RoleCAdaptationInfo } from "../role-c-content/contracts/external-api"
import type { DynamicFeedbackResult, ObjectiveRoundResult } from "../role-c-content/contracts/dynamic-feedback"
import {
  createAtomicRoleCLearningPersistence,
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessmentAnchors,
  submitRoleCAssessment,
  type RoleCForRoleDRuntimeOptions,
} from "../role-d-integration/role-c-service"
import type { LearnerProfile } from "../role-b-profile/types"
import type { RagResult } from "../rag/retriever"
import { advanceToNextNode, type FormalLearningPath } from "../role-b-profile/teaching-audit/formal-path"
import type { LearningPathNode } from "../role-c-content/contracts/profile-adapter"

export type InteractiveSessionStatus = "waiting_for_user" | "running" | "completed" | "blocked" | "failed"
export type InteractiveStage = "objective_diagnosis" | "assessment" | "completed" | "blocked" | "failed"

export interface PublicWorkerLedgerEntry {
  worker: WorkerName
  status: "completed" | "waiting_for_user" | "running" | "blocked" | "failed" | "pending"
  summary: string
  updated_at: string
}

export interface InteractiveEvent {
  event_id: string
  event_type: "session_created" | "worker_completed" | "worker_invoked" | "waiting_for_user" | "command_received" | "session_updated" | "session_completed" | "session_blocked"
  stage: InteractiveStage
  worker?: WorkerName
  message: string
  timestamp: string
}

export interface PublicDiagnosisItem {
  item_id: string
  source_id: string
  fact_id: string | null
  concept: string
  difficulty: string
  question: string
  options?: string[]
}

export interface InteractiveSessionRecord {
  schema_version: "1.0"
  session_id: string
  run_id: string
  owner_id: string
  mode: OrchestrationMode
  learner_request: LearnerRequest
  status: InteractiveSessionStatus
  current_stage: InteractiveStage
  round_no: number
  waiting_for: null | {
    type: "diagnosis_answers" | "anchor_answers" | "assessment_answers" | "clarification_answer"
    items: unknown[]
  }
  /** 锚点路由状态：生成后为 ANCHOR_PENDING，锚点提交后为 ROUTE_LOCKED。 */
  anchor_routing: null | {
    phase: "ANCHOR_PENDING" | "ROUTE_LOCKED"
    routing_request_id: string
    anchor_item_ids: string[]
    route_id?: string
    action?: "remediate" | "reinforce" | "advance"
    anchor_score_ratio?: number
    required_item_ids?: string[]
  }
  worker_ledger: PublicWorkerLedgerEntry[]
  profile: unknown | null
  formal_path: unknown | null
  current_path_node: unknown | null
  rag_result: unknown | null
  learning_resources: { concept_lesson: unknown | null; code_lab: unknown | null }
  assessment: unknown | null
  /** 本轮生成相对上一轮的适配信息（remediate/reinforce 时存在）。 */
  adaptation: unknown | null
  feedback: unknown | null
  blocked_reason: string | null
  events: InteractiveEvent[]
  processed_commands: Record<string, { request_hash: string; response: InteractiveSessionPublicView }>
  private: {
    diagnosis_answer_key: Record<string, string>
    diagnosis_answers: Record<string, string> | null
    diagnosis_items: PublicDiagnosisItem[]
    upstream_artifacts: Record<string, unknown>
    /** 评分后暂存给后台生成的下一轮上下文；生成完成即清空。 */
    next_round_context: NextRoundGenerationContext | null
    role_c_generation_attempt: number
    role_c: null | {
      data_directory: string
      session_id: string
      run_id: string
      learner_id: string
      form_id: string
      attempt_no: number
    }
  }
  created_at: string
  updated_at: string
}

export type InteractiveSessionPublicView = Omit<InteractiveSessionRecord, "private" | "processed_commands" | "learner_request" | "owner_id" | "events"> & {
  events?: never
}

export interface CreateInteractiveSessionInput {
  session_id?: string
  run_id?: string
  mode: OrchestrationMode
  learner_request: LearnerRequest
  owner_id: string
}

export interface InteractiveSessionCommand {
  command_id: string
  type: "submit_diagnosis_answers" | "submit_anchor_answers" | "submit_assessment_answers" | "retry"
  payload?: {
    answers?: Record<string, string> | SubmissionAnswer[]
  }
}

export class InteractiveSessionStore {
  private readonly commandQueues = new Map<string, Promise<unknown>>()
  private readonly createQueues = new Map<string, Promise<InteractiveSessionRecord>>()

  constructor(readonly data_root: string) {}

  async create(input: CreateInteractiveSessionInput): Promise<InteractiveSessionRecord> {
    const sessionId = safeId(input.session_id ?? `SESSION-${randomUUID()}`)
    const existingCreate = this.createQueues.get(sessionId)
    if (existingCreate) {
      await existingCreate.catch(() => undefined)
      throw new InteractiveSessionError("SESSION_ALREADY_EXISTS", `Session ${sessionId} already exists`, 409)
    }
    const operation = this.withSessionLock(sessionId, () => this.createUnlocked({ ...input, session_id: sessionId }))
    this.createQueues.set(sessionId, operation)
    try {
      return await operation
    } finally {
      if (this.createQueues.get(sessionId) === operation) this.createQueues.delete(sessionId)
    }
  }

  private async createUnlocked(input: CreateInteractiveSessionInput): Promise<InteractiveSessionRecord> {
    const sessionId = safeId(input.session_id!)
    const existing = await this.loadOptional(sessionId)
    if (existing) throw new InteractiveSessionError("SESSION_ALREADY_EXISTS", `Session ${sessionId} already exists`, 409)

    const now = new Date().toISOString()
    const knowledgeBase = await loadKnowledgeBase()
    const goalSpec = resolveLearningGoalSpec(input.learner_request.learning_goal_spec ?? {
      mode: "custom_goal",
      custom_goal: input.learner_request.goal,
    })
    const learnerId = input.learner_request.learner_id ?? sessionId
    const learnerMemory = await loadLearnerMemory(this.data_root, learnerId)
    const targetItems = knowledgeBase.items.filter((item) => goalSpec.mapped_source_ids.includes(item.sourceId))
    const selection = selectDiagnosticItems({
      knowledgeBase,
      target_source_ids: goalSpec.mapped_source_ids,
      prerequisite_source_ids: [...new Set(targetItems.flatMap((item) => item.prerequisites))],
      learner_memory: learnerMemory,
      max_items: 5,
    })
    const diagnosisItems: PublicDiagnosisItem[] = selection.items.map((item, index) => ({
      item_id: `DIAG-${index + 1}-${item.source_id}`,
      source_id: item.source_id,
      fact_id: item.fact_id,
      concept: item.concept,
      difficulty: item.difficulty,
      question: item.question,
      options: item.options ? [...item.options] : undefined,
    }))
    const answerKey = Object.fromEntries(selection.items.map((item, index) => [diagnosisItems[index]!.item_id, item.answer]))
    const events: InteractiveEvent[] = [
      event(sessionId, "session_created", "objective_diagnosis", "learning-orchestrator created a persistent session", now),
      event(sessionId, "worker_completed", "objective_diagnosis", "background-collector accepted learner background", now, "background-collector"),
      event(sessionId, "worker_completed", "objective_diagnosis", "self-assessor accepted learner self assessment", now, "self-assessor"),
      event(sessionId, "worker_invoked", "objective_diagnosis", "objective-diagnostician prepared grounded questions", now, "objective-diagnostician"),
      event(sessionId, "waiting_for_user", "objective_diagnosis", "waiting for diagnosis answers", now, "objective-diagnostician"),
    ]
    const record: InteractiveSessionRecord = {
      schema_version: "1.0",
      session_id: sessionId,
      run_id: safeId(input.run_id ?? `RUN-${randomUUID()}`),
      owner_id: input.owner_id,
      mode: input.mode,
      learner_request: structuredClone(input.learner_request),
      status: "waiting_for_user",
      current_stage: "objective_diagnosis",
      round_no: 1,
      waiting_for: { type: "diagnosis_answers", items: diagnosisItems },
      worker_ledger: [
        { worker: "background-collector", status: "completed", summary: "已收集学习背景", updated_at: now },
        { worker: "self-assessor", status: "completed", summary: "已收集学习者自评", updated_at: now },
        { worker: "objective-diagnostician", status: "waiting_for_user", summary: "等待诊断作答", updated_at: now },
      ],
      profile: null,
      formal_path: null,
      current_path_node: null,
      rag_result: null,
      learning_resources: { concept_lesson: null, code_lab: null },
      assessment: null,
      adaptation: null,
      anchor_routing: null,
      feedback: null,
      blocked_reason: null,
      events,
      processed_commands: {},
      private: { diagnosis_answer_key: answerKey, diagnosis_answers: null, diagnosis_items: diagnosisItems, upstream_artifacts: {}, next_round_context: null, role_c_generation_attempt: 0, role_c: null },
      created_at: now,
      updated_at: now,
    }
    await this.save(record)
    return record
  }

  async load(sessionId: string): Promise<InteractiveSessionRecord> {
    const record = await this.loadOptional(safeId(sessionId))
    if (!record) throw new InteractiveSessionError("SESSION_NOT_FOUND", `Session ${sessionId} was not found`, 404)
    return record
  }

  async command(sessionId: string, command: InteractiveSessionCommand): Promise<InteractiveSessionPublicView> {
    const safeSessionId = safeId(sessionId)
    const previous = this.commandQueues.get(safeSessionId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.withSessionLock(safeSessionId, () => this.executeCommand(safeSessionId, command)))
    this.commandQueues.set(safeSessionId, operation)
    try {
      return await operation
    } finally {
      if (this.commandQueues.get(safeSessionId) === operation) this.commandQueues.delete(safeSessionId)
    }
  }

  private async executeCommand(sessionId: string, command: InteractiveSessionCommand): Promise<InteractiveSessionPublicView> {
    validateCommand(command)
    const record = await this.load(sessionId)
    const requestHash = hashJson(command)
    const replay = record.processed_commands[command.command_id]
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new InteractiveSessionError("COMMAND_ID_REUSED", "command_id was already used with different content", 409)
      }
      return structuredClone(replay.response)
    }

    let updated: InteractiveSessionRecord
    if (command.type === "submit_diagnosis_answers") {
      if (record.status !== "waiting_for_user" || record.waiting_for?.type !== "diagnosis_answers") {
        throw new InteractiveSessionError("COMMAND_NOT_ALLOWED", "This session is not waiting for diagnosis answers", 409)
      }
      updated = await continueAfterDiagnosis(record, command, this.data_root)
    } else if (command.type === "submit_anchor_answers") {
      if (record.status !== "waiting_for_user" || record.waiting_for?.type !== "anchor_answers") {
        throw new InteractiveSessionError("COMMAND_NOT_ALLOWED", "This session is not waiting for anchor answers", 409)
      }
      updated = await continueAfterAnchorAnswers(record, command, this.data_root)
    } else if (command.type === "submit_assessment_answers") {
      if (record.status !== "waiting_for_user" || record.waiting_for?.type !== "assessment_answers") {
        throw new InteractiveSessionError("COMMAND_NOT_ALLOWED", "This session is not waiting for assessment answers", 409)
      }
      updated = await continueAfterAssessment(record, command, this.data_root)
      // 评分已返回；下一轮内容后台生成，完成后写回会话（前端轮询状态）。
      if (updated.status === "running" && updated.private.next_round_context) {
        void this.generateNextRoundInBackground(
          sessionId,
          updated.private.next_round_context,
        )
      }
    } else {
      if (record.status !== "blocked" && record.status !== "failed") {
        throw new InteractiveSessionError("COMMAND_NOT_ALLOWED", "This session is not blocked and cannot be retried", 409)
      }
      updated = await retryInteractiveSession(record, this.data_root)
    }

    const response = publicSessionView(updated)
    updated.processed_commands[command.command_id] = { request_hash: requestHash, response }
    await this.save(updated)
    return response
  }

  async save(record: InteractiveSessionRecord): Promise<void> {
    const dir = join(this.data_root, "sessions")
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${safeId(record.session_id)}.json`)
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    await rename(temporary, path)
  }

  /**
   * 后台生成下一轮内容（不占命令锁）。生成中会话为 running 状态，
   * 其他命令会被拒绝；完成后写回 round 2 内容与 adaptation。
   */
  private async generateNextRoundInBackground(
    sessionId: string,
    nextRoundContext: NextRoundGenerationContext,
  ): Promise<void> {
    try {
      const current = await this.load(sessionId)
      const record = structuredClone(current)
      const path = record.formal_path as FormalLearningPath | null
      const node = record.current_path_node as LearningPathNode | null
      if (!path || !node) throw new Error("next round generation missing path or node")
      const next = await generateFormalRoleCRound(
        record,
        path,
        node,
        this.data_root,
        nextRoundContext,
      )
      if (!next.ok) {
        record.status = "blocked"
        record.current_stage = "blocked"
        record.blocked_reason = next.reason
        record.events.push(event(record.session_id, "session_blocked", "blocked", next.reason, new Date().toISOString()))
        record.updated_at = new Date().toISOString()
        await this.save(record)
        return
      }
      applyFormalRoleCRound(record, next)
      record.private.next_round_context = null
      record.updated_at = new Date().toISOString()
      record.events.push(event(
        record.session_id,
        "waiting_for_user",
        "assessment",
        `round ${record.round_no} waiting for assessment answers`,
        record.updated_at,
        "tiered-evaluator",
      ))
      await this.save(record)
    } catch (error) {
      try {
        const current = await this.load(sessionId)
        current.status = "failed"
        current.current_stage = "failed"
        current.blocked_reason = error instanceof Error
          ? error.message
          : "next round generation failed"
        current.updated_at = new Date().toISOString()
        await this.save(current)
      } catch { /* 后台失败时不再二次写入 */ }
    }
  }

  private async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const lockDirectory = join(this.data_root, "locks")
    await mkdir(lockDirectory, { recursive: true })
    const lockPath = join(lockDirectory, `${safeId(sessionId)}.lock`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(lockPath, "wx")
        break
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
        await Bun.sleep(10)
      }
    }
    if (!handle) throw new InteractiveSessionError("SESSION_BUSY", `Session ${sessionId} is busy`, 409)
    try {
      return await action()
    } finally {
      await handle.close().catch(() => undefined)
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }

  private async loadOptional(sessionId: string): Promise<InteractiveSessionRecord | null> {
    try {
      return JSON.parse(await readFile(join(this.data_root, "sessions", `${sessionId}.json`), "utf8")) as InteractiveSessionRecord
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error
    }
  }
}

export function publicSessionView(record: InteractiveSessionRecord): InteractiveSessionPublicView {
  const { private: _private, processed_commands: _processed, learner_request: _request, owner_id: _owner, events: _events, ...view } = structuredClone(record)
  return view
}

export class InteractiveSessionError extends Error {
  constructor(readonly code: string, message: string, readonly http_status: number, readonly details?: string[]) {
    super(message)
  }
}

async function retryInteractiveSession(
  original: InteractiveSessionRecord,
  dataRoot: string,
): Promise<InteractiveSessionRecord> {
  const record = structuredClone(original)
  record.blocked_reason = null
  if (feedbackDecisionAction(record.feedback) === "advance") {
    const path = record.formal_path as FormalLearningPath | null
    const node = record.current_path_node as LearningPathNode | null
    if (!path || !node) {
      record.status = "completed"
      record.current_stage = "completed"
      record.waiting_for = null
      record.updated_at = new Date().toISOString()
      return record
    }
    const next = await generateFormalRoleCRound(record, path, node, dataRoot)
    if (!next.ok) {
      record.status = "blocked"
      record.current_stage = "blocked"
      record.waiting_for = null
      record.blocked_reason = next.reason
      record.events.push(event(record.session_id, "session_blocked", "blocked", next.reason, new Date().toISOString()))
      record.updated_at = new Date().toISOString()
      return record
    }
    applyFormalRoleCRound(record, next)
    record.updated_at = new Date().toISOString()
    return record
  }
  if (record.private.role_c && record.assessment && record.current_path_node && record.formal_path) {
    record.status = "waiting_for_user"
    record.current_stage = "assessment"
    const assessment = record.assessment as { payload?: { items?: unknown[] } }
    record.waiting_for = { type: "assessment_answers", items: assessment.payload?.items ?? [] }
    record.events.push(event(record.session_id, "session_updated", "assessment", "retry restored the assessment checkpoint", new Date().toISOString()))
    record.updated_at = new Date().toISOString()
    return record
  }
  const path = record.formal_path as FormalLearningPath | null
  const node = record.current_path_node as LearningPathNode | null
  if (record.profile && path && node && record.rag_result) {
    record.private.role_c_generation_attempt = (record.private.role_c_generation_attempt ?? 0) + 1
    const next = await generateFormalRoleCRound(record, path, node, dataRoot)
    if (!next.ok) {
      record.status = "blocked"
      record.current_stage = "blocked"
      record.waiting_for = null
      record.blocked_reason = next.reason
      record.events.push(event(record.session_id, "session_blocked", "blocked", next.reason, new Date().toISOString()))
      record.updated_at = new Date().toISOString()
      return record
    }
    applyFormalRoleCRound(record, next)
    markReviewedRoleCWorkers(record)
    record.updated_at = new Date().toISOString()
    return record
  }
  if (!record.private.diagnosis_answers) {
    throw new InteractiveSessionError("RETRY_CHECKPOINT_MISSING", "The original learner diagnosis answers are unavailable; create a new plan instead of fabricating answers", 409)
  }
  const retryCommand: InteractiveSessionCommand = {
    command_id: `RETRY-${Date.now()}`,
    type: "submit_diagnosis_answers",
    payload: { answers: structuredClone(record.private.diagnosis_answers) },
  }
  return continueAfterDiagnosis(record, retryCommand, dataRoot)
}

async function continueAfterAssessment(
  original: InteractiveSessionRecord,
  command: InteractiveSessionCommand,
  dataRoot: string,
): Promise<InteractiveSessionRecord> {
  const answers = command.payload?.answers
  if (!Array.isArray(answers)) {
    throw new InteractiveSessionError("INVALID_COMMAND", "submit_assessment_answers requires payload.answers array", 400)
  }
  const record = structuredClone(original)
  const roleC = record.private.role_c
  const path = record.formal_path as FormalLearningPath | null
  const currentNode = record.current_path_node as LearningPathNode | null
  if (!roleC || !record.assessment || !path || !currentNode) {
    throw new InteractiveSessionError("SESSION_ARTIFACT_MISSING", "Assessment session is missing trusted Role C identities", 409)
  }

  const submissionId = `SUB-${record.session_id}-R${record.round_no}-${command.command_id}`
  const outcome = await submitRoleCAssessment({
    sessionId: roleC.session_id,
    runId: roleC.run_id,
    learnerId: roleC.learner_id,
    formId: roleC.form_id,
    attemptNo: roleC.attempt_no,
    submissionId,
    answers: structuredClone(answers),
  }, roleCRuntime(dataRoot))
  if (outcome.status === "blocked") {
    record.status = "blocked"
    record.current_stage = "blocked"
    record.blocked_reason = `${outcome.code}: ${outcome.message}`
    record.events.push(event(record.session_id, "session_blocked", "blocked", record.blocked_reason, new Date().toISOString(), "tiered-evaluator"))
    record.updated_at = new Date().toISOString()
    return record
  }
  if (outcome.status === "needs_review") {
    record.status = "blocked"
    record.current_stage = "blocked"
    record.blocked_reason = `assessment requires review: ${outcome.unresolved_item_ids.join(",")}`
    record.events.push(event(record.session_id, "session_blocked", "blocked", record.blocked_reason, new Date().toISOString(), "tiered-evaluator"))
    record.updated_at = new Date().toISOString()
    return record
  }

  record.feedback = {
    ...outcome.feedback,
    assessment_items: (record.assessment as { payload?: unknown } | null)?.payload ?? null,
    your_answers: answers.map((answer: any) => ({
      item_id: answer.item_id,
      selected_option_id: answer.selected_option_id ?? null,
      text_response: answer.text_response ?? null,
      code_response: answer.code_response ?? null,
    })),
  }
  record.events.push(event(record.session_id, "command_received", "assessment", "Role C accepted and graded assessment answers", new Date().toISOString(), "tiered-evaluator"))
  // 画像漂移：不推进路径、不生成下一轮，回到诊断阶段重建学习者画像。
  if (outcome.feedback.final_decision.action === "reprofile") {
    return resetToDiagnosisPhase(record, dataRoot)
  }
  const advance = advanceToNextNode({
    path,
    updatedProfileSnapshot: path.profile_snapshot,
    decisionAction: outcome.feedback.final_decision.action,
  })
  record.formal_path = advance.path
  if (advance.pathCompleted || !advance.nextPathNode) {
    record.current_path_node = null
    record.status = "completed"
    record.current_stage = "completed"
    record.waiting_for = null
    record.events.push(event(record.session_id, "session_completed", "completed", "formal learning path completed", new Date().toISOString()))
    record.updated_at = new Date().toISOString()
    return record
  }

  record.current_path_node = advance.nextPathNode
  record.private.role_c_generation_attempt = 0
  record.round_no += 1
  const nextRoundContext = buildNextRoundContext(
    outcome.feedback,
    roleC.run_id,
    `NRC-${record.session_id}-R${record.round_no}`,
  )
  // 提交响应先返回评分反馈：下一轮内容在后台生成，前端轮询会话状态。
  record.status = "running"
  record.current_stage = "assessment"
  record.waiting_for = null
  record.private.next_round_context = nextRoundContext ?? null
  record.events.push(event(
    record.session_id,
    "session_updated",
    "assessment",
    `round ${record.round_no} generation started in background`,
    record.updated_at,
    "tiered-evaluator",
  ))
  return record
}

interface FormalRoleCRound {
  ok: true
  run_id: string
  learning_session: {
    session_id: string
    form_id: string
    attempt_no: number
    routing_request_id?: string
    anchor_item_ids?: string[]
  }
  concept_lesson: unknown
  code_lab: unknown
  assessment: unknown
  rag_result: RagResult
  /** 本轮相对上一轮的适配信息（remediate/reinforce 时存在），随会话公开给 D。 */
  adaptation?: RoleCAdaptationInfo
}

type FormalRoleCRoundResult = FormalRoleCRound | { ok: false; reason: string }

export function roleCRoundRunId(baseRunId: string, roundNo: number, generationAttempt: number): string {
  return `${baseRunId}-R${roundNo}-C${generationAttempt + 1}`
}

/** 与主 Agent 动态规划对齐的阈值：<40% 针对性补救，<80% 巩固强化。 */
export const REMEDIATE_ACCURACY_THRESHOLD = 0.4
export const REINFORCE_ACCURACY_THRESHOLD = 0.8

/**
 * 根据本轮评分结果选择下一轮的聚焦目标：
 * remediate → 低分目标（accuracy < 0.4）；reinforce → 不稳定目标（0.4..0.8）；
 * advance → 全部目标。
 */
export function focusObjectivesForNextRound(
  results: ObjectiveRoundResult[],
  action: DynamicFeedbackResult["final_decision"]["action"],
): string[] {
  if (action === "remediate") {
    return results
      .filter((result) => result.accuracy < REMEDIATE_ACCURACY_THRESHOLD)
      .map((result) => result.objective_id)
  }
  if (action === "reinforce") {
    return results
      .filter((result) => result.accuracy >= REMEDIATE_ACCURACY_THRESHOLD
        && result.accuracy < REINFORCE_ACCURACY_THRESHOLD)
      .map((result) => result.objective_id)
  }
  return results.map((result) => result.objective_id)
}

/**
 * 从本轮评分反馈构造传给 C 的 next_round_context：
 * action/聚焦目标/上一轮误区标签/反馈引用。reprofile 不进入生成轮（返回 undefined）。
 */
export function buildNextRoundContext(
  feedback: DynamicFeedbackResult,
  parentSpecId: string,
  requestId: string,
): NextRoundGenerationContext | undefined {
  const action = feedback.final_decision.action
  if (action === "reprofile") return undefined
  const focus = focusObjectivesForNextRound(feedback.objective_results, action)
  const misconceptionTags = focus.length > 0
    ? [
        ...new Set(feedback.objective_results
          .filter((result) => focus.includes(result.objective_id))
          .flatMap((result) => result.misconception_tags)),
      ]
    : []
  return {
    request_id: requestId,
    parent_spec_id: parentSpecId,
    prior_feedback_ref: feedback.feedback_id,
    trigger_grade_artifact_id: feedback.grade_result.artifact_id,
    action,
    focus_objective_ids: focus,
    reason_codes: [...feedback.final_decision.reason_codes],
    ...(misconceptionTags.length > 0 ? { misconception_tags: misconceptionTags } : {}),
  }
}

export function interactiveSessionProductionBoundary() {
  return {
    adapter_workers: ["profile-builder", "path-planner"] as const,
    reviewed_role_c_workers: ["concept-tutor", "code-lab", "tiered-evaluator"] as const,
    review_port: "local-ab-content-review" as const,
  }
}

function roleCRuntime(dataRoot: string): RoleCForRoleDRuntimeOptions {
  const dataDirectory = join(dataRoot, "role-c")
  return {
    providerMode: "model" as const,
    dataDirectory,
    learningPersistence: createAtomicRoleCLearningPersistence(dataDirectory),
  }
}

async function generateFormalRoleCRound(
  record: InteractiveSessionRecord,
  path: FormalLearningPath,
  node: LearningPathNode,
  dataRoot: string,
  nextRoundContext?: NextRoundGenerationContext,
): Promise<FormalRoleCRoundResult> {
  const runId = roleCRoundRunId(
    record.run_id,
    record.round_no,
    record.private.role_c_generation_attempt ?? 0,
  )
  const ragResult = record.rag_result as RagResult | null
  if (!ragResult) return { ok: false, reason: "A RAG result is missing for Role C generation" }
  const result = await generateRoleCForRoleDWithRuntime({
    profile: record.profile as LearnerProfile,
    ragResult,
    kbVersion: await resolveRoleCKnowledgeBaseVersion(),
    runId,
    pathNode: bindPathNodeFactsForRoleC(node, ragResult),
    ...(nextRoundContext ? { next_round_context: nextRoundContext } : {}),
  }, roleCRuntime(dataRoot))
  if (result.status !== "ready") return { ok: false, reason: result.reason }
  if (!result.reviewedRelease) return { ok: false, reason: "Role C ready result omitted reviewed public release" }
  const [conceptLesson, codeLab, assessment] = result.reviewedRelease.artifacts
  return {
    ok: true,
    run_id: result.runId,
    learning_session: {
      session_id: result.learningSession.sessionId,
      form_id: result.learningSession.formId,
      attempt_no: result.learningSession.attemptNo,
      ...(result.learningSession.routing_request_id
        ? {
            routing_request_id: result.learningSession.routing_request_id,
            anchor_item_ids: [...(result.learningSession.anchor_item_ids ?? [])],
          }
        : {}),
    },
    concept_lesson: conceptLesson,
    code_lab: codeLab,
    assessment,
    rag_result: ragResult,
    adaptation: result.reviewedRelease.adaptation,
  }
}

function applyFormalRoleCRound(record: InteractiveSessionRecord, round: FormalRoleCRound): void {
  record.rag_result = round.rag_result
  record.learning_resources = { concept_lesson: round.concept_lesson, code_lab: round.code_lab }
  record.assessment = round.assessment
  record.adaptation = round.adaptation ?? null
  record.private.role_c = {
    data_directory: "role-c",
    session_id: round.learning_session.session_id,
    run_id: round.run_id,
    learner_id: (record.profile as LearnerProfile).learner_id,
    form_id: round.learning_session.form_id,
    attempt_no: round.learning_session.attempt_no,
  }
  record.status = "waiting_for_user"
  record.current_stage = "assessment"
  if (round.learning_session.routing_request_id
    && round.learning_session.anchor_item_ids?.length) {
    record.anchor_routing = {
      phase: "ANCHOR_PENDING",
      routing_request_id: round.learning_session.routing_request_id,
      anchor_item_ids: [...round.learning_session.anchor_item_ids],
    }
    record.waiting_for = {
      type: "anchor_answers",
      items: anchorItemsOf(record.assessment, round.learning_session.anchor_item_ids),
    }
  } else {
    record.waiting_for = {
      type: "assessment_answers",
      items: assessmentItems(round.assessment),
    }
  }
}

export async function resolveRoleCKnowledgeBaseVersion(): Promise<string> {
  return (await loadKnowledgeBase()).version
}

export function bindPathNodeFactsForRoleC(
  node: LearningPathNode,
  ragResult: Pick<RagResult, "results">,
): LearningPathNode {
  return {
    ...node,
    objectives: node.objectives.map((objective) => {
      if (objective.required_fact_ids.length > 0) return objective
      const source = ragResult.results.find((item) => item.source_id === objective.source_id)
      const fact = source?.facts[0]
      return {
        ...objective,
        required_fact_ids: typeof fact?.fact_id === "string" ? [fact.fact_id] : [],
      }
    }),
    assessment_blueprint: { ...node.assessment_blueprint },
  }
}

function assessmentItems(assessment: unknown): unknown[] {
  if (!assessment || typeof assessment !== "object") return []
  const record = assessment as Record<string, unknown>
  if (Array.isArray(record.items)) return record.items
  const payload = record.payload
  if (payload && typeof payload === "object") {
    const items = (payload as Record<string, unknown>).items
    if (Array.isArray(items)) return items
  }
  return []
}

function anchorItemsOf(assessment: unknown, anchorItemIds: string[]): unknown[] {
  const all = assessmentItems(assessment)
  const idSet = new Set(anchorItemIds)
  return all.filter((item) =>
    typeof item === "object" && item !== null && "item_id" in item
      ? idSet.has((item as { item_id: string }).item_id)
      : false)
}

/**
 * 锚点作答提交：C 评分锚点并冻结路由，返回按路由揭示的题目集合。
 * 后续正式提交必须使用路由后的题目。
 */
async function continueAfterAnchorAnswers(
  original: InteractiveSessionRecord,
  command: InteractiveSessionCommand,
  dataRoot: string,
): Promise<InteractiveSessionRecord> {
  const answers = command.payload?.answers
  if (!Array.isArray(answers)) {
    throw new InteractiveSessionError("INVALID_COMMAND", "submit_anchor_answers requires payload.answers array", 400)
  }
  const record = structuredClone(original)
  const roleC = record.private.role_c
  const routing = record.anchor_routing
  if (!roleC || !routing || routing.phase !== "ANCHOR_PENDING") {
    throw new InteractiveSessionError("SESSION_ARTIFACT_MISSING", "Anchor routing is missing or already locked", 409)
  }
  const anchorIds = routing.anchor_item_ids
  const answerIds = answers.map((answer: { item_id: string }) => answer.item_id)
  const issues = [
    ...anchorIds.filter((id) => !answerIds.includes(id)).map((id) => `missing anchor answer ${id}`),
    ...answerIds.filter((id) => !anchorIds.includes(id)).map((id) => `unknown anchor item ${id}`),
  ]
  if (issues.length > 0) {
    throw new InteractiveSessionError("INVALID_ANCHOR_ANSWERS", "Anchor answers do not match the requested items", 400, issues)
  }
  const outcome = await routeRoleCAssessmentAnchors({
    routingRequestId: routing.routing_request_id,
    sessionId: roleC.session_id,
    runId: roleC.run_id,
    learnerId: roleC.learner_id,
    formId: roleC.form_id,
    attemptNo: roleC.attempt_no,
    submissionId: `SUB-${record.session_id}-R${record.round_no}-ANCHOR-${command.command_id}`,
    answers: structuredClone(answers),
  }, roleCRuntime(dataRoot))
  if (outcome.status !== "routed") {
    record.status = "blocked"
    record.current_stage = "blocked"
    record.blocked_reason = outcome.status === "needs_review"
      ? `anchor assessment requires review: ${outcome.unresolved_anchor_item_ids.join(",")}`
      : `anchor routing blocked: ${outcome.issues.join("；")}`
    record.events.push(event(record.session_id, "session_blocked", "blocked", record.blocked_reason, new Date().toISOString()))
    record.updated_at = new Date().toISOString()
    return record
  }
  record.anchor_routing = {
    ...routing,
    phase: "ROUTE_LOCKED",
    route_id: outcome.route_id,
    action: outcome.action,
    anchor_score_ratio: outcome.anchor_score_ratio,
    required_item_ids: [...outcome.required_item_ids],
  }
  record.waiting_for = {
    type: "assessment_answers",
    items: assessmentItems(record.assessment)
      .filter((item) => typeof item === "object" && item !== null && "item_id" in item
        ? outcome.required_item_ids.includes((item as { item_id: string }).item_id)
        : false),
  }
  record.events.push(event(
    record.session_id,
    "session_updated",
    "assessment",
    `anchor route locked (${outcome.action}, ratio ${outcome.anchor_score_ratio})`,
    new Date().toISOString(),
  ))
  record.updated_at = new Date().toISOString()
  return record
}

async function generateRoundArtifacts(
  record: InteractiveSessionRecord,
  path: FormalLearningPath,
  node: LearningPathNode,
): Promise<
  | {
      ok: true
      upstreamArtifacts: Record<string, unknown>
      pathArtifacts: { a_rag_result: unknown }
      conceptArtifacts: { concept_lesson: unknown }
      codeArtifacts: { code_lab_public: unknown }
      assessmentArtifacts: { assessment_public: AssessmentPublicArtifact; assessment_secure: AssessmentSecureArtifact }
    }
  | { ok: false; reason: string }
> {
  const prior = structuredClone(record.private.upstream_artifacts)
  const pathArtifacts = prior["path-planner"] as Record<string, unknown>
  const currentPathArtifacts = {
    ...pathArtifacts,
    formal_path: path,
    next_path_node: node,
    path_completed: false,
  }
  let upstreamArtifacts: Record<string, unknown> = {
    ...prior,
    "path-planner": currentPathArtifacts,
  }
  let inputRefs = ["path-planner:interactive-next-round"]
  for (const step of ORCHESTRATION_WORKER_SEQUENCE.slice(5)) {
    const invocation = {
      ...createScaffoldWorkerInvocation({
        session_id: record.session_id,
        run_id: `${record.run_id}-R${record.round_no}`,
        step_index: ORCHESTRATION_WORKER_SEQUENCE.findIndex((entry) => entry.worker === step.worker) + 1,
        stage: step.from,
        worker: step.worker,
        learner_request: record.learner_request,
        upstream_artifacts: upstreamArtifacts,
        input_refs: inputRefs,
        evidence_refs: [],
      }),
      mode: record.mode,
    }
    const result = await runWorkerAdapter(invocation)
    const validation = validateWorkerResult(invocation, result)
    if (!validation.ok || result.status !== "completed") {
      return {
        ok: false,
        reason: validation.ok
          ? result.errors[0]?.message ?? result.summary
          : validation.errors[0]?.message ?? "next round worker contract invalid",
      }
    }
    upstreamArtifacts[step.worker] = result.artifacts
    inputRefs = result.output_refs
    record.events.push(event(record.session_id, "worker_completed", "assessment", result.summary, new Date().toISOString(), step.worker))
  }
  return {
    ok: true,
    upstreamArtifacts,
    pathArtifacts: currentPathArtifacts as unknown as { a_rag_result: unknown },
    conceptArtifacts: upstreamArtifacts["concept-tutor"] as { concept_lesson: unknown },
    codeArtifacts: upstreamArtifacts["code-lab"] as { code_lab_public: unknown },
    assessmentArtifacts: upstreamArtifacts["tiered-evaluator"] as { assessment_public: AssessmentPublicArtifact; assessment_secure: AssessmentSecureArtifact },
  }
}

/**
 * 画像漂移（reprofile）后重置会话到诊断阶段：重新出诊断题、清空画像/
 * 路径/内容，学习者重答后走完整首轮流程（新画像 → 新路径 → 新内容）。
 */
async function resetToDiagnosisPhase(
  record: InteractiveSessionRecord,
  dataRoot: string,
): Promise<InteractiveSessionRecord> {
  const now = new Date().toISOString()
  const knowledgeBase = await loadKnowledgeBase()
  const goalSpec = resolveLearningGoalSpec(record.learner_request.learning_goal_spec ?? {
    mode: "custom_goal",
    custom_goal: record.learner_request.goal,
  })
  const learnerId = record.learner_request.learner_id ?? record.session_id
  const learnerMemory = await loadLearnerMemory(dataRoot, learnerId)
  const targetItems = knowledgeBase.items.filter((item) => goalSpec.mapped_source_ids.includes(item.sourceId))
  const selection = selectDiagnosticItems({
    knowledgeBase,
    target_source_ids: goalSpec.mapped_source_ids,
    prerequisite_source_ids: [...new Set(targetItems.flatMap((item) => item.prerequisites))],
    learner_memory: learnerMemory,
    max_items: 5,
  })
  const diagnosisItems: PublicDiagnosisItem[] = selection.items.map((item, index) => ({
    item_id: `DIAG-${index + 1}-${item.source_id}`,
    source_id: item.source_id,
    fact_id: item.fact_id,
    concept: item.concept,
    difficulty: item.difficulty,
    question: item.question,
    options: item.options ? [...item.options] : undefined,
  }))
  const answerKey = Object.fromEntries(selection.items.map((item, index) => [diagnosisItems[index]!.item_id, item.answer]))
  return {
    ...structuredClone(record),
    status: "waiting_for_user",
    current_stage: "objective_diagnosis",
    round_no: 1,
    waiting_for: { type: "diagnosis_answers", items: diagnosisItems },
    profile: null,
    formal_path: null,
    current_path_node: null,
    rag_result: null,
    learning_resources: { concept_lesson: null, code_lab: null },
    assessment: null,
    adaptation: null,
    feedback: null,
    blocked_reason: null,
    private: {
      ...record.private,
      diagnosis_items: diagnosisItems,
      diagnosis_answer_key: answerKey,
      diagnosis_answers: null,
      upstream_artifacts: {},
      next_round_context: null,
      role_c_generation_attempt: 0,
      role_c: null,
    },
    events: [
      ...record.events,
      event(record.session_id, "session_updated", "objective_diagnosis", "画像漂移，重新诊断以重建学习者画像", now),
    ],
    updated_at: now,
  }
}

async function continueAfterDiagnosis(
  original: InteractiveSessionRecord,
  command: InteractiveSessionCommand,
  dataRoot: string,
): Promise<InteractiveSessionRecord> {
  const answers = command.payload?.answers
  if (!answers || Array.isArray(answers) || typeof answers !== "object") {
    throw new InteractiveSessionError("INVALID_COMMAND", "submit_diagnosis_answers requires payload.answers object", 400)
  }
  const requiredIds = original.private.diagnosis_items.map((item) => item.item_id)
  const answerIds = Object.keys(answers)
  const issues = [
    ...requiredIds.filter((id) => typeof answers[id] !== "string").map((id) => `missing diagnosis answer ${id}`),
    ...answerIds.filter((id) => !requiredIds.includes(id)).map((id) => `unknown diagnosis item ${id}`),
  ]
  if (issues.length > 0) throw new InteractiveSessionError("INVALID_DIAGNOSIS_ANSWERS", "Diagnosis answers do not match the requested items", 400, issues)

  const record = structuredClone(original)
  const now = new Date().toISOString()
  record.status = "running"
  record.waiting_for = null
  upsertLedger(record, "objective-diagnostician", "completed", "已接收并判定诊断答案")
  record.events.push(event(record.session_id, "worker_completed", "objective_diagnosis", "objective-diagnostician completed grounded diagnosis", now, "objective-diagnostician"))
  record.events.push(event(record.session_id, "command_received", "objective_diagnosis", "received diagnosis answers", now, "objective-diagnostician"))

  const knowledgeBase = await loadKnowledgeBase()
  const background: BackgroundEvidence = {
    evidence_type: "background",
    learner_id: record.learner_request.learner_id ?? record.session_id,
    education_context: record.learner_request.background ?? null,
    prior_languages: [],
    prior_topics: [],
    goal_raw: record.learner_request.goal,
    time_budget: null,
    quotes: record.learner_request.background
      ? [{ field: "education_context", text: record.learner_request.background }]
      : [],
  }
  const selfAssessment: SelfAssessmentEvidence = {
    evidence_type: "self_assessment",
    self_rating: normalizeDifficulty(record.learner_request.self_rating),
    claimed_known: [],
    claimed_weak: [],
    quotes: record.learner_request.self_rating
      ? [{ field: "self_rating", text: record.learner_request.self_rating }]
      : [],
  }
  const diagnosisItems: DiagnosisItem[] = record.private.diagnosis_items.map((item) => {
    const learnerAnswer = answers[item.item_id]!
    const correct = normalizeAnswer(learnerAnswer) === normalizeAnswer(record.private.diagnosis_answer_key[item.item_id] ?? "")
    return {
      source_id: item.source_id,
      fact_id: item.fact_id,
      question: item.question,
      learner_answer: learnerAnswer,
      verdict: correct ? "correct" : "incorrect",
      concept: item.concept,
      difficulty: normalizeDifficulty(item.difficulty) ?? "beginner",
    }
  })
  const objectiveDiagnosis: ObjectiveDiagnosisEvidence = {
    evidence_type: "objective_diagnosis",
    items: diagnosisItems,
    quotes: diagnosisItems.map((item) => ({ field: item.source_id, text: item.learner_answer ?? "" })),
  }

  let upstreamArtifacts: Record<string, unknown> = {
    "background-collector": { mode: "interactive", evidence: background },
    "self-assessor": { mode: "interactive", evidence: selfAssessment },
    "objective-diagnostician": {
      mode: "interactive",
      evidence: objectiveDiagnosis,
      dynamic_selection: { items: record.private.diagnosis_items },
    },
  }
  let inputRefs = ["objective-diagnostician:interactive-result"]
  const learnerId = record.learner_request.learner_id ?? record.session_id
  const memory = await loadLearnerMemory(dataRoot, learnerId)
  upstreamArtifacts["learner-memory"] = memory

  record.private.diagnosis_answers = structuredClone(answers as Record<string, string>)
  for (const step of ORCHESTRATION_WORKER_SEQUENCE.slice(3, 5)) {
    record.events.push(event(record.session_id, "worker_invoked", stageForWorker(step.worker), `invoke ${step.worker}`, new Date().toISOString(), step.worker))
    const invocation = {
      ...createScaffoldWorkerInvocation({
        session_id: record.session_id,
        run_id: record.run_id,
        step_index: ORCHESTRATION_WORKER_SEQUENCE.findIndex((entry) => entry.worker === step.worker) + 1,
        stage: step.from,
        worker: step.worker,
        learner_request: record.learner_request,
        upstream_artifacts: upstreamArtifacts,
        input_refs: inputRefs,
        evidence_refs: [],
      }),
      mode: record.mode,
    }
    const result = await runWorkerAdapter(invocation)
    const validation = validateWorkerResult(invocation, result)
    if (!validation.ok || result.status !== "completed") {
      record.status = result.status === "blocked" ? "blocked" : "failed"
      record.current_stage = result.status === "blocked" ? "blocked" : "failed"
      const failureMessage = validation.ok
        ? result.errors[0]?.message ?? result.summary
        : validation.errors[0]?.message ?? "worker contract invalid"
      record.blocked_reason = failureMessage
      record.events.push(event(record.session_id, "session_blocked", record.current_stage, record.blocked_reason, new Date().toISOString(), step.worker))
      record.updated_at = new Date().toISOString()
      return record
    }
    upstreamArtifacts[step.worker] = result.artifacts
    inputRefs = result.output_refs
    record.events.push(event(record.session_id, "worker_completed", stageForWorker(step.worker), result.summary, new Date().toISOString(), step.worker))
    upsertLedger(record, step.worker, "completed", result.summary)
  }

  const profileArtifacts = upstreamArtifacts["profile-builder"] as { profile: unknown }
  const pathArtifacts = upstreamArtifacts["path-planner"] as {
    formal_path: FormalLearningPath
    next_path_node: LearningPathNode | null
    a_rag_result: unknown
  }
  record.profile = profileArtifacts.profile
  record.formal_path = pathArtifacts.formal_path
  record.current_path_node = pathArtifacts.next_path_node
  record.rag_result = pathArtifacts.a_rag_result
  record.private.upstream_artifacts = publicUpstreamArtifacts(upstreamArtifacts)
  if (!pathArtifacts.next_path_node) {
    record.status = "completed"
    record.current_stage = "completed"
    record.waiting_for = null
    record.updated_at = new Date().toISOString()
    return record
  }
  const formalRound = await generateFormalRoleCRound(record, pathArtifacts.formal_path, pathArtifacts.next_path_node, dataRoot)
  if (!formalRound.ok) {
    record.status = "blocked"
    record.current_stage = "blocked"
    record.waiting_for = null
    record.blocked_reason = formalRound.reason
    record.events.push(event(record.session_id, "session_blocked", "blocked", formalRound.reason, new Date().toISOString(), "tiered-evaluator"))
    record.updated_at = new Date().toISOString()
    return record
  }
  applyFormalRoleCRound(record, formalRound)
  markReviewedRoleCWorkers(record)
  record.updated_at = new Date().toISOString()
  record.events.push(event(record.session_id, "waiting_for_user", "assessment", "waiting for assessment answers", record.updated_at, "tiered-evaluator"))
  return record
}

function markReviewedRoleCWorkers(record: InteractiveSessionRecord): void {
  for (const worker of interactiveSessionProductionBoundary().reviewed_role_c_workers) {
    upsertLedger(record, worker, "completed", `Role C reviewed ${worker} output`)
    record.events.push(event(record.session_id, "worker_completed", stageForWorker(worker), `Role C reviewed ${worker} output`, new Date().toISOString(), worker))
  }
}

function publicUpstreamArtifacts(artifacts: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(artifacts)
  const codeLab = copy["code-lab"]
  if (codeLab && typeof codeLab === "object") delete (codeLab as Record<string, unknown>).code_lab_secure
  const assessment = copy["tiered-evaluator"]
  if (assessment && typeof assessment === "object") delete (assessment as Record<string, unknown>).assessment_secure
  return copy
}

function feedbackDecisionAction(feedback: unknown): string | undefined {
  if (!feedback || typeof feedback !== "object" || !("final_decision" in feedback)) return undefined
  const decision = (feedback as { final_decision?: unknown }).final_decision
  if (!decision || typeof decision !== "object" || !("action" in decision)) return undefined
  return typeof (decision as { action?: unknown }).action === "string" ? (decision as { action: string }).action : undefined
}

function validateCommand(command: InteractiveSessionCommand): void {
  if (!command || typeof command !== "object" || !/^[A-Za-z0-9_-]{1,120}$/.test(command.command_id ?? "")) {
    throw new InteractiveSessionError("INVALID_COMMAND", "command_id is required and must be safe", 400)
  }
  if (!["submit_diagnosis_answers", "submit_anchor_answers", "submit_assessment_answers", "retry"].includes(command.type)) {
    throw new InteractiveSessionError("INVALID_COMMAND", "Unsupported command type", 400)
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function normalizeAnswer(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function normalizeDifficulty(value: string | undefined): "beginner" | "basic" | "intermediate" | "integrated" | null {
  return value === "beginner" || value === "basic" || value === "intermediate" || value === "integrated" ? value : null
}

function stageForWorker(worker: WorkerName): InteractiveStage {
  return worker === "tiered-evaluator" ? "assessment" : "objective_diagnosis"
}

function upsertLedger(
  record: InteractiveSessionRecord,
  worker: WorkerName,
  status: PublicWorkerLedgerEntry["status"],
  summary: string,
): void {
  const next = { worker, status, summary, updated_at: new Date().toISOString() }
  const index = record.worker_ledger.findIndex((entry) => entry.worker === worker)
  if (index >= 0) record.worker_ledger[index] = next
  else record.worker_ledger.push(next)
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new InteractiveSessionError("INVALID_ID", "session_id and run_id may only contain letters, numbers, _ and -", 400)
  }
  return value
}

function event(
  sessionId: string,
  eventType: InteractiveEvent["event_type"],
  stage: InteractiveStage,
  message: string,
  timestamp: string,
  worker?: WorkerName,
): InteractiveEvent {
  return {
    event_id: `${sessionId}-${eventType}-${Math.random().toString(36).slice(2, 10)}`,
    event_type: eventType,
    stage,
    worker,
    message,
    timestamp,
  }
}
