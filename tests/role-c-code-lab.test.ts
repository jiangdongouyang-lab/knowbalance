import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { retrieveKnowledge } from "../src/rag/retriever"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  AtomicFileSecureArtifactStore,
  BunDockerCommandExecutor,
  buildCodeLabModelInput,
  buildGenerationSpec,
  createDockerPythonCodeRunnerFromEnv,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  DockerPythonCodeRunner,
  generateCodeLab,
  generateConceptLesson,
  ModelBackedRoleCContentProvider,
  NodeDockerCommandExecutor,
  OpenCodeConceptContentProvider,
  PLATFORM_PYTHON_IMPORT_ALLOWLIST,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  SecureArtifactStoreError,
  SecureStoreCodeTestSuiteRegistry,
  TrustedCodeLabVerifier,
  validateCodeLabDraftStructure,
  validateRoleCSchema,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeLabRequest,
  type CodeRunner,
  type DockerCommandExecutor,
  type DockerCommandRequest,
  type GenerationSpec,
  type ModelGateway,
  type RagEvidencePack,
  type RunnerTestSuite,
} from "../src/role-c-content"

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`
const profile: LearnerProfile = {
  learner_id: "lab_phase_two",
  level: "beginner",
  known_concepts: ["变量", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成成绩统计实验",
}

async function buildContext(modelConfigHash = "deterministic-code-lab-reference-v1"): Promise<{
  pack: RagEvidencePack
  spec: GenerationSpec
  request: CodeLabRequest
  provider: DeterministicCodeLabContentProvider
}> {
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
    run_id: "RUN-C-LAB-001",
    profile_snapshot: adaptLearnerProfile(profile, { profile_version: "profile-lab-v1" }),
    path_node: path,
    evidence_pack: pack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: modelConfigHash,
      runner_image_digest: RUNNER_DIGEST,
    },
    seed: 42,
  })
  if (!built.ok) throw new Error(built.errors.join("；"))
  const provider = new DeterministicCodeLabContentProvider()
  const concept = await generateConceptLesson(
    { generation_spec: built.spec, evidence_pack: pack },
    provider,
  )
  if (concept.status !== "ready") throw new Error(concept.blocked_reason?.message)
  return {
    pack,
    spec: built.spec,
    request: { generation_spec: built.spec, evidence_pack: pack, concept_artifact: concept },
    provider,
  }
}

describe("role C phase-two trusted code-lab", () => {
  test("publishes aligned public/secure artifacts only after independent execution", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateCodeLab(request, provider, new TrustedCodeLabVerifier(new FixtureIsolatedRunner()))

    expect(pair.public_artifact.status).toBe("ready")
    expect(pair.secure_artifact.status).toBe("ready")
    expect(pair.public_artifact.quality).toMatchObject({
      schema_ok: true,
      objective_coverage: 1,
      execution_verified: true,
      mutation_kill_rate: 1,
      verified_test_count: 5,
    })
    expect(pair.public_artifact.versions.runner_image_digest).toBe(RUNNER_DIGEST)
    expect(JSON.stringify(pair.public_artifact)).not.toContain("reference_solution")
    expect(JSON.stringify(pair.public_artifact)).not.toContain("hidden_tests")
    expect(pair.secure_artifact.payload?.hidden_tests).toHaveLength(5)
    expect(pair.secure_artifact.payload?.mutation_variants).toHaveLength(4)
  })

  test("returns structured UNSUPPORTED_TARGET for a non-gold offline target set", async () => {
    const { request, provider } = await buildContext()
    const unsupported = structuredClone(request)
    unsupported.generation_spec.targets[0]!.source_id = "K001"
    unsupported.generation_spec.targets[1]!.source_id = "K002"
    unsupported.generation_spec.targets[2]!.source_id = "K003"

    const pair = await generateCodeLab(
      unsupported,
      provider,
      new TrustedCodeLabVerifier(new FixtureIsolatedRunner()),
    )

    expect(pair.public_artifact.status).toBe("blocked")
    expect(pair.public_artifact.blocked_reason).toMatchObject({
      code: "UNSUPPORTED_TARGET",
      details: ["target_source_ids=K001,K002,K003"],
    })
    expect(pair.public_artifact.payload).toBeNull()
    expect(pair.secure_artifact.payload).toBeNull()
  })

  test("the mixed hidden case distinguishes a skipped final element", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateCodeLab(request)
    const hidden = draft.secure_draft.payload.hidden_tests.find((entry) => entry.test_id === "HT-O2-MIXED")
    expect(hidden).toBeDefined()
    const scores = hidden!.input as number[]
    const skippedLastAverage = scores.slice(0, -1).reduce((sum, score) => sum + score, 0) / (scores.length - 1)
    expect(skippedLastAverage).not.toBe(hidden!.expected)
  })

  test("strictly rejects nested lab shape errors", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateCodeLab(request)
    const invalid = structuredClone(draft) as unknown as Record<string, any>
    delete invalid.public_draft.payload.public_tests[0].citations
    const report = validateRoleCSchema("code_lab_draft.schema.json", invalid)
    expect(report.ok).toBe(false)
    expect(report.issues.some((entry) => entry.path.includes("public_tests"))).toBe(true)
  })

  test("rejects incomplete diagnostic maps and inconsistent scoring groups", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateCodeLab(request)
    const invalid = structuredClone(draft)
    invalid.secure_draft.payload.misconception_map.pop()
    const foreignTest = invalid.secure_draft.payload.scoring_groups[1]!.test_ids[0]!
    invalid.secure_draft.payload.scoring_groups[0]!.test_ids.push(foreignTest)
    const report = validateCodeLabDraftStructure(request, invalid)
    expect(report.ok).toBe(false)
    expect(report.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "missing_misconception_test",
      "group_objective_mismatch",
      "test_in_multiple_groups",
      "group_weight_mismatch",
    ]))
  })

  test("does not let an accepting custom verifier bypass deterministic Draft gates", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateCodeLab(request)
    delete (draft.public_draft.payload.public_tests[0] as any).citations
    provider.generateCodeLab = async () => draft
    const pair = await generateCodeLab(request, provider, {
      async verifyCodeLab() { return { execution_verified: true, issues: [] } },
    })
    expect(pair.public_artifact.status).toBe("blocked")
    expect(pair.public_artifact.blocked_reason?.code).toBe("BLOCKED_INVALID_OUTPUT")
  })

  test("snapshots provider output before an asynchronous verifier can mutate it", async () => {
    const { request, provider } = await buildContext()
    const providerDraft = await provider.generateCodeLab(request)
    const originalReference =
      providerDraft.secure_draft.payload.reference_solution
    provider.generateCodeLab = async () => providerDraft

    const pair = await generateCodeLab(request, provider, {
      async verifyCodeLab(_request, verifierDraft) {
        verifierDraft.secure_draft.payload.reference_solution =
          "MUTATED_BY_VERIFIER"
        return {
          execution_verified: true,
          runner_image_digest: RUNNER_DIGEST,
          issues: [],
        }
      },
    })
    providerDraft.secure_draft.payload.reference_solution =
      "MUTATED_BY_PROVIDER_AFTER_RETURN"

    expect(pair.secure_artifact.status).toBe("ready")
    expect(pair.secure_artifact.payload?.reference_solution)
      .toBe(originalReference)
  })

  test("blocks ungrounded claims and value-level reference leaks before runner execution", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateCodeLab(request)
    const normalized = structuredClone(draft)
    const normalizedFirst = normalized.public_draft.payload.instructions[0]
    if ("claims" in normalizedFirst) {
      normalizedFirst.claims[0].text = normalizedFirst.claims[0].text
        .replace("常用于", "通常用于")
        .replace("。", "！")
    }
    expect(validateCodeLabDraftStructure(request, normalized).ok).toBe(true)

    const ungrounded = structuredClone(draft)
    const first = ungrounded.public_draft.payload.instructions[0]
    if ("claims" in first) first.claims[0].text = "量子计算会自动修复所有循环"
    expect(validateCodeLabDraftStructure(request, ungrounded).issues.some((entry) => entry.code === "ungrounded_claim")).toBe(true)

    const leaked = structuredClone(draft)
    leaked.public_draft.payload.starter_code = leaked.secure_draft.payload.reference_solution
    const leakReport = validateCodeLabDraftStructure(request, leaked)
    expect(leakReport.ok).toBe(false)
    expect(leakReport.issues.some((entry) => entry.code === "starter_equals_reference")).toBe(true)

    const escapedMultilineLeak = structuredClone(draft)
    const instruction = escapedMultilineLeak.public_draft.payload.instructions[0]
    if ("text" in instruction) instruction.text = escapedMultilineLeak.secure_draft.payload.reference_solution
    const multilineReport = validateCodeLabDraftStructure(request, escapedMultilineLeak)
    expect(multilineReport.issues.some((entry) => entry.code === "reference_solution_leak")).toBe(true)

    const hiddenInputLeak = structuredClone(draft)
    hiddenInputLeak.public_draft.payload.public_tests[0]!.input =
      structuredClone(hiddenInputLeak.secure_draft.payload.hidden_tests[0]!.input)
    const hiddenInputReport =
      validateCodeLabDraftStructure(request, hiddenInputLeak)
    expect(hiddenInputReport.issues.some(
      (entry) => entry.code === "hidden_test_input_leak",
    )).toBe(true)

    const splitReferenceLeak = structuredClone(draft)
    const reference =
      splitReferenceLeak.secure_draft.payload.reference_solution
    const midpoint = Math.floor(reference.length / 2)
    splitReferenceLeak.public_draft.payload.reflection_questions = [
      reference.slice(0, midpoint),
      reference.slice(midpoint),
    ]
    const splitReferenceReport =
      validateCodeLabDraftStructure(request, splitReferenceLeak)
    expect(splitReferenceReport.issues.some(
      (entry) => entry.code === "reference_solution_leak",
    )).toBe(true)

    const reversedReferenceLeak = structuredClone(draft)
    reversedReferenceLeak.public_draft.payload.reflection_questions = [
      `第 2 段：${reference.slice(midpoint)}`,
      `第 1 段：${reference.slice(0, midpoint)}`,
    ]
    const reversedReferenceReport =
      validateCodeLabDraftStructure(request, reversedReferenceLeak)
    expect(reversedReferenceReport.issues.some(
      (entry) => entry.code === "reference_solution_leak",
    )).toBe(true)

    const semanticHiddenInputLeak = structuredClone(draft)
    semanticHiddenInputLeak.secure_draft.payload.hidden_tests[0]!.input =
      [10, 20, 30, 40]
    semanticHiddenInputLeak.secure_draft.payload.hidden_tests[0]!.expected =
      25
    semanticHiddenInputLeak.public_draft.payload.reflection_questions = [
      "隐藏用例会依次使用 10、20、30、40，输出应为 25。",
    ]
    const semanticHiddenInputReport =
      validateCodeLabDraftStructure(request, semanticHiddenInputLeak)
    expect(semanticHiddenInputReport.issues.some(
      (entry) => entry.code === "hidden_test_input_leak",
    )).toBe(true)
  })

  test("blocks a reference failure, a solved starter, or weak mutation tests", async () => {
    const { request, provider } = await buildContext()
    const cases = ["reference_fails", "starter_passes", "mutation_survives"] as const
    for (const mode of cases) {
      const pair = await generateCodeLab(request, provider, new TrustedCodeLabVerifier(new FixtureIsolatedRunner(mode)))
      expect(pair.public_artifact.status).toBe("blocked")
      expect(pair.public_artifact.blocked_reason?.code).toBe("BLOCKED_EXECUTION_UNVERIFIED")
      expect(JSON.stringify(pair.public_artifact)).not.toContain("HT-")
    }
  })

  test("keeps quiz answers and learner identity out of model-visible lab context", async () => {
    const { request } = await buildContext()
    const injected = structuredClone(request)
    injected.evidence_pack.results[0].quiz_seeds[0].answer = "PRIVATE_QUIZ_ANSWER"
    const input = buildCodeLabModelInput(injected)
    const serialized = JSON.stringify(input)
    expect(serialized).not.toContain("PRIVATE_QUIZ_ANSWER")
    expect(serialized).not.toContain(profile.learner_id)
    expect(serialized).not.toContain("quiz_seeds")
  })

  test("repairs one invalid model lab Draft before the independent verifier", async () => {
    const gateway = new SequenceGateway("MODEL-LAB-HASH")
    const { request, provider } = await buildContext(gateway.model_config_hash)
    const valid = await provider.generateCodeLab(request)
    gateway.outputs.push({}, valid)
    const repaired = await new ModelBackedRoleCContentProvider(gateway, {
      generation_strategy: "monolithic",
    }).generateCodeLab(request)
    expect(repaired.public_draft.payload.lab_id).toBe(valid.public_draft.payload.lab_id)
    expect(gateway.requests).toHaveLength(2)
    expect(JSON.stringify(gateway.requests[1].input)).toContain("validator_report")
  })

  test("adapts OpenCode code-lab provider_draft into the canonical harness", async () => {
    const { request, provider } = await buildContext()
    const draft = await provider.generateCodeLab(request)
    const adapter = new OpenCodeConceptContentProvider({
      async invoke(input) {
        if (input.worker !== "code-lab") throw new Error("unexpected worker")
        return {
          stage: "code_lab",
          status: "completed",
          summary: "[executed:code-lab]",
          provider_draft: draft,
          blocked_reason: null,
          next: "run_assessment",
        }
      },
    })
    const pair = await generateCodeLab(request, adapter, new TrustedCodeLabVerifier(new FixtureIsolatedRunner()))
    expect(pair.public_artifact.status).toBe("ready")
    expect(pair.public_artifact.payload?.lab_id).toBe(draft.public_draft.payload.lab_id)
  })

})

describe("role C Docker runner boundary", () => {
  test("uses an immutable, no-network, read-only, non-root Docker container request", async () => {
    const executor = new CapturingExecutor()
    const runner = new DockerPythonCodeRunner({
      docker_binary: "/usr/bin/docker",
      image_id: RUNNER_DIGEST,
      executor,
    })
    const suite = minimalSuite()
    const result = await runner.execute(executionRequest(suite, "def average_score(scores):\n    return 1"))

    expect(result.status).toBe("passed")
    const args = executor.requests[0].args
    expect(args).toContain("none")
    expect(args).toContain("--read-only")
    expect(args).toContain("ALL")
    expect(args).toContain("65534:65534")
    expect(args).toContain("--pull=never")
    expect(args.some((entry) => entry.includes("sha256:"))).toBe(true)
    const containerPayload = JSON.parse(executor.requests[0].stdin)
    expect(containerPayload.code).toContain("average_score")
    expect(containerPayload.test_inputs).toEqual([[1]])
    expect(containerPayload).not.toHaveProperty("tests")
    expect(JSON.stringify(containerPayload)).not.toContain(process.env.HOME ?? "unlikely-home")
  })

  test("rejects mutable image IDs and dangerous source before Docker process launch", async () => {
    expect(() => new DockerPythonCodeRunner({ docker_binary: "docker", image_id: "python:3.12" })).toThrow("sha256")
    const executor = new CapturingExecutor()
    const runner = new DockerPythonCodeRunner({ docker_binary: "docker", image_id: RUNNER_DIGEST, executor })
    const result = await runner.execute(executionRequest(minimalSuite(), "import os\ndef average_score(scores):\n    return 1"))
    expect(result.status).toBe("failed")
    expect(result.failure_codes).toContain("static:forbidden_import")
    expect(executor.requests).toHaveLength(0)
  })

  test("keeps expected answers outside Docker and scores returned values on the host", async () => {
    const executor = new CapturingExecutor(999)
    const runner = new DockerPythonCodeRunner({
      docker_binary: "docker",
      image_id: RUNNER_DIGEST,
      executor,
    })
    const result = await runner.execute(executionRequest(
      minimalSuite(),
      "def average_score(scores):\n    return 1",
    ))
    const payload = JSON.parse(executor.requests[0].stdin)
    expect(payload).not.toHaveProperty("tests")
    expect(payload.test_inputs).toEqual([[1]])
    expect(result).toMatchObject({
      status: "failed",
      passed_tests: 0,
      failure_codes: ["HT-1:assertion_failed"],
    })
  })

  test("applies numeric tolerances after Docker returns the actual value", async () => {
    const suite = minimalSuite()
    suite.tests[0]!.expected = 1
    suite.tests[0]!.comparison = { kind: "numeric", abs_tolerance: 0.01, rel_tolerance: 0 }
    const accepted = new DockerPythonCodeRunner({
      image_id: RUNNER_DIGEST,
      executor: new CapturingExecutor(1.005),
    })
    const rejected = new DockerPythonCodeRunner({
      image_id: RUNNER_DIGEST,
      executor: new CapturingExecutor(1.02),
    })
    expect((await accepted.execute(executionRequest(suite, "def average_score(scores):\n    return 1"))).status).toBe("passed")
    expect((await rejected.execute(executionRequest(suite, "def average_score(scores):\n    return 1"))).status).toBe("failed")
  })

  test("intersects each lab import declaration with the platform Python allowlist", async () => {
    const executor = new CapturingExecutor()
    const runner = new DockerPythonCodeRunner({ docker_binary: "docker", image_id: RUNNER_DIGEST, executor })

    const unsupported = minimalSuite()
    unsupported.execution_contract.allowed_imports = ["random"]
    const blocked = await runner.execute(executionRequest(unsupported, "def average_score(scores):\n    return 1"))
    expect(blocked.status).toBe("failed")
    expect(blocked.failure_codes).toContain("static:unsupported_contract_import")
    expect(executor.requests).toHaveLength(0)

    const supported = minimalSuite()
    supported.execution_contract.allowed_imports = ["math"]
    const passed = await runner.execute(executionRequest(supported, "import math\ndef average_score(scores):\n    return math.fsum(scores)"))
    expect(passed.status).toBe("passed")
    expect(executor.requests).toHaveLength(1)

    const schema = await Bun.file("schemas/role-c-content/code_lab_draft.schema.json").json()
    expect(schema.$defs.execution_contract.properties.allowed_imports.items.enum)
      .toEqual([...PLATFORM_PYTHON_IMPORT_ALLOWLIST])
  })

  test("resolves the dedicated Docker image to its immutable local image ID", async () => {
    const executor = new ImageInspectionExecutor()
    const runner = await createDockerPythonCodeRunnerFromEnv({}, { executor })
    expect(runner.runner_image_digest).toBe(RUNNER_DIGEST)
    expect(executor.requests[0]).toMatchObject({
      command: "docker",
      args: ["image", "inspect", "knowbalance-role-c-python-runner:1.0.0"],
    })
    await expect(createDockerPythonCodeRunnerFromEnv({}, {
      executor: new ImageInspectionExecutor({}),
    })).rejects.toThrow("缺少 io.knowbalance.role-c.runner=1")
  })

  test("bounds Docker CLI output while reading the process streams", async () => {
    const executor = new BunDockerCommandExecutor()
    const result = await executor.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      stdin: "",
      timeout_ms: 2_000,
      max_output_bytes: 512,
    })
    expect(result.output_truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(512)
  })

  test("provides the same bounded command boundary to Node-hosted backends", async () => {
    const executor = new NodeDockerCommandExecutor()
    const result = await executor.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      stdin: "",
      timeout_ms: 2_000,
      max_output_bytes: 512,
    })
    expect(result.output_truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr))
      .toBeLessThanOrEqual(512)

    const timedOut = await executor.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      stdin: "",
      timeout_ms: 100,
      max_output_bytes: 512,
    })
    expect(timedOut.timed_out).toBe(true)
  })

  test("retries forced Docker cleanup when container registration races command termination", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "role-c-cleanup-"))
    const counter = join(temporary, "attempts")
    const cleanupScript = [
      "const fs = require('node:fs')",
      `const path = ${JSON.stringify(counter)}`,
      "let count = 0",
      "try { count = Number(fs.readFileSync(path, 'utf8')) || 0 } catch {}",
      "count += 1",
      "fs.writeFileSync(path, String(count), 'utf8')",
      "process.exit(count >= 3 ? 0 : 1)",
    ].join(";")
    try {
      const result = await new NodeDockerCommandExecutor().run({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        stdin: "",
        timeout_ms: 100,
        max_output_bytes: 512,
        cleanup: {
          command: process.execPath,
          args: ["-e", cleanupScript],
        },
      })

      expect(result.timed_out).toBe(true)
      expect(await readFile(counter, "utf8")).toBe("3")
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("keeps the known test count when Docker reports an infrastructure error", async () => {
    const runner = new DockerPythonCodeRunner({
      image_id: RUNNER_DIGEST,
      executor: {
        async run() {
          return {
            exit_code: 125,
            stdout: "",
            stderr: "container startup failed",
            timed_out: false,
            output_truncated: false,
          }
        },
      },
    })
    const suite = minimalSuite()
    const result = await runner.execute(executionRequest(
      suite,
      "def average_score(scores):\n    return 1",
    ))
    expect(result).toMatchObject({
      status: "runner_error",
      total_tests: suite.tests.length,
      passed_tests: 0,
      score_ratio: 0,
      failure_codes: ["docker_container_failed"],
    })
  })
})

describe("role C atomic secure artifact store", () => {
  test("atomically stores, authorizes and resolves an opaque code test suite", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateCodeLab(request, provider, new TrustedCodeLabVerifier(new FixtureIsolatedRunner()))
    if (pair.secure_artifact.status !== "ready") throw new Error("secure artifact not ready")
    const temporary = await mkdtemp(join(tmpdir(), "role-c-secure-"))
    const root = join(temporary, "store")
    try {
      const store = new AtomicFileSecureArtifactStore({ root_directory: root })
      const refs = await store.putBatch(
        [pair.secure_artifact],
        { principal: "role-c-pipeline", run_id: request.generation_spec.run_id },
      )
      expect(refs).toHaveLength(1)
      expect(refs[0]).not.toContain(pair.secure_artifact.artifact_id)
      const loaded = await store.get(refs[0], { principal: "role-c-grader", run_id: request.generation_spec.run_id })
      expect(loaded).toEqual(pair.secure_artifact)
      await expect(store.get(refs[0], { principal: "role-c-grader", run_id: "OTHER-RUN" })).rejects.toBeInstanceOf(SecureArtifactStoreError)

      const registry = new SecureStoreCodeTestSuiteRegistry(store)
      const suiteId = await registry.registerCodeLab(refs[0], { principal: "role-c-grader", run_id: request.generation_spec.run_id })
      const suite = await registry.resolve(suiteId)
      expect(suite?.tests).toHaveLength(5)
      expect(suite?.execution_contract.entry_point).toBe("average_score")
      expect((await readdir(root)).filter((entry) => entry.startsWith("batch-"))).toHaveLength(1)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("validates the whole batch before writing, so invalid second data cannot leave partial state", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateCodeLab(request, provider, new TrustedCodeLabVerifier(new FixtureIsolatedRunner()))
    if (pair.secure_artifact.status !== "ready") throw new Error("secure artifact not ready")
    const invalid = structuredClone(pair.secure_artifact)
    invalid.run_id = "OTHER-RUN"
    const temporary = await mkdtemp(join(tmpdir(), "role-c-secure-"))
    const root = join(temporary, "store")
    try {
      const store = new AtomicFileSecureArtifactStore({ root_directory: root })
      await expect(store.putBatch(
        [pair.secure_artifact, invalid],
        { principal: "role-c-pipeline", run_id: request.generation_spec.run_id },
      )).rejects.toBeInstanceOf(SecureArtifactStoreError)
      expect(await readdir(temporary)).toEqual([])
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("reports a corrupted stored envelope as a typed integrity failure", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateCodeLab(request, provider, new TrustedCodeLabVerifier(new FixtureIsolatedRunner()))
    if (pair.secure_artifact.status !== "ready") throw new Error("secure artifact not ready")
    const temporary = await mkdtemp(join(tmpdir(), "role-c-secure-"))
    const root = join(temporary, "store")
    try {
      const store = new AtomicFileSecureArtifactStore({ root_directory: root })
      const [ref] = await store.putBatch(
        [pair.secure_artifact],
        { principal: "role-c-pipeline", run_id: request.generation_spec.run_id },
      )
      const [batchDirectory] = await readdir(root)
      const [artifactFile] = await readdir(join(root, batchDirectory))
      await writeFile(join(root, batchDirectory, artifactFile), "{}", "utf8")

      try {
        await store.get(ref, { principal: "role-c-grader", run_id: request.generation_spec.run_id })
        throw new Error("expected secure store read to fail")
      } catch (error) {
        expect(error).toBeInstanceOf(SecureArtifactStoreError)
        expect((error as SecureArtifactStoreError).code).toBe("INTEGRITY_ERROR")
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("deletes only a complete authorized transaction for the owning run", async () => {
    const { request, provider } = await buildContext()
    const pair = await generateCodeLab(request, provider, new TrustedCodeLabVerifier(new FixtureIsolatedRunner()))
    if (pair.secure_artifact.status !== "ready") throw new Error("secure artifact not ready")
    const second = structuredClone(pair.secure_artifact)
    second.artifact_id = "ART-SECURE-COPY"
    const temporary = await mkdtemp(join(tmpdir(), "role-c-secure-"))
    const root = join(temporary, "store")
    try {
      const store = new AtomicFileSecureArtifactStore({ root_directory: root })
      const refs = await store.putBatch(
        [pair.secure_artifact, second],
        { principal: "role-c-pipeline", run_id: request.generation_spec.run_id },
      )
      await expect(store.deleteBatch(
        [refs[0]],
        { principal: "role-c-pipeline", run_id: request.generation_spec.run_id },
      )).rejects.toMatchObject({ code: "INVALID_REF" })
      await expect(store.deleteBatch(
        refs,
        { principal: "role-c-pipeline", run_id: "OTHER-RUN" },
      )).rejects.toMatchObject({ code: "ACCESS_DENIED" })
      expect(await store.get(
        refs[0],
        { principal: "role-c-grader", run_id: request.generation_spec.run_id },
      )).toEqual(pair.secure_artifact)

      await store.deleteBatch(
        refs,
        { principal: "role-c-pipeline", run_id: request.generation_spec.run_id },
      )
      await expect(store.get(
        refs[0],
        { principal: "role-c-grader", run_id: request.generation_spec.run_id },
      )).rejects.toMatchObject({ code: "NOT_FOUND" })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})

class FixtureIsolatedRunner implements CodeRunner {
  readonly runner_image_digest = RUNNER_DIGEST

  constructor(private readonly mode?: "reference_fails" | "starter_passes" | "mutation_survives") {}

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const tests = request.test_suite?.tests ?? []
    const allIds = tests.map((entry) => entry.test_id)
    if (this.mode === "reference_fails" && request.code.includes("total += score")) return failed(allIds, [allIds[0]])
    if (this.mode === "starter_passes" && request.code.includes("return None")) return passed(allIds.length)
    if (request.code.includes("return None")) return failed(allIds, allIds)
    if (request.code.includes("total = score")) return failed(allIds, ["HT-O1-ALL"])
    if (request.code.includes("scores[:-1]")) return failed(allIds, ["HT-O2-MIXED"])
    if (request.code.includes("return 80")) {
      if (this.mode === "mutation_survives") return passed(allIds.length)
      return failed(allIds, ["HT-O2-SINGLE", "HT-O2-MIXED"])
    }
    if (request.code.includes("// count")) return failed(allIds, ["HT-O3-FRACTION"])
    return passed(allIds.length)
  }
}

class SequenceGateway implements ModelGateway {
  readonly model_id = "sequence-lab-model"
  readonly outputs: unknown[] = []
  readonly requests: Array<{ input: unknown }> = []

  constructor(readonly model_config_hash: string) {}

  async generateStructured<T>(request: { input: unknown }): Promise<T> {
    this.requests.push({ input: request.input })
    return structuredClone(this.outputs.shift()) as T
  }
}

class CapturingExecutor implements DockerCommandExecutor {
  readonly requests: DockerCommandRequest[] = []

  constructor(private readonly actual: unknown = 1) {}

  async run(request: DockerCommandRequest) {
    this.requests.push(request)
    const payload = JSON.parse(request.stdin)
    return {
      exit_code: 0,
      stdout: JSON.stringify({
        status: "completed",
        results: payload.test_inputs.map(() => ({ outcome: "returned", actual: this.actual })),
      }),
      stderr: "",
      timed_out: false,
      output_truncated: false,
    }
  }
}

class ImageInspectionExecutor implements DockerCommandExecutor {
  readonly requests: DockerCommandRequest[] = []

  constructor(
    private readonly labels: Record<string, string> = { "io.knowbalance.role-c.runner": "1" },
  ) {}

  async run(request: DockerCommandRequest) {
    this.requests.push(request)
    return {
      exit_code: 0,
      stdout: JSON.stringify([{
        Id: RUNNER_DIGEST,
        Config: { Labels: this.labels },
      }]),
      stderr: "",
      timed_out: false,
      output_truncated: false,
    }
  }
}

function minimalSuite(): RunnerTestSuite {
  return {
    test_suite_id: "TS-MINIMAL",
    execution_contract: {
      language: "python",
      execution_mode: "function",
      entry_point: "average_score",
      allowed_imports: [],
      input_contract: { type: "list[number]", constraints: ["length >= 1"] },
      output_contract: { type: "number" },
      resource_limits: { timeout_ms: 1000, memory_mb: 64, max_output_bytes: 2000 },
    },
    tests: [{
      test_id: "HT-1",
      input: [1],
      expected: 1,
      objective_id: "O1",
      weight: 1,
      comparison: { kind: "exact" },
    }],
  }
}

function executionRequest(suite: RunnerTestSuite, code: string): CodeExecutionRequest {
  return {
    language: "python",
    code,
    test_suite_id: suite.test_suite_id,
    test_suite: suite,
    timeout_ms: 1000,
    memory_mb: 64,
    max_output_bytes: 2000,
    network_allowed: false,
  }
}

function passed(total: number): CodeExecutionResult {
  return { status: "passed", passed_tests: total, total_tests: total, score_ratio: 1, failure_codes: [], runner_image_digest: RUNNER_DIGEST }
}

function failed(allIds: string[], failedIds: string[]): CodeExecutionResult {
  return {
    status: "failed",
    passed_tests: Math.max(0, allIds.length - failedIds.length),
    total_tests: allIds.length,
    score_ratio: allIds.length === 0 ? 0 : (allIds.length - failedIds.length) / allIds.length,
    failure_codes: failedIds.map((entry) => `${entry}:assertion_failed`),
    runner_image_digest: RUNNER_DIGEST,
  }
}
