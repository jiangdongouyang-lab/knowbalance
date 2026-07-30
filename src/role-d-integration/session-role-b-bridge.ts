import type { KnowledgeBase } from "../knowledge/types"
import {
  RoleBLearningProgressAdapter,
  type RoleBLearnerProgressRegistration,
} from "../role-b-profile/teaching-audit"
import type { LearnerProfileSnapshot } from "../role-c-content"

export type SessionRoleBBridgeErrorCode =
  | "INVALID_IDENTITY"
  | "GENERATION_BINDING_UNKNOWN"
  | "SESSION_NOT_FOUND"
  | "SESSION_LEARNER_MISMATCH"
  | "SESSION_BINDING_CONFLICT"
  | "PROFILE_STATE_MISSING"

export class SessionRoleBBridgeError extends Error {
  constructor(
    readonly code: SessionRoleBBridgeErrorCode,
    message: string,
  ) {
    super(`${code}:${message}`)
    this.name = "SessionRoleBBridgeError"
  }
}

export interface RoleCContinuationContextFailure {
  status: "blocked"
  stage: "context"
  code: "SESSION_NOT_FOUND"
  issues: string[]
}

/**
 * Converts server-held B binding failures to C's public continuation shape.
 *
 * All bridge failures intentionally share one public code and message. This
 * keeps internal learner/session bindings out of HTTP responses while giving D
 * a stable recovery path for expired or restarted process-local sessions.
 */
export function toRoleCContinuationContextFailure(
  error: unknown,
): RoleCContinuationContextFailure | undefined {
  if (!(error instanceof SessionRoleBBridgeError)) return undefined
  return {
    status: "blocked",
    stage: "context",
    code: "SESSION_NOT_FOUND",
    issues: ["C 学习会话不存在或服务已重启，请重新生成学习计划"],
  }
}

export interface SessionRoleBGenerationBinding {
  readonly learnerIdHash: string
  /** Inject this port into generateRoleCForRoleDWithRuntime. */
  readonly progressPort: RoleBLearningProgressAdapter
}

interface BoundRoleBSession {
  learnerIdHash: string
  progressPort: RoleBLearningProgressAdapter
}

interface FrozenContinuationSnapshot {
  learnerIdHash: string
  snapshot: LearnerProfileSnapshot
}

/**
 * Local server bridge between Role C learning sessions and B's in-process
 * learning-progress adapter.
 *
 * The bridge deliberately does not infer a profile version. Its caller must
 * register the same authoritative initial version that Role C freezes for the
 * generated run. Once a session is bound, continuation snapshots are resolved
 * only from this server-held B state, never from learner-facing request data.
 */
export class SessionRoleBBridge {
  private readonly knowledgeBase: KnowledgeBase
  private readonly ownedGenerationPorts =
    new WeakMap<RoleBLearningProgressAdapter, string>()
  private readonly sessions = new Map<string, BoundRoleBSession>()
  private readonly continuationSnapshots =
    new Map<string, Map<string, FrozenContinuationSnapshot>>()

  constructor(knowledgeBase: KnowledgeBase) {
    this.knowledgeBase = structuredClone(knowledgeBase)
  }

  createGenerationBinding(
    registration: RoleBLearnerProgressRegistration,
  ): SessionRoleBGenerationBinding {
    const progressPort = new RoleBLearningProgressAdapter({
      knowledgeBase: this.knowledgeBase,
      learners: [structuredClone(registration)],
    })
    this.ownedGenerationPorts.set(
      progressPort,
      registration.learnerIdHash,
    )
    return Object.freeze({
      learnerIdHash: registration.learnerIdHash,
      progressPort,
    })
  }

  bindGeneratedSession(
    sessionId: string,
    generation: SessionRoleBGenerationBinding,
  ): void {
    assertIdentity(sessionId, "sessionId")
    assertIdentity(generation.learnerIdHash, "learnerIdHash")
    const owner = this.ownedGenerationPorts.get(generation.progressPort)
    if (owner !== generation.learnerIdHash) {
      throw new SessionRoleBBridgeError(
        "GENERATION_BINDING_UNKNOWN",
        "generation binding 不属于当前 bridge",
      )
    }
    if (!generation.progressPort.getCurrentState(generation.learnerIdHash)) {
      throw new SessionRoleBBridgeError(
        "PROFILE_STATE_MISSING",
        "generation binding 缺少对应 learner 的 B 画像",
      )
    }
    this.bindSession(sessionId, {
      learnerIdHash: generation.learnerIdHash,
      progressPort: generation.progressPort,
    })
  }

  getCurrentSnapshotForContinue(
    sessionId: string,
    learnerIdHash: string,
  ): LearnerProfileSnapshot {
    const binding = this.requireSession(sessionId, learnerIdHash)
    const snapshot = binding.progressPort.getCurrentSnapshot(learnerIdHash)
    if (!snapshot) {
      throw new SessionRoleBBridgeError(
        "PROFILE_STATE_MISSING",
        "B 未持有该 learner 的当前画像",
      )
    }
    return snapshot
  }

  /**
   * Freezes the B snapshot used by one continuation request.
   *
   * Retrying the same completed submission must not observe a newer B revision
   * produced by a later learning round. A different submission ID starts a new
   * freeze and may therefore consume the adapter's latest snapshot.
   */
  getOrFreezeContinuationSnapshot(
    sessionId: string,
    submissionId: string,
    learnerIdHash: string,
  ): LearnerProfileSnapshot {
    assertIdentity(submissionId, "submissionId")
    this.requireSession(sessionId, learnerIdHash)
    const bySubmission = this.continuationSnapshots.get(sessionId)
      ?? new Map<string, FrozenContinuationSnapshot>()
    const frozen = bySubmission.get(submissionId)
    if (frozen) {
      if (frozen.learnerIdHash !== learnerIdHash) {
        throw new SessionRoleBBridgeError(
          "SESSION_LEARNER_MISMATCH",
          `continuation ${sessionId}/${submissionId} 不属于 learner ${learnerIdHash}`,
        )
      }
      return structuredClone(frozen.snapshot)
    }

    const snapshot = this.getCurrentSnapshotForContinue(
      sessionId,
      learnerIdHash,
    )
    bySubmission.set(submissionId, {
      learnerIdHash,
      snapshot: structuredClone(snapshot),
    })
    this.continuationSnapshots.set(sessionId, bySubmission)
    return structuredClone(snapshot)
  }

  bindPublishedSession(
    parentSessionId: string,
    publishedSessionId: string,
    learnerIdHash: string,
  ): void {
    assertIdentity(publishedSessionId, "publishedSessionId")
    const binding = this.requireSession(parentSessionId, learnerIdHash)
    this.bindSession(publishedSessionId, binding)
  }

  private requireSession(
    sessionId: string,
    learnerIdHash: string,
  ): BoundRoleBSession {
    assertIdentity(sessionId, "sessionId")
    assertIdentity(learnerIdHash, "learnerIdHash")
    const binding = this.sessions.get(sessionId)
    if (!binding) {
      throw new SessionRoleBBridgeError(
        "SESSION_NOT_FOUND",
        `未找到 session ${sessionId} 的 B 绑定`,
      )
    }
    if (binding.learnerIdHash !== learnerIdHash) {
      throw new SessionRoleBBridgeError(
        "SESSION_LEARNER_MISMATCH",
        `session ${sessionId} 不属于 learner ${learnerIdHash}`,
      )
    }
    return binding
  }

  private bindSession(
    sessionId: string,
    binding: BoundRoleBSession,
  ): void {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (
        existing.learnerIdHash === binding.learnerIdHash
        && existing.progressPort === binding.progressPort
      ) {
        return
      }
      throw new SessionRoleBBridgeError(
        "SESSION_BINDING_CONFLICT",
        `session ${sessionId} 已绑定到另一个 B learner/adapter`,
      )
    }
    this.sessions.set(sessionId, binding)
  }
}

function assertIdentity(value: string, field: string): void {
  if (value.trim() !== "") return
  throw new SessionRoleBBridgeError(
    "INVALID_IDENTITY",
    `${field} 不能为空`,
  )
}
