import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, vi } from "vitest"

afterEach(() => cleanup())

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn())
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { runId?: string; sessionId?: string; submissionId?: string }
    if (String(_input).includes("/api/role-c/submit")) {
      return new Response(JSON.stringify({
        status: "blocked",
        submission_id: request.submissionId ?? "SUB-TEST",
        code: "ROLE_C_TEST_PENDING",
        message: "测试环境未执行 C 正式评分。",
      }), { status: 422, headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({
      status: "ready",
      runId: request.runId ?? "RUN-TEST",
      learningSession: {
        sessionId: "C-SESSION-TEST",
        formId: "FORM-TEST",
        attemptNo: 1,
      },
      artifacts: [
        {
          id: "ART-CONCEPT-TEST",
          kind: "lesson",
          title: "循环、列表与成绩统计讲义",
          status: "real",
          content: "for 循环常用于遍历序列中的元素。\n\n列表可保存多个有序元素。",
          options: [],
          items: [],
          citations: [{ source_id: "K007", fact_id: "F001" }, { source_id: "K009", fact_id: "F001" }],
        },
        {
          id: "ART-LAB-TEST",
          kind: "lab",
          title: "成绩列表平均值实验",
          status: "real",
          content: "def average_score(scores):\n    # TODO",
          options: [],
          items: [],
          citations: [{ source_id: "K007", fact_id: "F001" }, { source_id: "K009", fact_id: "F001" }, { source_id: "K018", fact_id: "F001" }],
        },
        {
          id: "ART-ASSESSMENT-TEST",
          kind: "assessment",
          title: "循环、列表与成绩统计分阶测评",
          status: "real",
          content: "共 5 道分阶题。",
          options: ["A. 依次处理列表中的每个元素", "B. 安装第三方包"],
          citations: [{ source_id: "K007", fact_id: "F001" }, { source_id: "K009", fact_id: "F001" }, { source_id: "K018", fact_id: "F001" }],
          items: [
            { id: "I1", tier: 1, modality: "mcq", prompt: "for 循环适合做什么？", options: ["A. 依次处理列表中的每个元素", "B. 安装第三方包"], citations: [{ source_id: "K007", fact_id: "F001" }] },
            { id: "I2", tier: 1, modality: "true_false", prompt: "列表有顺序。", options: ["A. 错误", "B. 正确"], citations: [{ source_id: "K009", fact_id: "F001" }] },
            { id: "I3", tier: 2, modality: "trace", prompt: "追踪 total 的值。", options: [], citations: [{ source_id: "K007", fact_id: "F001" }] },
            { id: "I4", tier: 2, modality: "short_answer", prompt: "说明列表如何保存成绩。", options: [], citations: [{ source_id: "K009", fact_id: "F001" }] },
            { id: "I5", tier: 3, modality: "code", prompt: "补全 average_score。", options: [], starter_code: "def average_score(scores):\n    pass", citations: [{ source_id: "K018", fact_id: "F001" }] },
          ],
        },
      ],
      workflow: [
        { id: "C1", agent: "concept-tutor", stage: "定制讲义", status: "completed", summary: "讲义产物已就绪", timestamp: "刚刚" },
        { id: "C2", agent: "code-lab", stage: "代码实验", status: "completed", summary: "代码实验已通过门禁", timestamp: "刚刚" },
        { id: "C3", agent: "tiered-evaluator", stage: "分阶测评", status: "completed", summary: "分阶测评已通过门禁", timestamp: "刚刚" },
        { id: "C4", agent: "auditGeneratedContent()", stage: "A 事实审核", status: "completed", summary: "A 已检查 3 条内容声明，冲突 0 个。", timestamp: "刚刚" },
        { id: "C5", agent: "auditTeaching()", stage: "B 教学审核", status: "completed", summary: "教学审核通过：难度、前置知识、薄弱点覆盖与目标对齐均合格。", timestamp: "刚刚" },
        { id: "C6", agent: "arbitrate()", stage: "B 仲裁", status: "completed", summary: "事实审核与教学审核均通过，内容可发布。", timestamp: "刚刚" },
      ],
      audit: {
        factStatus: "pass",
        factAudits: [
          { artifactId: "ART-CONCEPT-TEST", artifactTitle: "循环、列表与成绩统计讲义", artifactKind: "lesson", status: "pass", checkedClaims: 1, conflicts: 0, notes: [] },
          { artifactId: "ART-LAB-TEST", artifactTitle: "成绩列表平均值实验", artifactKind: "lab", status: "pass", checkedClaims: 1, conflicts: 0, notes: [] },
          { artifactId: "ART-ASSESSMENT-TEST", artifactTitle: "循环、列表与成绩统计分阶测评", artifactKind: "assessment", status: "pass", checkedClaims: 1, conflicts: 0, notes: [] },
        ],
        teachingAudit: {
          artifactId: "role-c-week2-content",
          status: "pass",
          summary: "教学审核通过：难度、前置知识、薄弱点覆盖与目标对齐均合格。",
          revisionHints: [],
        },
        arbitration: {
          artifactId: "role-c-week2-content",
          decision: "pass",
          revisionRound: 0,
          maxRevisionRounds: 2,
          canRevise: false,
          reason: "事实审核与教学审核均通过，内容可发布。",
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }))
})