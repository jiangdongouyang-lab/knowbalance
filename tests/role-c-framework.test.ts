import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { retrieveKnowledge } from "../src/rag/retriever"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { LearnerProfile } from "../src/role-b-profile/types"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import { WORKER_DEFINITIONS } from "../src/agents/workers"
import { buildWorkerStubPrompt } from "../src/prompts/worker-stub"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  createRoleCAgents,
  DeterministicConceptContentProvider,
  DeterministicCodeLabContentProvider,
  defineLearningPathNode,
  getRoleCModelOutputSchema,
  runCPipeline,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  transitionCState,
  validateCitations,
  validatePublicArtifactNoSecrets,
  validateRoleCSchema,
  validateSpecEvidence,
  type ArtifactDraft,
  type AssessmentDraft,
  type CodeLabDraft,
  type ConceptLessonPayload,
  type LearningPathNode,
  type RagEvidencePack,
  type RoleCContentProvider,
  type GeneratedContentVerifiers,
  type SecureArtifact,
  type SecureArtifactStore,
} from "../src/role-c-content"

const profile: LearnerProfile = {
  learner_id: "demo_loop_weak",
  level: "beginner",
  known_concepts: ["变量", "数据类型", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成一个成绩统计小程序，能遍历一批成绩算平均分",
}

async function buildGoldenContext(): Promise<{
  pack: RagEvidencePack
  path: LearningPathNode
  spec: ReturnType<typeof buildGenerationSpec> & { ok: true }
}> {
  const request = buildRagRequest(profile)
  const rag = await retrieveKnowledge({ query: request.query, learnerLevel: profile.level, topK: request.top_k })
  const kb = await loadKnowledgeBase()
  const pack = adaptRagResult(rag, { kb_version: kb.version, rag_version: "rule-rag-0.1" })
  const rawPath = await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()
  const path = defineLearningPathNode({
    node_id: rawPath.node_id,
    target_source_ids: rawPath.target_source_ids,
    prerequisite_source_ids: rawPath.prerequisite_source_ids,
    goal: rawPath.goal,
    objectives: rawPath.objectives,
    assessment_blueprint: rawPath.assessment_blueprint,
  })
  const snapshot = adaptLearnerProfile(profile, { profile_version: "profile-v1" })
  const spec = buildGenerationSpec({
    run_id: "RUN-C-GOLDEN-001",
    profile_snapshot: snapshot,
    path_node: path,
    evidence_pack: pack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: "provider-not-bound",
    },
    seed: 42,
  })
  if (!spec.ok) throw new Error(spec.errors.join("; "))
  return { pack, path, spec }
}

describe("role C intake contracts", () => {
  test("normalizes A rag_result and builds a frozen K007/K009/K018 GenerationSpec", async () => {
    const { pack, path, spec } = await buildGoldenContext()
    expect(pack.match_status).toBe("strong")
    expect(pack.results.map((item) => item.source_id)).toEqual(expect.arrayContaining(["K007", "K009", "K018"]))
    expect(spec.spec.policies.external_knowledge_allowed).toBe(false)
    expect(spec.spec.targets.map((target) => target.objective_id)).toEqual(["O1", "O2", "O3"])
    expect(spec.spec.evidence_ref).toBe(pack.retrieval_id)
    expect(validateRoleCSchema("learning_path_node.schema.json", path).ok).toBe(true)
  })

  test("blocks no-match and weak-match evidence instead of letting C invent content", async () => {
    const { path } = await buildGoldenContext()
    const snapshot = adaptLearnerProfile(profile, { profile_version: "profile-v1" })
    const noMatch = adaptRagResult({ query: "量子计算", learnerLevel: undefined, topK: 3, results: [] }, {
      kb_version: "0.1.0",
      rag_version: "rule-rag-0.1",
    })
    const noMatchBuild = buildGenerationSpec({
      run_id: "RUN-NO-MATCH",
      profile_snapshot: snapshot,
      path_node: path,
      evidence_pack: noMatch,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(noMatchBuild.ok).toBe(false)
    if (!noMatchBuild.ok && noMatchBuild.code !== "INVALID_INPUT") {
      expect(noMatchBuild.code).toBe("MISSING_EVIDENCE")
      expect(noMatchBuild.gap_request.required_facts).toContainEqual({ source_id: "K007", fact_id: "F001" })
      expect(noMatchBuild.gap_request.required_facts).toContainEqual({ source_id: "K009", fact_id: "F001" })
    }

    const weakRag = await retrieveKnowledge({ query: "银河系天文观测", learnerLevel: "beginner", topK: 5 })
    const weakPack = adaptRagResult(weakRag, { kb_version: "0.1.0", rag_version: "rule-rag-0.1" })
    expect(weakPack.match_status).toBe("weak")
    const weakPath = defineLearningPathNode({
      node_id: "PATH-WEAK",
      target_source_ids: [weakPack.results[0].source_id],
      prerequisite_source_ids: [],
      goal: "测试弱匹配阻塞",
      objectives: [{
        objective_id: "OW",
        source_id: weakPack.results[0].source_id,
        required_fact_ids: [weakPack.results[0].facts[0].fact_id],
        observable_behavior: "recognize",
        importance: "core",
      }],
      assessment_blueprint: {
        tier_1_count: 1,
        tier_2_count: 0,
        tier_3_count: 0,
        required_modalities: ["mcq"],
      },
    })
    const weakBuild = buildGenerationSpec({
      run_id: "RUN-WEAK",
      profile_snapshot: snapshot,
      path_node: weakPath,
      evidence_pack: weakPack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(weakBuild.ok).toBe(false)
    if (!weakBuild.ok) expect(weakBuild.code).toBe("WEAK_EVIDENCE")
  })

  test("trusts A's pack-level match status without reclassifying individual retrieval traces", async () => {
    const { pack, path } = await buildGoldenContext()
    const mixedPack = structuredClone(pack)
    const target = mixedPack.results.find((item) => item.source_id === "K007")!
    target.retrieval_trace.matched_fields = ["difficulty"]
    const built = buildGenerationSpec({
      run_id: "RUN-MIXED-MATCH",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: path,
      evidence_pack: mixedPack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(mixedPack.match_status).toBe("strong")
    expect(built.ok).toBe(true)
  })

  test("rechecks evidence identity and versions without overriding A's match judgment", async () => {
    const { pack, spec } = await buildGoldenContext()
    const replaced = structuredClone(pack)
    replaced.results.find((item) => item.source_id === "K007")!.retrieval_trace.matched_fields = ["difficulty"]
    replaced.kb_version = "kb-replaced-after-spec"
    const report = validateSpecEvidence(spec.spec, replaced)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain("kb_version_mismatch")
    expect(report.issues.map((issue) => issue.code)).not.toContain("weak_target_source")
  })

  test("copies the upstream assessment blueprint verbatim and includes it in spec identity", async () => {
    const { pack, path, spec } = await buildGoldenContext()
    const customPath = structuredClone(path)
    customPath.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 2,
      tier_3_count: 2,
      required_modalities: ["true_false", "short_answer", "code"],
    }
    const built = buildGenerationSpec({
      run_id: "RUN-C-GOLDEN-001",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: customPath,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "provider-not-bound" },
      seed: 42,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.spec.assessment_blueprint).toEqual(customPath.assessment_blueprint)
    expect(built.spec.spec_id).not.toBe(spec.spec.spec_id)
  })

  test("rejects a path node that omits the upstream assessment blueprint", async () => {
    const { pack, path } = await buildGoldenContext()
    const missing = structuredClone(path) as Omit<LearningPathNode, "assessment_blueprint"> & {
      assessment_blueprint?: LearningPathNode["assessment_blueprint"]
    }
    delete missing.assessment_blueprint
    const built = buildGenerationSpec({
      run_id: "RUN-MISSING-BLUEPRINT",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: missing as LearningPathNode,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.code).toBe("INVALID_INPUT")
      expect(built.errors).toContain("path_node.assessment_blueprint 必须由上游下发")
    }
  })

  test("rejects an unsupported or undersized upstream assessment blueprint", async () => {
    const { pack, path } = await buildGoldenContext()
    const invalid = structuredClone(path)
    invalid.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 0,
      tier_3_count: 0,
      required_modalities: ["essay" as "mcq"],
    }
    const built = buildGenerationSpec({
      run_id: "RUN-INVALID-BLUEPRINT",
      profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-v1" }),
      path_node: invalid,
      evidence_pack: pack,
      versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: "none" },
    })
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.code).toBe("INVALID_INPUT")
      expect(built.errors).toEqual(expect.arrayContaining([
        "不支持的 assessment modality：essay",
        "assessment blueprint 总题量不能少于 core objective 数量",
      ]))
    }
  })

  test("validates citations against only the current evidence pack", async () => {
    const { pack } = await buildGoldenContext()
    expect(validateCitations([{ source_id: "K007", fact_id: "F001", relation: "supports" }], pack).ok).toBe(true)
    expect(validateCitations([{ source_id: "K999", fact_id: "F999", relation: "supports" }], pack).ok).toBe(false)
  })
})

describe("role C public/private and orchestration boundaries", () => {
  test("detects nested answer and hidden-test leakage in public output", () => {
    const report = validatePublicArtifactNoSecrets({
      title: "public",
      nested: { answer: "secret", hidden_tests: [{ expected: 1 }] },
    })
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain("public_secure_leak")
  })

  test("rejects illegal state transitions", () => {
    expect(transitionCState("PLANNED", "GENERATING")).toBe("GENERATING")
    expect(() => transitionCState("PLANNED", "READY")).toThrow("非法 C 流水线状态转换")
  })

  test("runs the shell pipeline and returns only secure references", async () => {
    const { pack, spec } = await buildGoldenContext()
    const objectiveIds = spec.spec.targets.map((target) => target.objective_id)
    const citations = spec.spec.targets.map((target) => ({
      source_id: target.source_id,
      fact_id: target.required_fact_ids[0],
      relation: "supports" as const,
    }))
    const provider = fixtureProvider(objectiveIds, citations)
    const stored: SecureArtifact[] = []
    const store: SecureArtifactStore = {
      async put(artifact, context) {
        return (await this.putBatch([artifact], context))[0]
      },
      async putBatch(artifacts) {
        stored.push(...artifacts)
        return artifacts.map((artifact) => `secure://${artifact.artifact_id}`)
      },
      async get() { throw new Error("not used") },
      async deleteBatch() {},
    }
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(provider, fixtureVerifiers),
      store,
    )
    expect(result.status).toBe("ready")
    expect(result.state).toBe("READY")
    expect(result.secure_refs).toHaveLength(2)
    expect(stored.map((artifact) => artifact.artifact_type)).toEqual(["code_lab_secure", "assessment_secure"])
    expect(JSON.stringify(result.public_artifacts)).not.toContain("reference_solution")
    expect(JSON.stringify(result.public_artifacts)).not.toContain("hidden_tests")
  })

  test("runs at most one critic-directed revision and revalidates before publication", async () => {
    const { pack, spec } = await buildGoldenContext()
    const objectiveIds = spec.spec.targets.map((target) => target.objective_id)
    const citations = spec.spec.targets.map((target) => ({
      source_id: target.source_id,
      fact_id: target.required_fact_ids[0],
      relation: "supports" as const,
    }))
    const baseline = fixtureProvider(objectiveIds, citations)
    let assessmentCalls = 0
    const provider: RoleCContentProvider = {
      ...baseline,
      async generateAssessment(request) {
        assessmentCalls += 1
        return baseline.generateAssessment(request)
      },
    }
    let reviews = 0
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(provider, fixtureVerifiers),
      {
        async put(artifact) { return `secure://${artifact.artifact_id}` },
        async putBatch(artifacts) { return artifacts.map((artifact) => `secure://${artifact.artifact_id}`) },
        async get() { throw new Error("not used") },
        async deleteBatch() {},
      },
      {
        critic: {
          async review(input) {
            reviews += 1
            if (reviews > 1) return []
            return [{
              objection_id: "OBJ-ONE-REVISION",
              from_agent: "cross-artifact-gate",
              target_artifact_id: input.assessment.artifact_id,
              objective_id: "O2",
              issue_type: "difficulty_mismatch",
              severity: "critical",
              evidence: ["fixture critic request"],
              proposed_action: "重新生成 assessment 并复核",
            }]
          },
        },
      },
    )
    expect(result.status).toBe("ready")
    expect(assessmentCalls).toBe(2)
    expect(reviews).toBe(2)
    expect(result.trace_events.filter((event) => event.retry_kind === "semantic_revision")).toHaveLength(1)
  })

  test("returns a typed failure when secure storage is unavailable", async () => {
    const { pack, spec } = await buildGoldenContext()
    const objectiveIds = spec.spec.targets.map((target) => target.objective_id)
    const citations = spec.spec.targets.map((target) => ({
      source_id: target.source_id,
      fact_id: target.required_fact_ids[0],
      relation: "supports" as const,
    }))
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(fixtureProvider(objectiveIds, citations), fixtureVerifiers),
      {
        async put() { throw new Error("secure store offline") },
        async putBatch() { throw new Error("secure store offline") },
        async get() { throw new Error("secure store offline") },
        async deleteBatch() {},
      },
    )
    expect(result.status).toBe("failed")
    expect(result.state).toBe("FAILED")
    expect(result.failure_reason?.code).toBe("SECURE_STORE_ERROR")
    expect(result.secure_refs).toEqual([])
  })

  test("does not accept execution or answer verification from the content Provider", async () => {
    const { pack, spec } = await buildGoldenContext()
    const objectiveIds = spec.spec.targets.map((target) => target.objective_id)
    const citations = spec.spec.targets.map((target) => ({
      source_id: target.source_id,
      fact_id: target.required_fact_ids[0],
      relation: "supports" as const,
    }))
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(fixtureProvider(objectiveIds, citations)),
      {
        async put(artifact) { return `secure://${artifact.artifact_id}` },
        async putBatch(artifacts) { return artifacts.map((artifact) => `secure://${artifact.artifact_id}`) },
        async get() { throw new Error("not used") },
        async deleteBatch() {},
      },
    )
    expect(result.status).toBe("blocked")
    expect(result.blocked_reason?.code).toBe("BLOCKED_EXECUTION_UNVERIFIED")
  })
})

describe("role C published integration assets", () => {
  test("ships parseable schemas for every external C message and core artifact", async () => {
    const files = (await readdir("schemas/role-c-content")).filter((file) => file.endsWith(".schema.json")).sort()
    expect(files).toEqual([
      "agent_trace_event.schema.json",
      "alignment_critic_judgment.schema.json",
      "artifact_envelope.schema.json",
      "assessment_draft.schema.json",
      "assessment_public.schema.json",
      "assessment_secure.schema.json",
      "code_lab_draft.schema.json",
      "code_lab_public.schema.json",
      "code_lab_secure.schema.json",
      "concept_artifact.schema.json",
      "concept_lesson_payload.schema.json",
      "evidence_gap_request.schema.json",
      "fact_audit_packet.schema.json",
      "generation_spec.schema.json",
      "grade_feedback.schema.json",
      "grade_result.schema.json",
      "learner_profile_snapshot.schema.json",
      "learning_evidence_event.schema.json",
      "learning_path_node.schema.json",
      "profile_drift_suggestion.schema.json",
      "rag_evidence_pack.schema.json",
      "rubric_judgment.schema.json",
      "session_state.schema.json",
      "submission.schema.json",
    ])
    for (const file of files) {
      const schema = await Bun.file(join("schemas/role-c-content", file)).json()
      expect(schema.$schema).toContain("json-schema")
      expect(schema.$id).toContain("/schemas/role-c-content/")
      expect(schema.type).toBe("object")
      if ([
        "concept_artifact.schema.json",
        "code_lab_public.schema.json",
        "code_lab_secure.schema.json",
        "assessment_public.schema.json",
        "assessment_secure.schema.json",
        "grade_result.schema.json",
      ].includes(file)) {
        expect(schema.allOf).toEqual([{ $ref: "artifact_envelope.schema.json" }])
      }
    }
    expect(JSON.stringify(getRoleCModelOutputSchema("assessment_draft.schema.json"))).not.toContain("\"$ref\"")
  })

  test("gives all three public workers distinct C-shell role prompts", () => {
    for (const name of ["concept-tutor", "code-lab", "tiered-evaluator"] as const) {
      const definition = WORKER_DEFINITIONS.find((worker) => worker.name === name)!
      const prompt = buildWorkerStubPrompt(definition)
      expect(prompt).toContain(ROLE_C_PROMPT_MANIFEST_VERSION)
      expect(prompt).toContain("generation_spec")
      expect(prompt).toContain("evidence_pack")
      expect(prompt).toContain("rag_result")
      expect(prompt).toContain(`[executed:${name}]`)
    }
    const labPrompt = buildWorkerStubPrompt(WORKER_DEFINITIONS.find((worker) => worker.name === "code-lab")!)
    expect(labPrompt).toContain("reference_solution")
    expect(labPrompt).toContain("BLOCKED_EXECUTION_UNVERIFIED")
  })

  test("indexes every Role C prompt file with the current manifest version", async () => {
    const index = await Bun.file("docs/role_c_prompt_index.md").text()
    expect(index).toContain(ROLE_C_PROMPT_MANIFEST_VERSION)
    for (const file of [
      "common-policy.ts",
      "concept-tutor.v1.ts",
      "code-lab.v1.ts",
      "evaluator-author.v1.ts",
      "staged-authors.v1.ts",
      "evaluator-grader.v1.ts",
      "evaluator-feedback.v1.ts",
      "cross-artifact-critic.v1.ts",
    ]) {
      expect(index).toContain(file)
    }
  })
})

function fixtureProvider(
  objectiveIds: string[],
  citations: Array<{ source_id: string; fact_id: string; relation: "supports" }>,
): RoleCContentProvider {
  const baseDraft = <T>(payload: T): ArtifactDraft<T> => ({ payload })
  const deterministicConcept = new DeterministicConceptContentProvider()
  const deterministicLab = new DeterministicCodeLabContentProvider()
  return {
    async generateConceptLesson(request): Promise<ArtifactDraft<ConceptLessonPayload>> {
      return deterministicConcept.generateConceptLesson(request)
    },
    async generateCodeLab(request): Promise<CodeLabDraft> {
      return deterministicLab.generateCodeLab(request)
    },
    async generateAssessment(request): Promise<AssessmentDraft> {
      return deterministicLab.generateAssessment(request)
    },
  }
}

const fixtureVerifiers: GeneratedContentVerifiers = {
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
