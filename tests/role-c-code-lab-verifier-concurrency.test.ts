import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { retrieveKnowledge } from "../src/rag/retriever"
import { buildRagRequest } from "../src/role-b-profile/rag-bridge"
import type { LearnerProfile } from "../src/role-b-profile/types"
import {
  adaptLearnerProfile,
  adaptRagResult,
  buildGenerationSpec,
  defineLearningPathNode,
  DeterministicCodeLabContentProvider,
  generateConceptLesson,
  ROLE_C_PROMPT_MANIFEST_VERSION,
  TrustedCodeLabVerifier,
  validateCodeLabDraftStructure,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeLabDraft,
  type CodeLabRequest,
  type CodeRunner,
} from "../src/role-c-content"

const RUNNER_DIGEST = `sha256:${"a".repeat(64)}`
const learner: LearnerProfile = {
  learner_id: "verifier_concurrency",
  level: "beginner",
  known_concepts: ["变量", "条件判断"],
  weak_concepts: ["循环", "列表"],
  goal: "完成成绩统计实验",
}

describe("TrustedCodeLabVerifier mutation execution", () => {
  test("runs only declared mutation tests with bounded concurrency instead of the full cross-product", async () => {
    const { request, draft: original } = await buildFixture()
    const draft = expandMutations(original, 30)
    expect(validateCodeLabDraftStructure(request, draft).ok).toBe(true)

    const runner = new ObservedMutationRunner(draft)
    const report = await new TrustedCodeLabVerifier(runner, {
      mutation_concurrency: 2,
    }).verifyCodeLab(request, draft)

    expect(report).toMatchObject({
      execution_verified: true,
      issues: [],
      mutation_kill_rate: 1,
      verified_test_count: draft.secure_draft.payload.hidden_tests.length,
      objective_coverage: 1,
    })
    expect(runner.maxActiveMutations).toBe(2)
    expect(runner.referenceTestIds).toEqual(hiddenTestIds(draft))
    expect(runner.starterTestIds).toEqual(hiddenTestIds(draft))
    expect(runner.mutationRequests).toHaveLength(30)

    for (const mutation of draft.secure_draft.payload.mutation_variants) {
      expect(runner.mutationRequests.find(
        (entry) => entry.index === mutationIndex(mutation.code),
      )?.testIds).toEqual(mutation.must_fail_test_ids)
    }

    const fullTestCount = draft.secure_draft.payload.hidden_tests.length
    const declaredMutationTestCount = draft.secure_draft.payload.mutation_variants
      .reduce((sum, mutation) => sum + mutation.must_fail_test_ids.length, 0)
    expect(runner.executedTestCount).toBe(
      fullTestCount * 2 + declaredMutationTestCount,
    )
    expect(runner.executedTestCount).toBeLessThan(
      fullTestCount * (2 + draft.secure_draft.payload.mutation_variants.length),
    )
    expect(() => new TrustedCodeLabVerifier(runner, {
      mutation_concurrency: 5,
    })).toThrow("mutation_concurrency 必须为 1..4 的整数")
  })

  test("aggregates failures and diagnostics in mutation plan order despite out-of-order completion", async () => {
    const { request, draft: original } = await buildFixture()
    const draft = expandMutations(original, 8)
    const survivingIndexes = new Set([0, 3, 6])
    const runner = new ObservedMutationRunner(draft, survivingIndexes)
    const report = await new TrustedCodeLabVerifier(runner, {
      mutation_concurrency: 2,
    }).verifyCodeLab(request, draft)

    expect(runner.completionOrder).not.toEqual(
      draft.secure_draft.payload.mutation_variants.map((_entry, index) => index),
    )
    expect(report).toMatchObject({
      execution_verified: true,
      issues: [],
      mutation_kill_rate: 5 / 8,
      verified_test_count: draft.secure_draft.payload.hidden_tests.length,
      objective_coverage: 1,
    })
    expect(report.failed_mutations?.map((entry) => entry.mutation_id)).toEqual(
      [...survivingIndexes].map((index) => `M-SCALE-${index + 1}`),
    )
    expect(report.failed_mutations).toEqual([...survivingIndexes].map((index) => ({
      mutation_id: `M-SCALE-${index + 1}`,
      status: "passed",
      failure_codes: [],
      must_fail_test_ids:
        draft.secure_draft.payload.mutation_variants[index]!.must_fail_test_ids,
    })))
  })
})

async function buildFixture(): Promise<{
  request: CodeLabRequest
  draft: CodeLabDraft
}> {
  const ragRequest = buildRagRequest(learner)
  const rag = await retrieveKnowledge({
    query: ragRequest.query,
    learnerLevel: learner.level,
    topK: 10,
  })
  const knowledgeBase = await loadKnowledgeBase()
  const evidencePack = adaptRagResult(rag, {
    kb_version: knowledgeBase.version,
    rag_version: "rule-rag-0.1",
  })
  const rawPath = await Bun.file(
    "examples/role-c-content/learning_path_node_score_project.json",
  ).json()
  const path = defineLearningPathNode({
    node_id: rawPath.node_id,
    target_source_ids: rawPath.target_source_ids,
    prerequisite_source_ids: rawPath.prerequisite_source_ids,
    goal: rawPath.goal,
    objectives: rawPath.objectives,
    assessment_blueprint: rawPath.assessment_blueprint,
  })
  const built = buildGenerationSpec({
    run_id: "RUN-C-VERIFIER-CONCURRENCY",
    profile_snapshot: adaptLearnerProfile(learner, {
      profile_version: "profile-verifier-v1",
    }),
    path_node: path,
    evidence_pack: evidencePack,
    versions: {
      prompt_version: ROLE_C_PROMPT_MANIFEST_VERSION,
      model_config_hash: "deterministic-code-lab-reference-v1",
      runner_image_digest: RUNNER_DIGEST,
    },
    seed: 42,
  })
  if (!built.ok) throw new Error(built.errors.join("；"))

  const provider = new DeterministicCodeLabContentProvider()
  const concept = await generateConceptLesson({
    generation_spec: built.spec,
    evidence_pack: evidencePack,
  }, provider)
  if (concept.status !== "ready") {
    throw new Error(concept.blocked_reason?.message ?? "concept fixture blocked")
  }
  const request: CodeLabRequest = {
    generation_spec: built.spec,
    evidence_pack: evidencePack,
    concept_artifact: concept,
  }
  return {
    request,
    draft: await provider.generateCodeLab(request),
  }
}

function expandMutations(draft: CodeLabDraft, count: number): CodeLabDraft {
  const expanded = structuredClone(draft)
  const originals = expanded.secure_draft.payload.mutation_variants
  expanded.secure_draft.payload.mutation_variants = Array.from(
    { length: count },
    (_entry, index) => {
      const original = originals[index % originals.length]!
      return {
        ...structuredClone(original),
        mutation_id: `M-SCALE-${index + 1}`,
        code: `${original.code.trimEnd()}\n# verifier-scale-${index}`,
      }
    },
  )
  for (const coverage of expanded.secure_draft.payload.objective_coverage) {
    coverage.mutation_ids = expanded.secure_draft.payload.mutation_variants
      .filter((mutation) => mutation.objective_ids.includes(coverage.objective_id))
      .map((mutation) => mutation.mutation_id)
  }
  return expanded
}

class ObservedMutationRunner implements CodeRunner {
  readonly runner_image_digest = RUNNER_DIGEST
  readonly mutationRequests: Array<{ index: number; testIds: string[] }> = []
  readonly completionOrder: number[] = []
  referenceTestIds: string[] = []
  starterTestIds: string[] = []
  executedTestCount = 0
  maxActiveMutations = 0
  private activeMutations = 0
  private readonly evenMutationReleases = new Map<number, () => void>()

  constructor(
    private readonly draft: CodeLabDraft,
    private readonly survivingIndexes = new Set<number>(),
  ) {}

  async execute(request: CodeExecutionRequest): Promise<CodeExecutionResult> {
    const testIds = request.test_suite?.tests.map((entry) => entry.test_id) ?? []
    this.executedTestCount += testIds.length
    if (request.code === this.draft.secure_draft.payload.reference_solution) {
      this.referenceTestIds = testIds
      return passed(testIds.length)
    }
    if (request.code === this.draft.public_draft.payload.starter_code) {
      this.starterTestIds = testIds
      return failed(testIds, testIds)
    }

    const index = mutationIndex(request.code)
    this.mutationRequests.push({ index, testIds })
    this.activeMutations += 1
    this.maxActiveMutations = Math.max(
      this.maxActiveMutations,
      this.activeMutations,
    )
    try {
      await this.completeAdjacentMutationsOutOfOrder(index)
      return this.survivingIndexes.has(index)
        ? passed(testIds.length)
        : failed(testIds, testIds)
    } finally {
      this.activeMutations -= 1
    }
  }

  private async completeAdjacentMutationsOutOfOrder(index: number): Promise<void> {
    if (index % 2 === 0) {
      await new Promise<void>((resolve) => {
        this.evenMutationReleases.set(index, resolve)
      })
      this.evenMutationReleases.delete(index)
      this.completionOrder.push(index)
      return
    }
    const releaseEven = this.evenMutationReleases.get(index - 1)
    if (!releaseEven) throw new Error("相邻 mutation 未按并发 worker 启动")
    this.completionOrder.push(index)
    releaseEven()
  }
}

function mutationIndex(code: string): number {
  const match = code.match(/# verifier-scale-(\d+)\s*$/)
  if (!match) throw new Error("mutation fixture 缺少 scale index")
  return Number(match[1])
}

function hiddenTestIds(draft: CodeLabDraft): string[] {
  return draft.secure_draft.payload.hidden_tests.map((entry) => entry.test_id)
}

function passed(total: number): CodeExecutionResult {
  return {
    status: "passed",
    passed_tests: total,
    total_tests: total,
    score_ratio: 1,
    failure_codes: [],
    runner_image_digest: RUNNER_DIGEST,
  }
}

function failed(allIds: string[], failedIds: string[]): CodeExecutionResult {
  return {
    status: "failed",
    passed_tests: Math.max(0, allIds.length - failedIds.length),
    total_tests: allIds.length,
    score_ratio: allIds.length === 0
      ? 0
      : (allIds.length - failedIds.length) / allIds.length,
    failure_codes: failedIds.map((entry) => `${entry}:assertion_failed`),
    runner_image_digest: RUNNER_DIGEST,
  }
}
