import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ConceptLessonArtifact,
  GradeResultArtifact,
} from "../src/role-c-content/contracts/artifacts"
import type { DynamicFeedbackResult } from "../src/role-c-content/contracts/dynamic-feedback"
import type { RagEvidencePack } from "../src/role-c-content/contracts/evidence-pack"
import { contentHash } from "../src/role-c-content/contracts/common"
import {
  buildGenerationSpec,
  type GenerationSpec,
} from "../src/role-c-content/contracts/generation-spec"
import type {
  LearnerProfileSnapshot,
  LearningPathNode,
} from "../src/role-c-content/contracts/profile-adapter"
import {
  executePreparedNextRound,
  InMemoryNextRoundExecutionJournal,
  KeyedSingleFlight,
  prepareNextRound,
  type GenerationReadyNextRound,
  type NextRoundExecutionJournalEntry,
} from "../src/role-c-content/orchestrator/next-round"
import {
  InMemorySecureArtifactStore,
  type SecureArtifactStore,
} from "../src/role-c-content/security/secure-artifact-store"
import {
  continueCompletedLearningCycle,
  createRoleCAgents,
  AtomicFileAdaptiveLearningLoopJournal,
  InMemoryAdaptiveLearningLoopJournal,
  InMemoryLearningCycleStore,
  InMemoryMasteryStateStore,
  LearningCycleService,
} from "../src/role-c-content"
import type {
  GeneratedContentVerifiers,
  RoleCAgents,
} from "../src/role-c-content/agents/types"
import { DeterministicCodeLabContentProvider } from "../src/role-c-content/providers"
import { runReviewedCPipeline } from "../src/role-c-content/review/run-reviewed-pipeline"
import { runRecoverableReviewedCPipeline } from "../src/role-c-content/review/run-recoverable-pipeline"
import type {
  ContentReviewRequest,
  ContentReviewResult,
  ReviewedCPipelineResult,
} from "../src/role-c-content/review/types"

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`

interface Fixture {
  profile: LearnerProfileSnapshot
  path: LearningPathNode
  evidence: RagEvidencePack
  spec: GenerationSpec
}

describe("Role C next-round planning", () => {
  test("remediate keeps the current node and blueprint while lowering load and increasing scaffolding", () => {
    const fixture = buildFixture()
    const parentSnapshot = structuredClone(fixture.spec)
    const first = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "remediate"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    const second = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "remediate"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })

    expect(first).toEqual(second)
    expect(fixture.spec).toEqual(parentSnapshot)
    expect(first.status).toBe("generation_ready")
    if (first.status !== "generation_ready") return
    expect(first.action).toBe("remediate")
    expect(first.generation_spec.path_node).toEqual(fixture.spec.path_node)
    expect(first.generation_spec.targets).toEqual(fixture.spec.targets)
    expect(first.generation_spec.assessment_blueprint).toEqual(fixture.spec.assessment_blueprint)
    expect(first.generation_spec.difficulty).toEqual({
      domain_complexity: fixture.spec.difficulty.domain_complexity,
      cognitive_demand: Math.max(0, fixture.spec.difficulty.cognitive_demand - 1),
      reasoning_steps: Math.max(0, fixture.spec.difficulty.reasoning_steps - 1),
      code_complexity: Math.max(0, fixture.spec.difficulty.code_complexity - 1),
      prerequisite_load: Math.max(0, fixture.spec.difficulty.prerequisite_load - 1),
      scaffold_strength: Math.min(5, fixture.spec.difficulty.scaffold_strength + 1),
    })
    expect(first.generation_spec.learner_adaptation.scaffold_level).toBe(
      Math.min(3, fixture.spec.learner_adaptation.scaffold_level + 1) as 0 | 1 | 2 | 3,
    )
    expect(first.generation_spec.learner_adaptation.reading_density).toBe("low")
    expect(first.generation_spec.run_id).not.toBe(fixture.spec.run_id)
    expect(first.generation_spec.spec_id).not.toBe(fixture.spec.spec_id)
  })

  test("remediate clamps an already minimal task and maximal scaffold", () => {
    const fixture = buildFixture({
      level: "beginner",
      difficulty: {
        domain_complexity: 0,
        cognitive_demand: 0,
        reasoning_steps: 0,
        code_complexity: 0,
        prerequisite_load: 0,
        scaffold_strength: 5,
      },
    })
    const result = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "remediate"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    expect(result.status).toBe("generation_ready")
    if (result.status !== "generation_ready") return
    expect(result.generation_spec.difficulty).toEqual(fixture.spec.difficulty)
    expect(result.generation_spec.learner_adaptation.scaffold_level).toBe(3)
    expect(result.generation_spec.learner_adaptation.reading_density).toBe("low")
  })

  test("reinforce preserves difficulty and adaptation but creates a deterministic new variant identity", () => {
    const fixture = buildFixture()
    const input = {
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    }
    const first = prepareNextRound(input)
    const replay = prepareNextRound(structuredClone(input))
    expect(first).toEqual(replay)
    expect(first.status).toBe("generation_ready")
    if (first.status !== "generation_ready") return
    expect(first.generation_spec.difficulty).toEqual(fixture.spec.difficulty)
    expect(first.generation_spec.learner_adaptation).toEqual(fixture.spec.learner_adaptation)
    expect(first.generation_spec.path_node).toEqual(fixture.spec.path_node)
    expect(first.generation_spec.targets).toEqual(fixture.spec.targets)
    expect(first.generation_spec.assessment_blueprint).toEqual(fixture.spec.assessment_blueprint)
    expect(first.generation_spec.run_id).not.toBe(fixture.spec.run_id)
    expect(first.generation_spec.spec_id).not.toBe(fixture.spec.spec_id)
    expect(Number.isSafeInteger(first.generation_spec.policies.seed)).toBe(true)
  })

  test("uses B's newer profile and A's refreshed evidence on a current-node follow-up", () => {
    const fixture = buildFixture()
    const updatedProfile = structuredClone(fixture.profile)
    updatedProfile.profile_id = "PROFILE-NEXT-ROUND-V2"
    updatedProfile.profile_version = "profile-next-round-v2"
    updatedProfile.known_concepts.push("循环基础")
    updatedProfile.weak_concepts = ["循环边界"]
    const refreshedEvidence = structuredClone(fixture.evidence)
    refreshedEvidence.retrieval_id = "RAG-CURRENT-REFRESHED"
    refreshedEvidence.query = "循环边界 继续练习"

    const result = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_profile_snapshot: updatedProfile,
      next_evidence_pack: refreshedEvidence,
    })

    expect(result.status).toBe("generation_ready")
    if (result.status !== "generation_ready") return
    expect(result.action).toBe("reinforce")
    expect(result.generation_spec.path_node.node_id).toBe(fixture.path.node_id)
    expect(result.generation_spec.profile_ref.profile_version)
      .toBe(updatedProfile.profile_version)
    expect(result.generation_spec.learner_adaptation.known_concepts)
      .toEqual(updatedProfile.known_concepts)
    expect(result.generation_spec.evidence_ref)
      .toBe(refreshedEvidence.retrieval_id)
  })

  test("selects explicit current generation versions and binds them to the request identity", () => {
    const fixture = buildFixture()
    const inherited = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    const upgraded = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      current_generation_versions: {
        prompt_version: "c-prompts-current-v2",
        model_config_hash: "model-current-v2",
        runner_image_digest: `sha256:${"c".repeat(64)}`,
      },
    })
    expect(inherited.status).toBe("generation_ready")
    expect(upgraded.status).toBe("generation_ready")
    if (inherited.status !== "generation_ready"
      || upgraded.status !== "generation_ready") return

    expect(inherited.generation_spec.versions).toEqual(fixture.spec.versions)
    expect(upgraded.generation_spec.versions).toEqual({
      ...fixture.spec.versions,
      prompt_version: "c-prompts-current-v2",
      model_config_hash: "model-current-v2",
      runner_image_digest: `sha256:${"c".repeat(64)}`,
    })
    expect(upgraded.parent_spec_id).toBe(fixture.spec.spec_id)
    expect(upgraded.request_id).not.toBe(inherited.request_id)
    expect(upgraded.idempotency_key).not.toBe(inherited.idempotency_key)
    expect(upgraded.generation_spec.run_id).not.toBe(
      inherited.generation_spec.run_id,
    )
  })

  test("binds prepared identities to the complete feedback, decision, profile, and evidence content", () => {
    const fixture = buildFixture()
    const baseInput = {
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    }
    const feedbackChanged = structuredClone(baseInput)
    feedbackChanged.feedback.feedback_id = "DFR-reinforce-reissued"
    const decisionChanged = structuredClone(baseInput)
    decisionChanged.feedback.final_decision.policy_ref = "test-policy-v2"
    const profileChanged = structuredClone(baseInput)
    profileChanged.profile_snapshot.goal = "掌握循环并能解释执行过程"
    const evidenceChanged = structuredClone(baseInput)
    evidenceChanged.current_evidence_pack.results[0]!.snippet = "updated fixture evidence"

    const results = [
      prepareNextRound(baseInput),
      prepareNextRound(feedbackChanged),
      prepareNextRound(decisionChanged),
      prepareNextRound(profileChanged),
      prepareNextRound(evidenceChanged),
    ]
    expect(results[3]).toMatchObject({
      status: "blocked",
      code: "INVALID_CURRENT_INPUT",
    })
    expect(results[4]).toMatchObject({
      status: "blocked",
      code: "INVALID_CURRENT_INPUT",
    })
    const ready = results.filter(
      (result): result is GenerationReadyNextRound => result.status === "generation_ready",
    )
    expect(ready).toHaveLength(3)
    expect(new Set(ready.map((result) => result.idempotency_key)).size).toBe(3)
    expect(new Set(ready.map((result) => result.generation_spec.run_id)).size).toBe(3)
  })

  test("advance waits without side effects and then consumes only the explicit upstream node and evidence", () => {
    const fixture = buildFixture()
    const feedback = feedbackFor(fixture, "advance")
    const awaiting = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    expect(awaiting).toMatchObject({
      status: "awaiting_path_node",
      action: "advance",
      current_path_node_id: fixture.path.node_id,
      completed_objective_ids: ["O1"],
      required_inputs: ["next_path_node", "next_evidence_pack"],
    })

    const nextPath = pathFor("PATH-NEXT", "K009", "O-NEXT")
    const nextEvidence = evidenceFor("RAG-NEXT", "K009")
    const ready = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: nextPath,
      next_evidence_pack: nextEvidence,
    })
    expect(ready.status).toBe("generation_ready")
    if (ready.status !== "generation_ready") return
    expect(ready.action).toBe("advance")
    expect(ready.generation_spec.path_node.node_id).toBe("PATH-NEXT")
    expect(ready.generation_spec.targets.map((target) => target.objective_id)).toEqual(["O-NEXT"])
    expect(ready.focus_objective_ids).toEqual(["O-NEXT"])
    expect(ready.trigger_objective_ids).toEqual([])
    expect(ready.generation_spec.evidence_ref).toBe("RAG-NEXT")
  })

  test("advance never accepts the current path as a purported next node and propagates weak evidence", () => {
    const fixture = buildFixture()
    const feedback = feedbackFor(fixture, "advance")
    const samePath = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: fixture.path,
      next_evidence_pack: fixture.evidence,
    })
    expect(samePath).toMatchObject({ status: "blocked", code: "INVALID_ADVANCE_INPUT" })

    const weakEvidence = evidenceFor("RAG-NEXT-WEAK", "K009")
    weakEvidence.match_status = "weak"
    const weak = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: pathFor("PATH-NEXT", "K009", "O-NEXT"),
      next_evidence_pack: weakEvidence,
    })
    expect(weak).toMatchObject({ status: "blocked", code: "SPEC_BUILD_BLOCKED" })
    if (weak.status === "blocked") expect(weak.gap_request?.missing_type).toBe("strong_match")
  })

  test("advance rejects a different learner and evidence retrieved for another profile level", () => {
    const fixture = buildFixture()
    const feedback = feedbackFor(fixture, "advance")
    const nextPath = pathFor("PATH-NEXT", "K009", "O-NEXT")
    const nextEvidence = evidenceFor("RAG-NEXT", "K009")
    const otherLearnerProfile = structuredClone(fixture.profile)
    otherLearnerProfile.learner_id = "learner-other"

    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: nextPath,
      next_evidence_pack: nextEvidence,
      next_profile_snapshot: otherLearnerProfile,
    })).toMatchObject({
      status: "blocked",
      code: "INVALID_ADVANCE_INPUT",
      errors: expect.arrayContaining([
        "advance 的 next_profile_snapshot.learner_id 必须与当前画像一致",
      ]),
    })

    const wrongLevelEvidence = structuredClone(nextEvidence)
    wrongLevelEvidence.learner_level = "intermediate"
    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: nextPath,
      next_evidence_pack: wrongLevelEvidence,
    })).toMatchObject({
      status: "blocked",
      code: "INVALID_ADVANCE_INPUT",
      errors: expect.arrayContaining([
        "advance 的 next_evidence_pack.learner_level 必须与下一轮画像 level 一致",
      ]),
    })
  })

  test("reprofile returns only the verified drift suggestion", () => {
    const fixture = buildFixture()
    const feedback = feedbackFor(fixture, "reprofile")
    const result = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    expect(result).toMatchObject({
      status: "reprofile_suggested",
      action: "reprofile",
      suggestion: {
        action: "reprofile",
        profile_version: fixture.profile.profile_version,
      },
    })
    expect("generation_spec" in result).toBe(false)

    const serverObservedProfile = structuredClone(fixture.profile)
    serverObservedProfile.profile_version = "profile-observed-v2"
    const withProfileObservation = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_profile_snapshot: serverObservedProfile,
    })
    expect(withProfileObservation).toMatchObject({
      status: "reprofile_suggested",
      action: "reprofile",
    })
    expect("generation_spec" in withProfileObservation).toBe(false)

    const missing = structuredClone(feedback)
    delete missing.profile_drift_suggestion
    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: missing,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })).toMatchObject({ status: "blocked", code: "MISSING_PROFILE_DRIFT" })
  })

  test("continues generation after B returns a reprofiled learner and path", () => {
    const fixture = buildFixture()
    const updatedProfile = structuredClone(fixture.profile)
    updatedProfile.profile_version = "profile-next-round-v2"
    updatedProfile.level = "intermediate"
    updatedProfile.known_concepts.push("循环")
    updatedProfile.weak_concepts = ["列表遍历"]
    const nextPath = pathFor("PATH-AFTER-REPROFILE", "K009", "O2")
    const nextEvidence = evidenceFor("RAG-AFTER-REPROFILE", "K009")
    nextEvidence.learner_level = "intermediate"
    nextEvidence.results[0]!.difficulty = "intermediate"

    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reprofile"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_profile_snapshot: updatedProfile,
      next_path_node: nextPath,
      next_evidence_pack: nextEvidence,
    })).toMatchObject({
      status: "blocked",
      code: "INVALID_ADVANCE_INPUT",
      errors: [
        "reprofile 继续生成时必须由上游明确提供 next_generation_action",
      ],
    })

    const result = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reprofile"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_profile_snapshot: updatedProfile,
      next_path_node: nextPath,
      next_evidence_pack: nextEvidence,
      next_generation_action: "remediate",
    })

    expect(result.status).toBe("generation_ready")
    if (result.status !== "generation_ready") return
    expect(result.action).toBe("reprofile")
    expect(result.generation_action).toBe("remediate")
    expect(result.generation_spec.profile_ref.profile_version)
      .toBe(updatedProfile.profile_version)
    expect(result.generation_spec.path_node.node_id).toBe(nextPath.node_id)
    expect(result.generation_spec.evidence_ref).toBe(nextEvidence.retrieval_id)
    expect(result.focus_objective_ids).toEqual(["O2"])
  })

  test("rejects mixed identity, unknown focus objectives, and path input on current-node actions", () => {
    const fixture = buildFixture()
    const mixed = feedbackFor(fixture, "reinforce")
    mixed.path_node_id = "PATH-OTHER"
    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: mixed,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })).toMatchObject({ status: "blocked", code: "IDENTITY_MISMATCH" })

    const unknown = feedbackFor(fixture, "remediate")
    unknown.final_decision.target_objective_ids = ["O-UNKNOWN"]
    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: unknown,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })).toMatchObject({ status: "blocked", code: "INVALID_TARGET_OBJECTIVES" })

    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: pathFor("PATH-NEXT", "K009", "O-NEXT"),
    })).toMatchObject({ status: "blocked", code: "INVALID_ADVANCE_INPUT" })
  })

  test("rejects a feedback envelope whose public round score no longer matches the frozen grade", () => {
    const fixture = buildFixture()
    const forged = feedbackFor(fixture, "reinforce")
    forged.round_score.accuracy = 0.25
    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: forged,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })).toMatchObject({
      status: "blocked",
      code: "INVALID_FEEDBACK",
      errors: expect.arrayContaining(["round_score 与冻结 grade_result 不一致"]),
    })
  })

  test("reprofile rejects any attempted next-node generation input", () => {
    const fixture = buildFixture()
    expect(prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reprofile"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_path_node: pathFor("PATH-NEXT", "K009", "O-NEXT"),
      next_evidence_pack: evidenceFor("RAG-NEXT", "K009"),
    })).toMatchObject({ status: "blocked", code: "INVALID_ADVANCE_INPUT" })
  })
})

describe("Role C next-round execution idempotency", () => {
  test("journals one reviewed READY result and replays it on a later call", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture next round not ready")
    }

    let pipelineCalls = 0
    const journal = new InMemoryNextRoundExecutionJournal()
    const secureStore = new InMemorySecureArtifactStore()
    const dependencies = {
      agents: reviewedAgents(),
      secure_store: secureStore,
      review_options: {
        review_port: {
          policy_version: "next-round-ready-review-v1",
          async review(request: ContentReviewRequest) {
            return passingReviewResult(request, this.policy_version)
          },
        },
        max_external_revisions: 1 as const,
        trace_seq_start: 7,
      },
      review_execution_config_version: "review-execution-ready-v1",
      execution_journal: journal,
      reviewed_pipeline_runner: async (...args: Parameters<typeof runReviewedCPipeline>) => {
        pipelineCalls += 1
        return runReviewedCPipeline(...args)
      },
    }

    const first = await executePreparedNextRound(prepared, dependencies)
    const replay = await executePreparedNextRound(
      structuredClone(prepared),
      dependencies,
    )

    expect(first.status).toBe("ready")
    expect(first.state).toBe("READY")
    expect(replay).toEqual(first)
    expect(pipelineCalls).toBe(1)
    expect(journal.size).toBe(1)
    expect(first.trace_events[0]?.seq).toBe(7)

    const compareAndDeleteProbe = new InMemoryNextRoundExecutionJournal()
    const probeEntry: NextRoundExecutionJournalEntry = {
      journal_version: "1.0",
      execution_key: "probe-execution-key",
      result_hash: contentHash(first),
      result: structuredClone(first),
    }
    await compareAndDeleteProbe.commitSuccessful(probeEntry)
    expect(await compareAndDeleteProbe.invalidateSuccessful(
      probeEntry.execution_key,
      `sha256:${"f".repeat(64)}`,
    )).toBe(false)
    expect(compareAndDeleteProbe.size).toBe(1)
    expect(await compareAndDeleteProbe.invalidateSuccessful(
      probeEntry.execution_key,
      probeEntry.result_hash,
    )).toBe(true)
    expect(compareAndDeleteProbe.size).toBe(0)

    await secureStore.deleteBatch(first.secure_refs, {
      principal: "role-c-pipeline",
      run_id: first.generation_spec.run_id,
    })
    const [recovered, concurrentReplay] = await Promise.all([
      executePreparedNextRound(prepared, dependencies),
      executePreparedNextRound(structuredClone(prepared), dependencies),
    ])
    expect(recovered.status).toBe("ready")
    expect(concurrentReplay).toEqual(recovered)
    expect(recovered.secure_refs).not.toEqual(first.secure_refs)
    expect(pipelineCalls).toBe(2)
    expect(journal.size).toBe(1)
  })

  test("cleans an ambiguously committed secure batch and can retry safely", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture next round not ready")
    }

    const secureStore = new InMemorySecureArtifactStore()
    const innerJournal = new InMemoryNextRoundExecutionJournal()
    let failAfterCommit = true
    let pipelineCalls = 0
    let firstRefs: string[] = []
    const journal = {
      loadSuccessful: innerJournal.loadSuccessful.bind(innerJournal),
      invalidateSuccessful:
        innerJournal.invalidateSuccessful.bind(innerJournal),
      async commitSuccessful(
        entry: NextRoundExecutionJournalEntry,
      ): Promise<NextRoundExecutionJournalEntry> {
        const committed = await innerJournal.commitSuccessful(entry)
        if (failAfterCommit) {
          failAfterCommit = false
          throw new Error("journal response lost after commit")
        }
        return committed
      },
    }
    const dependencies = {
      agents: reviewedAgents(),
      secure_store: secureStore,
      review_options: {
        review_port: {
          policy_version: "next-round-ambiguous-journal-v1",
          async review(request: ContentReviewRequest) {
            return passingReviewResult(request, this.policy_version)
          },
        },
      },
      review_execution_config_version: "review-execution-ambiguous-v1",
      execution_journal: journal,
      reviewed_pipeline_runner: async (...args: Parameters<typeof runReviewedCPipeline>) => {
        pipelineCalls += 1
        const result = await runReviewedCPipeline(...args)
        if (pipelineCalls === 1) firstRefs = [...result.secure_refs]
        return result
      },
    }

    await expect(executePreparedNextRound(prepared, dependencies))
      .rejects.toThrow("journal response lost after commit")
    expect(innerJournal.size).toBe(0)
    await expect(secureStore.get(firstRefs[0]!, {
      principal: "role-c-grader",
      run_id: prepared.generation_spec.run_id,
    })).rejects.toThrow()

    const recovered = await executePreparedNextRound(prepared, dependencies)
    expect(recovered.status).toBe("ready")
    expect(recovered.secure_refs).not.toEqual(firstRefs)
    expect(innerJournal.size).toBe(1)
    expect(pipelineCalls).toBe(2)
  })

  test("does not journal a READY result that fails the central reviewed gate", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture next round not ready")
    }
    const journal = new InMemoryNextRoundExecutionJournal()
    await expect(executePreparedNextRound(prepared, {
      agents: reviewedAgents(),
      secure_store: new InMemorySecureArtifactStore(),
      review_options: {
        review_port: {
          policy_version: "next-round-forged-review-v1",
          async review(request: ContentReviewRequest) {
            return passingReviewResult(request, this.policy_version)
          },
        },
      },
      review_execution_config_version: "review-execution-forged-v1",
      execution_journal: journal,
      reviewed_pipeline_runner: async (input, agents, store, options) => {
        const result = await runReviewedCPipeline(
          input,
          agents,
          store,
          options,
        )
        const forged = structuredClone(result)
        forged.review_reports.at(-1)!.artifact_results[0]!.artifact_hash =
          `sha256:${"f".repeat(64)}`
        return forged
      },
    })).rejects.toThrow("REVIEW_ARTIFACT_MISMATCH")
    expect(journal.size).toBe(0)
  })

  test("keeps the atomic journal winner and removes the losing secure batch", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture next round not ready")
    }

    const innerStore = new InMemorySecureArtifactStore()
    const deleted: string[][] = []
    const secureStore: SecureArtifactStore = {
      namespace_id: innerStore.namespace_id,
      put: innerStore.put.bind(innerStore),
      putBatch: innerStore.putBatch.bind(innerStore),
      get: innerStore.get.bind(innerStore),
      async deleteBatch(refs, context) {
        deleted.push([...refs])
        await innerStore.deleteBatch(refs, context)
      },
    }
    let winner: ReviewedCPipelineResult | undefined
    let loserRefs: string[] = []
    const journal = {
      async loadSuccessful() {
        return undefined
      },
      async invalidateSuccessful() {
        return false
      },
      async commitSuccessful(
        _entry: NextRoundExecutionJournalEntry,
      ): Promise<NextRoundExecutionJournalEntry> {
        if (!winner) throw new Error("winner missing")
        return {
          journal_version: "1.0",
          execution_key: _entry.execution_key,
          result_hash: contentHash(winner),
          result: structuredClone(winner),
        }
      },
    }
    const reviewOptions = {
      review_port: {
        policy_version: "next-round-race-review-v1",
        async review(request: ContentReviewRequest) {
          return passingReviewResult(request, this.policy_version)
        },
      },
      max_external_revisions: 1 as const,
      trace_seq_start: 3,
    }
    const result = await executePreparedNextRound(prepared, {
      agents: reviewedAgents(),
      secure_store: secureStore,
      review_options: reviewOptions,
      review_execution_config_version: "review-execution-race-v1",
      execution_journal: journal,
      reviewed_pipeline_runner: async (input, agents, store, options) => {
        winner = await runReviewedCPipeline(input, agents, store, options)
        const loser = await runReviewedCPipeline(input, agents, store, options)
        loserRefs = [...loser.secure_refs]
        return loser
      },
    })

    const committedWinner = winner as ReviewedCPipelineResult | undefined
    if (!committedWinner) throw new Error("winner missing after execution")
    expect(committedWinner.status).toBe("ready")
    expect(result.secure_refs).toEqual(committedWinner.secure_refs)
    expect(new Set(result.secure_refs)).not.toEqual(new Set(loserRefs))
    expect(deleted).toEqual([loserRefs])
    await Promise.all(result.secure_refs.map((ref) =>
      secureStore.get(ref, {
        principal: "role-c-grader",
        run_id: result.generation_spec.run_id,
      })))
    await expect(secureStore.get(loserRefs[0]!, {
      principal: "role-c-grader",
      run_id: result.generation_spec.run_id,
    })).rejects.toThrow()
  })

  test("fails explicitly when the losing secure batch cannot be removed", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture next round not ready")
    }

    const innerStore = new InMemorySecureArtifactStore()
    const secureStore: SecureArtifactStore = {
      namespace_id: innerStore.namespace_id,
      put: innerStore.put.bind(innerStore),
      putBatch: innerStore.putBatch.bind(innerStore),
      get: innerStore.get.bind(innerStore),
      async deleteBatch() {
        throw new Error("storage unavailable")
      },
    }
    let winner: ReviewedCPipelineResult | undefined
    const reviewOptions = {
      review_port: {
        policy_version: "next-round-race-cleanup-review-v1",
        async review(request: ContentReviewRequest) {
          return passingReviewResult(request, this.policy_version)
        },
      },
      max_external_revisions: 1 as const,
      trace_seq_start: 3,
    }
    await expect(executePreparedNextRound(prepared, {
      agents: reviewedAgents(),
      secure_store: secureStore,
      review_options: reviewOptions,
      review_execution_config_version: "review-execution-race-cleanup-v1",
      execution_journal: {
        async loadSuccessful() {
          return undefined
        },
        async invalidateSuccessful() {
          return false
        },
        async commitSuccessful(entry) {
          if (!winner) throw new Error("winner missing")
          return {
            journal_version: "1.0",
            execution_key: entry.execution_key,
            result_hash: contentHash(winner),
            result: structuredClone(winner),
          }
        },
      },
      reviewed_pipeline_runner: async (input, agents, store, options) => {
        winner = await runReviewedCPipeline(input, agents, store, options)
        return runReviewedCPipeline(input, agents, store, options)
      },
    })).rejects.toThrow("NEXT_ROUND_LOSER_SECURE_CLEANUP_FAILED")
  })

  test("shares one in-flight pipeline execution for concurrent identical requests", async () => {
    const fixture = buildFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") throw new Error("fixture next round not ready")

    let conceptCalls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const agents: RoleCAgents = {
      concept_tutor: {
        async generate(request) {
          conceptCalls += 1
          expect(request.next_round_context).toMatchObject({
            prior_feedback_ref: prepared.prior_feedback_ref,
            action: prepared.action,
            focus_objective_ids: prepared.focus_objective_ids,
          })
          await gate
          return blockedConcept(request.generation_spec)
        },
      },
      code_lab: { async generate() { throw new Error("code-lab must not run") } },
      tiered_evaluator: { async generate() { throw new Error("evaluator must not run") } },
    }
    const dependencies = {
      agents,
      secure_store: new InMemorySecureArtifactStore(),
      review_options: {
        review_port: {
          policy_version: "next-round-test-review-v1",
          async review() {
            throw new Error("blocked candidate must not reach external review")
          },
        },
      },
      single_flight: new KeyedSingleFlight(),
      review_execution_config_version: "review-execution-test-v1",
    }
    const first = executePreparedNextRound(prepared, dependencies)
    const duplicate = executePreparedNextRound(structuredClone(prepared), dependencies)
    release()
    const [left, right] = await Promise.all([first, duplicate])
    expect(left).toEqual(right)
    expect(left.status).toBe("blocked")
    expect(conceptCalls).toBe(1)
    expect(dependencies.single_flight.size).toBe(0)

    const sequentialRetry = await executePreparedNextRound(prepared, dependencies)
    expect(sequentialRetry.status).toBe("blocked")
    expect(conceptCalls).toBe(2)
  })

  test("rejects tampered prepared input and binds every review execution setting into the flight key", async () => {
    const fixture = buildFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") throw new Error("fixture next round not ready")

    const duplicate = structuredClone(prepared)
    const changedInput = structuredClone(prepared)
    changedInput.evidence_pack.results[0]!.snippet = "different execution evidence"
    const changedFeedback = structuredClone(prepared)
    changedFeedback.prior_feedback_ref = "DFR-reinforce-reissued"
    const changedDecision = structuredClone(prepared)
    changedDecision.trigger_decision.policy_ref = "test-policy-v2"
    const changedProfile = structuredClone(prepared)
    changedProfile.profile_content_hash = `sha256:${"b".repeat(64)}`

    let conceptCalls = 0
    let release!: () => void
    let allStarted!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { allStarted = resolve })
    const agents: RoleCAgents = {
      concept_tutor: {
        async generate(request) {
          conceptCalls += 1
          if (conceptCalls === 6) allStarted()
          await gate
          return blockedConcept(request.generation_spec)
        },
      },
      code_lab: { async generate() { throw new Error("code-lab must not run") } },
      tiered_evaluator: { async generate() { throw new Error("evaluator must not run") } },
    }
    const secureStore = new InMemorySecureArtifactStore()
    const singleFlight = new KeyedSingleFlight()
    const dependenciesFor = (
      policyVersion: string,
      options: {
        max_external_revisions?: 0 | 1 | 2
        trace_seq_start?: number
        review_execution_config_version?: string
        secure_store?: SecureArtifactStore
      } = {},
    ) => ({
      agents,
      secure_store: options.secure_store ?? secureStore,
      review_options: {
        review_port: {
          policy_version: policyVersion,
          async review() {
            throw new Error("blocked candidate must not reach external review")
          },
        },
        ...(options.max_external_revisions !== undefined
          ? { max_external_revisions: options.max_external_revisions }
          : {}),
        ...(options.trace_seq_start !== undefined
          ? { trace_seq_start: options.trace_seq_start }
          : {}),
      },
      single_flight: singleFlight,
      review_execution_config_version:
        options.review_execution_config_version
          ?? "review-execution-test-v1",
    })

    await expect(executePreparedNextRound(
      changedInput,
      dependenciesFor("review-v1"),
    )).rejects.toThrow("NEXT_ROUND_PREPARED_IDENTITY_MISMATCH")
    await expect(executePreparedNextRound(
      changedFeedback,
      dependenciesFor("review-v1"),
    )).rejects.toThrow("NEXT_ROUND_PREPARED_IDENTITY_MISMATCH")
    await expect(executePreparedNextRound(
      changedDecision,
      dependenciesFor("review-v1"),
    )).rejects.toThrow("NEXT_ROUND_PREPARED_IDENTITY_MISMATCH")
    await expect(executePreparedNextRound(
      changedProfile,
      dependenciesFor("review-v1"),
    )).rejects.toThrow("NEXT_ROUND_PREPARED_IDENTITY_MISMATCH")

    const executions = [
      executePreparedNextRound(prepared, dependenciesFor("review-v1")),
      executePreparedNextRound(duplicate, dependenciesFor("review-v1")),
      executePreparedNextRound(structuredClone(prepared), dependenciesFor("review-v2")),
      executePreparedNextRound(structuredClone(prepared), dependenciesFor(
        "review-v1",
        { max_external_revisions: 1 },
      )),
      executePreparedNextRound(structuredClone(prepared), dependenciesFor(
        "review-v1",
        { trace_seq_start: 4 },
      )),
      executePreparedNextRound(structuredClone(prepared), dependenciesFor(
        "review-v1",
        { review_execution_config_version: "review-execution-test-v2" },
      )),
      executePreparedNextRound(structuredClone(prepared), dependenciesFor(
        "review-v1",
        { secure_store: new InMemorySecureArtifactStore() },
      )),
    ]
    const reachedExpectedFlights = await Promise.race([
      started.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])
    release()
    const results = await Promise.all(executions)

    expect(reachedExpectedFlights).toBe(true)
    expect(conceptCalls).toBe(6)
    expect(results.every((result) => result.status === "blocked")).toBe(true)
    expect(singleFlight.size).toBe(0)
  })

  test("requires explicit review config and a stable secure-store namespace", async () => {
    const fixture = buildFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture next round not ready")
    }
    const agents: RoleCAgents = {
      concept_tutor: {
        async generate(request) {
          return blockedConcept(request.generation_spec)
        },
      },
      code_lab: { async generate() { throw new Error("unexpected") } },
      tiered_evaluator: { async generate() { throw new Error("unexpected") } },
    }
    const reviewOptions = {
      review_port: {
        policy_version: "review-config-validation-v1",
        async review() {
          throw new Error("unexpected")
        },
      },
    }
    await expect(executePreparedNextRound(prepared, {
      agents,
      secure_store: new InMemorySecureArtifactStore(),
      review_options: reviewOptions,
      review_execution_config_version: " ",
    })).rejects.toThrow(
      "NEXT_ROUND_REVIEW_EXECUTION_CONFIG_VERSION_EMPTY",
    )

    const inner = new InMemorySecureArtifactStore()
    const noNamespaceStore: SecureArtifactStore = {
      put: inner.put.bind(inner),
      putBatch: inner.putBatch.bind(inner),
      get: inner.get.bind(inner),
      deleteBatch: inner.deleteBatch.bind(inner),
    }
    await expect(executePreparedNextRound(prepared, {
      agents,
      secure_store: noNamespaceStore,
      review_options: reviewOptions,
      review_execution_config_version: "review-execution-v1",
    })).rejects.toThrow("NEXT_ROUND_SECURE_STORE_NAMESPACE_REQUIRED")
  })

  test("allows retry after a failed flight and keeps different keys independent", async () => {
    const flight = new KeyedSingleFlight()
    let failedCalls = 0
    const first = flight.run("same", async () => {
      failedCalls += 1
      throw new Error("temporary")
    })
    const duplicate = flight.run("same", async () => {
      failedCalls += 1
      return "unexpected"
    })
    await expect(first).rejects.toThrow("temporary")
    await expect(duplicate).rejects.toThrow("temporary")
    expect(failedCalls).toBe(1)
    expect(flight.size).toBe(0)
    expect(await flight.run("same", async () => "recovered")).toBe("recovered")

    const values = await Promise.all([
      flight.run("left", async () => "L"),
      flight.run("right", async () => "R"),
    ])
    expect(values).toEqual(["L", "R"])
  })

  test("rejects an empty idempotency key without invoking work", async () => {
    const flight = new KeyedSingleFlight()
    let calls = 0
    await expect(flight.run(" ", async () => {
      calls += 1
      return "never"
    })).rejects.toThrow("NEXT_ROUND_IDEMPOTENCY_KEY_EMPTY")
    expect(calls).toBe(0)
  })
})

describe("Role C completed-cycle continuation", () => {
  test("uses B's updated profile/path to generate, review, and idempotently publish the next round to D", async () => {
    const fixture = buildReviewedFixture()
    const updatedProfile = structuredClone(fixture.profile)
    updatedProfile.profile_id = "PROFILE-NEXT-ROUND-REVIEWED-V2"
    updatedProfile.profile_version = "profile-next-round-reviewed-v2"
    updatedProfile.known_concepts.push("循环")
    updatedProfile.weak_concepts = ["列表"]
    const updatedPath = structuredClone(fixture.path)
    updatedPath.node_id = "PATH-NEXT-ROUND-AFTER-B"
    const updatedEvidence = structuredClone(fixture.evidence)
    updatedEvidence.retrieval_id = "RAG-NEXT-ROUND-AFTER-B"
    updatedEvidence.query = "循环 列表 成绩统计"
    const feedback = feedbackFor(fixture, "reprofile")
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback,
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
      next_profile_snapshot: updatedProfile,
      next_path_node: updatedPath,
      next_evidence_pack: updatedEvidence,
      next_generation_action: "advance",
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture completed-cycle continuation not ready")
    }

    const journal = new InMemoryNextRoundExecutionJournal()
    const adaptiveJournal = new InMemoryAdaptiveLearningLoopJournal()
    const delivered = new Set<string>()
    const deliveries: string[] = []
    const lifecycleEvents: string[] = []
    let pipelineCalls = 0
    const secureStore = new InMemorySecureArtifactStore()
    const cycleService = new LearningCycleService({
      cycle_store: new InMemoryLearningCycleStore(),
      secure_store: secureStore,
      mastery_store: new InMemoryMasteryStateStore(),
    })
    const dependencies = {
      learning_cycle: {
        async prepareNextRoundFromCompletedSubmission() {
          return structuredClone(prepared)
        },
        async registerReadyRun(
          request: Parameters<LearningCycleService["registerReadyRun"]>[0],
        ) {
          lifecycleEvents.push("register")
          return cycleService.registerReadyRun(request)
        },
        async openAnchorFirstSession(
          request: Parameters<
            LearningCycleService["openAnchorFirstSession"]
          >[0],
        ) {
          lifecycleEvents.push("open_anchor_session")
          return cycleService.openAnchorFirstSession(request)
        },
      },
      agents: reviewedAgents(),
      secure_store: secureStore,
      review_options: {
        review_port: {
          policy_version: "completed-cycle-review-v1",
          async review(request: ContentReviewRequest) {
            return passingReviewResult(request, this.policy_version)
          },
        },
      },
      review_execution_config_version: "completed-cycle-execution-v1",
      recovery_policy_version: "completed-cycle-recovery-policy-v1",
      recovery_port_version: "completed-cycle-recovery-ports-v1",
      delivery_target_namespace: "role-d-test",
      execution_journal: journal,
      adaptive_execution_journal: adaptiveJournal,
      reviewed_pipeline_runner: async (
        ...args: Parameters<typeof runReviewedCPipeline>
      ) => {
        pipelineCalls += 1
        return runReviewedCPipeline(...args)
      },
      role_d_port: {
        async publishReviewedRelease(
          release: Parameters<
            import("../src/role-c-content").RoleDPublicDeliveryPort[
              "publishReviewedRelease"
            ]
          >[0],
        ) {
          lifecycleEvents.push("publish_release")
          deliveries.push(release.delivery_id)
          const status = delivered.has(release.delivery_id)
            ? "duplicate" as const
            : "accepted" as const
          delivered.add(release.delivery_id)
          return {
            schema_version: "1.0" as const,
            delivery_kind: "reviewed_release" as const,
            delivery_id: release.delivery_id,
            status,
          }
        },
        async publishLearningSession(delivery: Parameters<
          import("../src/role-c-content").RoleDLearningSessionPort[
            "publishLearningSession"
          ]
        >[0]) {
          lifecycleEvents.push("publish_session")
          deliveries.push(delivery.delivery_id)
          expect(delivery.session.phase).toBe("anchor_pending")
          const status = delivered.has(delivery.delivery_id)
            ? "duplicate" as const
            : "accepted" as const
          delivered.add(delivery.delivery_id)
          return {
            schema_version: "1.0" as const,
            delivery_kind: "learning_session" as const,
            delivery_id: delivery.delivery_id,
            status,
          }
        },
        async publishReviewRecoveryStatus(delivery: Parameters<
          import("../src/role-c-content").RoleDReviewRecoveryStatusPort[
            "publishReviewRecoveryStatus"
          ]
        >[0]) {
          throw new Error(`unexpected recovery status ${delivery.delivery_id}`)
        },
      },
    }
    const continuationInput = {
      session_id: "SESSION-NEXT-ROUND",
      submission_id: "SUB-NEXT-ROUND",
      authenticated_learner_id_hash: "learner-hash",
      profile_snapshot: fixture.profile,
      next_profile_snapshot: updatedProfile,
      next_path_node: updatedPath,
      next_evidence_pack: updatedEvidence,
      next_generation_action: "advance" as const,
    }

    const first = await continueCompletedLearningCycle(
      continuationInput,
      dependencies,
    )
    const replay = await continueCompletedLearningCycle(
      structuredClone(continuationInput),
      dependencies,
    )

    expect(first.status).toBe("published")
    expect(replay.status).toBe("published")
    if (first.status !== "published" || replay.status !== "published") return
    expect(first.preparation.action).toBe("reprofile")
    expect(first.preparation.generation_action).toBe("advance")
    expect(first.preparation.profile_version)
      .toBe(updatedProfile.profile_version)
    expect(first.preparation.path_node_id)
      .toBe(updatedPath.node_id)
    expect(first.generation.pipeline_state).toBe("READY")
    expect(first.learning_session.run_id).toBe(first.generation.run_id)
    expect(replay.learning_session).toEqual(first.learning_session)
    expect(first.delivery_to_d.reviewed_release.status).toBe("accepted")
    expect(first.delivery_to_d.learning_session.status).toBe("accepted")
    expect(replay.delivery_to_d).toEqual(first.delivery_to_d)
    expect(deliveries).toEqual([
      first.delivery_to_d.reviewed_release.delivery_id,
      first.delivery_to_d.learning_session.delivery_id,
    ])
    expect(pipelineCalls).toBe(1)
    expect(journal.size).toBe(1)
    expect(adaptiveJournal.size).toBe(1)
    expect(lifecycleEvents).toEqual([
      "register",
      "open_anchor_session",
      "publish_release",
      "publish_session",
    ])
    expect(JSON.stringify(first)).not.toContain(
      updatedEvidence.results[0]!.quiz_seeds[0]!.answer,
    )
  })

  test("opens an anchor-first session and retries safely after session creation fails", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "remediate"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture remediate continuation not ready")
    }

    const secureStore = new InMemorySecureArtifactStore()
    const journal = new InMemoryNextRoundExecutionJournal()
    const cycleService = new LearningCycleService({
      cycle_store: new InMemoryLearningCycleStore(),
      secure_store: secureStore,
      mastery_store: new InMemoryMasteryStateStore(),
    })
    let openAttempts = 0
    let pipelineCalls = 0
    let deliveryCalls = 0
    let sessionDeliveryCalls = 0
    let publishedRelease:
      | Parameters<
          import("../src/role-c-content").RoleDPublicDeliveryPort[
            "publishReviewedRelease"
          ]
        >[0]
      | undefined
    let publishedSession:
      | Parameters<
          import("../src/role-c-content").RoleDLearningSessionPort[
            "publishLearningSession"
          ]
        >[0]
      | undefined
    const dependencies = {
      learning_cycle: {
        async prepareNextRoundFromCompletedSubmission() {
          return structuredClone(prepared)
        },
        registerReadyRun: cycleService.registerReadyRun.bind(cycleService),
        async openAnchorFirstSession(
          request: Parameters<
            LearningCycleService["openAnchorFirstSession"]
          >[0],
        ) {
          openAttempts += 1
          if (openAttempts === 1) throw new Error("temporary session failure")
          return cycleService.openAnchorFirstSession(request)
        },
      },
      agents: reviewedAgents(),
      secure_store: secureStore,
      review_options: {
        review_port: {
          policy_version: "remediate-route-review-v1",
          async review(request: ContentReviewRequest) {
            return passingReviewResult(request, this.policy_version)
          },
        },
      },
      review_execution_config_version: "remediate-route-execution-v1",
      recovery_policy_version: "remediate-route-recovery-policy-v1",
      recovery_port_version: "remediate-route-recovery-ports-v1",
      delivery_target_namespace: "role-d-test",
      execution_journal: journal,
      reviewed_pipeline_runner: async (
        ...args: Parameters<typeof runReviewedCPipeline>
      ) => {
        pipelineCalls += 1
        return runReviewedCPipeline(...args)
      },
      role_d_port: {
        async publishReviewedRelease(
          release: Parameters<
            import("../src/role-c-content").RoleDPublicDeliveryPort[
              "publishReviewedRelease"
            ]
          >[0],
        ) {
          deliveryCalls += 1
          publishedRelease = structuredClone(release)
          return {
            schema_version: "1.0" as const,
            delivery_kind: "reviewed_release" as const,
            delivery_id: release.delivery_id,
            status: "accepted" as const,
          }
        },
        async publishLearningSession(delivery: Parameters<
          import("../src/role-c-content").RoleDLearningSessionPort[
            "publishLearningSession"
          ]
        >[0]) {
          sessionDeliveryCalls += 1
          publishedSession = structuredClone(delivery)
          return {
            schema_version: "1.0" as const,
            delivery_kind: "learning_session" as const,
            delivery_id: delivery.delivery_id,
            status: "accepted" as const,
          }
        },
        async publishReviewRecoveryStatus(delivery: Parameters<
          import("../src/role-c-content").RoleDReviewRecoveryStatusPort[
            "publishReviewRecoveryStatus"
          ]
        >[0]) {
          throw new Error(`unexpected recovery status ${delivery.delivery_id}`)
        },
      },
    }
    const continuationInput = {
      session_id: "SESSION-REMEDIATE-PARENT",
      submission_id: "SUB-REMEDIATE-PARENT",
      authenticated_learner_id_hash: "learner-hash",
      profile_snapshot: fixture.profile,
    }

    await expect(continueCompletedLearningCycle(
      continuationInput,
      dependencies,
    )).rejects.toThrow("temporary session failure")
    expect(deliveryCalls).toBe(0)
    expect(pipelineCalls).toBe(1)
    expect(journal.size).toBe(1)

    const result = await continueCompletedLearningCycle(
      continuationInput,
      dependencies,
    )
    expect(result.status).toBe("published")
    if (result.status !== "published"
      || !publishedRelease
      || !publishedSession) return
    expect(result.learning_session.phase).toBe("anchor_pending")
    expect(publishedSession.session).toEqual(result.learning_session)
    expect("learning_session" in publishedRelease).toBe(false)
    const assessment = publishedRelease.artifacts[2].payload!
    expect(result.learning_session.required_item_ids)
      .toEqual(assessment.routing.anchor_item_ids)
    expect(openAttempts).toBe(2)
    expect(deliveryCalls).toBe(1)
    expect(sessionDeliveryCalls).toBe(1)
    expect(pipelineCalls).toBe(1)
  })

  test("registers and publishes the recovered final input after A supplies new evidence", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture evidence recovery continuation not ready")
    }
    const refreshed = structuredClone(prepared.evidence_pack)
    refreshed.retrieval_id = "RAG-NEXT-ROUND-RECOVERED"
    refreshed.query = "循环 巩固 补充证据"
    refreshed.results[0]!.facts[0]!.content = "补充后的循环教学事实"
    const secretAnswer = "SECRET_ADAPTIVE_RECOVERY_ANSWER_31ab"
    refreshed.results[0]!.quiz_seeds[0]!.answer = secretAnswer

    const secureStore = new InMemorySecureArtifactStore()
    const cycleService = new LearningCycleService({
      cycle_store: new InMemoryLearningCycleStore(),
      secure_store: secureStore,
      mastery_store: new InMemoryMasteryStateStore(),
    })
    let registered:
      | Parameters<LearningCycleService["registerReadyRun"]>[0]
      | undefined
    let evidenceCalls = 0
    let pipelineCalls = 0
    let publishedJson = ""
    const result = await continueCompletedLearningCycle(
      {
        session_id: "SESSION-EVIDENCE-PARENT",
        submission_id: "SUB-EVIDENCE-PARENT",
        authenticated_learner_id_hash: "learner-hash",
        profile_snapshot: fixture.profile,
      },
      {
        learning_cycle: {
          async prepareNextRoundFromCompletedSubmission() {
            return structuredClone(prepared)
          },
          async registerReadyRun(request) {
            registered = structuredClone(request)
            return cycleService.registerReadyRun(request)
          },
          openAnchorFirstSession:
            cycleService.openAnchorFirstSession.bind(cycleService),
        },
        agents: reviewedAgents(),
        secure_store: secureStore,
        review_options: {
          review_port: {
            policy_version: "adaptive-evidence-recovery-review-v1",
            async review(request) {
              return request.generation_spec.evidence_ref
                  === prepared.evidence_pack.retrieval_id
                ? newEvidenceReviewResult(request, this.policy_version)
                : passingReviewResult(request, this.policy_version)
            },
          },
        },
        review_execution_config_version:
          "adaptive-evidence-recovery-execution-v1",
        recovery_policy_version:
          "adaptive-evidence-recovery-policy-v1",
        recovery_port_version:
          "adaptive-evidence-recovery-ports-v1",
        delivery_target_namespace: "role-d-test",
        execution_journal: new InMemoryNextRoundExecutionJournal(),
        reviewed_pipeline_runner: async (
          ...args: Parameters<typeof runReviewedCPipeline>
        ) => {
          pipelineCalls += 1
          return runReviewedCPipeline(...args)
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return structuredClone(refreshed)
          },
        },
        role_d_port: {
          async publishReviewedRelease(release) {
            publishedJson += JSON.stringify(release)
            return {
              schema_version: "1.0",
              delivery_kind: "reviewed_release",
              delivery_id: release.delivery_id,
              status: "accepted",
            }
          },
          async publishLearningSession(delivery) {
            publishedJson += JSON.stringify(delivery)
            return {
              schema_version: "1.0",
              delivery_kind: "learning_session",
              delivery_id: delivery.delivery_id,
              status: "accepted",
            }
          },
          async publishReviewRecoveryStatus(delivery) {
            throw new Error(`unexpected recovery status ${delivery.delivery_id}`)
          },
        },
      },
    )

    expect(result.status).toBe("published")
    if (result.status !== "published" || !registered) return
    expect(result.generation.recovery).toMatchObject({
      code: "READY",
      required_action: "request_new_evidence",
      recovery_attempts: 1,
    })
    expect(registered.pipeline_input.evidence_pack.retrieval_id)
      .toBe(refreshed.retrieval_id)
    expect(registered.pipeline_input.generation_spec.spec_id)
      .not.toBe(prepared.generation_spec.spec_id)
    expect(registered.pipeline_result.generation_spec.spec_id)
      .toBe(registered.pipeline_input.generation_spec.spec_id)
    expect(result.generation.run_id)
      .toBe(registered.pipeline_input.generation_spec.run_id)
    expect(evidenceCalls).toBe(1)
    expect(pipelineCalls).toBe(2)
    expect(JSON.stringify(result)).not.toContain(secretAnswer)
    expect(publishedJson).not.toContain(secretAnswer)
  })

  test("never opens or publishes when final run registration fails", async () => {
    const fixture = buildReviewedFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture registration failure continuation not ready")
    }
    let registerCalls = 0
    let openCalls = 0
    let deliveryCalls = 0

    await expect(continueCompletedLearningCycle(
      {
        session_id: "SESSION-REGISTER-FAIL-PARENT",
        submission_id: "SUB-REGISTER-FAIL-PARENT",
        authenticated_learner_id_hash: "learner-hash",
        profile_snapshot: fixture.profile,
      },
      {
        learning_cycle: {
          async prepareNextRoundFromCompletedSubmission() {
            return structuredClone(prepared)
          },
          async registerReadyRun() {
            registerCalls += 1
            throw new Error("registration unavailable")
          },
          async openAnchorFirstSession() {
            openCalls += 1
            return {}
          },
        },
        agents: reviewedAgents(),
        secure_store: new InMemorySecureArtifactStore(),
        review_options: {
          review_port: {
            policy_version: "registration-failure-review-v1",
            async review(request) {
              return passingReviewResult(request, this.policy_version)
            },
          },
        },
        review_execution_config_version: "registration-failure-execution-v1",
        recovery_policy_version: "registration-failure-recovery-policy-v1",
        recovery_port_version: "registration-failure-recovery-ports-v1",
        delivery_target_namespace: "role-d-test",
        role_d_port: {
          async publishReviewedRelease(release) {
            deliveryCalls += 1
            return {
              schema_version: "1.0",
              delivery_kind: "reviewed_release",
              delivery_id: release.delivery_id,
              status: "accepted",
            }
          },
          async publishLearningSession(delivery) {
            deliveryCalls += 1
            return {
              schema_version: "1.0",
              delivery_kind: "learning_session",
              delivery_id: delivery.delivery_id,
              status: "accepted",
            }
          },
          async publishReviewRecoveryStatus(delivery) {
            deliveryCalls += 1
            return {
              schema_version: "1.0",
              delivery_kind: "review_recovery_status",
              delivery_id: delivery.delivery_id,
              status: "accepted",
            }
          },
        },
      },
    )).rejects.toThrow("registration unavailable")
    expect(registerCalls).toBe(1)
    expect(openCalls).toBe(0)
    expect(deliveryCalls).toBe(0)
  })

  test("publishes a structured D status when the prepared target is unsupported", async () => {
    const fixture = buildFixture()
    const prepared = prepareNextRound({
      authenticated_learner_id_hash: "learner-hash",
      feedback: feedbackFor(fixture, "reinforce"),
      parent_spec: fixture.spec,
      profile_snapshot: fixture.profile,
      current_evidence_pack: fixture.evidence,
    })
    if (prepared.status !== "generation_ready") {
      throw new Error("fixture unsupported continuation not ready")
    }
    let deliveryCalls = 0

    const result = await continueCompletedLearningCycle(
      {
        session_id: "SESSION-NEXT-ROUND",
        submission_id: "SUB-NEXT-ROUND",
        authenticated_learner_id_hash: "learner-hash",
        profile_snapshot: fixture.profile,
      },
      {
        learning_cycle: {
          async prepareNextRoundFromCompletedSubmission() {
            return structuredClone(prepared)
          },
          async registerReadyRun() {
            throw new Error("blocked generation must not register")
          },
          async openAnchorFirstSession() {
            throw new Error("blocked generation must not open a session")
          },
        },
        agents: reviewedAgents(),
        secure_store: new InMemorySecureArtifactStore(),
        review_options: {
          review_port: {
            policy_version: "unsupported-target-review-v1",
            async review() {
              throw new Error("unsupported generation must not reach review")
            },
          },
        },
        review_execution_config_version: "unsupported-target-execution-v1",
        recovery_policy_version: "unsupported-target-recovery-policy-v1",
        recovery_port_version: "unsupported-target-recovery-ports-v1",
        delivery_target_namespace: "role-d-test",
        role_d_port: {
          async publishReviewedRelease(release) {
            throw new Error(`blocked generation released ${release.delivery_id}`)
          },
          async publishLearningSession(delivery) {
            throw new Error(`blocked generation opened ${delivery.delivery_id}`)
          },
          async publishReviewRecoveryStatus(delivery) {
            deliveryCalls += 1
            return {
              schema_version: "1.0",
              delivery_kind: "review_recovery_status",
              delivery_id: delivery.delivery_id,
              status: "accepted",
            }
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result).toMatchObject({
      stage: "generation_review",
      generation: {
        pipeline_status: "blocked",
        recovery: {
          code: "UNSUPPORTED_TARGET",
        },
      },
    })
    expect(result).toMatchObject({
      delivery_to_d: {
        delivery_kind: "review_recovery_status",
        status: "accepted",
      },
    })
    expect(deliveryCalls).toBe(1)
  })
})

describe("Role C completed-cycle restart recovery", () => {
  test("replays a durable A result after a crash and freezes the published outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "role-c-adaptive-restart-"))
    try {
      const fixture = buildReviewedFixture()
      const prepared = prepareNextRound({
        authenticated_learner_id_hash: "learner-hash",
        feedback: feedbackFor(fixture, "reinforce"),
        parent_spec: fixture.spec,
        profile_snapshot: fixture.profile,
        current_evidence_pack: fixture.evidence,
      })
      if (prepared.status !== "generation_ready") {
        throw new Error("fixture restart continuation not ready")
      }
      const refreshed = structuredClone(prepared.evidence_pack)
      refreshed.retrieval_id = "RAG-ADAPTIVE-RESTART"
      refreshed.query = "循环 列表 恢复证据"
      refreshed.results[0]!.facts[0]!.content = "重启后复用的证据"
      const secretAnswer = "SECRET_DURABLE_A_RESULT_7dd1"
      refreshed.results[0]!.quiz_seeds[0]!.answer = secretAnswer

      const secureStore = new InMemorySecureArtifactStore()
      const cycleService = new LearningCycleService({
        cycle_store: new InMemoryLearningCycleStore(),
        secure_store: secureStore,
        mastery_store: new InMemoryMasteryStateStore(),
      })
      let evidenceCalls = 0
      let reviewedRunnerCalls = 0
      let registerCalls = 0
      let openCalls = 0
      let deliveryCalls = 0
      const continuationInput = {
        session_id: "SESSION-ADAPTIVE-RESTART",
        submission_id: "SUB-ADAPTIVE-RESTART",
        authenticated_learner_id_hash: "learner-hash",
        profile_snapshot: fixture.profile,
      }
      const dependencies = () => ({
        learning_cycle: {
          async prepareNextRoundFromCompletedSubmission() {
            return structuredClone(prepared)
          },
          async registerReadyRun(
            request: Parameters<LearningCycleService["registerReadyRun"]>[0],
          ) {
            registerCalls += 1
            return cycleService.registerReadyRun(request)
          },
          async openAnchorFirstSession(
            request: Parameters<
              LearningCycleService["openAnchorFirstSession"]
            >[0],
          ) {
            openCalls += 1
            return cycleService.openAnchorFirstSession(request)
          },
        },
        agents: reviewedAgents(),
        secure_store: secureStore,
        review_options: {
          review_port: {
            policy_version: "adaptive-restart-review-v1",
            async review(request: ContentReviewRequest) {
              return request.generation_spec.evidence_ref
                  === prepared.evidence_pack.retrieval_id
                ? newEvidenceReviewResult(request, this.policy_version)
                : passingReviewResult(request, this.policy_version)
            },
          },
        },
        review_execution_config_version: "adaptive-restart-execution-v1",
        recovery_policy_version: "adaptive-restart-policy-v1",
        recovery_port_version: "adaptive-restart-ports-v1",
        delivery_target_namespace: "role-d-adaptive-restart",
        adaptive_execution_journal:
          new AtomicFileAdaptiveLearningLoopJournal({
            root_directory: root,
          }),
        execution_journal: new InMemoryNextRoundExecutionJournal(),
        reviewed_pipeline_runner: async (
          ...args: Parameters<typeof runReviewedCPipeline>
        ) => {
          reviewedRunnerCalls += 1
          if (reviewedRunnerCalls === 2) {
            throw new Error("simulated process interruption")
          }
          return runReviewedCPipeline(...args)
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return structuredClone(refreshed)
          },
        },
        role_d_port: {
          async publishReviewedRelease(release: Parameters<
            import("../src/role-c-content").RoleDPublicDeliveryPort[
              "publishReviewedRelease"
            ]
          >[0]) {
            deliveryCalls += 1
            return {
              schema_version: "1.0" as const,
              delivery_kind: "reviewed_release" as const,
              delivery_id: release.delivery_id,
              status: "accepted" as const,
            }
          },
          async publishLearningSession(delivery: Parameters<
            import("../src/role-c-content").RoleDLearningSessionPort[
              "publishLearningSession"
            ]
          >[0]) {
            deliveryCalls += 1
            return {
              schema_version: "1.0" as const,
              delivery_kind: "learning_session" as const,
              delivery_id: delivery.delivery_id,
              status: "accepted" as const,
            }
          },
          async publishReviewRecoveryStatus(delivery: Parameters<
            import("../src/role-c-content").RoleDReviewRecoveryStatusPort[
              "publishReviewRecoveryStatus"
            ]
          >[0]) {
            throw new Error(`unexpected recovery status ${delivery.delivery_id}`)
          },
        },
      })

      await expect(continueCompletedLearningCycle(
        continuationInput,
        dependencies(),
      )).rejects.toThrow("simulated process interruption")
      expect(evidenceCalls).toBe(1)
      expect(registerCalls).toBe(0)
      expect(openCalls).toBe(0)
      expect(deliveryCalls).toBe(0)

      const recovered = await continueCompletedLearningCycle(
        continuationInput,
        dependencies(),
      )
      const replay = await continueCompletedLearningCycle(
        structuredClone(continuationInput),
        dependencies(),
      )
      expect(recovered.status).toBe("published")
      expect(replay).toEqual(recovered)
      expect(evidenceCalls).toBe(1)
      expect(reviewedRunnerCalls).toBe(4)
      expect(registerCalls).toBe(1)
      expect(openCalls).toBe(1)
      expect(deliveryCalls).toBe(2)
      expect(JSON.stringify(recovered)).not.toContain(secretAnswer)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("retries only the same terminal D delivery after an acknowledgement is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "role-c-terminal-restart-"))
    try {
      const fixture = buildFixture()
      const prepared = prepareNextRound({
        authenticated_learner_id_hash: "learner-hash",
        feedback: feedbackFor(fixture, "reinforce"),
        parent_spec: fixture.spec,
        profile_snapshot: fixture.profile,
        current_evidence_pack: fixture.evidence,
      })
      if (prepared.status !== "generation_ready") {
        throw new Error("fixture terminal restart not ready")
      }
      let recoverableCalls = 0
      let statusDeliveryCalls = 0
      const secureStore = new InMemorySecureArtifactStore()
      const continuationInput = {
        session_id: "SESSION-TERMINAL-RESTART",
        submission_id: "SUB-TERMINAL-RESTART",
        authenticated_learner_id_hash: "learner-hash",
        profile_snapshot: fixture.profile,
      }
      const dependencies = () => ({
        learning_cycle: {
          async prepareNextRoundFromCompletedSubmission() {
            return structuredClone(prepared)
          },
          async registerReadyRun() {
            throw new Error("terminal result must not register")
          },
          async openAnchorFirstSession() {
            throw new Error("terminal result must not open a session")
          },
        },
        agents: reviewedAgents(),
        secure_store: secureStore,
        review_options: {
          review_port: {
            policy_version: "terminal-restart-review-v1",
            async review() {
              throw new Error("unsupported target must not reach review")
            },
          },
        },
        review_execution_config_version: "terminal-restart-execution-v1",
        recovery_policy_version: "terminal-restart-policy-v1",
        recovery_port_version: "terminal-restart-ports-v1",
        delivery_target_namespace: "role-d-terminal-restart",
        adaptive_execution_journal:
          new AtomicFileAdaptiveLearningLoopJournal({
            root_directory: root,
          }),
        recoverable_pipeline_runner: async (
          ...args: Parameters<typeof runRecoverableReviewedCPipeline>
        ) => {
          recoverableCalls += 1
          return runRecoverableReviewedCPipeline(...args)
        },
        role_d_port: {
          async publishReviewedRelease(release: Parameters<
            import("../src/role-c-content").RoleDPublicDeliveryPort[
              "publishReviewedRelease"
            ]
          >[0]) {
            throw new Error(`terminal result released ${release.delivery_id}`)
          },
          async publishLearningSession(delivery: Parameters<
            import("../src/role-c-content").RoleDLearningSessionPort[
              "publishLearningSession"
            ]
          >[0]) {
            throw new Error(`terminal result opened ${delivery.delivery_id}`)
          },
          async publishReviewRecoveryStatus(delivery: Parameters<
            import("../src/role-c-content").RoleDReviewRecoveryStatusPort[
              "publishReviewRecoveryStatus"
            ]
          >[0]) {
            statusDeliveryCalls += 1
            if (statusDeliveryCalls === 1) {
              throw new Error("terminal acknowledgement lost")
            }
            return {
              schema_version: "1.0" as const,
              delivery_kind: "review_recovery_status" as const,
              delivery_id: delivery.delivery_id,
              status: "duplicate" as const,
            }
          },
        },
      })

      await expect(continueCompletedLearningCycle(
        continuationInput,
        dependencies(),
      )).rejects.toThrow("terminal acknowledgement lost")
      const recovered = await continueCompletedLearningCycle(
        continuationInput,
        dependencies(),
      )
      const replay = await continueCompletedLearningCycle(
        structuredClone(continuationInput),
        dependencies(),
      )
      expect(recovered.status).toBe("blocked")
      expect(recovered).toMatchObject({
        delivery_to_d: {
          delivery_kind: "review_recovery_status",
          status: "duplicate",
        },
      })
      expect(replay).toEqual(recovered)
      expect(recoverableCalls).toBe(1)
      expect(statusDeliveryCalls).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function buildFixture(options: {
  level?: LearnerProfileSnapshot["level"]
  difficulty?: GenerationSpec["difficulty"]
} = {}): Fixture {
  const level = options.level ?? "basic"
  const profile: LearnerProfileSnapshot = {
    schema_version: "1.0",
    profile_id: "PROFILE-NEXT-ROUND",
    profile_version: "profile-next-round-v1",
    learner_id: "learner-next-round",
    level,
    known_concepts: ["变量"],
    weak_concepts: ["循环"],
    goal: "掌握循环",
    preferred_contexts: ["成绩统计"],
    accommodations: [],
  }
  const path = pathFor("PATH-CURRENT", "K007", "O1")
  const evidence = evidenceFor("RAG-CURRENT", "K007")
  const built = buildGenerationSpec({
    run_id: "RUN-CURRENT",
    profile_snapshot: profile,
    path_node: path,
    evidence_pack: evidence,
    versions: {
      prompt_version: "c-prompts-test",
      model_config_hash: "model-test",
      runner_image_digest: RUNNER_DIGEST,
    },
    seed: 42,
    ...(options.difficulty ? { difficulty: options.difficulty } : {}),
  })
  if (!built.ok) throw new Error(built.errors.join(";"))
  return { profile, path, evidence, spec: built.spec }
}

function buildReviewedFixture(): Fixture {
  const profile: LearnerProfileSnapshot = {
    schema_version: "1.0",
    profile_id: "PROFILE-NEXT-ROUND-REVIEWED",
    profile_version: "profile-next-round-reviewed-v1",
    learner_id: "learner-next-round-reviewed",
    level: "basic",
    known_concepts: ["变量"],
    weak_concepts: ["循环", "列表"],
    goal: "完成成绩统计程序",
    preferred_contexts: ["成绩统计"],
    accommodations: [],
  }
  const path: LearningPathNode = {
    schema_version: "1.0",
    node_id: "PATH-NEXT-ROUND-REVIEWED",
    target_source_ids: ["K007", "K009", "K018"],
    prerequisite_source_ids: [],
    goal: "理解循环与列表，并完成一个成绩统计程序",
    objectives: [
      {
        objective_id: "O1",
        source_id: "K007",
        required_fact_ids: ["F001"],
        observable_behavior: "trace",
        importance: "core",
      },
      {
        objective_id: "O2",
        source_id: "K009",
        required_fact_ids: ["F001"],
        observable_behavior: "apply",
        importance: "core",
      },
      {
        objective_id: "O3",
        source_id: "K018",
        required_fact_ids: ["F001"],
        observable_behavior: "create",
        importance: "core",
      },
    ],
    assessment_blueprint: {
      tier_1_count: 2,
      tier_2_count: 2,
      tier_3_count: 1,
      required_modalities: ["mcq", "trace", "code"],
    },
  }
  const evidence = evidenceFor("RAG-NEXT-ROUND-REVIEWED", "K007")
  evidence.top_k = 3
  evidence.results.push(
    evidenceFor("unused", "K009").results[0]!,
    evidenceFor("unused", "K018").results[0]!,
  )
  const built = buildGenerationSpec({
    run_id: "RUN-CURRENT-REVIEWED",
    profile_snapshot: profile,
    path_node: path,
    evidence_pack: evidence,
    versions: {
      prompt_version: "c-prompts-reviewed-test",
      model_config_hash: "model-reviewed-test",
      runner_image_digest: RUNNER_DIGEST,
    },
    seed: 42,
  })
  if (!built.ok) throw new Error(built.errors.join(";"))
  return { profile, path, evidence, spec: built.spec }
}

function pathFor(nodeId: string, sourceId: string, objectiveId: string): LearningPathNode {
  return {
    schema_version: "1.0",
    node_id: nodeId,
    target_source_ids: [sourceId],
    prerequisite_source_ids: [],
    goal: `学习 ${sourceId}`,
    objectives: [{
      objective_id: objectiveId,
      source_id: sourceId,
      required_fact_ids: ["F001"],
      observable_behavior: "trace",
      importance: "core",
    }],
    assessment_blueprint: {
      tier_1_count: 1,
      tier_2_count: 0,
      tier_3_count: 0,
      required_modalities: ["mcq"],
    },
  }
}

function evidenceFor(retrievalId: string, sourceId: string): RagEvidencePack {
  return {
    schema_version: "1.0",
    retrieval_id: retrievalId,
    query: `query ${sourceId}`,
    learner_level: "basic",
    top_k: 1,
    match_status: "strong",
    kb_version: "kb-next-round-v1",
    rag_version: "rag-next-round-v1",
    results: [{
      source_id: sourceId,
      title: `知识 ${sourceId}`,
      difficulty: "basic",
      rank_score: 1,
      match_reason: "fixture strong match",
      snippet: "fixture",
      facts: [{ source_id: sourceId, fact_id: "F001", content: `${sourceId} 核心事实` }],
      examples: [{ title: "示例", code: "for value in values:\n    print(value)", explanation: "逐项处理" }],
      practice_tasks: ["完成一次逐项处理"],
      quiz_seeds: [{
        level: 1,
        type: "mcq",
        question: "循环会做什么？",
        options: ["逐项处理", "停止程序"],
        answer: "逐项处理",
        source_id: sourceId,
        fact_id: "F001",
      }],
      source_file: `${sourceId}.json`,
      retrieval_trace: {
        matched_keywords: [sourceId],
        matched_fields: ["facts"],
        difficulty_match: true,
        score_breakdown: {
          keyword: 1,
          title: 0,
          facts: 1,
          practice_tasks: 0,
          difficulty: 1,
          bonus: 0,
        },
      },
    }],
  }
}

function feedbackFor(
  fixture: Fixture,
  action: DynamicFeedbackResult["final_decision"]["action"],
): DynamicFeedbackResult {
  const targetObjectiveIds = action === "advance" ? [] : ["O1"]
  const drift = action === "reprofile"
    ? {
        schema_version: "1.0" as const,
        suggestion_id: "PDS-NEXT-ROUND",
        learner_id_hash: "learner-hash",
        profile_version: fixture.profile.profile_version,
        conflicting_objective_ids: ["O1"],
        reason_codes: ["repeated_profile_evidence_conflict"],
        confidence: 0.9,
        action: "reprofile" as const,
      }
    : undefined
  const gradeResult = gradeResultFor(fixture, action)
  return {
    schema_version: "1.0",
    feedback_id: `DFR-${action}`,
    run_id: fixture.spec.run_id,
    session_id: "SESSION-NEXT-ROUND",
    submission_id: "SUB-NEXT-ROUND",
    learner_id_hash: "learner-hash",
    profile_version: fixture.profile.profile_version,
    path_node_id: fixture.path.node_id,
    form_id: "FORM-NEXT-ROUND",
    attempt_no: 1,
    round_score: {
      raw_score: action === "remediate" ? 0 : 1,
      max_score: 1,
      accuracy: action === "remediate" ? 0 : 1,
      evidence_score: action === "remediate" ? 0 : 1,
    },
    objective_results: [{
      objective_id: "O1",
      raw_score: action === "remediate" ? 0 : 1,
      max_score: 1,
      accuracy: action === "remediate" ? 0 : 1,
      evidence_score: action === "remediate" ? 0 : 1,
      misconception_tags: [],
    }],
    grade_result: gradeResult,
    mastery_snapshot: [{
      objective_id: "O1",
      mastery: 0.5,
      evidence_batches: 1,
      observed_modalities: ["mcq"],
      revision: 1,
    }],
    final_decision: {
      action,
      basis: action === "reprofile" ? "profile_drift" : "round_accuracy",
      confidence: 0.9,
      reason_codes: [action === "reprofile" ? "repeated_profile_evidence_conflict" : `round_${action}`],
      target_objective_ids: targetObjectiveIds,
      policy_ref: "test-policy-v1",
    },
    profile_drift_suggestion: drift,
  }
}

function gradeResultFor(
  fixture: Fixture,
  action: DynamicFeedbackResult["final_decision"]["action"],
): GradeResultArtifact {
  const rawScore = action === "remediate" ? 0 : 1
  return {
    schema_version: "1.0",
    run_id: fixture.spec.run_id,
    artifact_id: `ART-GRADE-${action}`,
    artifact_type: "grade_result",
    agent: "tiered-evaluator",
    status: "ready",
    versions: fixture.spec.versions,
    seed: fixture.spec.policies.seed,
    input_refs: [],
    citations: [],
    quality: {
      schema_ok: true,
      citation_coverage: 1,
      objective_coverage: 1,
      alignment_score: 1,
      answer_key_verified: true,
    },
    payload: {
      submission_id: "SUB-NEXT-ROUND",
      form_id: "FORM-NEXT-ROUND",
      score_frozen: true,
      raw_score: rawScore,
      max_score: 1,
      evidence_score: rawScore,
      item_results: [{
        item_id: "ITEM-O1",
        objective_id: "O1",
        raw_score: rawScore,
        max_score: 1,
        evidence_score: rawScore,
        grader_confidence: 1,
        hint_factor: 1,
        repeat_factor: 1,
        misconception_tags: [],
        feedback_code: rawScore === 1 ? "correct" : "incorrect",
      }],
      recommendation: {
        action,
        confidence: 0.9,
        reason_codes: [action === "reprofile" ? "repeated_profile_evidence_conflict" : `round_${action}`],
      },
      feedback: {
        generated_after_score_freeze: true,
        mode: "formative",
        summary: "fixture feedback",
        item_feedback: [{
          item_id: "ITEM-O1",
          feedback_code: rawScore === 1 ? "correct" : "incorrect",
          message: "fixture",
          next_step: "fixture",
        }],
      },
    },
    trace_ref: `TRACE-GRADE-${action}`,
  }
}

function blockedConcept(spec: GenerationSpec): ConceptLessonArtifact {
  return {
    schema_version: "1.0",
    run_id: spec.run_id,
    artifact_id: "ART-CONCEPT-BLOCKED",
    artifact_type: "concept_lesson",
    agent: "concept-tutor",
    status: "blocked",
    blocked_reason: {
      code: "BLOCKED_PROVIDER_UNAVAILABLE",
      message: "fixture blocked",
    },
    versions: spec.versions,
    seed: spec.policies.seed,
    input_refs: [spec.spec_id],
    citations: [],
    quality: {
      schema_ok: false,
      citation_coverage: 0,
      objective_coverage: 0,
      alignment_score: 0,
    },
    payload: null,
    trace_ref: "TRACE-CONCEPT-BLOCKED",
  }
}

function reviewedAgents(): RoleCAgents {
  const verifiers: GeneratedContentVerifiers = {
    code_lab: {
      async verifyCodeLab() {
        return { execution_verified: true, issues: [] }
      },
    },
    assessment: {
      async verifyAssessment() {
        return { answer_key_verified: true, issues: [] }
      },
    },
  }
  return createRoleCAgents(
    new DeterministicCodeLabContentProvider(),
    verifiers,
  )
}

function passingReviewResult(
  request: ContentReviewRequest,
  policyVersion: string,
): ContentReviewResult {
  return {
    run_id: request.run_id,
    pipeline_input_hash: request.pipeline_input_hash,
    generation_spec_hash: request.generation_spec_hash,
    policy_version: policyVersion,
    revision_round: request.revision_round,
    max_revision_rounds: request.max_revision_rounds,
    evidence_hash: request.evidence_hash,
    decision: "pass",
    artifact_results: request.artifacts.map((target) => ({
      artifact_kind: target.kind,
      artifact_id: target.artifact.artifact_id,
      artifact_hash: target.artifact_hash,
      fact_status: "pass",
      teaching_status: "pass",
      decision: "pass",
      can_revise: false,
      findings: [],
      revision_instructions: [],
    })),
    revision_instructions: [],
  }
}

function newEvidenceReviewResult(
  request: ContentReviewRequest,
  policyVersion: string,
): ContentReviewResult {
  const target = request.artifacts[0]!
  const finding = {
    source: "fact_audit" as const,
    code: "evidence_support",
    artifact_kind: target.kind,
    artifact_id: target.artifact.artifact_id,
    message: "当前冻结证据不足以支持教学内容",
    proposed_action: "请求 A 补充证据后重新生成",
    fix_scope: "new_evidence" as const,
    evidence_refs: [target.artifact.artifact_id],
  }
  const instruction = {
    ...finding,
    instruction_id: `REV-EVIDENCE-${target.artifact.artifact_id}`,
    target_agent: "concept-tutor" as const,
    target_artifact_id: target.artifact.artifact_id,
    objective_id: request.generation_spec.targets[0]!.objective_id,
  }
  return {
    run_id: request.run_id,
    pipeline_input_hash: request.pipeline_input_hash,
    generation_spec_hash: request.generation_spec_hash,
    policy_version: policyVersion,
    revision_round: request.revision_round,
    max_revision_rounds: request.max_revision_rounds,
    evidence_hash: request.evidence_hash,
    decision: "reject",
    artifact_results: request.artifacts.map((artifact, index) => index === 0
      ? {
          artifact_kind: artifact.kind,
          artifact_id: artifact.artifact.artifact_id,
          artifact_hash: artifact.artifact_hash,
          fact_status: "reject" as const,
          teaching_status: "pass" as const,
          decision: "reject" as const,
          can_revise: false,
          findings: [finding],
          revision_instructions: [instruction],
        }
      : {
          artifact_kind: artifact.kind,
          artifact_id: artifact.artifact.artifact_id,
          artifact_hash: artifact.artifact_hash,
          fact_status: "pass" as const,
          teaching_status: "pass" as const,
          decision: "pass" as const,
          can_revise: false,
          findings: [],
          revision_instructions: [],
        }),
    revision_instructions: [instruction],
    failed_dimensions: ["evidence_support"],
    missing_prerequisite_source_ids: [],
    unknown_prerequisite_refs: [],
    required_action: "request_new_evidence",
    fix_scope: "new_evidence",
    can_recover: true,
  }
}
