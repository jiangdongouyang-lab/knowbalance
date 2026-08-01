import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeBase } from "../src/knowledge/types"
import { auditTeaching } from "../src/role-b-profile/teaching-audit/auditor"
import {
  buildGenerationSpec,
  contentHash,
  createLocalABContentReviewPort,
  createLocalBPathPlanningPort,
  createRoleCAgents,
  DeterministicCodeLabContentProvider,
  InMemorySecureArtifactStore,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  runRecoverableReviewedCPipeline,
  runReviewedCPipeline,
  toReviewRecoveryPublicResult,
  type ContentRecoveryAction,
  type ContentReviewResult,
  type ContentRevisionInstruction,
  type CPipelineInput,
  type EvidenceGapRequest,
  type GeneratedContentVerifiers,
  type LearnerProfileSnapshot,
  type LearningPathNode,
  type RagEvidencePack,
  type RecoverableReviewedReadyContext,
  type ReviewedCPipelineResult,
  type ReviewFixScope,
  type RoleBPathDraft,
  type RoleBPathPlanningRequest,
  type RoleCAgents,
  type SecureArtifactStore,
} from "../src/role-c-content"

describe("Role C review recovery orchestration", () => {
  test("requests new A evidence, builds a new spec/run, re-reviews, and publishes secure data only after pass", async () => {
    const fixture = recoveryFixture()
    const refreshed = evidenceFor(
      "RAG-RECOVERED",
      ["K001"],
      "beginner",
      "补充后的事实",
    )
    const secretAnswer = "SECRET_RECOVERY_ANSWER_9f4d2c"
    refreshed.results[0]!.quiz_seeds[0]!.answer = secretAnswer
    const evidenceRequests: EvidenceGapRequest[] = []
    const reviewedInputs: CPipelineInput[] = []
    const readyContexts: RecoverableReviewedReadyContext[] = []
    const secure = recordingSecureStore()
    const runner: typeof runReviewedCPipeline = async (input, _agents, store) => {
      reviewedInputs.push(structuredClone(input))
      if (reviewedInputs.length === 1) {
        expect(secure.batchWrites).toBe(0)
        return blockedResult(input, recoveryReport(
          input,
          "new_evidence",
          "request_new_evidence",
        ))
      }
      await store.putBatch([], {
        principal: "role-c-pipeline",
        run_id: input.generation_spec.run_id,
      })
      return readyResult(input)
    }

    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      secure.store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: runner,
        evidence_refresh_port: {
          async refreshEvidence(request) {
            evidenceRequests.push(structuredClone(request))
            expect(Object.isFrozen(request)).toBe(true)
            return structuredClone(refreshed)
          },
        },
        async on_ready(context) {
          expect(Object.isFrozen(context)).toBe(true)
          readyContexts.push(structuredClone(context))
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(result.recovery).toMatchObject({
      code: "READY",
      required_action: "request_new_evidence",
      fix_scope: "new_evidence",
      recovery_attempts: 1,
    })
    expect(evidenceRequests).toHaveLength(1)
    expect(evidenceRequests[0]).toMatchObject({
      run_id: fixture.input.generation_spec.run_id,
      target_source_ids: ["K001"],
      learner_level: "beginner",
    })
    expect(reviewedInputs).toHaveLength(2)
    expect(reviewedInputs[1]!.evidence_pack.retrieval_id).toBe("RAG-RECOVERED")
    expect(reviewedInputs[1]!.generation_spec.evidence_ref).toBe("RAG-RECOVERED")
    expect(reviewedInputs[1]!.generation_spec.spec_id)
      .not.toBe(fixture.input.generation_spec.spec_id)
    expect(reviewedInputs[1]!.generation_spec.run_id)
      .not.toBe(fixture.input.generation_spec.run_id)
    expect(reviewedInputs[1]!.generation_spec.difficulty)
      .toEqual(fixture.input.generation_spec.difficulty)
    expect(readyContexts).toHaveLength(1)
    expect(readyContexts[0]!.pipeline_input).toEqual(reviewedInputs[1]!)
    expect(readyContexts[0]!.profile_snapshot).toEqual(fixture.profile)
    expect(JSON.stringify(readyContexts[0])).toContain(secretAnswer)
    expect(result.pipeline_input_hash)
      .toBe(contentHash(readyContexts[0]!.pipeline_input))
    expect(JSON.stringify(result)).not.toContain(secretAnswer)
    const publicRecovery = toReviewRecoveryPublicResult(result)
    expect(validatePublicRecovery(publicRecovery)).toBe(true)
    expect(JSON.stringify(publicRecovery)).not.toContain(secretAnswer)
    expect(result.recovery_history[0]).toMatchObject({
      action: "new_evidence",
      evidence_request_id: evidenceRequests[0]!.request_id,
      output_spec_id: reviewedInputs[1]!.generation_spec.spec_id,
    })
    expect(secure.batchWrites).toBe(1)
  })

  test("rejects refreshed A evidence that omits a source explicitly requested by review", async () => {
    const fixture = recoveryFixture()
    let runnerCalls = 0
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          runnerCalls += 1
          return blockedResult(input, recoveryReport(
            input,
            "new_evidence",
            "request_new_evidence",
            {
              failed_dimensions: ["prerequisite_coverage"],
              missing_prerequisite_source_ids: ["K002"],
            },
          ))
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            return evidenceFor(
              "RAG-CHANGED-BUT-INCOMPLETE",
              ["K001"],
              "beginner",
              "内容有变化但没有补回 K002",
            )
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      missing_prerequisite_source_ids: ["K002"],
      recovery_attempts: 1,
    })
    expect(result.recovery.message).toContain("缺少知识点 K002")
    expect(runnerCalls).toBe(1)
  })

  test("asks B for a new path/profile, requests A evidence when needed, and reviews the new spec", async () => {
    const fixture = recoveryFixture()
    const nextProfile: LearnerProfileSnapshot = {
      ...structuredClone(fixture.profile),
      profile_id: "PROFILE-RECOVERY-V2",
      profile_version: "PROFILE-V2",
      level: "basic",
      weak_concepts: ["分支"],
    }
    const nextPath = pathFor("PATH-K002", "K002", "O-K002", ["K001"])
    const nextEvidence = evidenceFor(
      "RAG-K002",
      ["K002", "K001"],
      "basic",
      "新路径事实",
    )
    const pathRequests: RoleBPathPlanningRequest[] = []
    const evidenceRequests: EvidenceGapRequest[] = []
    const reviewedInputs: CPipelineInput[] = []
    const readyContexts: RecoverableReviewedReadyContext[] = []
    const runner: typeof runReviewedCPipeline = async (input) => {
      reviewedInputs.push(structuredClone(input))
      return reviewedInputs.length === 1
        ? blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
            {
              failed_dimensions: ["difficulty_alignment", "prerequisite_coverage"],
              missing_prerequisite_source_ids: ["K001"],
              recommended_level: "basic",
            },
          ))
        : readyResult(input)
    }

    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: runner,
        path_planning_port: {
          async replanLearningPath(request) {
            pathRequests.push(structuredClone(request))
            expect(Object.isFrozen(request)).toBe(true)
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: structuredClone(nextPath),
              profile_snapshot: structuredClone(nextProfile),
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence(request) {
            evidenceRequests.push(structuredClone(request))
            return structuredClone(nextEvidence)
          },
        },
        async on_ready(context) {
          readyContexts.push(structuredClone(context))
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(result.recovery).toMatchObject({
      code: "READY",
      failed_dimensions: ["difficulty_alignment", "prerequisite_coverage"],
      missing_prerequisite_source_ids: ["K001"],
      required_action: "replan_path",
      fix_scope: "new_spec",
      recommended_level: "basic",
      recovery_attempts: 1,
    })
    expect(pathRequests).toHaveLength(1)
    expect(pathRequests[0]).toMatchObject({
      current_spec_id: fixture.input.generation_spec.spec_id,
      required_action: "replan_path",
      fix_scope: "new_spec",
      recommended_level: "basic",
    })
    expect(evidenceRequests).toHaveLength(1)
    expect(new Set(evidenceRequests[0]!.target_source_ids))
      .toEqual(new Set(["K001", "K002"]))
    expect(reviewedInputs).toHaveLength(2)
    const recovered = reviewedInputs[1]!
    expect(recovered.generation_spec.path_node.node_id).toBe("PATH-K002")
    expect(recovered.generation_spec.targets.map((target) => target.source_id))
      .toEqual(["K002"])
    expect(recovered.generation_spec.profile_ref.profile_version).toBe("PROFILE-V2")
    expect(recovered.generation_spec.learner_adaptation.level).toBe("basic")
    expect(recovered.generation_spec.evidence_ref).toBe("RAG-K002")
    expect(readyContexts).toHaveLength(1)
    expect(readyContexts[0]!.pipeline_input).toEqual(recovered)
    expect(readyContexts[0]!.profile_snapshot).toEqual(nextProfile)
    expect(result.generation_spec_hash)
      .toBe(contentHash(readyContexts[0]!.pipeline_input.generation_spec))
    expect(result.recovery_history[0]).toMatchObject({
      action: "new_spec",
      path_request_id: pathRequests[0]!.request_id,
      evidence_request_id: evidenceRequests[0]!.request_id,
      output_spec_id: recovered.generation_spec.spec_id,
    })
  })

  test("binds a new B draft from current evidence without calling A again", async () => {
    const fixture = recoveryFixture()
    const draft = pathFor("PATH-K001-REPLANNED", "K001", "RO-K001")
    draft.objectives[0]!.required_fact_ids = []
    const reviewedInputs: CPipelineInput[] = []
    let evidenceCalls = 0

    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          reviewedInputs.push(structuredClone(input))
          return reviewedInputs.length === 1
            ? blockedResult(input, recoveryReport(
                input,
                "new_spec",
                "replan_path",
              ))
            : readyResult(input)
        },
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: structuredClone(draft),
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            throw new Error("current evidence already covers this path")
          },
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(evidenceCalls).toBe(0)
    expect(reviewedInputs).toHaveLength(2)
    expect(reviewedInputs[1]!.evidence_pack)
      .toEqual(fixture.input.evidence_pack)
    expect(reviewedInputs[1]!.generation_spec.targets[0]!.required_fact_ids)
      .toEqual(fixture.input.evidence_pack.results[0]!.facts
        .map((fact) => fact.fact_id)
        .sort())
    expect(result.recovery_history[0]!.evidence_request_id).toBeUndefined()
  })

  test("does not refresh A solely because current source evidence is sparse", async () => {
    const fixture = recoveryFixture()
    const sparseEvidence = structuredClone(fixture.evidence)
    sparseEvidence.results[0]!.examples = []
    sparseEvidence.results[0]!.practice_tasks = []
    sparseEvidence.results[0]!.quiz_seeds = []
    const rebuilt = buildGenerationSpec({
      run_id: "RUN-RECOVERY-SPARSE",
      profile_snapshot: fixture.profile,
      path_node: fixture.path,
      evidence_pack: sparseEvidence,
      versions: {
        prompt_version: "prompt-recovery-test-v1",
        model_config_hash: "model-recovery-test-v1",
      },
      seed: 7,
    })
    if (!rebuilt.ok) throw new Error(rebuilt.errors.join("; "))
    const sparseInput: CPipelineInput = {
      generation_spec: rebuilt.spec,
      evidence_pack: sparseEvidence,
    }
    const draft = pathFor("PATH-K001-SPARSE", "K001", "RO-K001-SPARSE")
    draft.objectives[0]!.required_fact_ids = []
    let runnerCalls = 0
    let evidenceCalls = 0

    const result = await runRecoverableReviewedCPipeline(
      sparseInput,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          runnerCalls += 1
          return runnerCalls === 1
            ? blockedResult(input, recoveryReport(
                input,
                "new_spec",
                "replan_path",
              ))
            : readyResult(input)
        },
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: structuredClone(draft),
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            throw new Error("auxiliary authoring material is not a fact gap")
          },
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(runnerCalls).toBe(2)
    expect(evidenceCalls).toBe(0)
  })

  test("consumes the actual B path draft after A evidence is refreshed and facts are bound", async () => {
    const fixture = recoveryFixture()
    const knowledgeBase = await loadKnowledgeBase()
    const localBPort = createLocalBPathPlanningPort(knowledgeBase)
    const plannedPaths: RoleBPathDraft[] = []
    const evidenceRequests: EvidenceGapRequest[] = []
    const reviewedInputs: CPipelineInput[] = []
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          reviewedInputs.push(structuredClone(input))
          return reviewedInputs.length === 1
            ? blockedResult(input, recoveryReport(
                input,
                "new_spec",
                "replan_path",
                {
                  failed_dimensions: [
                    "difficulty_alignment",
                    "prerequisite_coverage",
                  ],
                  missing_prerequisite_source_ids: ["K007"],
                  recommended_level: "basic",
                },
              ))
            : readyResult(input)
        },
        path_planning_port: {
          async replanLearningPath(request) {
            const planned = await localBPort.replanLearningPath(request)
            if (planned.status === "ready") {
              plannedPaths.push(structuredClone(planned.path_draft))
            }
            return planned
          },
        },
        evidence_refresh_port: {
          async refreshEvidence(request) {
            evidenceRequests.push(structuredClone(request))
            return evidenceFromKnowledgeBase(
              "RAG-B-RECOVERY-INTEGRATION",
              request.target_source_ids,
              request.learner_level,
              knowledgeBase,
            )
          },
        },
      },
    )

    expect(result.status).toBe("ready")
    expect(plannedPaths).toHaveLength(1)
    expect(plannedPaths[0]!.target_source_ids).toEqual(["K003"])
    expect(plannedPaths[0]!.objectives.every(
      (objective) => objective.required_fact_ids.length === 0,
    )).toBe(true)
    expect(evidenceRequests).toHaveLength(1)
    expect(reviewedInputs).toHaveLength(2)
    const recovered = reviewedInputs[1]!
    expect(recovered.generation_spec.path_node.node_id)
      .not.toBe(plannedPaths[0]!.node_id)
    for (const target of recovered.generation_spec.targets) {
      const item = recovered.evidence_pack.results.find(
        (candidate) => candidate.source_id === target.source_id,
      )
      const expectedFactIds = [
        ...new Set(item?.facts.map((fact) => fact.fact_id) ?? []),
      ].sort()
      expect(target.required_fact_ids).toEqual(expectedFactIds)
    }
  })

  test("runs the real deterministic C pipeline after B replans and A binds all recovered facts", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const profile: LearnerProfileSnapshot = {
      schema_version: "1.0",
      profile_id: "PROFILE-RECOVERY-GOLD",
      profile_version: "PROFILE-RECOVERY-GOLD-V1",
      learner_id: "LEARNER-RECOVERY-GOLD",
      level: "basic",
      known_concepts: ["变量", "基本数据类型", "算术运算符"],
      weak_concepts: ["循环", "列表", "条件判断"],
      goal: "用循环、列表和条件判断统计达标人数",
      preferred_contexts: ["成绩统计"],
      accommodations: [],
    }
    const initialPath: LearningPathNode = {
      schema_version: "1.0",
      node_id: "PATH-RECOVERY-GOLD-INITIAL",
      target_source_ids: ["K007", "K009", "K018"],
      prerequisite_source_ids: ["K013"],
      goal: profile.goal,
      objectives: [
        {
          objective_id: "O1",
          source_id: "K007",
          required_fact_ids: ["F001"],
          observable_behavior: "recognize",
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
    const initialEvidence = evidenceFromKnowledgeBase(
      "RAG-RECOVERY-GOLD-INITIAL",
      ["K007", "K009", "K018", "K013"],
      profile.level,
      knowledgeBase,
    )
    const built = buildGenerationSpec({
      run_id: "RUN-RECOVERY-GOLD-INITIAL",
      profile_snapshot: profile,
      path_node: initialPath,
      evidence_pack: initialEvidence,
      versions: {
        prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
        model_config_hash: "deterministic-recovery-gold-v1",
      },
      seed: 42,
    })
    if (!built.ok) throw new Error(built.errors.join("；"))

    const reviewPort = createLocalABContentReviewPort({
      knowledge_base: knowledgeBase,
    })
    const observedReviews: ContentReviewResult[] = []
    const agents = createRoleCAgents(
      new DeterministicCodeLabContentProvider(),
      deterministicRecoveryVerifiers,
    )
    const result = await runRecoverableReviewedCPipeline(
      {
        generation_spec: built.spec,
        evidence_pack: initialEvidence,
      },
      agents,
      new InMemorySecureArtifactStore(),
      {
        profile_snapshot: profile,
        review_port: {
          policy_version: reviewPort.policy_version,
          async review(request) {
            const report = await reviewPort.review(request)
            observedReviews.push(structuredClone(report))
            return report
          },
        },
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: {
                schema_version: "1.0",
                node_id: "PATH-B-RECOVERY-GOLD-DRAFT",
                target_source_ids: ["K007", "K009", "K006"],
                prerequisite_source_ids: ["K002", "K003", "K005"],
                goal: profile.goal,
                objectives: [
                  {
                    objective_id: "RO1",
                    source_id: "K007",
                    required_fact_ids: [],
                    observable_behavior: "recognize",
                    importance: "core",
                  },
                  {
                    objective_id: "RO2",
                    source_id: "K009",
                    required_fact_ids: [],
                    observable_behavior: "apply",
                    importance: "core",
                  },
                  {
                    objective_id: "RO3",
                    source_id: "K006",
                    required_fact_ids: [],
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
              },
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence(request) {
            return evidenceFromKnowledgeBase(
              "RAG-RECOVERY-GOLD-REFRESHED",
              request.target_source_ids,
              request.learner_level,
              knowledgeBase,
            )
          },
        },
      },
    )

    expect(observedReviews[0]).toMatchObject({
      decision: "reject",
      required_action: "replan_path",
      fix_scope: "new_spec",
    })
    expect(observedReviews.at(-1)?.decision).toBe("pass")
    expect(result.status).toBe("ready")
    expect(result.state).toBe("READY")
    expect(result.recovery).toMatchObject({
      code: "READY",
      recovery_attempts: 1,
    })
    expect(result.recovery_history).toHaveLength(1)
    expect(result.recovery_history[0]).toMatchObject({
      action: "new_spec",
    })
    expect(result.recovery_history[0]?.path_request_id).toBeTruthy()
    expect(result.recovery_history[0]?.evidence_request_id).toBeTruthy()
    expect(result.recovery_history[0]?.output_spec_id).toBe(
      result.generation_spec.spec_id,
    )
    expect(result.generation_spec.targets.map((target) => target.source_id))
      .toEqual(["K007", "K009", "K006"])
    expect(result.generation_spec.targets.every(
      (target) =>
        target.required_fact_ids.join(",") === "F001,F002,F003",
    )).toBe(true)
    expect(result.public_artifacts.concept_lesson?.status).toBe("ready")
    expect(result.public_artifacts.code_lab?.status).toBe("ready")
    expect(result.public_artifacts.assessment?.status).toBe("ready")
    expect(result.secure_refs).toHaveLength(2)
    expect(result.review_reports.at(-1)?.artifact_results.every(
      (artifact) =>
        artifact.fact_status === "pass"
        && artifact.teaching_status === "pass"
        && artifact.decision === "pass",
    )).toBe(true)

    const concept = result.public_artifacts.concept_lesson
    if (!concept?.payload) throw new Error("恢复后的讲义缺失")
    const citedFacts = new Set(
      concept.payload.explanation_blocks.flatMap((block) =>
        "claims" in block
          ? block.claims.flatMap((claim) =>
              claim.citations.map((citation) =>
                `${citation.source_id}:${citation.fact_id}`))
          : []),
    )
    for (const target of result.generation_spec.targets) {
      for (const factId of target.required_fact_ids) {
        expect(citedFacts.has(`${target.source_id}:${factId}`)).toBe(true)
      }
    }
  })

  test("returns explicit UNSUPPORTED_TARGET when a recovered path exceeds offline lab templates", async () => {
    const fixture = recoveryFixture()
    const knowledgeBase = await loadKnowledgeBase()
    let reviewedRuns = 0
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      createRoleCAgents(
        new DeterministicCodeLabContentProvider(),
        deterministicRecoveryVerifiers,
      ),
      new InMemorySecureArtifactStore(),
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (
          input,
          agents,
          secureStore,
          options,
        ) => {
          reviewedRuns += 1
          if (reviewedRuns === 1) {
            return blockedResult(input, recoveryReport(
              input,
              "new_spec",
              "replan_path",
            ))
          }
          return runReviewedCPipeline(input, agents, secureStore, options)
        },
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: {
                schema_version: "1.0",
                node_id: "PATH-B-UNSUPPORTED-DRAFT",
                target_source_ids: ["K010", "K011", "K012"],
                prerequisite_source_ids: ["K002", "K003", "K009"],
                goal: fixture.profile.goal,
                objectives: ["K010", "K011", "K012"].map(
                  (sourceId, index) => ({
                    objective_id: `RO${index + 1}`,
                    source_id: sourceId,
                    required_fact_ids: [],
                    observable_behavior: (["recognize", "apply", "create"] as const)[index]!,
                    importance: "core" as const,
                  }),
                ),
                assessment_blueprint: {
                  tier_1_count: 2,
                  tier_2_count: 2,
                  tier_3_count: 1,
                  required_modalities: ["mcq", "trace", "code"],
                },
              },
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence(request) {
            return evidenceFromKnowledgeBase(
              "RAG-RECOVERY-UNSUPPORTED",
              request.target_source_ids,
              request.learner_level,
              knowledgeBase,
            )
          },
        },
      },
    )

    expect(reviewedRuns).toBe(2)
    expect(result.status).toBe("blocked")
    expect(result.state).toBe("BLOCKED")
    expect(result.blocked_reason?.code).toBe("UNSUPPORTED_TARGET")
    expect(result.recovery).toMatchObject({
      code: "UNSUPPORTED_TARGET",
      can_recover: false,
      recovery_attempts: 1,
    })
    expect(result.blocked_reason?.message).toContain("离线 code-lab")
    expect(result.public_artifacts.concept_lesson?.status).toBe("ready")
    expect(result.public_artifacts.code_lab?.status).toBe("blocked")
    expect(result.public_artifacts.assessment).toBeUndefined()
    expect(result.trace_events.some((event) =>
      event.agent === "tiered-evaluator" && event.event_type === "c.agent.started"))
      .toBe(false)
    expect(result.secure_refs).toEqual([])
  })

  test("local B path adapter blocks empty targets and planner exceptions", async () => {
    const fixture = recoveryFixture()
    const knowledgeBase = await loadKnowledgeBase()
    const request: RoleBPathPlanningRequest = {
      schema_version: "1.0",
      request_id: "BPATH-LOCAL-ADAPTER",
      run_id: fixture.input.generation_spec.run_id,
      current_spec_id: fixture.input.generation_spec.spec_id,
      profile_snapshot: structuredClone(fixture.profile),
      current_path_node: structuredClone(fixture.path),
      failed_dimensions: ["difficulty_alignment"],
      missing_prerequisite_source_ids: [],
      required_action: "replan_path",
      fix_scope: "new_spec",
      recommended_level: "beginner",
      review_instruction_ids: ["INSTRUCTION-LOCAL-B"],
    }

    const emptyResult = await createLocalBPathPlanningPort({
      ...structuredClone(knowledgeBase),
      items: [],
    }).replanLearningPath(request)
    expect(emptyResult).toMatchObject({
      status: "blocked",
      request_id: request.request_id,
      code: "UNSUPPORTED_TARGET",
      can_recover: false,
    })

    const exceptionalResult = await createLocalBPathPlanningPort({
      ...structuredClone(knowledgeBase),
      items: undefined as unknown as KnowledgeBase["items"],
    }).replanLearningPath(request)
    expect(exceptionalResult).toMatchObject({
      status: "blocked",
      request_id: request.request_id,
      code: "BLOCKED",
      can_recover: false,
      reason: "本地 B 路径规划执行失败",
    })
  })

  test("local B selects the first dependency-ready prerequisite as a focused recovery stage", async () => {
    const fixture = recoveryFixture()
    const knowledgeBase = await loadKnowledgeBase()
    const profile: LearnerProfileSnapshot = {
      ...structuredClone(fixture.profile),
      level: "basic",
      known_concepts: [],
      weak_concepts: ["综合项目"],
      goal: "完成成绩统计器综合项目",
    }
    const request: RoleBPathPlanningRequest = {
      schema_version: "1.0",
      request_id: "BPATH-K018-RECURSIVE",
      run_id: fixture.input.generation_spec.run_id,
      current_spec_id: fixture.input.generation_spec.spec_id,
      profile_snapshot: profile,
      current_path_node: {
        ...structuredClone(fixture.path),
        node_id: "PATH-K018-MISSING-PREREQUISITES",
        target_source_ids: ["K018"],
        prerequisite_source_ids: [],
        goal: profile.goal,
        objectives: [{
          objective_id: "O-K018",
          source_id: "K018",
          required_fact_ids: ["F001"],
          observable_behavior: "create",
          importance: "core",
        }],
      },
      failed_dimensions: ["prerequisite_coverage"],
      missing_prerequisite_source_ids: ["K007", "K009", "K013"],
      required_action: "replan_path",
      fix_scope: "new_spec",
      review_instruction_ids: ["REV-K018-PREREQUISITES"],
    }

    const result = await createLocalBPathPlanningPort(
      knowledgeBase,
    ).replanLearningPath(request)
    if (result.status !== "ready") throw new Error(result.reason)

    expect(result.path_draft.target_source_ids).toEqual(["K001"])
    expect(result.path_draft.target_source_ids).not.toContain("K018")
    expect(result.path_draft.prerequisite_source_ids).toEqual([])
    expect(
      result.path_draft.assessment_blueprint.tier_1_count
      + result.path_draft.assessment_blueprint.tier_2_count
      + result.path_draft.assessment_blueprint.tier_3_count,
    ).toBeGreaterThanOrEqual(result.path_draft.objectives.length)
    expect(result.path_draft.goal).toContain(profile.goal)
    expect(result.profile_snapshot?.profile_version)
      .not.toBe(profile.profile_version)
    expect(result.profile_snapshot?.weak_concepts).toEqual(
      expect.arrayContaining(["Python 是什么"]),
    )

    const stageProfile = result.profile_snapshot
    if (!stageProfile) throw new Error("先修阶段缺少复审画像")
    const stageAudit = auditTeaching({
      artifactId: "ARTIFACT-K018-PREREQUISITE-STAGE",
      learnerProfile: {
        learner_id: stageProfile.learner_id,
        level: stageProfile.level,
        known_concepts: [...stageProfile.known_concepts],
        weak_concepts: [...stageProfile.weak_concepts],
        goal: result.path_draft.goal,
      },
      knowledgeBase,
      citedSourceIds: [...result.path_draft.target_source_ids],
      targetSourceIds: [...result.path_draft.target_source_ids],
      contentSummary: result.path_draft.goal,
    })
    expect(stageAudit.status).toBe("pass")
    expect(stageAudit.failedDimensions).toEqual([])
    expect(stageAudit.missingPrerequisiteSourceIds).toEqual([])
  })

  test("local B fails closed when a recursive prerequisite reference is unknown", async () => {
    const fixture = recoveryFixture()
    const knowledgeBase = await loadKnowledgeBase()
    const malformed = structuredClone(knowledgeBase)
    const nested = malformed.items.find((item) => item.sourceId === "K013")
    if (!nested) throw new Error("测试知识库缺少 K013")
    nested.prerequisites = [...nested.prerequisites, "K999"]
    const result = await createLocalBPathPlanningPort(
      malformed,
    ).replanLearningPath({
      schema_version: "1.0",
      request_id: "BPATH-UNKNOWN-NESTED-PREREQUISITE",
      run_id: fixture.input.generation_spec.run_id,
      current_spec_id: fixture.input.generation_spec.spec_id,
      profile_snapshot: structuredClone(fixture.profile),
      current_path_node: structuredClone(fixture.path),
      failed_dimensions: ["prerequisite_coverage"],
      missing_prerequisite_source_ids: ["K013"],
      required_action: "replan_path",
      fix_scope: "new_spec",
      review_instruction_ids: ["REV-UNKNOWN-NESTED-PREREQUISITE"],
    })

    expect(result).toMatchObject({
      status: "blocked",
      code: "BLOCKED",
      can_recover: false,
    })
    if (result.status !== "blocked") throw new Error("预期 B 拒绝未知先修")
    expect(result.reason).toContain("K999")
  })

  test("gives equivalent B drafts a stable formal path identity and deterministic fact binding", async () => {
    const fixture = recoveryFixture()
    const formalNodeIds: string[] = []
    const boundFacts: string[][] = []
    const rawNodeIds = ["RECOVERY-K002-100", "RECOVERY-K002-200"]

    for (const rawNodeId of rawNodeIds) {
      const draft = pathFor(rawNodeId, "K002", "RO1", ["K001"])
      draft.objectives[0]!.required_fact_ids = []
      const refreshed = evidenceFor(
        "RAG-STABLE-DRAFT",
        ["K002", "K001"],
      )
      refreshed.results[0]!.facts = [
        {
          source_id: "K002",
          fact_id: "F002",
          content: "排序靠后的事实",
        },
        {
          source_id: "K002",
          fact_id: "F001",
          content: "排序靠前的事实",
        },
      ]
      let runnerCalls = 0
      const result = await runRecoverableReviewedCPipeline(
        fixture.input,
        unusedAgents,
        recordingSecureStore().store,
        {
          profile_snapshot: fixture.profile,
          review_port: unusedReviewPort,
          reviewed_pipeline_runner: async (input) => {
            runnerCalls += 1
            if (runnerCalls === 2) {
              formalNodeIds.push(input.generation_spec.path_node.node_id)
              boundFacts.push(
                input.generation_spec.targets.flatMap(
                  (target) => target.required_fact_ids,
                ),
              )
              return readyResult(input)
            }
            return blockedResult(input, recoveryReport(
              input,
              "new_spec",
              "replan_path",
            ))
          },
          path_planning_port: {
            async replanLearningPath(request) {
              return {
                status: "ready",
                request_id: request.request_id,
                path_draft: structuredClone(draft),
              }
            },
          },
          evidence_refresh_port: {
            async refreshEvidence() {
              return structuredClone(refreshed)
            },
          },
        },
      )
      expect(result.status).toBe("ready")
    }

    expect(formalNodeIds).toHaveLength(2)
    expect(formalNodeIds[0]).toBe(formalNodeIds[1])
    expect(formalNodeIds).not.toContain(rawNodeIds[0])
    expect(formalNodeIds).not.toContain(rawNodeIds[1])
    expect(boundFacts).toEqual([
      ["F001", "F002"],
      ["F001", "F002"],
    ])
  })

  test("blocks an objective outside the planned targets before requesting A evidence", async () => {
    const fixture = recoveryFixture()
    const invalidDraft = pathFor("PATH-INVALID-DRAFT", "K002", "RO1")
    invalidDraft.objectives[0]!.source_id = "K099"
    invalidDraft.objectives[0]!.required_fact_ids = []
    let evidenceCalls = 0

    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) =>
          blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
          )),
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: structuredClone(invalidDraft),
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return evidenceFor("UNUSED", ["K002"])
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      recovery_attempts: 1,
    })
    expect(result.recovery.message).toContain("source_id 不在 target_source_ids")
    expect(evidenceCalls).toBe(0)
  })

  test("blocks safely when A returns no usable fact for an unbound B objective", async () => {
    const fixture = recoveryFixture()
    const draft = pathFor("PATH-NO-FACT-DRAFT", "K002", "RO1")
    draft.objectives[0]!.required_fact_ids = []
    const noFactEvidence = evidenceFor("RAG-NO-FACT", ["K002"])
    noFactEvidence.results[0]!.facts = []

    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) =>
          blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
          )),
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: structuredClone(draft),
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            return structuredClone(noFactEvidence)
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      recovery_attempts: 1,
    })
    expect(result.recovery.message).toContain("没有可用事实")
  })

  test("does not call A, B, or secure storage when the review says recovery is not allowed", async () => {
    const fixture = recoveryFixture()
    let runnerCalls = 0
    let evidenceCalls = 0
    let pathCalls = 0
    const secure = recordingSecureStore()
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      secure.store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          runnerCalls += 1
          return blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
            { can_recover: false },
          ))
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return evidenceFor("UNUSED", ["K001"])
          },
        },
        path_planning_port: {
          async replanLearningPath(request) {
            pathCalls += 1
            return {
              status: "ready",
              request_id: request.request_id,
              path_draft: pathFor("UNUSED", "K001", "O-K001"),
            }
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      required_action: "replan_path",
      fix_scope: "new_spec",
      can_recover: false,
      recovery_attempts: 0,
    })
    expect(runnerCalls).toBe(1)
    expect(evidenceCalls).toBe(0)
    expect(pathCalls).toBe(0)
    expect(secure.batchWrites).toBe(0)
    expect(result.recovery_history).toEqual([])
  })

  test("caps outer recovery at two attempts while leaving the final rejected candidate unpublished", async () => {
    const fixture = recoveryFixture()
    let runnerCalls = 0
    let evidenceCalls = 0
    const secure = recordingSecureStore()
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      secure.store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        max_recovery_attempts: 2,
        reviewed_pipeline_runner: async (input) => {
          runnerCalls += 1
          return blockedResult(input, recoveryReport(
            input,
            "new_evidence",
            "request_new_evidence",
          ))
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return evidenceFor(
              `RAG-OUTER-${evidenceCalls}`,
              ["K001"],
              "beginner",
              `补证据版本 ${evidenceCalls}`,
            )
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      required_action: "request_new_evidence",
      fix_scope: "new_evidence",
      can_recover: false,
      recovery_attempts: 2,
    })
    expect(result.recovery.message).toContain("恢复次数上限")
    expect(runnerCalls).toBe(3)
    expect(evidenceCalls).toBe(2)
    expect(result.recovery_history).toHaveLength(2)
    expect(result.recovery_history.map((entry) => entry.attempt_no))
      .toEqual([1, 2])
    expect(secure.batchWrites).toBe(0)
  })

  test("returns structured UNSUPPORTED_TARGET when B cannot plan the requested target", async () => {
    const fixture = recoveryFixture()
    let runnerCalls = 0
    let evidenceCalls = 0
    const secure = recordingSecureStore()
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      secure.store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          runnerCalls += 1
          return blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
            { failed_dimensions: ["target_support"] },
          ))
        },
        path_planning_port: {
          async replanLearningPath(request) {
            return {
              status: "blocked",
              request_id: request.request_id,
              code: "UNSUPPORTED_TARGET",
              reason: "当前路径规划器不支持该目标",
              failed_dimensions: ["UNSUPPORTED_TARGET"],
              missing_prerequisite_source_ids: ["K099"],
              can_recover: false,
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return evidenceFor("UNUSED", ["K001"])
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toEqual(expect.objectContaining({
      code: "UNSUPPORTED_TARGET",
      failed_dimensions: ["target_support", "UNSUPPORTED_TARGET"],
      missing_prerequisite_source_ids: ["K099"],
      required_action: "replan_path",
      fix_scope: "new_spec",
      can_recover: false,
      recovery_attempts: 1,
      message: "当前路径规划器不支持该目标",
    }))
    expect(runnerCalls).toBe(1)
    expect(evidenceCalls).toBe(0)
    expect(secure.batchWrites).toBe(0)
  })

  test("keeps artifact repair inside the reviewed runner and never starts an outer recovery", async () => {
    const fixture = recoveryFixture()
    let runnerCalls = 0
    let simulatedInnerReviewCalls = 0
    let observedInnerLimit: number | undefined
    const runner: typeof runReviewedCPipeline = async (
      input,
      _agents,
      _store,
      options,
    ) => {
      runnerCalls += 1
      observedInnerLimit = options.max_external_revisions
      simulatedInnerReviewCalls = (options.max_external_revisions ?? 2) + 1
      return blockedResult(input, recoveryReport(
        input,
        "artifact",
        "adjust_content",
        {
          revision_round: 2,
          max_revision_rounds: 2,
        },
      ))
    }
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        max_external_revisions: 2,
        reviewed_pipeline_runner: runner,
        evidence_refresh_port: {
          async refreshEvidence() {
            throw new Error("artifact repair must not call A")
          },
        },
        path_planning_port: {
          async replanLearningPath() {
            throw new Error("artifact repair must not call B")
          },
        },
      },
    )

    expect(result.status).toBe("blocked")
    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      required_action: "adjust_content",
      fix_scope: "artifact",
      recovery_attempts: 0,
    })
    expect(result.recovery.message).toContain("artifact 修订已由当前 GenerationSpec")
    expect(observedInnerLimit).toBe(2)
    expect(simulatedInnerReviewCalls).toBe(3)
    expect(runnerCalls).toBe(1)
    expect(result.recovery_history).toEqual([])
  })

  test("handles port exceptions, mismatched B response IDs, and coverage-complete unchanged A evidence", async () => {
    const fixture = recoveryFixture()
    const newEvidenceReport = recoveryReport(
      fixture.input,
      "new_evidence",
      "request_new_evidence",
    )
    const newSpecReport = recoveryReport(
      fixture.input,
      "new_spec",
      "replan_path",
    )

    const thrownA = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) =>
          blockedResult(input, newEvidenceReport),
        evidence_refresh_port: {
          async refreshEvidence() {
            throw new Error("A unavailable")
          },
        },
      },
    )
    expect(thrownA.recovery).toMatchObject({
      code: "BLOCKED",
      recovery_attempts: 1,
      message: "A 证据刷新接口调用失败",
    })

    let evidenceCallsAfterBadB = 0
    const mismatchedB = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) =>
          blockedResult(input, newSpecReport),
        path_planning_port: {
          async replanLearningPath() {
            return {
              status: "ready",
              request_id: "WRONG-REQUEST-ID",
              path_draft: pathFor("PATH-OTHER", "K002", "O-K002"),
            }
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCallsAfterBadB += 1
            return evidenceFor("UNUSED", ["K002"])
          },
        },
      },
    )
    expect(mismatchedB.recovery).toMatchObject({
      code: "BLOCKED",
      recovery_attempts: 1,
      message: "B 路径规划响应与请求标识不一致",
    })
    expect(evidenceCallsAfterBadB).toBe(0)

    let unchangedRunnerCalls = 0
    const unchangedEvidence = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          unchangedRunnerCalls += 1
          return unchangedRunnerCalls === 1
            ? blockedResult(input, recoveryReport(
                input,
                "new_evidence",
                "request_new_evidence",
              ))
            : readyResult(input)
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            return structuredClone(fixture.input.evidence_pack)
          },
        },
      },
    )
    expect(unchangedEvidence.recovery).toMatchObject({
      code: "READY",
      recovery_attempts: 1,
    })
    expect(unchangedRunnerCalls).toBe(2)
    expect(unchangedEvidence.generation_spec.evidence_ref)
      .toBe(fixture.input.evidence_pack.retrieval_id)
  })

  test("blocks unknown prerequisite references without calling A or B", async () => {
    const fixture = recoveryFixture()
    let externalCalls = 0
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) =>
          blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
            { unknown_prerequisite_refs: ["K-MISSING"] },
          )),
        path_planning_port: {
          async replanLearningPath() {
            externalCalls += 1
            throw new Error("must not call B")
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            externalCalls += 1
            throw new Error("must not call A")
          },
        },
      },
    )

    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      can_recover: false,
      recovery_attempts: 0,
      unknown_prerequisite_refs: ["K-MISSING"],
    })
    expect(result.recovery.message).toContain("无法解析的前置引用")
    expect(externalCalls).toBe(0)
  })

  test("turns a malformed B path response into a structured block", async () => {
    const fixture = recoveryFixture()
    let evidenceCalls = 0
    const result = await runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      recordingSecureStore().store,
      {
        profile_snapshot: fixture.profile,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) =>
          blockedResult(input, recoveryReport(
            input,
            "new_spec",
            "replan_path",
          )),
        path_planning_port: {
          async replanLearningPath() {
            return null as never
          },
        },
        evidence_refresh_port: {
          async refreshEvidence() {
            evidenceCalls += 1
            return evidenceFor("UNUSED", ["K001"])
          },
        },
      },
    )

    expect(result.recovery).toMatchObject({
      code: "BLOCKED",
      recovery_attempts: 1,
      message: "B 路径规划响应未通过 Schema 校验",
    })
    expect(evidenceCalls).toBe(0)
  })

  test("rejects a mismatched initial profile before generation or secure writes", async () => {
    const fixture = recoveryFixture()
    const mismatched = structuredClone(fixture.profile)
    mismatched.profile_version = "PROFILE-WRONG"
    const secure = recordingSecureStore()
    let runnerCalls = 0

    await expect(runRecoverableReviewedCPipeline(
      fixture.input,
      unusedAgents,
      secure.store,
      {
        profile_snapshot: mismatched,
        review_port: unusedReviewPort,
        reviewed_pipeline_runner: async (input) => {
          runnerCalls += 1
          return readyResult(input)
        },
      },
    )).rejects.toThrow("ROLE_C_RECOVERY_INITIAL_PROFILE_MISMATCH")
    expect(runnerCalls).toBe(0)
    expect(secure.batchWrites).toBe(0)
  })
})

function validatePublicRecovery(value: unknown): boolean {
  const serialized = JSON.stringify(value)
  return !serialized.includes("profile_snapshot")
    && !serialized.includes("evidence_pack")
    && !serialized.includes("secure_refs")
    && !serialized.includes("trusted_context")
}

interface RecoveryFixture {
  profile: LearnerProfileSnapshot
  path: LearningPathNode
  evidence: RagEvidencePack
  input: CPipelineInput
}

function recoveryFixture(): RecoveryFixture {
  const profile: LearnerProfileSnapshot = {
    schema_version: "1.0",
    profile_id: "PROFILE-RECOVERY",
    profile_version: "PROFILE-V1",
    learner_id: "LEARNER-RECOVERY",
    level: "beginner",
    known_concepts: ["变量"],
    weak_concepts: ["循环"],
    goal: "完成基础程序练习",
    preferred_contexts: ["成绩统计"],
    accommodations: [],
  }
  const path = pathFor("PATH-K001", "K001", "O-K001")
  const evidence = evidenceFor("RAG-INITIAL", ["K001"])
  const built = buildGenerationSpec({
    run_id: "RUN-RECOVERY-INITIAL",
    profile_snapshot: profile,
    path_node: path,
    evidence_pack: evidence,
    versions: {
      prompt_version: "role-c-recovery-test-v1",
      model_config_hash: "model-recovery-test-v1",
    },
    seed: 17,
  })
  if (!built.ok) throw new Error(built.errors.join("；"))
  return {
    profile,
    path,
    evidence,
    input: {
      generation_spec: built.spec,
      evidence_pack: evidence,
    },
  }
}

function pathFor(
  nodeId: string,
  sourceId: string,
  objectiveId: string,
  prerequisites: string[] = [],
): LearningPathNode {
  return {
    schema_version: "1.0",
    node_id: nodeId,
    target_source_ids: [sourceId],
    prerequisite_source_ids: [...prerequisites],
    goal: `掌握 ${sourceId}`,
    objectives: [{
      objective_id: objectiveId,
      source_id: sourceId,
      required_fact_ids: ["F001"],
      observable_behavior: "recognize",
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

function evidenceFor(
  retrievalId: string,
  sourceIds: string[],
  level: LearnerProfileSnapshot["level"] = "beginner",
  contentPrefix = "基础事实",
): RagEvidencePack {
  return {
    schema_version: "1.0",
    retrieval_id: retrievalId,
    query: `检索 ${sourceIds.join("、")}`,
    learner_level: level,
    top_k: sourceIds.length,
    match_status: "strong",
    kb_version: `KB-${retrievalId}`,
    rag_version: `RAG-${retrievalId}`,
    results: sourceIds.map((sourceId, index) => ({
      source_id: sourceId,
      title: `${sourceId} 标题`,
      difficulty: level,
      rank_score: 100 - index,
      match_reason: "测试强匹配",
      snippet: `${contentPrefix}-${sourceId}`,
      facts: [{
        source_id: sourceId,
        fact_id: "F001",
        content: `${contentPrefix}-${sourceId}-F001`,
      }],
      examples: [{
        title: `${sourceId} 示例`,
        code: "value = 1",
        explanation: `${sourceId} 的可追踪示例`,
      }],
      practice_tasks: [`练习 ${sourceId}`],
      quiz_seeds: [{
        level: 1,
        type: "mcq",
        question: `${sourceId} 的核心事实是什么？`,
        options: ["A", "B"],
        answer: "A",
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
          title: 1,
          facts: 1,
          practice_tasks: 1,
          difficulty: 1,
          bonus: 0,
        },
      },
    })),
  }
}

function evidenceFromKnowledgeBase(
  retrievalId: string,
  sourceIds: string[],
  level: LearnerProfileSnapshot["level"],
  knowledgeBase: KnowledgeBase,
): RagEvidencePack {
  const items = sourceIds.map((sourceId) => {
    const item = knowledgeBase.items.find(
      (candidate) => candidate.sourceId === sourceId,
    )
    if (!item) throw new Error(`测试知识库缺少 ${sourceId}`)
    return {
      source_id: item.sourceId,
      title: item.title,
      difficulty: item.difficulty,
      rank_score: 100,
      match_reason: "按恢复路径精确检索",
      snippet: item.snippet,
      facts: item.facts
        .map((fact) => ({
          source_id: fact.sourceId,
          fact_id: fact.factId,
          content: fact.content,
        }))
        .reverse(),
      examples: item.examples.map((example) => ({ ...example })),
      practice_tasks: [...item.practiceTasks],
      quiz_seeds: item.quizItems.map((quiz) => ({
        level: quiz.level,
        type: quiz.type,
        question: quiz.question,
        ...(quiz.options ? { options: [...quiz.options] } : {}),
        answer: quiz.answer,
        source_id: quiz.sourceId,
        fact_id: quiz.factId,
      })),
      source_file: item.file,
      retrieval_trace: {
        matched_keywords: [item.title],
        matched_fields: ["title", "facts"],
        difficulty_match: item.difficulty === level,
        score_breakdown: {
          keyword: 1,
          title: 1,
          facts: 1,
          practice_tasks: 1,
          difficulty: item.difficulty === level ? 1 : 0,
          bonus: 0,
        },
      },
    }
  })
  return {
    schema_version: "1.0",
    retrieval_id: retrievalId,
    query: `恢复路径：${sourceIds.join("、")}`,
    learner_level: level,
    top_k: sourceIds.length,
    match_status: "strong",
    kb_version: knowledgeBase.version,
    rag_version: "role-c-b-integration-test-v1",
    results: items,
  }
}

function recoveryReport(
  input: CPipelineInput,
  fixScope: ReviewFixScope,
  requiredAction: ContentRecoveryAction,
  overrides: Partial<Pick<
    ContentReviewResult,
    | "failed_dimensions"
    | "missing_prerequisite_source_ids"
    | "unknown_prerequisite_refs"
    | "recommended_level"
    | "can_recover"
    | "revision_round"
    | "max_revision_rounds"
  >> = {},
): ContentReviewResult {
  const instruction = revisionInstruction(input, fixScope)
  return {
    run_id: input.generation_spec.run_id,
    pipeline_input_hash: contentHash(input),
    generation_spec_hash: contentHash(input.generation_spec),
    policy_version: "recovery-test-policy-v1",
    revision_round: overrides.revision_round ?? 0,
    max_revision_rounds: overrides.max_revision_rounds ?? 2,
    evidence_hash: contentHash(input.evidence_pack),
    decision: "reject",
    artifact_results: [],
    revision_instructions: [instruction],
    failed_dimensions: overrides.failed_dimensions ?? [
      fixScope === "new_evidence"
        ? "evidence_support"
        : fixScope === "new_spec"
          ? "difficulty_alignment"
          : "content_alignment",
    ],
    missing_prerequisite_source_ids:
      overrides.missing_prerequisite_source_ids ?? [],
    unknown_prerequisite_refs:
      overrides.unknown_prerequisite_refs ?? [],
    required_action: requiredAction,
    fix_scope: fixScope,
    ...(overrides.recommended_level
      ? { recommended_level: overrides.recommended_level }
      : {}),
    can_recover: overrides.can_recover ?? true,
  }
}

function revisionInstruction(
  input: CPipelineInput,
  fixScope: ReviewFixScope,
): ContentRevisionInstruction {
  const artifactId = "ARTIFACT-RECOVERY-CANDIDATE"
  return {
    source: fixScope === "new_evidence"
      ? "fact_audit"
      : "teaching_audit",
    code: fixScope === "new_evidence"
      ? "evidence_support"
      : fixScope === "new_spec"
        ? "difficulty_alignment"
        : "content_alignment",
    artifact_kind: "concept",
    artifact_id: artifactId,
    message: `需要执行 ${fixScope}`,
    proposed_action: `按 ${fixScope} 恢复`,
    fix_scope: fixScope,
    evidence_refs: [artifactId],
    instruction_id: `INSTRUCTION-${fixScope}`,
    target_agent: "concept-tutor",
    target_artifact_id: artifactId,
    objective_id: input.generation_spec.targets[0]!.objective_id,
  }
}

function blockedResult(
  input: CPipelineInput,
  report: ContentReviewResult,
): ReviewedCPipelineResult {
  return {
    status: "blocked",
    state: "BLOCKED",
    generation_spec: input.generation_spec,
    public_artifacts: {},
    secure_refs: [],
    trace_events: [],
    fact_audit_packets: [],
    blocked_reason: {
      code: "BLOCKED_CONTENT_REVIEW",
      message: "内容审核未通过",
    },
    pipeline_input_hash: contentHash(input),
    generation_spec_hash: contentHash(input.generation_spec),
    review_policy_version: report.policy_version,
    review_reports: [report],
  }
}

function readyResult(input: CPipelineInput): ReviewedCPipelineResult {
  return {
    status: "ready",
    state: "READY",
    generation_spec: input.generation_spec,
    public_artifacts: {},
    secure_refs: ["secure://test/one", "secure://test/two"],
    trace_events: [],
    fact_audit_packets: [],
    pipeline_input_hash: contentHash(input),
    generation_spec_hash: contentHash(input.generation_spec),
    review_policy_version: "recovery-test-policy-v1",
    review_reports: [],
  }
}

function recordingSecureStore(): {
  store: SecureArtifactStore
  readonly batchWrites: number
} {
  let batchWrites = 0
  const store: SecureArtifactStore = {
    namespace_id: "review-recovery-test-store",
    async put() {
      throw new Error("single put is not expected")
    },
    async putBatch() {
      batchWrites += 1
      return []
    },
    async get() {
      throw new Error("get is not expected")
    },
    async deleteBatch() {},
  }
  return {
    store,
    get batchWrites() {
      return batchWrites
    },
  }
}

const deterministicRecoveryVerifiers: GeneratedContentVerifiers = {
  code_lab: {
    async verifyCodeLab() {
      return {
        execution_verified: true,
        mutation_kill_rate: 1,
        verified_test_count: 5,
        objective_coverage: 1,
        issues: [],
      }
    },
  },
  assessment: {
    async verifyAssessment() {
      return {
        answer_key_verified: true,
        verified_item_count: 5,
        verified_test_count: 4,
        objective_coverage: 1,
        issues: [],
      }
    },
  },
}

const unusedAgents: RoleCAgents = {
  concept_tutor: {
    async generate() {
      throw new Error("injected reviewed runner must not call agents")
    },
  },
  code_lab: {
    async generate() {
      throw new Error("injected reviewed runner must not call agents")
    },
  },
  tiered_evaluator: {
    async generate() {
      throw new Error("injected reviewed runner must not call agents")
    },
  },
}

const unusedReviewPort = {
  policy_version: "recovery-test-policy-v1",
  async review(): Promise<ContentReviewResult> {
    throw new Error("injected reviewed runner must not call review_port")
  },
}
