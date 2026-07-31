import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AssessmentPublicArtifact,
  ArtifactReviewResult,
  CodeLabPublicArtifact,
  ConceptLessonArtifact,
  DynamicFeedbackResult,
  ReviewedCPipelineResult,
  SessionState,
  SubmissionEnvelope,
} from "../src/role-c-content"
import {
  buildGenerationSpec,
  type RagEvidencePack,
} from "../src/role-c-content"
import { contentHash } from "../src/role-c-content/contracts/common"
import type { SubmissionGrade } from "../src/role-c-content/grading/grade-submission"
import type {
  CPipelineInput,
} from "../src/role-c-content/orchestrator/content-pipeline"
import {
  AtomicFileLearningCycleStore,
  InMemoryLearningCycleStore,
  learningSubmissionInputHash,
  type LearningRunRecord,
  type LearningSessionRecord,
  type LearningSubmissionRecord,
} from "../src/role-c-content/reliability/learning-cycle-store"
import {
  AtomicFileMasteryStateStore,
} from "../src/role-c-content/reliability/mastery-file-store"
import type { ObjectiveMasteryState } from "../src/role-c-content/mastery/beta-mastery"

const temporaryDirectories: string[] = []
const LAB_REF = `secure://role-c/v1/${"a".repeat(48)}/${"b".repeat(48)}`
const ASSESSMENT_REF = `secure://role-c/v1/${"a".repeat(48)}/${"c".repeat(48)}`
const DEAD_PID = 2_147_483_647

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe("Role C learning-cycle persistence", () => {
  test("in-memory records clone values and enforce revision CAS", async () => {
    const store = new InMemoryLearningCycleStore()
    const run = runRecord()
    await store.createRun(run)

    const loaded = await store.loadRun(run.run_id)
    expect(loaded).toEqual(run)
    loaded!.pipeline_result.secure_refs.length = 0
    expect((await store.loadRun(run.run_id))?.pipeline_result.secure_refs).toHaveLength(2)

    const revisionOne = { ...run, revision: 1 }
    await store.saveRun(revisionOne, 0)
    await expect(store.saveRun(revisionOne, 0)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    })
    expect((await store.loadRun(run.run_id))?.revision).toBe(1)
  })

  test("atomic learning-cycle store survives reopen and keeps private filesystem modes", async () => {
    const root = await temporaryDirectory("role-c-cycle-")
    const first = new AtomicFileLearningCycleStore({ root_directory: root })
    const run = runRecord()
    const session = sessionRecord()
    const received = submissionRecord()

    await first.createRun(run)
    await first.createSession(session)
    await first.createSubmission(received)

    const scored: LearningSubmissionRecord = {
      ...received,
      status: "SCORED",
      grade: gradedSubmission(),
      revision: 1,
    }
    await first.saveSubmission(scored, 0)

    const reopened = new AtomicFileLearningCycleStore({ root_directory: root })
    expect(await reopened.loadRun(run.run_id)).toEqual(run)
    expect(await reopened.loadSession(session.session_id)).toEqual(session)
    expect(await reopened.loadSubmission(session.session_id, received.submission_id))
      .toEqual(scored)

    for (const directory of ["runs", "sessions", "submissions"]) {
      expectPrivateMode(await stat(join(root, directory)).then((value) => value.mode & 0o777), "directory")
      const files = (await readdir(join(root, directory))).filter((entry) => entry.endsWith(".json"))
      expect(files).toHaveLength(1)
      expectPrivateMode(
        await stat(join(root, directory, files[0]!)).then((value) => value.mode & 0o777),
        "file",
      )
    }

    const runFile = join(root, "runs", (await readdir(join(root, "runs")))[0]!)
    const stored = await readFile(runFile, "utf8")
    expect(stored).toContain(LAB_REF)
    expect(stored).toContain(ASSESSMENT_REF)
    expect(stored).not.toContain("hidden_tests")
    expect(stored).not.toContain("reference_solution")
  })

  test("submission hash detects ID reuse and public feedback cannot carry secure refs", async () => {
    const store = new InMemoryLearningCycleStore()
    const received = submissionRecord()
    await store.createSubmission(received)

    const changedSubmission = {
      ...received.submission,
      answers: [{
        item_id: "ITEM-1",
        selected_option_id: "opt-other",
        hint_level_used: 0 as const,
      }],
    }
    await expect(store.createSubmission({
      ...received,
      submission: changedSubmission,
    })).rejects.toMatchObject({ code: "INVALID_RECORD" })

    const feedback = feedbackResult()
    feedback.final_decision.reason_codes.push(LAB_REF)
    await expect(store.saveSubmission({
      ...received,
      status: "DECIDED",
      grade: gradedSubmission(),
      feedback,
      revision: 1,
    }, 0)).rejects.toMatchObject({ code: "INVALID_RECORD" })

    await expect(store.saveSubmission({
      ...received,
      status: "DECIDED",
      grade: gradedSubmission(),
      feedback: feedbackResult(),
      revision: 1,
    }, 0)).rejects.toThrow("DECIDED 必须包含")
  })

  test("integrity tampering is rejected instead of returning a record", async () => {
    const root = await temporaryDirectory("role-c-cycle-corrupt-")
    const store = new AtomicFileLearningCycleStore({ root_directory: root })
    const run = runRecord()
    await store.createRun(run)
    const file = join(root, "runs", (await readdir(join(root, "runs")))[0]!)
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      payload: { run_id: string }
    }
    parsed.payload.run_id = "RUN-TAMPERED"
    await writeFile(file, JSON.stringify(parsed), "utf8")

    await expect(store.loadRun(run.run_id)).rejects.toMatchObject({
      code: "INTEGRITY_ERROR",
    })
  })

  test("atomic record locks allow exactly one concurrent CAS writer", async () => {
    const root = await temporaryDirectory("role-c-cycle-concurrent-")
    const first = new AtomicFileLearningCycleStore({ root_directory: root })
    const second = new AtomicFileLearningCycleStore({ root_directory: root })
    const run = runRecord()
    await first.createRun(run)
    const next = { ...run, revision: 1 }

    const writes = await Promise.allSettled([
      first.saveRun(next, 0),
      second.saveRun(next, 0),
    ])
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await first.loadRun(run.run_id))?.revision).toBe(1)
    expect((await readdir(join(root, "runs"))).some((entry) => entry.endsWith(".lock"))).toBe(false)
  })

  test("a live local PID owns its lock even after the fallback lease", async () => {
    const root = await temporaryDirectory("role-c-cycle-live-lock-")
    const bootstrap = new AtomicFileLearningCycleStore({ root_directory: root })
    const run = runRecord()
    await bootstrap.createRun(run)
    const lockPath = await onlyRecordLockPath(root, "runs")
    await seedLock(lockPath, lockMetadata(process.pid, Date.now() - 60_000, "live-owner"))

    const contender = new AtomicFileLearningCycleStore({
      root_directory: root,
      lock_timeout_ms: 20,
      stale_lock_lease_ms: 1,
    })
    await expect(contender.saveRun({ ...run, revision: 1 }, 0)).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    })
    expect((await stat(lockPath)).isDirectory()).toBe(true)
    expect((await bootstrap.loadRun(run.run_id))?.revision).toBe(0)
  })

  test("concurrent stores safely recover a dead-PID record lock", async () => {
    const root = await temporaryDirectory("role-c-cycle-dead-lock-")
    const bootstrap = new AtomicFileLearningCycleStore({ root_directory: root })
    const run = runRecord()
    await bootstrap.createRun(run)
    const lockPath = await onlyRecordLockPath(root, "runs")
    await seedLock(lockPath, lockMetadata(DEAD_PID, Date.now(), "dead-owner"))
    await writeFile(
      join(lockPath, ".reclaim"),
      JSON.stringify(lockMetadata(DEAD_PID, Date.now(), "dead-reclaimer")),
      { mode: 0o600 },
    )

    const first = new AtomicFileLearningCycleStore({
      root_directory: root,
      lock_timeout_ms: 500,
      stale_lock_lease_ms: 60_000,
    })
    const second = new AtomicFileLearningCycleStore({
      root_directory: root,
      lock_timeout_ms: 500,
      stale_lock_lease_ms: 60_000,
    })
    const writes = await Promise.allSettled([
      first.saveRun({ ...run, revision: 1 }, 0),
      second.saveRun({ ...run, revision: 1 }, 0),
    ])

    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await first.loadRun(run.run_id))?.revision).toBe(1)
    expect((await readdir(join(root, "runs"))).some((entry) => entry.includes(".lock")))
      .toBe(false)
  })
})

describe("Role C mastery file persistence", () => {
  test("save and saveBatch reject revision jumps without partial file writes", async () => {
    const root = await temporaryDirectory("role-c-mastery-step-")
    const store = new AtomicFileMasteryStateStore({ root_directory: root })

    await expect(store.save(masteryState("O1", 3, 1, 2), 0))
      .rejects.toMatchObject({ code: "INVALID_STATE" })
    expect(await store.load("learner-hash", "profile-v1", "O1")).toBeUndefined()

    const valid = masteryState("O1", 2, 1, 1)
    const jumping = masteryState("O2", 3, 1, 2)
    await expect(store.saveBatch([
      { state: valid, expected_revision: 0 },
      { state: jumping, expected_revision: 0 },
    ])).rejects.toMatchObject({ code: "INVALID_STATE" })
    expect(await store.load("learner-hash", "profile-v1", "O1")).toBeUndefined()
    expect(await store.load("learner-hash", "profile-v1", "O2")).toBeUndefined()

    await store.save(valid, 0)
    await expect(store.save(masteryState("O1", 4, 1, 3), 1))
      .rejects.toMatchObject({ code: "INVALID_STATE" })
    expect(await store.load("learner-hash", "profile-v1", "O1")).toEqual(valid)
  })

  test("saveBatch commits every objective and survives store reopen", async () => {
    const root = await temporaryDirectory("role-c-mastery-")
    const store = new AtomicFileMasteryStateStore({ root_directory: root })
    const first = masteryState("O1", 2, 1, 1)
    const second = masteryState("O2", 1, 2, 1)

    await store.saveBatch([
      { state: first, expected_revision: 0 },
      { state: second, expected_revision: 0 },
    ])

    const reopened = new AtomicFileMasteryStateStore({ root_directory: root })
    expect(await reopened.load("learner-hash", "profile-v1", "O1")).toEqual(first)
    expect(await reopened.load("learner-hash", "profile-v1", "O2")).toEqual(second)
    expectPrivateMode(await stat(root).then((value) => value.mode & 0o777), "directory")
    expectPrivateMode(
      await stat(join(root, "mastery-state.json")).then((value) => value.mode & 0o777),
      "file",
    )
  })

  test("a conflicting objective aborts the complete mastery batch", async () => {
    const root = await temporaryDirectory("role-c-mastery-cas-")
    const store = new AtomicFileMasteryStateStore({ root_directory: root })
    const first = masteryState("O1", 2, 1, 1)
    const second = masteryState("O2", 1, 2, 1)
    await store.saveBatch([
      { state: first, expected_revision: 0 },
      { state: second, expected_revision: 0 },
    ])

    const nextFirst = masteryState("O1", 3, 1, 2)
    const staleSecond = masteryState("O2", 2, 2, 1)
    await expect(store.saveBatch([
      { state: nextFirst, expected_revision: 1 },
      { state: staleSecond, expected_revision: 0 },
    ])).rejects.toMatchObject({ code: "REVISION_CONFLICT" })

    expect(await store.load("learner-hash", "profile-v1", "O1")).toEqual(first)
    expect(await store.load("learner-hash", "profile-v1", "O2")).toEqual(second)
  })

  test("mastery snapshot integrity failures are explicit", async () => {
    const root = await temporaryDirectory("role-c-mastery-corrupt-")
    const store = new AtomicFileMasteryStateStore({ root_directory: root })
    await store.save(masteryState("O1", 2, 1, 1), 0)
    const path = join(root, "mastery-state.json")
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      payload: { entries: Record<string, { state: { mastery: number } }> }
    }
    Object.values(parsed.payload.entries)[0]!.state.mastery = 0.99
    await writeFile(path, JSON.stringify(parsed), "utf8")

    await expect(store.load("learner-hash", "profile-v1", "O1")).rejects.toMatchObject({
      code: "INTEGRITY_ERROR",
    })
  })

  test("corrupt mastery lock metadata is reclaimed only after its fallback lease", async () => {
    const root = await temporaryDirectory("role-c-mastery-unknown-lock-")
    const lockPath = join(root, ".mastery-state.lock")
    await mkdir(lockPath, { mode: 0o700 })
    await writeFile(join(lockPath, "owner.json"), "{broken-json", { mode: 0o600 })
    const state = masteryState("O1", 2, 1, 1)

    const beforeLease = new AtomicFileMasteryStateStore({
      root_directory: root,
      lock_timeout_ms: 20,
      stale_lock_lease_ms: 1_000,
    })
    await expect(beforeLease.save(state, 0)).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    })
    expect((await stat(lockPath)).isDirectory()).toBe(true)

    const expired = new Date(Date.now() - 2_000)
    await utimes(lockPath, expired, expired)
    const afterLease = new AtomicFileMasteryStateStore({
      root_directory: root,
      lock_timeout_ms: 500,
      stale_lock_lease_ms: 1_000,
    })
    await afterLease.save(state, 0)
    expect(await afterLease.load("learner-hash", "profile-v1", "O1")).toEqual(state)
    expect((await readdir(root)).some((entry) => entry.includes(".mastery-state.lock")))
      .toBe(false)
  })

  test("a dead local PID does not strand the mastery store", async () => {
    const root = await temporaryDirectory("role-c-mastery-dead-lock-")
    const lockPath = join(root, ".mastery-state.lock")
    await seedLock(lockPath, lockMetadata(DEAD_PID, Date.now(), "dead-mastery-owner"))
    const store = new AtomicFileMasteryStateStore({
      root_directory: root,
      lock_timeout_ms: 500,
      stale_lock_lease_ms: 60_000,
    })
    const state = masteryState("O1", 2, 1, 1)

    await store.save(state, 0)

    expect(await store.load("learner-hash", "profile-v1", "O1")).toEqual(state)
    expect((await readdir(root)).some((entry) => entry.includes(".mastery-state.lock")))
      .toBe(false)
  })
})


function expectPrivateMode(mode: number, kind: "directory" | "file"): void {
  if (process.platform === "win32") {
    expect([0o700, 0o600, 0o666]).toContain(mode)
    return
  }
  expect(mode).toBe(kind === "directory" ? 0o700 : 0o600)
}

function runRecord(): LearningRunRecord {
  const evidencePack: RagEvidencePack = {
    schema_version: "1.0",
    retrieval_id: "RAG-CYCLE-1",
    query: "循环",
    learner_level: "basic",
    top_k: 1,
    match_status: "strong",
    kb_version: "kb-cycle-v1",
    rag_version: "rag-cycle-v1",
    results: [{
      source_id: "K001",
      title: "循环",
      difficulty: "basic",
      rank_score: 1,
      match_reason: "fixture",
      snippet: "循环用于重复执行代码。",
      facts: [{
        source_id: "K001",
        fact_id: "F001",
        content: "for 循环可遍历序列。",
      }],
      examples: [{
        title: "遍历列表",
        code: "for item in items:\n    print(item)",
        explanation: "逐项访问列表。",
      }],
      practice_tasks: ["遍历一个列表。"],
      quiz_seeds: [{
        level: 1,
        type: "mcq",
        question: "哪种语句可遍历列表？",
        options: ["for", "if"],
        answer: "for",
        source_id: "K001",
        fact_id: "F001",
      }],
      source_file: "fixture.md",
      retrieval_trace: {
        matched_keywords: ["循环"],
        matched_fields: ["title"],
        difficulty_match: true,
        score_breakdown: {
          keyword: 1,
          title: 1,
          facts: 1,
          practice_tasks: 1,
          difficulty: 1,
          bonus: 0,
        },
      },
    }],
  }
  const built = buildGenerationSpec({
    run_id: "RUN-CYCLE-1",
    profile_snapshot: {
      schema_version: "1.0",
      profile_id: "PROFILE-CYCLE-1",
      profile_version: "profile-cycle-v1",
      learner_id: "learner-cycle",
      level: "basic",
      known_concepts: [],
      weak_concepts: ["循环"],
      goal: "掌握循环",
      preferred_contexts: [],
      accommodations: [],
    },
    path_node: {
      schema_version: "1.0",
      node_id: "NODE-CYCLE-1",
      target_source_ids: ["K001"],
      prerequisite_source_ids: [],
      goal: "掌握循环",
      objectives: [{
        objective_id: "O1",
        source_id: "K001",
        required_fact_ids: ["F001"],
        observable_behavior: "apply",
        importance: "core",
      }],
      assessment_blueprint: {
        tier_1_count: 1,
        tier_2_count: 0,
        tier_3_count: 0,
        required_modalities: ["mcq"],
      },
    },
    evidence_pack: evidencePack,
    versions: {
      prompt_version: "cycle-store-fixture-v1",
      model_config_hash: "cycle-store-fixture-v1",
    },
    seed: 1,
  })
  if (!built.ok) throw new Error(JSON.stringify(built))
  const generationSpec = built.spec
  const pipelineInput = {
    generation_spec: generationSpec,
    evidence_pack: evidencePack,
  } satisfies CPipelineInput
  const publicArtifacts = {
    concept_lesson: {
      schema_version: "1.0",
      artifact_id: "ART-CYCLE-CONCEPT",
      artifact_type: "concept_lesson",
      run_id: generationSpec.run_id,
      status: "ready",
      payload: {},
    } as unknown as ConceptLessonArtifact,
    code_lab: {
      schema_version: "1.0",
      artifact_id: "ART-CYCLE-LAB",
      artifact_type: "code_lab_public",
      run_id: generationSpec.run_id,
      status: "ready",
      payload: {},
    } as unknown as CodeLabPublicArtifact,
    assessment: {
      schema_version: "1.0",
      artifact_id: "ART-CYCLE-ASSESSMENT",
      artifact_type: "assessment_public",
      run_id: generationSpec.run_id,
      status: "ready",
      payload: {},
    } as unknown as AssessmentPublicArtifact,
  }
  const reviewPolicyVersion = "cycle-store-fixture-v1"
  const artifactEntries: Array<readonly [
    ArtifactReviewResult["artifact_kind"],
    ConceptLessonArtifact | CodeLabPublicArtifact | AssessmentPublicArtifact,
  ]> = [
    ["concept", publicArtifacts.concept_lesson],
    ["code_lab", publicArtifacts.code_lab],
    ["assessment", publicArtifacts.assessment],
  ]
  const artifactResults: ArtifactReviewResult[] = artifactEntries.map(([kind, artifact]) => ({
    artifact_kind: kind,
    artifact_id: artifact.artifact_id,
    artifact_hash: contentHash(artifact),
    fact_status: "pass",
    teaching_status: "pass",
    decision: "pass",
    can_revise: false,
    findings: [],
    revision_instructions: [],
  }))
  const pipelineResult: ReviewedCPipelineResult = {
    status: "ready",
    state: "READY",
    generation_spec: generationSpec,
    public_artifacts: publicArtifacts,
    secure_refs: [LAB_REF, ASSESSMENT_REF],
    trace_events: [
      {
        schema_version: "1.0",
        seq: 1,
        event_type: "c.review.passed",
        run_id: generationSpec.run_id,
        status: "success",
        input_refs: [generationSpec.spec_id],
        summary: "fixture review passed",
        attempt: 1,
      },
      {
        schema_version: "1.0",
        seq: 2,
        event_type: "c.pipeline.ready",
        run_id: generationSpec.run_id,
        status: "success",
        input_refs: [
          generationSpec.spec_id,
          publicArtifacts.concept_lesson.artifact_id,
          publicArtifacts.code_lab.artifact_id,
          publicArtifacts.assessment.artifact_id,
        ],
        summary: "fixture ready",
      },
    ],
    fact_audit_packets: [],
    alignment_report: {
      ok: true,
      alignment_score: 1,
      objections: [],
    },
    pipeline_input_hash: contentHash(pipelineInput),
    generation_spec_hash: contentHash(generationSpec),
    review_policy_version: reviewPolicyVersion,
    review_reports: [{
      run_id: generationSpec.run_id,
      pipeline_input_hash: contentHash(pipelineInput),
      generation_spec_hash: contentHash(generationSpec),
      policy_version: reviewPolicyVersion,
      revision_round: 0,
      max_revision_rounds: 0,
      evidence_hash: contentHash(pipelineInput.evidence_pack),
      decision: "pass",
      artifact_results: artifactResults,
      revision_instructions: [],
    }],
  }
  return {
    schema_version: "1.0",
    run_id: generationSpec.run_id,
    learner_id_hash: "learner-hash",
    pipeline_input: pipelineInput,
    pipeline_result: pipelineResult,
    secure_artifact_refs: {
      code_lab: LAB_REF,
      assessment: ASSESSMENT_REF,
    },
    revision: 0,
  }
}

function sessionRecord(): LearningSessionRecord {
  const state: SessionState = {
    schema_version: "1.0",
    session_id: "SESSION-CYCLE-1",
    run_id: "RUN-CYCLE-1",
    learner_id_hash: "learner-hash",
    current_path_node_id: "NODE-1",
    current_form_id: "FORM-1",
    attempt_no: 1,
    required_item_ids: ["ITEM-1"],
    revealed_hint_levels: { "ITEM-1": 0 },
    public_artifact_refs: ["ART-ASSESSMENT-PUBLIC"],
    secure_artifact_refs: [LAB_REF, ASSESSMENT_REF],
  }
  return {
    schema_version: "1.0",
    session_id: state.session_id,
    run_id: state.run_id,
    session_state: state,
    profile_expectations_by_objective: { O1: "weak" },
    repeat_exposure_by_item: { "ITEM-1": 0 },
    revision: 0,
  }
}

function submissionRecord(): LearningSubmissionRecord {
  const submission: SubmissionEnvelope = {
    schema_version: "1.0",
    submission_id: "SUBMISSION-1",
    run_id: "RUN-CYCLE-1",
    learner_id_hash: "learner-hash",
    form_id: "FORM-1",
    attempt_no: 1,
    answers: [{
      item_id: "ITEM-1",
      selected_option_id: "opt-correct",
      hint_level_used: 0,
    }],
  }
  return {
    schema_version: "1.0",
    session_id: "SESSION-CYCLE-1",
    submission_id: submission.submission_id,
    run_id: submission.run_id,
    submission,
    input_hash: learningSubmissionInputHash(submission),
    status: "RECEIVED",
    revision: 0,
  }
}

function gradedSubmission(): SubmissionGrade {
  return {
    status: "graded",
    submission_id: "SUBMISSION-1",
    form_id: "FORM-1",
    raw_score: 1,
    max_score: 1,
    evidence_score: 1,
    item_results: [{
      item_id: "ITEM-1",
      objective_id: "O1",
      raw_score: 1,
      max_score: 1,
      evidence_score: 1,
      grader_confidence: 1,
      hint_factor: 1,
      repeat_factor: 1,
      misconception_tags: [],
      feedback_code: "correct",
    }],
    unresolved_item_ids: [],
    boundary_verified: true,
  }
}

function feedbackResult(): DynamicFeedbackResult {
  return {
    schema_version: "1.0",
    feedback_id: "DFR-1",
    run_id: "RUN-CYCLE-1",
    session_id: "SESSION-CYCLE-1",
    submission_id: "SUBMISSION-1",
    learner_id_hash: "learner-hash",
    profile_version: "profile-v1",
    path_node_id: "NODE-1",
    form_id: "FORM-1",
    attempt_no: 1,
    round_score: {
      raw_score: 1,
      max_score: 1,
      accuracy: 1,
      evidence_score: 1,
    },
    objective_results: [{
      objective_id: "O1",
      raw_score: 1,
      max_score: 1,
      accuracy: 1,
      evidence_score: 1,
      misconception_tags: [],
    }],
    grade_result: {} as DynamicFeedbackResult["grade_result"],
    mastery_snapshot: [{
      objective_id: "O1",
      mastery: 0.666667,
      evidence_batches: 1,
      observed_modalities: ["mcq"],
      revision: 1,
    }],
    final_decision: {
      action: "advance",
      basis: "round_accuracy",
      confidence: 0.8,
      reason_codes: ["round_accuracy_at_or_above_advancement_threshold"],
      target_objective_ids: [],
      policy_ref: "role-c-round-accuracy-v1",
    },
  }
}

function masteryState(
  objectiveId: string,
  alpha: number,
  beta: number,
  revision: number,
): ObjectiveMasteryState {
  return {
    schema_version: "1.0",
    learner_id_hash: "learner-hash",
    profile_version: "profile-v1",
    objective_id: objectiveId,
    alpha,
    beta,
    mastery: Math.round((alpha / (alpha + beta)) * 1_000_000) / 1_000_000,
    evidence_batches: revision,
    observed_modalities: ["mcq"],
    processed_artifact_ids: Array.from(
      { length: revision },
      (_, index) => `ART-GRADE-${index + 1}`,
    ),
    last_action: "reinforce",
    revision,
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  await chmod(path, 0o700)
  return path
}

async function onlyRecordLockPath(root: string, directory: string): Promise<string> {
  const records = (await readdir(join(root, directory))).filter((entry) => entry.endsWith(".json"))
  expect(records).toHaveLength(1)
  return join(root, directory, `${records[0]}.lock`)
}

function lockMetadata(pid: number, createdAtMs: number, ownerToken: string) {
  return {
    lock_version: "1.0",
    owner_token: ownerToken,
    pid,
    hostname: hostname(),
    created_at_ms: createdAtMs,
  }
}

async function seedLock(
  lockPath: string,
  metadata: ReturnType<typeof lockMetadata>,
): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 })
  await writeFile(join(lockPath, "owner.json"), JSON.stringify(metadata), { mode: 0o600 })
}
