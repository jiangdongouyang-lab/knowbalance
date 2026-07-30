import { retrieveKnowledge } from "../src/rag/retriever"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import type { KnowledgeDifficulty } from "../src/knowledge/types"
import { RoleBLearningProgressAdapter } from "../src/role-b-profile/teaching-audit"
import { RoleDRoleCDeliveryReceiver } from "../src/role-d-integration/role-c-delivery-receiver"
import {
  continueRoleCAfterSubmission,
  generateRoleCForRoleDWithRuntime,
  routeRoleCAssessment,
  submitRoleCAssessment,
} from "../src/role-d-integration/role-c-service"
import { adaptHandoff } from "../src/role-d-ui/src/domain/adapt-handoff"
import { exportProgressJson } from "../src/role-d-ui/src/domain/progress-file"
import { isValidRoleDSession } from "../src/role-d-ui/src/domain/session-store"
import {
  createDockerPythonCodeRunnerFromEnv,
  NodeDockerCommandExecutor,
} from "../src/role-c-content"

interface LearnerProfile {
  learner_id: string
  level: KnowledgeDifficulty
  known_concepts: string[]
  weak_concepts: string[]
  goal: string
}

const profileInput = (await Bun.file(
  "examples/learner_project_goal.json",
).json()) as LearnerProfile
const profile: LearnerProfile = {
  ...profileInput,
  learner_id: "demo_project_goal",
  level: "intermediate",
  known_concepts: [
    ...new Set([...profileInput.known_concepts, "基本数据类型"]),
  ],
}

const query = [
  `学习者水平：${profile.level}`,
  `已掌握：${profile.known_concepts.join("、")}`,
  `薄弱点：${profile.weak_concepts.join("、")}`,
  `学习目标：${profile.goal}`,
].join("；")

const ragResult = await retrieveKnowledge({ query, learnerLevel: profile.level, topK: 5 })
const knowledgeBase = await loadKnowledgeBase()
const runId = "RUN-team-integration-demo"
const roleB = new RoleBLearningProgressAdapter({
  knowledgeBase,
  learners: [{
    learnerIdHash: profile.learner_id,
    currentProfile: profile,
    profileVersion: `${runId}-profile-v1`,
    profileRevision: 1,
  }],
})
const roleD = new RoleDRoleCDeliveryReceiver(
  "role-d-team-integration-demo",
)
const runner = await createDockerPythonCodeRunnerFromEnv(process.env, {
  executor: new NodeDockerCommandExecutor(),
})
const roleC = await generateRoleCForRoleDWithRuntime({
  profile,
  ragResult,
  kbVersion: knowledgeBase.version,
  runId,
}, {
  runner,
  learningProgressPort: roleB,
  roleDPort: roleD,
})
if (roleC.status !== "ready") {
  throw new Error(`TEAM_ROLE_C_GENERATION_FAILED:${roleC.reason}`)
}
const firstIdentity = {
  sessionId: roleC.learningSession.sessionId,
  runId: roleC.runId,
  learnerId: profile.learner_id,
  formId: roleC.learningSession.formId,
  attemptNo: roleC.learningSession.attemptNo,
}
const firstRoute = await routeRoleCAssessment({
  ...firstIdentity,
  routingRequestId: roleC.learningSession.routingRequestId,
  submissionId: "SUB-team-integration-anchors-1",
  answers: anchorAnswers(),
})
if (firstRoute.status !== "routed") {
  throw new Error(`TEAM_ROLE_C_ROUTE_FAILED:${JSON.stringify(firstRoute)}`)
}
const firstCompletion = await submitRoleCAssessment({
  ...firstIdentity,
  submissionId: "SUB-team-integration-final-1",
  answers: reinforcementAnswers().filter((answer) =>
    firstRoute.requiredItemIds.includes(answer.item_id)),
})
if (firstCompletion.status !== "completed") {
  throw new Error(
    `TEAM_ROLE_C_SUBMISSION_FAILED:${JSON.stringify(firstCompletion)}`,
  )
}
const updatedBState = roleB.getCurrentState(profile.learner_id)
if (!updatedBState) throw new Error("TEAM_ROLE_B_STATE_MISSING")
const continuation = await continueRoleCAfterSubmission({
  sessionId: firstIdentity.sessionId,
  submissionId: "SUB-team-integration-final-1",
  learnerId: profile.learner_id,
  nextProfileSnapshot: updatedBState.currentSnapshot,
})
if (continuation.status !== "published") {
  throw new Error(
    `TEAM_ROLE_C_CONTINUATION_FAILED:${JSON.stringify(continuation)}`,
  )
}
const nextSession = continuation.learning_session
const nextRoute = await routeRoleCAssessment({
  sessionId: nextSession.session_id,
  runId: nextSession.run_id,
  learnerId: profile.learner_id,
  formId: nextSession.form_id,
  attemptNo: nextSession.attempt_no,
  routingRequestId: nextSession.routing_request_id,
  submissionId: "SUB-team-integration-anchors-2",
  answers: anchorAnswers(),
})
if (nextRoute.status !== "routed") {
  throw new Error(
    `TEAM_ROLE_C_NEXT_ROUTE_FAILED:${JSON.stringify(nextRoute)}`,
  )
}
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
  adaptive_learning_loop: {
    first_session_phase: roleC.learningSession.phase,
    first_route_phase: firstRoute.learningSession.phase,
    first_round_accuracy: firstCompletion.feedback.round_score.accuracy,
    first_round_action: firstCompletion.feedback.final_decision.action,
    b_profile_revision: updatedBState.profileRevision,
    b_profile_version: updatedBState.profileVersion,
    next_round_status: continuation.status,
    next_round_action: continuation.preparation.action,
    next_session_phase: continuation.learning_session.phase,
    next_route_status: nextRoute.status,
    next_route_phase: nextRoute.learningSession.phase,
    d_reviewed_releases: roleD.snapshot().reviewed_releases.length,
    d_learning_session_updates: roleD.snapshot().learning_sessions.length,
  },
}

console.log(JSON.stringify(handoff, null, 2))

function anchorAnswers() {
  return [
    {
      item_id: "ITEM-O1-T1-MCQ",
      selected_option_id: "opt_iterate",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O2-T1-TF",
      selected_option_id: "opt_true",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O1-T2-TRACE",
      text_response: "8",
      hint_level_used: 0 as const,
    },
  ]
}

function reinforcementAnswers() {
  return [
    ...anchorAnswers(),
    {
      item_id: "ITEM-O2-T2-SHORT",
      text_response:
        "列表保存一组成绩并保持顺序，程序可以逐项处理。",
      hint_level_used: 0 as const,
    },
    {
      item_id: "ITEM-O3-T3-CODE",
      code_response: "def average_score(scores):\n    return None",
      hint_level_used: 0 as const,
    },
  ]
}
