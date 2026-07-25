import { describe, expect, test } from "bun:test"
import { auditGeneratedContent } from "../src/fact-audit/auditor"
import { adaptRoleCArtifactToFactAuditInput, adaptRoleCBlocksToFactAuditInput } from "../src/fact-audit/adapters/role-c-block-adapter"
import { retrieveKnowledge } from "../src/rag/retriever"
import type { ArtifactEnvelope } from "../src/role-c-content/contracts/common"
import type { ConceptLessonPayload } from "../src/role-c-content/contracts/artifacts"

const versions = {
  profile_version: "test-profile",
  kb_version: "python-basic@0.1.0",
  rag_version: "rule-rag@0.1.0",
  prompt_version: "test-prompt",
  model_config_hash: "test-model",
  schema_version: "1.0" as const,
}

describe("Role C fact-audit adapter", () => {
  test("adapts a simple Role C block contract into FactAuditInput", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const input = adaptRoleCBlocksToFactAuditInput({
      artifactId: "role-c-simple",
      ragResult,
      blocks: [{
        blockId: "block-1",
        text: "for 循环常用于遍历序列中的元素。",
        citations: [{ source_id: "K007", fact_id: "F001", relation: "supports" }],
      }],
    })

    expect(input).toEqual({
      artifactId: "role-c-simple",
      ragResult,
      generatedContent: {
        blocks: [{
          blockId: "block-1",
          text: "for 循环常用于遍历序列中的元素。",
          citations: [{ source_id: "K007", fact_id: "F001" }],
        }],
      },
    })
    expect(auditGeneratedContent(input).status).toBe("pass")
  })

  test("keeps missing citations visible so the audit can require revision", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const input = adaptRoleCBlocksToFactAuditInput({
      artifactId: "role-c-missing-citation",
      ragResult,
      blocks: [{
        blockId: "block-1",
        text: "for 循环可以帮助学习者处理重复任务。",
        citations: [],
      }],
    })

    expect(auditGeneratedContent(input).status).toBe("revise")
  })

  test("keeps fake citations visible so the audit can reject them", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const input = adaptRoleCBlocksToFactAuditInput({
      artifactId: "role-c-fake-citation",
      ragResult,
      blocks: [{
        blockId: "block-1",
        text: "for 循环常用于遍历序列中的元素。",
        citations: [{ source_id: "K999", fact_id: "F001", relation: "supports" }],
      }],
    })

    expect(auditGeneratedContent(input).status).toBe("reject")
  })

  test("extracts claims from a Role C concept lesson artifact envelope", async () => {
    const ragResult = await retrieveKnowledge({ query: "怎么让代码重复执行", learnerLevel: "beginner", topK: 3 })
    const artifact: ArtifactEnvelope<ConceptLessonPayload> = {
      schema_version: "1.0",
      run_id: "run-1",
      artifact_id: "concept-lesson-1",
      artifact_type: "concept_lesson",
      agent: "concept-tutor",
      status: "ready",
      versions,
      seed: 1,
      input_refs: ["rag-1"],
      citations: [{ source_id: "K007", fact_id: "F001", relation: "supports" }],
      quality: { schema_ok: true, citation_coverage: 1, objective_coverage: 1, alignment_score: 1 },
      trace_ref: "trace-1",
      payload: {
        title: "for 循环入门",
        objective_ids: ["OBJ-K007"],
        prerequisite_bridge: [],
        explanation_blocks: [{
          block_id: "explain-1",
          block_type: "paragraph",
          text: "for 循环常用于遍历序列中的元素。",
          claims: [{
            claim_id: "claim-1",
            text: "for 循环常用于遍历序列中的元素。",
            citations: [{ source_id: "K007", fact_id: "F001", relation: "supports" }],
          }],
        }],
        worked_examples: [],
        misconceptions: [],
        micro_checks: [],
        hint_ladders: [],
        summary: [],
        objective_coverage: [{ objective_id: "OBJ-K007", block_ids: ["explain-1"] }],
        used_evidence: [{ source_id: "K007", fact_id: "F001", relation: "supports" }],
      },
    }

    const input = adaptRoleCArtifactToFactAuditInput({ artifact, ragResult })

    expect(input.artifactId).toBe("concept-lesson-1")
    expect(input.generatedContent.blocks).toEqual([{ blockId: "claim-1", text: "for 循环常用于遍历序列中的元素。", citations: [{ source_id: "K007", fact_id: "F001" }] }])
    expect(auditGeneratedContent(input).status).toBe("pass")
  })
})
