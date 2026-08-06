import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { InteractiveSessionRepository } from "../src/orchestration/interactive-session-repository"
import { validateOrchestratorApiBody } from "../src/orchestration/orchestrator-api-schema"
import {
  bindPathNodeFactsForRoleC,
  interactiveSessionProductionBoundary,
  resolveRoleCKnowledgeBaseVersion,
  roleCRoundRunId,
} from "../src/orchestration/interactive-session"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("main agent session architecture", () => {
  test("runs C once through the reviewed production boundary", () => {
    expect(interactiveSessionProductionBoundary()).toEqual({
      adapter_workers: ["profile-builder", "path-planner"],
      reviewed_role_c_workers: ["concept-tutor", "code-lab", "tiered-evaluator"],
      review_port: "local-ab-content-review",
    })
  })

  test("uses a fresh C generation identity on retry without changing the learning round", () => {
    expect(roleCRoundRunId("RUN-001", 1, 0)).toBe("RUN-001-R1-C1")
    expect(roleCRoundRunId("RUN-001", 1, 1)).toBe("RUN-001-R1-C2")
  })

  test("uses A's live knowledge-base version for every reviewed C round", async () => {
    expect(await resolveRoleCKnowledgeBaseVersion()).toBe("0.6.0")
    expect(await resolveRoleCKnowledgeBaseVersion()).not.toBe("python-basics-v1")
  })

  test("binds B path objectives to A facts before invoking Role C", () => {
    const node = bindPathNodeFactsForRoleC({
      schema_version: "1.0",
      node_id: "NODE-K001",
      target_source_ids: ["K001"],
      prerequisite_source_ids: [],
      goal: "理解 Python 是什么",
      objectives: [{
        objective_id: "OBJ-K001",
        source_id: "K001",
        required_fact_ids: [],
        observable_behavior: "recognize",
        importance: "core",
      }],
      assessment_blueprint: {
        tier_1_count: 1,
        tier_2_count: 1,
        tier_3_count: 1,
        required_modalities: ["mcq", "short_answer", "code"],
      },
    }, {
      results: [{ source_id: "K001", facts: [{ fact_id: "K001-F1" }] }],
    } as any)

    expect(node.objectives[0]?.required_fact_ids).toEqual(["K001-F1"])
  })

  test("isolates session persistence behind a repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-repository-"))
    roots.push(root)
    const repository = new InteractiveSessionRepository(root)

    const path = repository.sessionPath("SESSION-REPO-001")
    expect(path).toContain("sessions")
    expect(path).toContain("SESSION-REPO-001")
    expect(path).toContain("state.json")
    expect(() => repository.sessionPath("../escape")).toThrow("session_id may only contain")

    await repository.withSessionLock("SESSION-REPO-001", async () => {
      await repository.saveJson("SESSION-REPO-001", { session_id: "SESSION-REPO-001", status: "waiting_for_user" })
    })

    expect(await repository.loadJson<{ session_id: string; status: string }>("SESSION-REPO-001")).toEqual({
      session_id: "SESSION-REPO-001",
      status: "waiting_for_user",
    })
    expect(await repository.loadOptionalJson("SESSION-MISSING")).toBeNull()
  })

  test("uses one schema gate for run requests, session requests, and commands", () => {
    expect(validateOrchestratorApiBody("run", {
      mode: "deterministic",
      learner_request: { learner_id: "learner-001", goal: "学习 Python 循环" },
    })).toEqual({ ok: true, value: {
      mode: "deterministic",
      learner_request: { learner_id: "learner-001", goal: "学习 Python 循环" },
    } })

    expect(validateOrchestratorApiBody("session", {
      mode: "scaffold",
      learner_request: { learner_id: "learner-001", goal: "学习 Python 循环" },
    })).toEqual({
      ok: false,
      errors: ["interactive sessions currently require deterministic mode"],
    })

    expect(validateOrchestratorApiBody("command", {
      command_id: "CMD-001",
      type: "submit_diagnosis_answers",
      payload: { answers: { "DIAG-1-K007": "遍历序列" } },
    })).toEqual({ ok: true, value: {
      command_id: "CMD-001",
      type: "submit_diagnosis_answers",
      payload: { answers: { "DIAG-1-K007": "遍历序列" } },
    } })

    expect(validateOrchestratorApiBody("command", {
      command_id: "../bad",
      type: "submit_diagnosis_answers",
    })).toEqual({
      ok: false,
      errors: ["command_id is required and must be safe"],
    })
  })
})
