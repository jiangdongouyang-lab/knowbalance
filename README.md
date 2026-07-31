# KnowBalance Personalized Learning Workflow

KnowBalance is a personalized Python learning system built around one OpenCode orchestration agent and eight role-specific workers. The repository still includes the native OpenCode registration and ordered worker ledger, but the Week 1 business path is no longer a wiring-only scaffold: Role A provides a traceable Python knowledge base and rule-based RAG, Role B synthesizes evidence-grounded learner profiles, Role C publishes verified lesson/lab/assessment artifacts, and Role D provides the learner-facing Web application.

## Workflow

1. Create or switch a local learner profile and choose one of that learner's plans.
2. Collect background, self-assessment, and knowledge-base diagnostic evidence.
3. Synthesize a learner profile and retrieve a traceable learning path.
4. Generate and verify a concept lesson, code lab, and tiered assessment.
5. Capture learner responses and preserve the plan checkpoint.
6. Grade the submission, update mastery, return one adaptive decision, and prepare the next learning round.

The `learning-orchestrator` agent only uses OpenCode's native `task` and `question` tools. Its task permission is limited to the eight registered workers. Worker agents cannot delegate further work. The native OpenCode path remains sequential because some anonymous OpenCode model/provider combinations can close the parent stream after a subagent finishes; the deterministic TypeScript implementations are the reproducible Week 1 verification path.

## Setup

```bash
bun install
bun run check
```

编程练习和代码题统一在专用 Docker 镜像中运行。安装并启动 Docker 后，首次使用先构建镜像：

```bash
bun run docker:role-c:build
bun run docker:role-c:doctor
bun run test:role-c:docker
```

Docker 验收依次检查隔离与资源限制、编程练习验证，以及包含代码题判分的完整 C 流程；任一环节未达到 `ready` 都会返回非零退出码。

Copy `opencode.example.json` to `opencode.json` and replace its plugin entry with the absolute `file://` URL for this workspace. The local `opencode.json` is ignored because that path is machine-specific.

Confirm that OpenCode sees all agents without touching the normal OpenCode data directories:

```bash
bash scripts/smoke-test.sh
```

## Run

Choose the orchestrator in the OpenCode UI, or run it headlessly:

```bash
opencode run --agent learning-orchestrator \
  "Goal: learn TypeScript generics. Background: JavaScript developer. Self-rating: beginner. Diagnostic seed: explain when to use a generic instead of any."
```

The native OpenCode orchestration path demonstrates the ordered `[executed:<worker-name>]` ledger. Complete Role C artifacts use the typed pipeline and its validators described below.

### Headless runtime note

With OpenCode `1.17.20`, the currently available anonymous `opencode/*-free` models may close or return an empty parent stream immediately after a native subagent finishes. In that case the JSON output ends after a `task` event even though the parent session has started its next step. Continue the same session from the UI, or run:

```bash
opencode run --session <session-id> --agent learning-orchestrator \
  "Continue the existing scaffold workflow from the next missing worker."
```

This repository's `scripts/smoke-test.sh` intentionally verifies deterministic plugin loading and all nine agent definitions without requiring model credentials. A reliable provider/model is required to use a single headless command as full end-to-end orchestration evidence.

## Role B: learner profile chain (real implementation)

The four evidence workers (`background-collector`, `self-assessor`, `objective-diagnostician`, `profile-builder`) are no longer wiring stubs. They now carry real quote-grounded prompts, backed by a deterministic reference implementation in `src/role-b-profile/` (concept canonicalization onto knowledge-base vocabulary, evidence-priority merging with explicit conflict records, and a ready-to-send `rag_request`). See `docs/role_b_profile_guide.md`.

```bash
bun src/role-b-profile/profile-demo.ts   # end-to-end B chain demo, no model credentials needed
```

## Role A: Python knowledge and traceable retrieval

Role A provides a versioned Python-basics knowledge slice, knowledge facts, examples, practice tasks, real quiz seeds, and a rule-based retriever with beginner-synonym expansion. Results preserve `source_id`, `fact_id`, retrieval reasons, matched fields, and score breakdowns. This is currently deterministic keyword/rule retrieval, not an embedding service.

## Role C: evidence-constrained content generation

Role C implements `concept-tutor`, `code-lab`, and `tiered-evaluator` with a frozen `GenerationSpec`, runtime JSON Schemas, public/secure separation, Docker code execution, A/B content review, mixed grading, persistent mastery updates, unified dynamic feedback, atomic delivery envelopes, and reviewed next-round regeneration. Model-backed Authors use staged generation and deterministic composition. See `docs/role_c_design.md` and `docs/role_c_prompt_index.md`.

```bash
bun run demo:role-c       # profile → RAG → verified concept lesson
bun run demo:role-c:lab   # concept lesson → Docker-verified code lab
bun run demo:role-c:full  # three agents → review → Docker grading → next reviewed round
```

`code-lab` 参考答案校验、可选错误变体诊断、测评代码题校验和学习者代码评分共用
`DockerPythonCodeRunner`。Runner 每次使用镜像的不可变本地 image ID，并关闭网络、使用只读
文件系统和非 root 用户，同时限制 CPU、内存、进程数、运行时间、临时目录和输出大小。
隐藏测试的期望答案与权重不进入容器，Docker 只返回代码的实际运行结果，由后端完成比较和计分。
镜像名称及资源参数可通过 `.env.role-c.example` 中列出的 `ROLE_C_DOCKER_*` 环境变量覆盖。

For a real model smoke test, copy `.env.role-c.example` to `.env.role-c.local`, set `ROLE_C_MODEL_ENDPOINT`, `ROLE_C_MODEL_ID`, optional `ROLE_C_MODEL_API_KEY`, and `ROLE_C_MODEL_THINKING`, then run:

```bash
bun run smoke:role-c:model
```

`.env.role-c.local` is Git-ignored. `model_config_hash` records the effective model configuration in `GenerationSpec`.

## Role D: guided personalized learning app

Role D provides a React/Vite application with local learner profiles and a per-user learning-plan list. First use collects the background fields required by B; users can switch local profiles, create multiple plans, resume each plan's independent stage and answers, and delete only the selected plan. Existing single-session browser progress migrates into the versioned local workspace.

The learning path is built from the learner profile, A retrieval, knowledge prerequisites, and B's formal path contract. Role C then generates and reviews a lesson, code lab, and blueprint-driven assessment for the selected targets. Role D renders the public artifacts, citations, and trace; supports every published question modality; and submits answers to C for trusted grading, mastery updates, adaptive decisions, and reviewed recovery. Secure answers, hidden tests, reference solutions, and code suites remain server-side.

Local profiles are not cloud accounts and there is no cross-device synchronization yet. See `docs/role_d_frontend_guide.md`.

```bash
bun run role-d:dev
bun run role-d:test
bun run role-d:build
```

### Share the Role D frontend with teammates

The repository includes the full Role D frontend and its local Vite API middleware. A/B/C teammates can run the same page from a fresh clone without copying any local secrets:

```bash
git clone https://github.com/jiangdongouyang-lab/knowbalance.git
cd knowbalance
bun install --frozen-lockfile
bun run role-d:dev -- --host 127.0.0.1 --port 5174
```

Open `http://127.0.0.1:5174/` in a browser. The page shell opens without Docker or a model key; content generation fails closed until a Provider is configured. For the normal model-backed path, copy `.env.role-c.example` to `.env.role-c.local`, fill the model endpoint/model/key, build the Role C Docker image, and restart the command. The fixed deterministic templates are available only when `ROLE_C_PROVIDER_MODE=deterministic` is selected explicitly for offline regression. `.env.role-c.local` is ignored and must never be committed.

The local Vite middleware exposes `/api/role-c/generate` and `/api/role-c/submit` for this demo. It is a development/integration harness, not a production backend; do not expose it publicly or use it as a substitute for C's persistent service.

Repository tests use `bun test --isolate ./tests` so Role C's schema and frozen-fixture tests run in separate globals on Windows/Bun.

## Current milestone boundary

- **Complete path:** learner input → B profile and path → A retrieval and exact path evidence → C staged model generation, Docker verification, A/B review and recovery → D display and trusted submission.
- **Provider modes:** the model Provider consumes arbitrary formal targets within the published schemas; deterministic templates are explicit offline regression fixtures.
- **Adaptive cycle:** formal grading, isolated code execution, mastery evidence, adaptive decisions, idempotent delivery, persistence, and reviewed next-round regeneration are implemented behind transport-neutral ports.
- **Future product work:** real authentication and cloud synchronization should use a dedicated backend; they must not be simulated with local browser profiles or by widening worker permissions.
