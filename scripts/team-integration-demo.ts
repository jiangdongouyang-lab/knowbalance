import { retrieveKnowledge } from "../src/rag/retriever"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeDifficulty } from "../src/knowledge/types"
import { generateRoleCForRoleDWithRuntime } from "../src/role-d-integration/role-c-service"
import { adaptHandoff } from "../src/role-d-ui/src/domain/adapt-handoff"
import { exportProgressJson } from "../src/role-d-ui/src/domain/progress-file"
import { isValidRoleDSession } from "../src/role-d-ui/src/domain/session-store"
import { normalizeUnifiedHandoff, unifiedBoundaryReport } from "../src/contracts/unified"
import { defineLearningPathNode, type LearningPathNode } from "../src/role-c-content"

interface LearnerProfile {
  learner_id: string
  level: KnowledgeDifficulty
  known_concepts: string[]
  weak_concepts: string[]
  goal: string
}

const profile = (await Bun.file("examples/role-c-content/learner_score_project_ready.json").json()) as LearnerProfile
const rawPath = (await Bun.file("examples/role-c-content/learning_path_node_score_project.json").json()) as LearningPathNode

const query = [
  `学习者水平：${profile.level}`,
  `已掌握：${profile.known_concepts.join("、")}`,
  `薄弱点：${profile.weak_concepts.join("、")}`,
  `学习目标：${profile.goal}`,
].join("；")

const initialRagResult = await retrieveKnowledge({ query, learnerLevel: profile.level, topK: 5 })
const knowledgeBase = await loadKnowledgeBase()
const pathNode = defineLearningPathNode({
  node_id: rawPath.node_id,
  target_source_ids: rawPath.target_source_ids,
  prerequisite_source_ids: rawPath.prerequisite_source_ids,
  goal: rawPath.goal,
  objectives: rawPath.objectives,
  assessment_blueprint: rawPath.assessment_blueprint,
})

const requiredSourceIds = [...new Set([
  ...pathNode.target_source_ids,
  ...pathNode.prerequisite_source_ids,
])]
const presentSourceIds = new Set(initialRagResult.results.map((item) => item.sourceId))
const missingSourceIds = requiredSourceIds.filter((sourceId) => !presentSourceIds.has(sourceId))
const missingKnowledgeItems = missingSourceIds.map((sourceId) =>
  knowledgeBase.items.find((item) => item.sourceId === sourceId))
if (missingKnowledgeItems.some((item) => !item)) {
  const unknown = missingSourceIds.filter((_sourceId, index) => !missingKnowledgeItems[index])
  throw new Error(`B 路径引用了知识库中不存在的节点：${unknown.join("、")}`)
}
const refreshed = missingSourceIds.length > 0
  ? await retrieveKnowledge({
      query: `学习路径目标与前置证据：${missingKnowledgeItems.map((item) => item!.title).join("、")}；学习目标：${pathNode.goal}`,
      learnerLevel: profile.level,
      topK: Math.max(5, missingSourceIds.length + 2),
    })
  : undefined
const refreshedById = new Map(
  (refreshed?.results ?? []).map((item) => [item.sourceId, item]),
)
const unresolvedSourceIds = missingSourceIds.filter((sourceId) => !refreshedById.has(sourceId))
if (unresolvedSourceIds.length > 0) {
  throw new Error(`A 未返回 B 路径所需证据：${unresolvedSourceIds.join("、")}`)
}
const additions = missingSourceIds.map((sourceId) => refreshedById.get(sourceId)!)
const ragResult = {
  ...initialRagResult,
  topK: Math.max(initialRagResult.topK, initialRagResult.results.length + additions.length),
  results: [...initialRagResult.results, ...additions],
}
const roleC = await generateRoleCForRoleDWithRuntime({
  profile,
  ragResult,
  kbVersion: knowledgeBase.version,
  runId: "RUN-team-integration-demo",
  pathNode,
}, {
  providerMode: "deterministic",
  allowDeterministicFallback: true,
})
const roleDSession = adaptHandoff({
  eventMode: "demo",
  planSource: "real-ab",
  planInput: {
    learnerId: profile.learner_id,
    educationContext: "团队联调样例",
    timeBudget: "每周 3 小时",
    priorLanguages: [],
    knownConcepts: profile.known_concepts,
    weakConcepts: profile.weak_concepts,
  },
  diagnosis: {
    sourceId: "K007",
    factId: "F001",
    concept: "for 循环",
    difficulty: "beginner",
    question: "for 循环最适合用于什么场景？",
    options: ["遍历序列", "定义变量", "捕获异常", "导入模块"],
    answer: "遍历序列",
  },
  session_id: "session-team-integration-demo",
  updated_at: "2026-07-23T00:00:00.000Z",
  b_profile: profile,
  a_rag_result: ragResult,
  workflow_events: roleC.workflow,
  c_artifacts: roleC.artifacts,
  learning_path: pathNode.target_source_ids.map((sourceId, index) => {
    const item = knowledgeBase.items.find((candidate) => candidate.sourceId === sourceId)!
    return {
      id: sourceId,
      title: item.title,
      difficulty: item.difficulty,
      status: index === 0 ? "current" as const : "upcoming" as const,
      reason: `B 正式路径将 ${sourceId} 列为本轮学习目标，A 已补齐相应证据。`,
    }
  }),
  decision: { next: "remediate", reason: "等待 C 正式评分后更新动态路径。" },
})
const progressJson = exportProgressJson(roleDSession, "2026-07-23T00:00:00.000Z")
const progressPreview = JSON.parse(progressJson) as { format: string; version: number; session: unknown }
const boundaryReport = unifiedBoundaryReport(normalizeUnifiedHandoff(roleDSession))

const handoff = {
  workflow: "B_profile_to_A_rag_to_C_content_to_D_display",
  github: {
    repository: "https://github.com/jiangdongouyang-lab/knowbalance.git",
    update_command: "git pull origin main",
  },
  b_profile: {
    ...profile,
    learner_id: "demo_loop_weak",
  },
  a_rag_request: {
    learner_profile: profile,
    query,
    top_k: 5,
  },
  a_rag_result: ragResult,
  c_content_contract: {
    allowed_sources: ["facts", "examples", "practiceTasks", "quizItems"],
    rule: "C must generate lessons, labs, and quizzes only from rag_result evidence.",
    required_citations: ragResult.results.flatMap((item) =>
      item.facts.slice(0, 1).map((fact) => ({ source_id: item.source_id, fact_id: fact.fact_id ?? fact.factId })),
    ),
  },
  d_display_contract: {
    implementation: "src/role-d-ui/ React + Vite frontend, not an empty .gitkeep placeholder",
    persistence: "versioned localStorage workspace + exportable/importable progress JSON",
    required_sections: ["profile", "rag_result", "retrieval_trace", "citations"],
    trace_fields: ["matched_keywords", "matched_fields", "score_breakdown"],
    ui_files: [
      "src/role-d-ui/index.html",
      "src/role-d-ui/src/App.tsx",
      "src/role-d-ui/src/domain/workspace-store.ts",
      "src/role-d-ui/src/domain/progress-file.ts",
      "src/role-d-ui/src/components/EvidenceInspector.tsx",
    ],
    progress_file: {
      format: progressPreview.format,
      version: progressPreview.version,
      session_valid: isValidRoleDSession(progressPreview.session),
      preview_bytes: progressJson.length,
    },
    role_c_status: roleC.status,
    public_artifacts: roleC.artifacts.map((artifact) => ({
      kind: artifact.kind,
      status: artifact.status,
      citations: artifact.citations,
      item_count: artifact.items?.length ?? 0,
    })),
    role_d_session_summary: {
      valid: isValidRoleDSession(roleDSession),
      current_stage: roleDSession.view.currentStage,
      retrieval_items: roleDSession.retrieval.items.length,
      artifacts: roleDSession.artifacts.length,
      workflow_events: roleDSession.workflow.length,
      evidence_gaps: roleDSession.evidenceGaps,
    },
  },
  unified_contract: {
    ...boundaryReport,
    schema_version: boundaryReport.schemaVersion,
    adapter: "normalizeUnifiedHandoff",
    canonical_fields: boundaryReport.canonicalFields,
    evidence_gaps: boundaryReport.evidenceGaps,
    package: "src/contracts/unified",
  },
}

console.log(JSON.stringify(handoff, null, 2))
