import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  contentHash,
  deliverRoleCToB,
  type LearningEvidenceEvent,
  type RoleBLearningProgressPort,
} from "../src/role-c-content"
import {
  SessionRoleBBridge,
  SessionRoleBBridgeError,
  toRoleCContinuationContextFailure,
} from "../src/role-d-integration/session-role-b-bridge"
import { isRoleCContinuationHttpRequest } from "../src/role-d-integration/contracts"

describe("Role C continuation HTTP request boundary", () => {
  test("accepts only the three completed-round identity fields", () => {
    const identity = {
      sessionId: "SESSION-1",
      submissionId: "SUBMISSION-1",
      learnerId: "learner-session-bridge",
    }
    expect(isRoleCContinuationHttpRequest(identity)).toBe(true)
    expect(isRoleCContinuationHttpRequest({
      ...identity,
      nextPathNode: { node_id: "UNTRUSTED" },
    })).toBe(false)
    expect(isRoleCContinuationHttpRequest({
      ...identity,
      nextEvidencePack: { retrieval_id: "UNTRUSTED" },
    })).toBe(false)
    expect(isRoleCContinuationHttpRequest({
      ...identity,
      nextGenerationAction: "advance",
    })).toBe(false)
    expect(isRoleCContinuationHttpRequest({
      ...identity,
      learnerId: " ",
    })).toBe(false)
  })
})

describe("SessionRoleBBridge", () => {
  test("maps expired and mismatched bindings to one non-leaking public continuation failure", async () => {
    const bridge = new SessionRoleBBridge(await loadKnowledgeBase())
    let captured: unknown
    try {
      bridge.getOrFreezeContinuationSnapshot(
        "PRIVATE-SESSION-ID",
        "SUBMISSION-1",
        "PRIVATE-LEARNER-ID",
      )
    } catch (error) {
      captured = error
    }

    const failure = toRoleCContinuationContextFailure(captured)
    expect(failure).toEqual({
      status: "blocked",
      stage: "context",
      code: "SESSION_NOT_FOUND",
      issues: ["C 学习会话不存在或服务已重启，请重新生成学习计划"],
    })
    expect(JSON.stringify(failure)).not.toContain("PRIVATE-SESSION-ID")
    expect(JSON.stringify(failure)).not.toContain("PRIVATE-LEARNER-ID")
    expect(toRoleCContinuationContextFailure(new Error("other")))
      .toBeUndefined()
  })

  test("injects one B adapter, resolves its server snapshot, and carries it to the published session", async () => {
    const bridge = new SessionRoleBBridge(await loadKnowledgeBase())
    const generation = bridge.createGenerationBinding({
      learnerIdHash: "learner-session-bridge",
      currentProfile: profile("learner-session-bridge"),
      profileVersion: "profile-v1",
      profileRevision: 1,
    })
    const progressPort: RoleBLearningProgressPort = generation.progressPort

    expect(Object.isFrozen(generation)).toBe(true)
    bridge.bindGeneratedSession("SESSION-1", generation)
    bridge.bindGeneratedSession("SESSION-1", generation)
    expect(bridge.getCurrentSnapshotForContinue(
      "SESSION-1",
      "learner-session-bridge",
    ).profile_version).toBe("profile-v1")

    await deliverRoleCToB(progressPort, [
      progressEvent("learner-session-bridge", "profile-v1"),
    ])
    const updated = bridge.getCurrentSnapshotForContinue(
      "SESSION-1",
      "learner-session-bridge",
    )
    expect(updated.profile_version).toMatch(
      /^role-b-profile-v2-[a-f0-9]{12}$/,
    )
    expect(updated.known_concepts).toContain("for 循环")
    expect(updated.weak_concepts).not.toContain("for 循环")
    const frozenFirstContinuation =
      bridge.getOrFreezeContinuationSnapshot(
        "SESSION-1",
        "SUBMISSION-1",
        "learner-session-bridge",
      )

    bridge.bindPublishedSession(
      "SESSION-1",
      "SESSION-2",
      "learner-session-bridge",
    )
    bridge.bindPublishedSession(
      "SESSION-1",
      "SESSION-2",
      "learner-session-bridge",
    )
    expect(bridge.getCurrentSnapshotForContinue(
      "SESSION-2",
      "learner-session-bridge",
    )).toEqual(updated)

    await deliverRoleCToB(progressPort, [
      progressEvent(
        "learner-session-bridge",
        updated.profile_version,
        "EVENT-SESSION-BRIDGE-SECOND",
        "K009",
      ),
    ])
    const latest = bridge.getCurrentSnapshotForContinue(
      "SESSION-2",
      "learner-session-bridge",
    )
    expect(latest.profile_version).toMatch(
      /^role-b-profile-v3-[a-f0-9]{12}$/,
    )
    expect(latest.profile_version).not.toBe(updated.profile_version)

    frozenFirstContinuation.known_concepts.push("tampered caller copy")
    expect(bridge.getOrFreezeContinuationSnapshot(
      "SESSION-1",
      "SUBMISSION-1",
      "learner-session-bridge",
    )).toEqual(updated)
    expect(bridge.getOrFreezeContinuationSnapshot(
      "SESSION-1",
      "SUBMISSION-2",
      "learner-session-bridge",
    )).toEqual(latest)
  })

  test("rejects unknown sessions, learner mismatches, foreign bindings, and conflicting rebinds", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const bridge = new SessionRoleBBridge(knowledgeBase)
    const alice = bridge.createGenerationBinding({
      learnerIdHash: "alice",
      currentProfile: profile("alice"),
      profileVersion: "alice-v1",
      profileRevision: 1,
    })
    const bob = bridge.createGenerationBinding({
      learnerIdHash: "bob",
      currentProfile: profile("bob"),
      profileVersion: "bob-v1",
      profileRevision: 1,
    })
    bridge.bindGeneratedSession("SESSION-ALICE", alice)
    bridge.bindGeneratedSession("SESSION-BOB", bob)

    expectBridgeError(
      () => bridge.getCurrentSnapshotForContinue("SESSION-MISSING", "alice"),
      "SESSION_NOT_FOUND",
    )
    expectBridgeError(
      () => bridge.getCurrentSnapshotForContinue("SESSION-ALICE", "bob"),
      "SESSION_LEARNER_MISMATCH",
    )
    expectBridgeError(
      () => bridge.bindGeneratedSession("SESSION-ALICE", bob),
      "SESSION_BINDING_CONFLICT",
    )
    expectBridgeError(
      () => bridge.bindPublishedSession(
        "SESSION-ALICE",
        "SESSION-BOB",
        "alice",
      ),
      "SESSION_BINDING_CONFLICT",
    )

    const foreign = new SessionRoleBBridge(knowledgeBase)
      .createGenerationBinding({
        learnerIdHash: "alice",
        currentProfile: profile("alice"),
        profileVersion: "alice-v1",
        profileRevision: 1,
      })
    expectBridgeError(
      () => bridge.bindGeneratedSession("SESSION-FOREIGN", foreign),
      "GENERATION_BINDING_UNKNOWN",
    )
  })
})

function profile(learnerId: string): LearnerProfile {
  return {
    learner_id: learnerId,
    level: "beginner",
    known_concepts: ["变量"],
    weak_concepts: ["for 循环"],
    goal: "掌握 for 循环",
  }
}

function progressEvent(
  learnerIdHash: string,
  profileVersion: string,
  eventId = "EVENT-SESSION-BRIDGE",
  sourceId = "K007",
): LearningEvidenceEvent {
  return {
    schema_version: "1.0",
    event_id: eventId,
    learner_id_hash: learnerIdHash,
    profile_version: profileVersion,
    path_node_id: "PATH-SESSION-BRIDGE",
    objective_id: `OBJECTIVE-${sourceId}`,
    source_id: sourceId,
    evidence: {
      modality: "mcq",
      raw_score: 1,
      evidence_score: 0.9,
      grader_confidence: 0.9,
      hint_level: 0,
      attempt_no: 1,
    },
    misconceptions: [],
    recommendation: {
      action: "reinforce",
      confidence: 0.9,
      reason_codes: ["bridge_integration_test"],
    },
    provenance: {
      artifact_id: `GRADE-${eventId}`,
      idempotency_key: contentHash({
        contract: "role-d-session-role-b-bridge-test",
        learnerIdHash,
        eventId,
      }),
      item_id: `ITEM-${eventId}`,
      grader_version: "bridge-test-grader-v1",
    },
  }
}

function expectBridgeError(
  action: () => unknown,
  code: SessionRoleBBridgeError["code"],
): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(SessionRoleBBridgeError)
    expect((error as SessionRoleBBridgeError).code).toBe(code)
  }
}
