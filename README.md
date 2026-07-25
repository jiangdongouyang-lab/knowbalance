# KnowBalance Personalized Learning Workflow

KnowBalance is a personalized Python learning system built around one OpenCode orchestration agent and eight role-specific workers. The repository still includes the native OpenCode registration and ordered worker ledger, but the Week 1 business path is no longer a wiring-only scaffold: Role A provides a traceable Python knowledge base and rule-based RAG, Role B synthesizes evidence-grounded learner profiles, Role C publishes verified lesson/lab/assessment artifacts, and Role D provides the learner-facing Web application.

## Workflow

1. Create or switch a local learner profile and choose one of that learner's plans.
2. Collect background, self-assessment, and knowledge-base diagnostic evidence.
3. Synthesize a learner profile and retrieve a traceable learning path.
4. Generate and verify a concept lesson, code lab, and tiered assessment.
5. Capture learner responses and preserve the plan checkpoint.
6. Grade, update mastery, and decide advance/remediate/reprofile after the remaining Week 2 integration.

The `learning-orchestrator` agent only uses OpenCode's native `task` and `question` tools. Its task permission is limited to the eight registered workers. Worker agents cannot delegate further work. The native OpenCode path remains sequential because some anonymous OpenCode model/provider combinations can close the parent stream after a subagent finishes; the deterministic TypeScript implementations are the reproducible Week 1 verification path.

## Setup

```bash
bun install
bun run check
```

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

Role C implements `concept-tutor`, `code-lab`, and `tiered-evaluator` with a frozen `GenerationSpec`, runtime JSON Schemas, public/secure separation, independent verification, cross-artifact alignment, mixed grading, frozen feedback, idempotent mastery updates, checkpoint recovery and append-only traces. Model-backed Authors use staged generation and deterministic composition. See `docs/role_c_design.md` and `docs/role_c_prompt_index.md`.

```bash
bun run demo:role-c       # profile → RAG → verified concept lesson
bun run demo:role-c:lab   # concept lesson → verified code lab
bun run demo:role-c:full  # three agents → submission → grade → mastery
```

OCI execution uses `ROLE_C_RUNNER_RUNTIME` and a digest-pinned `ROLE_C_RUNNER_IMAGE`:

```bash
bun run demo:role-c:lab:oci
```

For a real model smoke test, copy `.env.role-c.example` to `.env.role-c.local`, set `ROLE_C_MODEL_ENDPOINT`, `ROLE_C_MODEL_ID`, optional `ROLE_C_MODEL_API_KEY`, and `ROLE_C_MODEL_THINKING`, then run:

```bash
bun run smoke:role-c:model
```

`.env.role-c.local` is Git-ignored. `model_config_hash` records the effective model configuration in `GenerationSpec`.

## Role D: guided personalized learning app

Role D provides a React/Vite application with local learner profiles and a per-user learning-plan list. First use collects the background fields required by B; users can switch local profiles, create multiple plans, resume each plan's independent stage and answers, and delete only the selected plan. Existing single-session browser progress migrates into the versioned local workspace.

The Week 1 score-project path runs B profile synthesis, A retrieval, A-prerequisite expansion for a dynamic diagnosis of up to five traceable questions, and the official Role C deterministic pipeline. The verified score-project path currently yields five questions; other goals show only the real answerable questions available from A and its prerequisites rather than padding the set with invented items. Role D renders the verified lesson, code lab, five-item tiered assessment, citations, and agent trace. Selection, true/false, trace, short-answer, and code responses can be entered, saved, refreshed, exported, imported as a sibling plan, and submitted locally. Secure answers, hidden tests, reference solutions, and code suites remain server-side.

Local assessment submission is complete, but formal `gradeSubmission()` delivery, isolated learner-code execution, mastery updates, and automatic remediate/advance decisions remain Week 2 integration work. Local profiles are not cloud accounts and there is no cross-device synchronization yet. See `docs/role_d_frontend_guide.md`.

```bash
bun run role-d:dev
bun run role-d:test
bun run role-d:build
```

Repository tests use `bun test --isolate ./tests` so Role C's schema and frozen-fixture tests run in separate globals on Windows/Bun.

## Current milestone boundary

- **Week 1 complete path:** learner input → B profile → A retrieval → C verified lesson/lab/assessment → D display, response capture, local submission, and checkpoint recovery.
- **Gold path limitation:** the deterministic C provider currently supports the K007/K009/K018 score-project target. Unsupported goals are blocked honestly instead of receiving fabricated artifacts.
- **Week 2 remaining:** formal grading delivery, isolated code execution, mastery evidence, automatic next-step decisions, and the broader review/arbitration visualization required by the project plan.
- **Future product work:** real authentication and cloud synchronization should use a dedicated backend; they must not be simulated with local browser profiles or by widening worker permissions.
