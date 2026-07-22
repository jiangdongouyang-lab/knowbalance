import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { retrieveKnowledge } from "../src/rag/retriever"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  buildAssessmentItemPlan,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  DeterministicConceptContentProvider,
  generateConceptLesson,
  ModelBackedRoleCContentProvider,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  splitConceptRequest,
  validateAssessmentDraftStructure,
  validateCodeLabDraftStructure,
  validateConceptLesson,
  type AssessmentDraft,
  type AssessmentPublicPayload,
  type ConceptLessonPayload,
  type GenerationSpec,
  type ModelGateway,
  type RagEvidencePack,
} from "../src/role-c-content"

const MODEL_HASH = "MODEL-STAGED-FIXTURE-V1"

describe("role C staged model provider", () => {
  test("composes bounded concept groups and public/secure stages into the unchanged final contracts", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready" || !conceptArtifact.payload) throw new Error("fixture concept 未 ready")
    const labRequest = {
      ...context.conceptRequest,
      concept_artifact: conceptArtifact,
    }
    const assessmentRequest = {
      ...labRequest,
      code_lab_summary: { lab_id: "FIXTURE-LAB", objective_ids: conceptArtifact.payload.objective_ids, execution_verified: true },
    }
    const segments = splitConceptRequest(context.conceptRequest, 1)
    const conceptOutputs = new Map<string, ConceptLessonPayload>()
    for (const segment of segments) {
      const draft = await deterministic.generateConceptLesson(segment)
      draft.payload.objective_coverage[0].block_ids.push("NOT-A-REAL-BLOCK")
      if (segment.segment_index === 0) draft.payload.prerequisite_bridge = []
      conceptOutputs.set(segment.generation_spec.targets[0].objective_id, draft.payload)
    }
    const labDraft = await deterministic.generateCodeLab(labRequest)
    const firstInstruction = labDraft.public_draft.payload.instructions[0]
    if ("claims" in firstInstruction) firstInstruction.claims[0].text = "模型改写但程序会按 citation 冻结"
    labDraft.public_draft.payload.public_tests.forEach((entry) => { entry.objective_id = "O1" })
    labDraft.secure_draft.payload.hidden_tests.forEach((entry) => { entry.weight *= 2 })
    labDraft.secure_draft.payload.scoring_groups.forEach((entry) => { entry.weight = 0.123 })
    const assessmentDraft = await deterministic.generateAssessment(assessmentRequest)
    const gateway = new StagedFixtureGateway(conceptOutputs, labDraft, assessmentDraft)
    const provider = new ModelBackedRoleCContentProvider(gateway, {
      concept_group_size: 1,
      concept_concurrency: 2,
      max_repair_attempts: 0,
    })

    const concept = await provider.generateConceptLesson(context.conceptRequest)
    const lab = await provider.generateCodeLab(labRequest)
    const assessment = await provider.generateAssessment(assessmentRequest)

    expect(validateConceptLesson({ payload: concept.payload, spec: context.spec, evidence: context.pack }).ok).toBe(true)
    expect(validateCodeLabDraftStructure(labRequest, lab).ok).toBe(true)
    expect(validateAssessmentDraftStructure(assessmentRequest, assessment).ok).toBe(true)
    expect(concept.payload.objective_ids).toEqual(context.spec.targets.map((target) => target.objective_id))
    expect(lab.public_draft.payload.lab_id).toBe(lab.secure_draft.payload.lab_id)
    expect(assessment.public_draft.payload.form_id).toBe(assessment.secure_draft.payload.form_id)
    expect(gateway.tasks).toEqual([
      "role-c.concept-tutor.segment",
      "role-c.concept-tutor.segment",
      "role-c.concept-tutor.segment",
      "role-c.code-lab.public",
      "role-c.code-lab.secure",
      "role-c.tiered-evaluator.public",
      "role-c.tiered-evaluator.secure",
    ])
    expect(gateway.tasks).not.toContain("role-c.code-lab.generate")
    expect(gateway.maxActiveConceptCalls).toBe(2)
  })

  test("keeps concurrency disabled by default while retaining deterministic segment order", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicConceptContentProvider()
    const outputs = new Map<string, ConceptLessonPayload>()
    for (const segment of splitConceptRequest(context.conceptRequest, 1)) {
      outputs.set(
        segment.generation_spec.targets[0].objective_id,
        (await deterministic.generateConceptLesson(segment)).payload,
      )
    }
    const gateway = new StagedFixtureGateway(outputs)
    const payload = await new ModelBackedRoleCContentProvider(gateway, {
      max_repair_attempts: 0,
    }).generateConceptLesson(context.conceptRequest)

    expect(gateway.maxActiveConceptCalls).toBe(1)
    expect(payload.payload.objective_coverage.map((entry) => entry.objective_id)).toEqual(["O1", "O2", "O3"])
  })

  test("keeps bounded repair calls inside the configured concept worker limit", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicConceptContentProvider()
    const outputs = new Map<string, ConceptLessonPayload>()
    for (const segment of splitConceptRequest(context.conceptRequest, 1)) {
      outputs.set(
        segment.generation_spec.targets[0].objective_id,
        (await deterministic.generateConceptLesson(segment)).payload,
      )
    }
    const gateway = new StagedFixtureGateway(outputs, undefined, undefined, true)
    const payload = await new ModelBackedRoleCContentProvider(gateway, {
      concept_concurrency: 2,
      max_repair_attempts: 1,
    }).generateConceptLesson(context.conceptRequest)

    expect(validateConceptLesson({ payload: payload.payload, spec: context.spec, evidence: context.pack }).ok).toBe(true)
    expect(gateway.tasks).toHaveLength(6)
    expect(gateway.maxActiveConceptCalls).toBe(2)
  })

  test("builds the assessment plan from the upstream quota instead of a fixed 2/2/1 layout", async () => {
    const context = await buildContext()
    const spec = structuredClone(context.spec)
    spec.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 3,
      tier_3_count: 2,
      required_modalities: ["true_false", "short_answer", "code"],
    }
    const plan = buildAssessmentItemPlan(spec)

    expect(plan.filter((item) => item.tier === 1)).toHaveLength(1)
    expect(plan.filter((item) => item.tier === 2)).toHaveLength(3)
    expect(plan.filter((item) => item.tier === 3)).toHaveLength(2)
    expect(plan.map((item) => item.modality)).toEqual(expect.arrayContaining(["true_false", "short_answer", "code"]))
  })
})

async function buildContext(): Promise<{
  pack: RagEvidencePack
  spec: GenerationSpec
  conceptRequest: { generation_spec: GenerationSpec; evidence_pack: RagEvidencePack }
}> {
  const profile: LearnerProfile = {
    learner_id: "staged_provider_fixture",
    level: "beginner",
    known_concepts: ["变量", "条件判断"],
    weak_concepts: ["循环", "列表"],
    goal: "理解循环与列表并完成成绩统计程序",
  }
  const ragRequest = buildRagRequest(profile)
  const rag = await retrieveKnowledge({ query: ragRequest.query, learnerLevel: profile.level, topK: 5 })
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
  const built = buildGenerationSpec({
    run_id: "RUN-C-STAGED-FIXTURE",
    profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-staged-v1" }),
    path_node: path,
    evidence_pack: pack,
    versions: { prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION, model_config_hash: MODEL_HASH },
    seed: 42,
  })
  if (!built.ok) throw new Error(built.errors.join("；"))
  return {
    pack,
    spec: built.spec,
    conceptRequest: { generation_spec: built.spec, evidence_pack: pack },
  }
}

class StagedFixtureGateway implements ModelGateway {
  readonly model_id = "staged-fixture"
  readonly model_config_hash = MODEL_HASH
  readonly tasks: string[] = []
  maxActiveConceptCalls = 0
  private activeConceptCalls = 0
  private readonly conceptAttempts = new Map<string, number>()

  constructor(
    private readonly concepts: Map<string, ConceptLessonPayload>,
    private readonly lab?: Awaited<ReturnType<DeterministicCodeLabContentProvider["generateCodeLab"]>>,
    private readonly assessment?: AssessmentDraft,
    private readonly invalidateFirstConceptAttempt = false,
  ) {}

  async generateStructured<T>(request: Parameters<ModelGateway["generateStructured"]>[0]): Promise<T> {
    this.tasks.push(request.task)
    if (request.task === "role-c.concept-tutor.segment") {
      this.activeConceptCalls += 1
      this.maxActiveConceptCalls = Math.max(this.maxActiveConceptCalls, this.activeConceptCalls)
      await Bun.sleep(5)
      const input = request.input as { contract: { targets: Array<{ objective_id: string }> } }
      const objectiveId = input.contract.targets[0].objective_id
      const attempt = (this.conceptAttempts.get(objectiveId) ?? 0) + 1
      this.conceptAttempts.set(objectiveId, attempt)
      const output = this.concepts.get(objectiveId)
      this.activeConceptCalls -= 1
      if (!output) throw new Error("missing concept fixture")
      const clone = structuredClone(output)
      if (this.invalidateFirstConceptAttempt && attempt === 1) clone.title = ""
      return clone as T
    }
    if (request.task === "role-c.code-lab.public" && this.lab) {
      return structuredClone(this.lab.public_draft.payload) as T
    }
    if (request.task === "role-c.code-lab.secure" && this.lab) {
      return structuredClone(this.lab.secure_draft.payload) as T
    }
    if (request.task === "role-c.tiered-evaluator.public" && this.assessment) {
      return structuredClone(this.assessment.public_draft.payload) as T
    }
    if (request.task === "role-c.tiered-evaluator.secure" && this.assessment) {
      const input = request.input as { public_payload: AssessmentPublicPayload }
      return adaptAssessmentSecureFixture(this.assessment, input.public_payload) as T
    }
    throw new Error(`unexpected staged task ${request.task}`)
  }
}

function adaptAssessmentSecureFixture(
  draft: AssessmentDraft,
  publicPayload: AssessmentPublicPayload,
): AssessmentDraft["secure_draft"]["payload"] {
  const secure = structuredClone(draft.secure_draft.payload)
  secure.items.forEach((item, index) => {
    const oldPublic = draft.public_draft.payload.items[index]
    const newPublic = publicPayload.items[index]
    if (!oldPublic.options || !newPublic.options || !item.correct_option_id) return
    const correctText = oldPublic.options.find((option) => option.option_id === item.correct_option_id)?.text
    const correctOption = newPublic.options.find((option) => option.text === correctText)
    const oldTags = item.misconception_by_option
    item.correct_option_id = correctOption?.option_id ?? item.correct_option_id
    item.answer_spec = {
      kind: "exact_set",
      accepted: [item.correct_option_id],
      normalization: ["trim", "casefold", "unicode", "collapse_whitespace"],
    }
    item.misconception_by_option = Object.fromEntries(newPublic.options.flatMap((option) => {
      if (option.option_id === item.correct_option_id) return []
      const oldId = oldPublic.options?.find((old) => old.text === option.text)?.option_id
      return [[option.option_id, oldTags[oldId ?? ""] ?? "incorrect_option"]]
    }))
  })
  return secure
}
