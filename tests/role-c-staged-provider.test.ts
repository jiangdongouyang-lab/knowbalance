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
  buildCodeLabObjectivePlan,
  buildCodeLabSecurePlan,
  buildLabIdentity,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  DeterministicConceptContentProvider,
  generateConceptLesson,
  ModelBackedRoleCContentProvider,
  normalizeAssessmentPair,
  normalizeCodeLabSecure,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  splitConceptRequest,
  validateAssessmentDraftStructure,
  validateAssessmentSecureAgainstPublic,
  validateCodeLabDraftStructure,
  validateCodeLabPublicAuthorAgainstPlan,
  validateConceptLesson,
  type AssessmentDraft,
  type AssessmentPublicPayload,
  type CodeLabDraft,
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
    assessmentDraft.public_draft.payload.items[3]!.citations =
      structuredClone(assessmentDraft.public_draft.payload.items[0]!.citations)
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
    for (const item of assessment.public_draft.payload.items) {
      const target = context.spec.targets.find(
        (entry) => entry.objective_id === item.objective_id,
      )!
      expect(item.citations).toEqual(target.required_fact_ids.map((factId) => ({
        source_id: target.source_id,
        fact_id: factId,
        relation: "derived_from",
      })))
    }
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

  test("binds external review rounds into both public and secure model calls", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready" || !conceptArtifact.payload) throw new Error("fixture concept 未 ready")
    const baseLabRequest = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const baseAssessmentRequest = {
      ...baseLabRequest,
      code_lab_summary: {
        lab_id: "FIXTURE-LAB",
        objective_ids: conceptArtifact.payload.objective_ids,
        execution_verified: true,
      },
    }
    const labDraft = await deterministic.generateCodeLab(baseLabRequest)
    const assessmentDraft = await deterministic.generateAssessment(baseAssessmentRequest)
    const gateway = new StagedFixtureGateway(new Map(), labDraft, assessmentDraft)
    const provider = new ModelBackedRoleCContentProvider(gateway, { max_repair_attempts: 0 })

    for (const external_revision_round of [1, 2] as const) {
      await provider.generateCodeLab({ ...baseLabRequest, external_revision_round })
      await provider.generateAssessment({ ...baseAssessmentRequest, external_revision_round })
    }

    for (const task of ["role-c.code-lab.secure", "role-c.tiered-evaluator.secure"]) {
      const requests = gateway.requests.filter((request) => request.task === task)
      expect(requests).toHaveLength(2)
      expect((requests[0]!.input as { external_revision_round?: number }).external_revision_round).toBe(1)
      expect((requests[1]!.input as { external_revision_round?: number }).external_revision_round).toBe(2)
      expect(requests[0]!.idempotency_key).not.toBe(requests[1]!.idempotency_key)
    }
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

  test("uses a free blueprint slot to select a modality that measures the core behavior", async () => {
    const context = await buildContext()
    const spec = structuredClone(context.spec)
    spec.targets = [{
      ...spec.targets[0]!,
      observable_behavior: "explain",
    }]
    spec.path_node.target_source_ids = [spec.targets[0]!.source_id]
    spec.assessment_blueprint = {
      tier_1_count: 1,
      tier_2_count: 0,
      tier_3_count: 0,
      required_modalities: [],
    }
    const plan = buildAssessmentItemPlan(spec)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({
      objective_id: spec.targets[0]!.objective_id,
      modality: "short_answer",
    })
  })

  test("fills missing choice diagnostic labels without changing the authored correct answer", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready" || !conceptArtifact.payload) throw new Error("fixture concept 未 ready")
    const assessmentRequest = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const draft = await deterministic.generateAssessment(assessmentRequest)
    const choiceIndex = draft.public_draft.payload.items.findIndex((item) =>
      item.modality === "mcq" || item.modality === "true_false")
    const secureChoice = draft.secure_draft.payload.items[choiceIndex]!
    const correctOptionId = secureChoice.correct_option_id!
    secureChoice.misconception_by_option = {}
    draft.secure_draft.payload.code_test_suites.forEach((suite) => {
      if (suite.execution_contract.execution_mode !== "function") return
      suite.hidden_tests.forEach((test) => {
        test.input = asInvocationEnvelope(test.input)
      })
    })

    expect(validateAssessmentSecureAgainstPublic(
      draft.secure_draft.payload,
      draft.public_draft.payload,
    )).toEqual([])
    const normalized = normalizeAssessmentPair(
      context.spec,
      draft.public_draft.payload,
      draft.secure_draft.payload,
    )
    const normalizedChoice = normalized.secure_payload.items[choiceIndex]!
    expect(normalizedChoice.correct_option_id).toBe(correctOptionId)
    const wrongOptionIds = normalized.public_payload.items[choiceIndex]!.options!
      .map((option) => option.option_id)
      .filter((optionId) => optionId !== correctOptionId)
    expect(Object.keys(normalizedChoice.misconception_by_option).sort()).toEqual(
      wrongOptionIds.sort(),
    )
    expect(Object.values(normalizedChoice.misconception_by_option).every(Boolean)).toBe(true)
  })

  test("requires every frozen fact for each objective across lab and assessment", async () => {
    const context = await buildContext()
    const spec = structuredClone(context.spec)
    for (const target of spec.targets) {
      const source = context.pack.results.find((item) =>
        item.source_id === target.source_id)!
      target.required_fact_ids = source.facts.map((fact) => fact.fact_id)
    }
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptRequest = {
      generation_spec: spec,
      evidence_pack: context.pack,
    }
    const concept = await generateConceptLesson(conceptRequest, deterministic)
    if (concept.status !== "ready") throw new Error("fixture concept 未 ready")
    const labRequest = { ...conceptRequest, concept_artifact: concept }
    const lab = await deterministic.generateCodeLab(labRequest)
    const assessment = await deterministic.generateAssessment(labRequest)

    expect(validateCodeLabDraftStructure(labRequest, lab).ok).toBe(true)
    expect(validateAssessmentDraftStructure(labRequest, assessment).ok).toBe(true)
    for (const target of spec.targets) {
      const labFacts = new Set(lab.public_draft.payload.instructions
        .flatMap((block) => "claims" in block ? block.claims : [])
        .flatMap((claim) => claim.citations)
        .filter((citation) => citation.source_id === target.source_id)
        .map((citation) => citation.fact_id))
      const assessmentFacts = new Set(assessment.public_draft.payload.items
        .filter((item) => item.objective_id === target.objective_id)
        .flatMap((item) => item.citations)
        .filter((citation) => citation.source_id === target.source_id)
        .map((citation) => citation.fact_id))
      expect([...labFacts].sort()).toEqual([...target.required_fact_ids].sort())
      expect([...assessmentFacts].sort()).toEqual([...target.required_fact_ids].sort())
    }
  })

  test("does not invoke repair for mutation-only diagnostics", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const prior = await deterministic.generateCodeLab(request)
    if (prior.public_draft.payload.execution_contract.execution_mode === "function") {
      prior.secure_draft.payload.hidden_tests.forEach((test) => {
        test.input = asInvocationEnvelope(test.input)
      })
    }
    const identity = buildLabIdentity(context.spec)
    prior.secure_draft.payload = normalizeCodeLabSecure(
      context.spec,
      prior.secure_draft.payload,
      prior.public_draft.payload,
      identity.test_suite_id,
      buildCodeLabSecurePlan(context.spec, identity.test_suite_id),
    )
    const mutation = prior.secure_draft.payload.mutation_variants[0]!
    const gateway = new ExecutionRepairGateway(prior)
    const provider = new ModelBackedRoleCContentProvider(gateway, {
      max_repair_attempts: 1,
    })

    const repaired = await provider.repairCodeLabAfterVerification(
      request,
      prior,
      {
        revision_round: 1,
        issues: [`mutation ${mutation.mutation_id} 未被指定隐藏测试杀死`],
        reference_failed: false,
        reference_failure_codes: [],
        starter_status: "failed",
        failed_mutations: [{
          mutation_id: mutation.mutation_id,
          status: "passed",
          failure_codes: [],
          must_fail_test_ids: [...mutation.must_fail_test_ids],
        }],
      },
    )

    expect(gateway.requests).toHaveLength(0)
    expect(repaired.public_draft.payload).toEqual(prior.public_draft.payload)
    expect(repaired.secure_draft.payload.mutation_variants[0]!.code).toBe(mutation.code)
    expect(validateCodeLabDraftStructure(request, repaired).ok).toBe(true)
  })

  test("accepts a failed-reference repair that corrects the failing hidden test instead of rewriting valid code", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const prior = await deterministic.generateCodeLab(request)
    if (prior.public_draft.payload.execution_contract.execution_mode === "function") {
      prior.secure_draft.payload.hidden_tests.forEach((test) => {
        test.input = asInvocationEnvelope(test.input)
      })
    }
    const identity = buildLabIdentity(context.spec)
    prior.secure_draft.payload = normalizeCodeLabSecure(
      context.spec,
      prior.secure_draft.payload,
      prior.public_draft.payload,
      identity.test_suite_id,
      buildCodeLabSecurePlan(context.spec, identity.test_suite_id),
    )
    const failedTest = prior.secure_draft.payload.hidden_tests[0]!
    const gateway = new ExecutionRepairGateway(prior)
    const provider = new ModelBackedRoleCContentProvider(gateway, {
      max_repair_attempts: 0,
    })

    const repaired = await provider.repairCodeLabAfterVerification(
      request,
      prior,
      {
        revision_round: 1,
        issues: [`reference_solution 未通过全部隐藏测试：${failedTest.test_id}:assertion_failed`],
        reference_failed: true,
        reference_failure_codes: [`${failedTest.test_id}:assertion_failed`],
        starter_status: "failed",
        failed_mutations: [],
      },
    )

    expect(repaired.secure_draft.payload.reference_solution).toBe(
      prior.secure_draft.payload.reference_solution,
    )
    expect(repaired.secure_draft.payload.hidden_tests[0]!.expected).not.toEqual(
      failedTest.expected,
    )
    expect(validateCodeLabDraftStructure(request, repaired).ok).toBe(true)
  })

  test("keeps assessment execution repair on the compact secure author contract", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(
      context.conceptRequest,
      deterministic,
    )
    if (conceptArtifact.status !== "ready") {
      throw new Error("fixture concept 未 ready")
    }
    const request = {
      ...context.conceptRequest,
      concept_artifact: conceptArtifact,
    }
    const prior = await deterministic.generateAssessment(request)
    const gateway = new AssessmentExecutionRepairGateway(prior)
    const provider = new ModelBackedRoleCContentProvider(gateway, {
      max_repair_attempts: 0,
    })

    const repaired = await provider.repairAssessmentAfterVerification(
      request,
      prior,
      {
        revision_round: 1,
        issues: ["代码题参考实现未通过全部隐藏测试"],
      },
    )

    expect(gateway.requests).toHaveLength(1)
    expect(gateway.requests[0]!.output_schema_id)
      .toBe("role_c_assessment_secure_author_payload_v1")
    expect(validateAssessmentDraftStructure(request, repaired).ok).toBe(true)
    expect(repaired.secure_draft.payload.code_test_suites[0]!
      .hidden_tests[0]!.expected).toBe("normalized stdout\n")
  })

  test("repairs an answer-complete public starter before trusted execution without exposing secure material", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const leaked = await deterministic.generateCodeLab(request)
    leaked.public_draft.payload.starter_code =
      `${leaked.secure_draft.payload.reference_solution}\n# TODO: learner should rewrite this`
    const entryPoint = leaked.public_draft.payload.execution_contract.entry_point
      ?? "solution"
    const repairedStarter = `def ${entryPoint}(*args, **kwargs):\n    raise RuntimeError("TODO: implement")`
    const gateway = new StagedFixtureGateway(
      new Map(),
      leaked,
      undefined,
      false,
      repairedStarter,
    )
    const provider = new ModelBackedRoleCContentProvider(gateway, {
      max_repair_attempts: 0,
    })

    const draft = await provider.generateCodeLab(request)

    expect(gateway.tasks).toEqual([
      "role-c.code-lab.public",
      "role-c.code-lab.secure",
      "role-c.code-lab.public.safety-repair",
    ])
    expect(draft.public_draft.payload.starter_code).toBe(repairedStarter)
    expect(validateCodeLabDraftStructure(request, draft).ok).toBe(true)
    const repairRequest = gateway.requests.at(-1)!
    const repairInput = repairRequest.input as Record<string, unknown>
    expect(repairInput).not.toHaveProperty("prior_secure_payload")
    expect(JSON.stringify(repairInput)).not.toContain("hidden_tests")
    expect(JSON.stringify(repairInput)).not.toContain("mutation_variants")
  })

  test("uses a target-agnostic safe public draft when the model repeats a leaking repair", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const leaked = await deterministic.generateCodeLab(request)
    leaked.public_draft.payload.starter_code = leaked.secure_draft.payload.reference_solution
    const gateway = new StagedFixtureGateway(
      new Map(),
      leaked,
      undefined,
      false,
      undefined,
      true,
    )
    const provider = new ModelBackedRoleCContentProvider(gateway, {
      max_repair_attempts: 0,
    })

    const draft = await provider.generateCodeLab(request)

    expect(gateway.tasks).toContain("role-c.code-lab.public.safety-repair")
    expect(draft.public_draft.payload.starter_code).toContain("NotImplementedError")
    expect(validateCodeLabDraftStructure(request, draft).ok).toBe(true)
  })

  test("rejects function contracts that describe stdout as the graded result", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const draft = await deterministic.generateCodeLab(request)
    const author = adaptCodeLabPublicAuthorFixture(draft.public_draft.payload)
    author.execution_contract.execution_mode = "function"
    author.execution_contract.output_contract = {
      type: "None",
      constraints: ["通过标准输出打印结果"],
    }

    const issues = validateCodeLabPublicAuthorAgainstPlan(
      author,
      buildCodeLabObjectivePlan(context.spec),
    )

    expect(issues.some((issue) => issue.includes("function 模式只校验")))
      .toBe(true)
  })

  test("normalizes a model-authored stdout task to the executable stdin/stdout contract", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const fixture = await deterministic.generateCodeLab(request)
    fixture.public_draft.payload.execution_contract.execution_mode = "function"
    fixture.public_draft.payload.execution_contract.output_contract = {
      type: "None",
      constraints: ["通过标准输出打印结果"],
    }
    fixture.public_draft.payload.instructions.forEach((block) => {
      if ("text" in block) block.text = `${block.text}，并打印结果。`
    })
    fixture.secure_draft.payload.execution_contract.execution_mode = "stdin_stdout"
    delete fixture.secure_draft.payload.execution_contract.entry_point
    fixture.secure_draft.payload.execution_contract.output_contract = {
      type: "stdout text",
      constraints: ["精确标准输出"],
    }
    fixture.secure_draft.payload.reference_solution = "def show_result():\n    return 3\n"
    fixture.secure_draft.payload.hidden_tests.forEach((test) => {
      test.input = ""
      test.expected = "3"
      test.comparison = { kind: "exact" }
    })
    fixture.secure_draft.payload.mutation_variants.forEach((mutation) => {
      mutation.code = "print(4)\n"
    })
    const provider = new ModelBackedRoleCContentProvider(
      new StagedFixtureGateway(new Map(), fixture),
      { max_repair_attempts: 0 },
    )

    const draft = await provider.generateCodeLab(request)

    expect(draft.public_draft.payload.execution_contract.execution_mode)
      .toBe("stdin_stdout")
    expect(draft.public_draft.payload.execution_contract.entry_point)
      .toBeUndefined()
    expect(draft.public_draft.payload.public_tests.every((test) =>
      typeof test.input === "string")).toBe(true)
    expect(draft.secure_draft.payload.hidden_tests.every((test) =>
      test.expected === "3\n")).toBe(true)
    expect(draft.secure_draft.payload.reference_solution)
      .toContain("print(show_result())")
    expect(validateCodeLabDraftStructure(request, draft).ok).toBe(true)
  })

  test("wraps a zero-input script in the declared function entry point", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const fixture = await deterministic.generateCodeLab(request)
    const entryPoint = fixture.public_draft.payload.execution_contract.entry_point!
    fixture.public_draft.payload.execution_contract.input_contract = {
      type: "none",
      constraints: [],
    }
    fixture.public_draft.payload.execution_contract.output_contract = {
      type: "integer",
      constraints: ["返回最终变量值"],
    }
    fixture.secure_draft.payload.reference_solution = "score = 10\nscore = score + 5\n"
    fixture.secure_draft.payload.hidden_tests.forEach((test) => {
      test.input = { args: [], kwargs: {} }
      test.expected = 15
      test.comparison = { kind: "exact" }
    })
    const provider = new ModelBackedRoleCContentProvider(
      new StagedFixtureGateway(new Map(), fixture),
      { max_repair_attempts: 0 },
    )

    const draft = await provider.generateCodeLab(request)

    expect(draft.secure_draft.payload.reference_solution)
      .toContain(`def ${entryPoint}():`)
    expect(draft.secure_draft.payload.reference_solution)
      .toContain("return score")
    expect(validateCodeLabDraftStructure(request, draft).ok).toBe(true)
  })

  test("replaces an unsafe model-authored starter with a runnable TODO skeleton", async () => {
    const context = await buildContext()
    const deterministic = new DeterministicCodeLabContentProvider()
    const conceptArtifact = await generateConceptLesson(context.conceptRequest, deterministic)
    if (conceptArtifact.status !== "ready") throw new Error("fixture concept 未 ready")
    const request = { ...context.conceptRequest, concept_artifact: conceptArtifact }
    const fixture = await deterministic.generateCodeLab(request)
    fixture.public_draft.payload.starter_code = "import sys\nprint(sys.stdin.read())\n"
    fixture.public_draft.payload.execution_contract.allowed_imports = []
    const provider = new ModelBackedRoleCContentProvider(
      new StagedFixtureGateway(new Map(), fixture),
      { max_repair_attempts: 0 },
    )

    const draft = await provider.generateCodeLab(request)

    expect(draft.public_draft.payload.starter_code).toContain("NotImplementedError")
    expect(draft.public_draft.payload.starter_code).not.toContain("import sys")
    expect(validateCodeLabDraftStructure(request, draft).ok).toBe(true)
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
  readonly requests: Array<Parameters<ModelGateway["generateStructured"]>[0]> = []
  maxActiveConceptCalls = 0
  private activeConceptCalls = 0
  private readonly conceptAttempts = new Map<string, number>()

  constructor(
    private readonly concepts: Map<string, ConceptLessonPayload>,
    private readonly lab?: Awaited<ReturnType<DeterministicCodeLabContentProvider["generateCodeLab"]>>,
    private readonly assessment?: AssessmentDraft,
    private readonly invalidateFirstConceptAttempt = false,
    private readonly starterRepairCode?: string,
    private readonly unchangedSafetyRepair = false,
  ) {}

  async generateStructured<T>(request: Parameters<ModelGateway["generateStructured"]>[0]): Promise<T> {
    this.tasks.push(request.task)
    this.requests.push(structuredClone(request))
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
      if (this.invalidateFirstConceptAttempt && attempt === 1) return {} as T
      return adaptConceptAuthorFixture(output) as T
    }
    if (request.task === "role-c.code-lab.public" && this.lab) {
      const payload = structuredClone(this.lab.public_draft.payload)
      if (payload.execution_contract.execution_mode === "function") {
        payload.public_tests.forEach((test) => {
          test.input = asInvocationEnvelope(test.input)
        })
      }
      return adaptCodeLabPublicAuthorFixture(payload) as T
    }
    if (request.task === "role-c.code-lab.secure" && this.lab) {
      const input = request.input as {
        staged_contract: {
          objective_plan: {
            hidden_tests: Array<{ test_id: string; objective_id: string; case_kind?: string; weight: number }>
            mutation_variants: Array<{ mutation_id: string; objective_ids: string[]; must_fail_test_ids: string[] }>
          }
        }
      }
      const secure = adaptCodeLabSecureFixture(
        this.lab.secure_draft.payload,
        input.staged_contract.objective_plan,
      )
      const misconceptionByTest = new Map(secure.misconception_map.map((entry) => [
        entry.failed_test_id,
        entry.misconception_tag,
      ]))
      return {
        reference_solution: secure.reference_solution,
        hidden_tests: secure.hidden_tests.map((test) => ({
          input: structuredClone(test.input),
          expected: structuredClone(test.expected),
          comparison: structuredClone(test.comparison),
          misconception_tag: misconceptionByTest.get(test.test_id) ?? "incorrect_behavior",
        })),
        mutation_variants: secure.mutation_variants.map((mutation) => ({
          code: mutation.code,
          misconception_tag: mutation.misconception_tag,
        })),
      } as T
    }
    if (request.task === "role-c.code-lab.public.starter-repair"
      && this.starterRepairCode) {
      return { starter_code: this.starterRepairCode } as T
    }
    if (request.task === "role-c.code-lab.public.safety-repair"
      && (this.starterRepairCode || this.unchangedSafetyRepair)) {
      const input = request.input as {
        public_payload: CodeLabDraft["public_draft"]["payload"]
      }
      if (this.unchangedSafetyRepair) {
        return {
          starter_code: input.public_payload.starter_code,
          instruction_texts: input.public_payload.instructions.map((block) =>
            "text" in block ? block.text : block.block_type),
          public_test_descriptions: input.public_payload.public_tests.map((test) =>
            test.description),
          public_test_expected_behaviors: input.public_payload.public_tests.map((test) =>
            test.expected_behavior),
          hint_texts: input.public_payload.hint_ladders.map((ladder) =>
            ladder.hints.map((hint) => hint.text)),
          reflection_questions: [...input.public_payload.reflection_questions],
        } as T
      }
      return {
        starter_code: this.starterRepairCode!,
        instruction_texts: input.public_payload.instructions.map(() =>
          "按任务合同组织输入、处理中间状态并返回结果，核心实现留给学习者。"),
        public_test_descriptions: input.public_payload.public_tests.map(() =>
          "检查公开输入下的可观察结果是否符合任务合同。"),
        public_test_expected_behaviors: input.public_payload.public_tests.map(() =>
          "返回值应满足题目声明的输出约束。"),
        hint_texts: input.public_payload.hint_ladders.map(() => [
          "先确认入口参数和返回目标。",
          "把计算拆成输入、处理和返回三个步骤。",
          "检查边界输入，但保留核心表达式由你完成。",
        ]),
        reflection_questions: ["你的实现如何满足输入与输出合同？"],
      } as T
    }
    if (request.task === "role-c.tiered-evaluator.public" && this.assessment) {
      return adaptAssessmentPublicAuthorFixture(
        this.assessment.public_draft.payload,
      ) as T
    }
    if (request.task === "role-c.tiered-evaluator.secure" && this.assessment) {
      const input = request.input as { public_payload: AssessmentPublicPayload }
      const secure = adaptAssessmentSecureFixture(this.assessment, input.public_payload)
      return assessmentSecureAuthorFixture(secure) as T
    }
    throw new Error(`unexpected staged task ${request.task}`)
  }
}

function adaptAssessmentPublicAuthorFixture(
  payload: AssessmentPublicPayload,
) {
  return {
    title: payload.title,
    items: payload.items.map((item) => ({
      prompt: item.prompt,
      options: item.options?.map((option) => option.text) ?? null,
      starter_code: item.starter_code ?? null,
    })),
  }
}

function adaptConceptAuthorFixture(payload: ConceptLessonPayload) {
  return {
    title: payload.title,
    objectives: payload.objective_ids.map((objectiveId, index) => {
      const misconception = payload.misconceptions.find((entry) =>
        entry.objective_id === objectiveId)
      const ladder = payload.hint_ladders.find((entry) =>
        entry.objective_id === objectiveId)
      const check = payload.micro_checks[index % payload.micro_checks.length]!
      return {
        explanation: renderedBlockText(
          payload.explanation_blocks[index % payload.explanation_blocks.length]!,
        ),
        worked_example: renderedBlockText(
          payload.worked_examples[index % payload.worked_examples.length]!,
        ),
        misconception: misconception?.explanation ?? "检查对该目标的常见误解。",
        micro_check_prompt: check.prompt,
        micro_check_options: check.options?.map((option) => option.text)
          ?? ["能够满足当前事实", "不能满足当前事实"],
        hints: ladder?.hints.map((hint) => hint.text)
          ?? ["先定位目标事实", "将事实用于步骤", "检查结果是否满足目标"],
        summary: renderedBlockText(
          payload.summary[index % payload.summary.length]!,
        ),
      }
    }),
  }
}

function adaptCodeLabPublicAuthorFixture(
  payload: CodeLabDraft["public_draft"]["payload"],
) {
  return {
    title: payload.title,
    execution_contract: structuredClone(payload.execution_contract),
    starter_code: payload.starter_code,
    objectives: payload.objective_ids.map((objectiveId, index) => ({
      instruction_text: renderedBlockText(
        payload.instructions[index % payload.instructions.length]!,
      ),
      public_test: {
        description: payload.public_tests[index % payload.public_tests.length]!.description,
        input: structuredClone(
          payload.public_tests[index % payload.public_tests.length]!.input,
        ),
        expected_behavior:
          payload.public_tests[index % payload.public_tests.length]!.expected_behavior,
      },
      hints: payload.hint_ladders[index % payload.hint_ladders.length]!.hints
        .map((hint) => hint.text),
      reflection_question: payload.reflection_questions[
        index % payload.reflection_questions.length
      ]!,
    })),
  }
}

function renderedBlockText(block: ConceptLessonPayload["explanation_blocks"][number]): string {
  if (block.block_type === "heading") return block.text
  if (block.block_type === "paragraph" || block.block_type === "callout") {
    return block.text
  }
  if (block.block_type === "comparison") {
    return `${block.title}：${block.columns.map((column) =>
      `${column.heading} ${column.content}`).join("；")}`
  }
  if (block.block_type === "code") return block.caption || block.code
  if (block.block_type === "quiz") return block.prompt
  if (block.block_type === "hint") return block.text
  return "围绕当前目标完成练习。"
}

class ExecutionRepairGateway implements ModelGateway {
  readonly model_id = "execution-repair-fixture"
  readonly model_config_hash = MODEL_HASH
  readonly requests: Array<Parameters<ModelGateway["generateStructured"]>[0]> = []

  constructor(private readonly prior: CodeLabDraft) {}

  async generateStructured<T>(request: Parameters<ModelGateway["generateStructured"]>[0]): Promise<T> {
    this.requests.push(structuredClone(request))
    if (request.task !== "role-c.code-lab.secure.execution-repair") {
      throw new Error(`unexpected task ${request.task}`)
    }
    const failed = this.prior.secure_draft.payload.hidden_tests[0]!
    return {
      reference_solution: null,
      hidden_test_repairs: [{
        test_id: failed.test_id,
        input: structuredClone(failed.input),
        expected: { repaired_expected: true },
        comparison: structuredClone(failed.comparison),
      }],
      mutation_repairs: [],
    } as T
  }
}

class AssessmentExecutionRepairGateway implements ModelGateway {
  readonly model_id = "assessment-execution-repair-fixture"
  readonly model_config_hash = MODEL_HASH
  readonly requests: Array<Parameters<ModelGateway["generateStructured"]>[0]> = []

  constructor(private readonly prior: AssessmentDraft) {}

  async generateStructured<T>(request: Parameters<ModelGateway["generateStructured"]>[0]): Promise<T> {
    this.requests.push(structuredClone(request))
    if (request.task !== "role-c.tiered-evaluator.secure.execution-repair") {
      throw new Error(`unexpected task ${request.task}`)
    }
    const input = request.input as { public_payload: AssessmentPublicPayload }
    const secure = adaptAssessmentSecureFixture(
      this.prior,
      input.public_payload,
    )
    const authored = assessmentSecureAuthorFixture(secure)
    const codeIndex = input.public_payload.items.findIndex((item) =>
      item.modality === "code")
    if (codeIndex >= 0) {
      authored.items[codeIndex]!.answer_spec = {
        kind: "code",
        test_suite_id: "MODEL_OWNED_REDUNDANT_ID",
      }
      authored.code_test_suites.forEach((suite) => {
        suite.execution_contract.execution_mode = "stdin_stdout"
        delete suite.execution_contract.entry_point
        suite.execution_contract.output_contract = {
          type: "string",
          constraints: ["精确标准输出"],
        }
        suite.reference_solution = "print(\"normalized stdout\")"
        suite.hidden_tests.forEach((test) => {
          test.input = ""
          test.expected = "normalized stdout"
          test.comparison = { kind: "exact" }
        })
      })
    }
    return authored as T
  }
}

function adaptCodeLabSecureFixture(
  source: Awaited<ReturnType<DeterministicCodeLabContentProvider["generateCodeLab"]>>["secure_draft"]["payload"],
  plan: {
    hidden_tests: Array<{ test_id: string; objective_id: string; case_kind?: string; weight: number }>
    mutation_variants: Array<{ mutation_id: string; objective_ids: string[]; must_fail_test_ids: string[] }>
  },
) {
  const secure = structuredClone(source)
  secure.hidden_tests = plan.hidden_tests.map((entry, index) => {
    const { case_kind: _caseKind, ...identity } = entry
    return {
      ...structuredClone(source.hidden_tests[index % source.hidden_tests.length]!),
      ...identity,
      input: asInvocationEnvelope(source.hidden_tests[index % source.hidden_tests.length]!.input),
    }
  })
  secure.mutation_variants = plan.mutation_variants.map((entry, index) => ({
    ...structuredClone(source.mutation_variants[index % source.mutation_variants.length]!),
    ...structuredClone(entry),
  }))
  secure.misconception_map = secure.hidden_tests.map((test, index) => ({
    failed_test_id: test.test_id,
    misconception_tag: secure.mutation_variants.find((mutation) =>
      mutation.objective_ids.includes(test.objective_id))?.misconception_tag
      ?? source.misconception_map[index % source.misconception_map.length]!.misconception_tag,
  }))
  return secure
}

function adaptAssessmentSecureFixture(
  draft: AssessmentDraft,
  publicPayload: AssessmentPublicPayload,
): AssessmentDraft["secure_draft"]["payload"] {
  const secure = structuredClone(draft.secure_draft.payload)
  secure.code_test_suites.forEach((suite) => {
    if (suite.execution_contract.execution_mode !== "function") return
    suite.hidden_tests.forEach((test) => {
      test.input = asInvocationEnvelope(test.input)
    })
  })
  secure.items.forEach((item, index) => {
    const oldPublic = draft.public_draft.payload.items[index]
    const newPublic = publicPayload.items[index]
    item.item_id = newPublic.item_id
    item.objective_id = newPublic.objective_id
    item.tier = newPublic.tier
    item.modality = newPublic.modality
    item.max_score = newPublic.max_score
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

function assessmentSecureAuthorFixture(
  secure: AssessmentDraft["secure_draft"]["payload"],
) {
  return {
    items: secure.items.map((item) => ({
      answer_spec: item.modality === "mcq"
        || item.modality === "true_false"
        || item.modality === "code"
        ? null
        : structuredClone(item.answer_spec),
      correct_option_id: item.correct_option_id ?? null,
      misconception_by_option: structuredClone(item.misconception_by_option),
    })),
    code_test_suites: secure.code_test_suites.map((suite) => ({
      execution_contract: structuredClone(suite.execution_contract),
      reference_solution: suite.reference_solution,
      hidden_tests: suite.hidden_tests.map((test) => ({
        input: structuredClone(test.input),
        expected: structuredClone(test.expected),
        comparison: structuredClone(test.comparison),
      })),
    })),
  }
}

function asInvocationEnvelope(value: unknown): { args: unknown[]; kwargs?: Record<string, unknown> } {
  if (value && typeof value === "object" && !Array.isArray(value)
    && Array.isArray((value as { args?: unknown }).args)) {
    return structuredClone(value) as { args: unknown[]; kwargs?: Record<string, unknown> }
  }
  return { args: [structuredClone(value)] }
}
