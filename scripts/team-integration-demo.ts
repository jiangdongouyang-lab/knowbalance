import { retrieveKnowledge } from "../src/rag/retriever"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeDifficulty } from "../src/knowledge/types"
import { generateRoleCForRoleD } from "../src/role-d-integration/role-c-service"
import { adaptHandoff } from "../src/role-d-ui/src/domain/adapt-handoff"
import { exportProgressJson } from "../src/role-d-ui/src/domain/progress-file"
import { isValidRoleDSession } from "../src/role-d-ui/src/domain/session-store"

interface LearnerProfile {
  learner_id: string
  level: KnowledgeDifficulty
  known_concepts: string[]
  weak_concepts: string[]
  goal: string
}

const profile = (await Bun.file("examples/learner_loop_weak.json").json()) as LearnerProfile

const query = [
  `学习者水平：${profile.level}`,
  `已掌握：${profile.known_concepts.join("、")}`,
  `薄弱点：${profile.weak_concepts.join("、")}`,
  `学习目标：${profile.goal}`,
].join("；")

const ragResult = await retrieveKnowledge({ query, learnerLevel: profile.level, topK: 5 })
const knowledgeBase = await loadKnowledgeBase()
const roleC = await generateRoleCForRoleD({
  profile,
  ragResult,
  kbVersion: knowledgeBase.version,
  runId: "RUN-team-integration-demo",
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
  learning_path: [
    { id: "for-loop", title: "for 循环", difficulty: "beginner", status: "current", reason: "A 检索命中 K007，作为当前补强点。" },
    { id: "list", title: "列表", difficulty: "basic", status: "upcoming", reason: "A 检索命中 K009，支撑成绩数据集合。" },
    { id: "score-project", title: "成绩统计器综合项目", difficulty: "integrated", status: "upcoming", reason: "A 检索命中 K018，作为项目化目标。" },
  ],
  decision: { next: "remediate", reason: "等待 C 正式评分后更新动态路径。" },
})
const progressJson = exportProgressJson(roleDSession, "2026-07-23T00:00:00.000Z")
const progressPreview = JSON.parse(progressJson) as { format: string; version: number; session: unknown }

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
}

console.log(JSON.stringify(handoff, null, 2))
