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
  defineLearningPathNode,
  runCPipeline,
  transitionCState,
  validateCitations,
  validatePublicArtifactNoSecrets,
  type ArtifactDraft,
  type AssessmentDraft,
  type CodeLabDraft,
  type ConceptLessonPayload,
  type LearningPathNode,
  type RagEvidencePack,
  type RoleCContentProvider,
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
  })
  const snapshot = adaptLearnerProfile(profile, { profile_version: "profile-v1" })
  const spec = buildGenerationSpec({
    run_id: "RUN-C-GOLDEN-001",
    profile_snapshot: snapshot,
    path_node: path,
    evidence_pack: pack,
    versions: {
      prompt_version: "c-shell-0.1.0",
      model_config_hash: "provider-not-bound",
    },
    seed: 42,
  })
  if (!spec.ok) throw new Error(spec.errors.join("; "))
  return { pack, path, spec }
}

describe("role C intake contracts", () => {
  test("normalizes A rag_result and builds a frozen K007/K009/K018 GenerationSpec", async () => {
    const { pack, spec } = await buildGoldenContext()
    expect(pack.match_status).toBe("strong")
    expect(pack.results.map((item) => item.source_id)).toEqual(expect.arrayContaining(["K007", "K009", "K018"]))
    expect(spec.spec.policies.external_knowledge_allowed).toBe(false)
    expect(spec.spec.targets.map((target) => target.objective_id)).toEqual(["O1", "O2", "O3"])
    expect(spec.spec.evidence_ref).toBe(pack.retrieval_id)
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
      versions: { prompt_version: "c-shell-0.1.0", model_config_hash: "none" },
    })
    expect(noMatchBuild.ok).toBe(false)
    if (!noMatchBuild.ok) {
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
    })
    const weakBuild = buildGenerationSpec({
      run_id: "RUN-WEAK",
      profile_snapshot: snapshot,
      path_node: weakPath,
      evidence_pack: weakPack,
      versions: { prompt_version: "c-shell-0.1.0", model_config_hash: "none" },
    })
    expect(weakBuild.ok).toBe(false)
    if (!weakBuild.ok) expect(weakBuild.code).toBe("WEAK_EVIDENCE")
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
      async put(artifact) {
        stored.push(artifact)
        return `secure://${artifact.artifact_id}`
      },
    }
    const result = await runCPipeline(
      { generation_spec: spec.spec, evidence_pack: pack },
      createRoleCAgents(provider),
      store,
    )
    expect(result.status).toBe("ready")
    expect(result.state).toBe("READY")
    expect(result.secure_refs).toHaveLength(2)
    expect(stored.map((artifact) => artifact.artifact_type)).toEqual(["code_lab_secure", "assessment_secure"])
    expect(JSON.stringify(result.public_artifacts)).not.toContain("reference_solution")
    expect(JSON.stringify(result.public_artifacts)).not.toContain("hidden_tests")
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
      createRoleCAgents(fixtureProvider(objectiveIds, citations)),
      { async put() { throw new Error("secure store offline") } },
    )
    expect(result.status).toBe("failed")
    expect(result.state).toBe("FAILED")
    expect(result.failure_reason?.code).toBe("SECURE_STORE_ERROR")
    expect(result.secure_refs).toEqual([])
  })
})

describe("role C published integration assets", () => {
  test("ships parseable schemas for every external C message and core artifact", async () => {
    const files = (await readdir("schemas/role-c-content")).filter((file) => file.endsWith(".schema.json")).sort()
    expect(files).toEqual([
      "agent_trace_event.schema.json",
      "artifact_envelope.schema.json",
      "assessment_public.schema.json",
      "assessment_secure.schema.json",
      "code_lab_public.schema.json",
      "code_lab_secure.schema.json",
      "concept_artifact.schema.json",
      "evidence_gap_request.schema.json",
      "fact_audit_packet.schema.json",
      "generation_spec.schema.json",
      "grade_result.schema.json",
      "learner_profile_snapshot.schema.json",
      "learning_evidence_event.schema.json",
      "learning_path_node.schema.json",
      "profile_drift_suggestion.schema.json",
      "rag_evidence_pack.schema.json",
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
  })

  test("gives all three public workers distinct C-shell role prompts", () => {
    for (const name of ["concept-tutor", "code-lab", "tiered-evaluator"] as const) {
      const definition = WORKER_DEFINITIONS.find((worker) => worker.name === name)!
      const prompt = buildWorkerStubPrompt(definition)
      expect(prompt).toContain("c-shell-0.1.0")
      expect(prompt).toContain("generation_spec")
      expect(prompt).toContain("evidence_pack")
      expect(prompt).toContain("rag_result")
      expect(prompt).toContain(`[executed:${name}]`)
    }
    const labPrompt = buildWorkerStubPrompt(WORKER_DEFINITIONS.find((worker) => worker.name === "code-lab")!)
    expect(labPrompt).toContain("reference_solution")
    expect(labPrompt).toContain("BLOCKED_EXECUTION_UNVERIFIED")
  })
})

function fixtureProvider(
  objectiveIds: string[],
  citations: Array<{ source_id: string; fact_id: string; relation: "supports" }>,
): RoleCContentProvider {
  const baseDraft = <T>(payload: T): ArtifactDraft<T> => ({
    payload,
    citations,
    factual_claim_count: citations.length,
    cited_claim_count: citations.length,
  })
  return {
    async generateConceptLesson(): Promise<ArtifactDraft<ConceptLessonPayload>> {
      return baseDraft({
        title: "循环、列表与成绩统计",
        objective_ids: objectiveIds,
        prerequisite_bridge: [], explanation_blocks: [], worked_examples: [], misconceptions: [],
        micro_checks: [], hint_ladders: [], summary: [], objective_coverage: [], used_evidence: citations,
      })
    },
    async generateCodeLab(): Promise<CodeLabDraft> {
      return {
        public_draft: baseDraft({
          lab_id: "LAB-01", title: "成绩统计实验", objective_ids: objectiveIds, instructions: [],
          execution_contract: {
            language: "python", execution_mode: "function", entry_point: "average_score", allowed_imports: [],
            input_contract: { type: "list[number]", constraints: ["length >= 1"] },
            output_contract: { type: "number" },
            resource_limits: { timeout_ms: 2000, memory_mb: 128, max_output_bytes: 20000 },
          },
          starter_code: "def average_score(scores):\n    pass", public_tests: [], hint_ladders: [],
          reflection_questions: [], used_evidence: citations,
        }),
        secure_draft: baseDraft({
          lab_id: "LAB-01", reference_solution: "def average_score(scores): return sum(scores) / len(scores)",
          hidden_tests: [], scoring_groups: [], misconception_map: [],
        }),
        execution_verified: true,
      }
    },
    async generateAssessment(): Promise<AssessmentDraft> {
      return {
        public_draft: baseDraft({
          form_id: "FORM-01", title: "分层测评", objective_ids: objectiveIds, items: [],
          submission_policy: { max_attempts: 2, formative: true },
        }),
        secure_draft: baseDraft({ form_id: "FORM-01", items: [], option_order_seed: 42 }),
        answer_key_verified: true,
      }
    },
  }
}
