import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, vi } from "vitest"

afterEach(() => cleanup())

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn())
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { runId?: string }
    return new Response(JSON.stringify({
      status: "ready",
      runId: request.runId ?? "RUN-TEST",
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
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }))
})