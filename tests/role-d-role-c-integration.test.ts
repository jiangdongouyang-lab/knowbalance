import { describe, expect, test } from "bun:test"
import { loadKnowledgeBase } from "../src/knowledge/loader"
import { executeProfileRetrieval } from "../src/role-b-profile/rag-bridge"
import { synthesizeProfile } from "../src/role-b-profile/profile-synthesizer"
import { generateRoleCForRoleD } from "../src/role-d-integration/role-c-service"

describe("Role D → official Role C Week 1 integration", () => {
  test("returns three grounded real artifacts and the complete C trace", async () => {
    const knowledgeBase = await loadKnowledgeBase()
    const synthesis = synthesizeProfile({
      background: {
        evidence_type: "background",
        learner_id: "student-week1-001",
        education_context: "大二非计算机专业",
        prior_languages: ["Python"],
        prior_topics: ["变量", "列表"],
        goal_raw: "完成成绩统计程序",
        time_budget: "每周 4 小时",
        quotes: [],
      },
      selfAssessment: {
        evidence_type: "self_assessment",
        self_rating: "basic",
        claimed_known: ["变量", "列表"],
        claimed_weak: ["循环"],
        quotes: [],
      },
      objectiveDiagnosis: { evidence_type: "objective_diagnosis", items: [], quotes: [] },
      knowledgeBase,
    })
    const { rag_result: ragResult } = await executeProfileRetrieval(synthesis.profile)

    const result = await generateRoleCForRoleD({
      profile: synthesis.profile,
      ragResult,
      kbVersion: knowledgeBase.version,
      runId: "RUN-D-WEEK1-INTEGRATION",
    })

    expect(result.status).toBe("ready")
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["lesson", "lab", "assessment"])
    expect(result.artifacts.every((artifact) => artifact.status === "real")).toBe(true)
    expect(result.artifacts.every((artifact) => artifact.citations.length > 0)).toBe(true)
    expect(result.artifacts.find((artifact) => artifact.kind === "assessment")?.items).toHaveLength(5)
    expect(result.workflow.some((event) => event.agent === "concept-tutor" && event.status === "completed")).toBe(true)
    expect(result.workflow.some((event) => event.agent === "code-lab" && event.status === "completed")).toBe(true)
    expect(result.workflow.some((event) => event.agent === "tiered-evaluator" && event.status === "completed")).toBe(true)

    const validFacts = new Set(ragResult.results.flatMap((item) => item.facts.map((fact) => `${fact.sourceId ?? fact.source_id}-${fact.factId ?? fact.fact_id}`)))
    for (const artifact of result.artifacts) {
      for (const citation of artifact.citations) {
        expect(validFacts.has(`${citation.source_id}-${citation.fact_id}`)).toBe(true)
      }
    }
  })
})
