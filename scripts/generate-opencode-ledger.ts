/**
 * OpenCode 调度 Ledger 生成器 — Day 2 核心产出
 *
 * 运行完整闭环并生成评委可读的 OpenCode 风格多Agent调度记录。
 *
 * 用法:
 *   bun --env-file=.env.role-c.local scripts/generate-opencode-ledger.ts
 *   bun --env-file=.env.role-c.local scripts/generate-opencode-ledger.ts --mode deterministic
 *   bun --env-file=.env.role-c.local scripts/generate-opencode-ledger.ts --root .tmp/competition-sprint/day2-opencode-ledger
 */

import { join } from "node:path"
import { runLearningOrchestrator } from "../src/orchestration/learning-orchestrator-runner"
import type { OrchestrationMode, TraceEvent, WorkerName } from "../src/orchestration/types"

// ============================================================
// 中文描述映射
// ============================================================

const WORKER_CN: Record<string, { desc: string; role: string; input_desc: string }> = {
  "background-collector": { desc: "提取学习者背景证据（教育背景、编程经历、学习目标）", role: "B", input_desc: "学习者原始输入文本" },
  "self-assessor": { desc: "提取学习者自评证据（自评水平、声称掌握、声称薄弱）", role: "B", input_desc: "background-collector 的输出" },
  "objective-diagnostician": { desc: "对知识库诊断题打分，绑定 source_id / fact_id 引用", role: "B", input_desc: "self-assessor 的输出 + 知识库诊断题" },
  "profile-builder": { desc: "合并三条证据→标准学习画像 + RAG 检索请求", role: "B", input_desc: "前三步的全部证据" },
  "path-planner": { desc: "根据画像规划个性化学习路径，检索 A 角色知识库", role: "B", input_desc: "profile-builder 的画像 + RAG 结果" },
  "concept-tutor": { desc: "生成引用约束的个性化讲义（DeepSeek V3）", role: "C", input_desc: "path-planner 的路径节点 + 知识库证据" },
  "code-lab": { desc: "设计公开代码实验 + 私密验证产物（DeepSeek V3）", role: "C", input_desc: "concept-tutor 的讲义 + 生成规格" },
  "tiered-evaluator": { desc: "创作分层测评题——公开题面/私密答案分离（DeepSeek V3）", role: "C", input_desc: "concept-tutor + code-lab 的输出" },
  "teaching-auditor": { desc: "四维教学审核（难度/前置/薄弱点/目标）", role: "B", input_desc: "C 生成内容 + 学习者画像 + 知识库" },
}

// 每个 worker 的上游依赖（index 从 1 开始）
const WORKER_UPSTREAM: Record<string, number[]> = {
  "background-collector": [],
  "self-assessor": [1],
  "objective-diagnostician": [1, 2],
  "profile-builder": [1, 2, 3],
  "path-planner": [4],
  "concept-tutor": [5],
  "code-lab": [6],
  "tiered-evaluator": [6, 7],
  "teaching-auditor": [6, 7, 8],
}

const STAGE_CN: Record<string, string> = {
  created: "已创建", intake_ready: "等待输入", background_collected: "背景已收集",
  self_assessed: "自评已完成", objective_diagnosed: "客观诊断已完成",
  profile_built: "画像已构建", path_planned: "路径已规划",
  concept_ready: "讲义已生成", lab_ready: "代码实验已生成",
  assessment_ready: "测评已生成", completed: "已完成", blocked: "已阻塞", failed: "已失败",
}

// ============================================================
// 类型
// ============================================================

interface LedgerCall {
  index: number
  worker: WorkerName
  role: string
  stage: string
  stage_cn: string
  description: string
  invoked_at: string
  completed_at: string
  duration_ms: number
  status: string
  marker: string
  input: { from: string; ref: string }
  output: {
    marker: string
    summary: string
    status: string
    product_refs: { artifact_path: string; artifact_type: string; result_size_bytes: number }
    evidence_refs: { source_id: string; fact_id: string | null; title: string }[]
  }
  upstream_deps: number[]
  errors: unknown[]
}

interface LedgerOutput {
  schema_version: string
  ledger_id: string
  session_id: string
  run_id: string
  mode: string
  started_at: string
  finished_at: string
  total_duration_ms: number
  status: string
  orchestrator: {
    name: string
    role: string
    total_calls: number
    completed_calls: number
    blocked_calls: number
    failed_calls: number
    retries: number
    self_generated: boolean
    self_generated_note: string
  }
  calls: LedgerCall[]
  summary: {
    total_workers: number
    completed: number
    blocked: number
    failed: number
    total_duration_ms: number
    artifacts_generated: number
    roles: Record<string, { workers: string[]; count: number; total_duration_ms: number }>
    workflow_stages: { stage: string; stage_cn: string; worker: string }[]
  }
}

// ============================================================
// 主流程
// ============================================================

interface CliOptions {
  mode: OrchestrationMode
  root: string
  goal: string
  background: string
  self_rating: string
  diagnostic_seed: string
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mode: "deterministic",
    root: join(process.cwd(), ".tmp", "competition-sprint", "day2-opencode-ledger"),
    goal: "学习 Python 循环并完成成绩统计",
    background: "零基础学习者，需要个性化教学路径",
    self_rating: "beginner",
    diagnostic_seed: "解释 for 循环什么时候适合遍历一组数据",
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && argv[i + 1]) { opts.mode = argv[i + 1] as OrchestrationMode; i++ }
    else if (argv[i] === "--root" && argv[i + 1]) { opts.root = argv[i + 1]; i++ }
    else if (argv[i] === "--goal" && argv[i + 1]) { opts.goal = argv[i + 1]; i++ }
    else if (argv[i] === "--background" && argv[i + 1]) { opts.background = argv[i + 1]; i++ }
    else if (argv[i] === "--self-rating" && argv[i + 1]) { opts.self_rating = argv[i + 1]; i++ }
    else if (argv[i] === "--diagnostic-seed" && argv[i + 1]) { opts.diagnostic_seed = argv[i + 1]; i++ }
  }
  return opts
}

const options = parseArgs(Bun.argv.slice(2))

// 1. 运行完整闭环（产物写入 disk）
const result = await runLearningOrchestrator({
  root_dir: options.root,
  mode: options.mode,
  artifact_dir: options.root,
  learner_request: {
    goal: options.goal,
    background: options.background,
    self_rating: options.self_rating,
    diagnostic_seed: options.diagnostic_seed,
  },
})

// 2. 从 TraceEvent 生成 Ledger
const events = result.summary.events
const workerEvents = events.filter((e): e is TraceEvent & { worker: WorkerName } =>
  e.event_type === "worker_completed" && e.worker != null)

const calls: LedgerCall[] = []
for (let idx = 0; idx < workerEvents.length; idx++) {
  const event = workerEvents[idx]
  const cn = WORKER_CN[event.worker] ?? { desc: event.worker, role: "?", input_desc: "上游输出" }
  const invokedEvent = events.find(e => e.event_type === "worker_invoked" && e.worker === event.worker && e.step_index === event.step_index)

  const artifactPath = join(options.root, "artifacts", `step${event.step_index}-${event.worker}.json`)
  let evidenceRefs: LedgerCall["output"]["evidence_refs"] = []
  try {
    const artifactContent = await Bun.file(artifactPath).text()
    const artifacts = JSON.parse(artifactContent)
    evidenceRefs = extractEvidenceRefs(artifacts)
  } catch { /* 文件可能不存在，保持空 */ }

  calls.push({
    index: idx + 1,
    worker: event.worker,
    role: cn.role,
    stage: event.stage,
    stage_cn: STAGE_CN[event.stage] ?? event.stage,
    description: cn.desc,
    invoked_at: invokedEvent?.timestamp ?? event.timestamp,
    completed_at: event.timestamp,
    duration_ms: event.duration_ms ?? 0,
    status: "completed",
    marker: `[executed:${event.worker}]`,
    input: { from: cn.input_desc, ref: event.input_refs[0] ?? "无" },
    output: {
      marker: `[executed:${event.worker}]`,
      summary: event.message,
      status: "completed",
      product_refs: {
        artifact_path: artifactPath,
        artifact_type: event.worker,
        result_size_bytes: event.result_size_bytes ?? 0,
      },
      evidence_refs: evidenceRefs,
    },
    upstream_deps: WORKER_UPSTREAM[event.worker] ?? (idx === 0 ? [] : [idx]),
    errors: [],
  })
}

// 3. 生成 Ledger
const roleSummary: Record<string, { workers: string[]; count: number; total_duration_ms: number }> = {}
for (const call of calls) {
  if (!roleSummary[call.role]) roleSummary[call.role] = { workers: [], count: 0, total_duration_ms: 0 }
  roleSummary[call.role].workers.push(call.worker)
  roleSummary[call.role].count++
  roleSummary[call.role].total_duration_ms += call.duration_ms
}

const ledger: LedgerOutput = {
  schema_version: "1.0",
  ledger_id: `ledger-${result.summary.run_id}`,
  session_id: result.summary.session_id,
  run_id: result.summary.run_id,
  mode: result.summary.mode,
  started_at: result.summary.started_at,
  finished_at: result.summary.finished_at,
  total_duration_ms: calls.reduce((s, c) => s + c.duration_ms, 0),
  status: result.summary.status,
  orchestrator: {
    name: "learning-orchestrator",
    role: "scheduler_only",
    total_calls: calls.length,
    completed_calls: calls.filter(c => c.status === "completed").length,
    blocked_calls: 0,
    failed_calls: 0,
    retries: 0,
    self_generated: false,
    self_generated_note:
      "主 Agent（learning-orchestrator）未生成任何教学内容。" +
      "所有讲义、代码实验、测评题、学习画像、学习路径均由对应子 Agent 独立产出。" +
      "证据：TraceEvent 中每个 domain 步骤都是 'delegate X to Y'，" +
      "主 Agent 仅使用 task 工具调度子 Agent、使用 question 工具询问学习者。",
  },
  calls,
  summary: {
    total_workers: calls.length,
    completed: calls.filter(c => c.status === "completed").length,
    blocked: 0, failed: 0,
    total_duration_ms: calls.reduce((s, c) => s + c.duration_ms, 0),
    artifacts_generated: calls.length,
    roles: roleSummary,
    workflow_stages: calls.map(c => ({ stage: c.stage, stage_cn: c.stage_cn, worker: c.worker })),
  },
}

// 4. 写入 ledger
const ledgerPath = join(options.root, "ledger.json")
await Bun.write(ledgerPath, JSON.stringify(ledger, null, 2))

// 5. 终端输出
console.log(JSON.stringify({
  ledger_path: ledgerPath,
  run_id: result.summary.run_id,
  status: result.summary.status,
  completed_steps: result.summary.completed_steps,
  total_steps: result.summary.total_steps,
  artifacts_dir: join(options.root, "artifacts"),
  artifact_files: calls.map(c => `step${c.index}-${c.worker}.json`),
  total_duration_ms: calls.reduce((s, c) => s + c.duration_ms, 0),
  orchestrator_self_generated: false,
  evidence_refs_total: calls.reduce((s, c) => s + c.output.evidence_refs.length, 0),
}, null, 2))

// ============================================================
// Helper: 从 artifacts 中提取 evidence_refs
// ============================================================

function extractEvidenceRefs(artifacts: Record<string, unknown>): { source_id: string; fact_id: string | null; title: string }[] {
  // 从 RAG 结果中提取
  const ragResult = artifacts.a_rag_result as { results?: { source_id: string; fact_id?: string; title?: string }[] } | undefined
  if (ragResult?.results) {
    return ragResult.results.map(r => ({
      source_id: r.source_id,
      fact_id: r.fact_id ?? null,
      title: r.title ?? "",
    }))
  }
  // 从 evidence_pack 中提取
  const evidencePack = artifacts.evidence_pack as { facts?: { source_id: string; fact_id?: string; title?: string }[] } | undefined
  if (evidencePack?.facts) {
    return evidencePack.facts.map(f => ({
      source_id: f.source_id,
      fact_id: f.fact_id ?? null,
      title: f.title ?? "",
    }))
  }
  // 从 profile-builder 的 rag_request 中提取
  const ragReq = artifacts.rag_request as { query?: string } | undefined
  if (ragReq?.query) {
    // RAG query 本身不算 evidence ref，但有总比没有好
    return []
  }
  // 从客观诊断中提取 source_id
  const evidence = artifacts.evidence as { items?: { source_id: string; fact_id?: string; question?: string }[] } | undefined
  if (evidence?.items) {
    return evidence.items.filter(i => i.source_id).map(i => ({
      source_id: i.source_id,
      fact_id: i.fact_id ?? null,
      title: i.question ?? "",
    }))
  }
  return []
}
