import type { FactAuditInput, GeneratedContentBlock } from "../types"
import type { RagResult } from "../../rag/retriever"
import type { ArtifactEnvelope, CitationRef } from "../../role-c-content/contracts/common"
import type { Claim, ConceptLessonPayload, RenderBlock } from "../../role-c-content/contracts/artifacts"

export interface RoleCBlockContract {
  blockId: string
  text: string
  citations: CitationRef[]
}

export interface AdaptRoleCBlocksInput {
  artifactId: string
  ragResult: RagResult
  blocks: RoleCBlockContract[]
}

export interface AdaptRoleCArtifactInput {
  artifact: ArtifactEnvelope<ConceptLessonPayload>
  ragResult: RagResult
}

export function adaptRoleCBlocksToFactAuditInput(input: AdaptRoleCBlocksInput): FactAuditInput {
  return {
    artifactId: input.artifactId,
    ragResult: input.ragResult,
    generatedContent: {
      blocks: input.blocks.map((block) => ({
        blockId: block.blockId,
        text: block.text,
        citations: block.citations.map(toAuditCitation),
      })),
    },
  }
}

export function adaptRoleCArtifactToFactAuditInput(input: AdaptRoleCArtifactInput): FactAuditInput {
  return {
    artifactId: input.artifact.artifact_id,
    ragResult: input.ragResult,
    generatedContent: {
      blocks: extractConceptLessonBlocks(input.artifact.payload),
    },
  }
}

function extractConceptLessonBlocks(payload: ConceptLessonPayload | null): GeneratedContentBlock[] {
  if (!payload) return []

  return [
    ...claimsFromRenderBlocks(payload.prerequisite_bridge),
    ...claimsFromRenderBlocks(payload.explanation_blocks),
    ...claimsFromRenderBlocks(payload.worked_examples),
    ...payload.misconceptions.map((item) => ({
      blockId: `${item.objective_id}:${item.misconception_tag}`,
      text: item.explanation,
      citations: item.citations.map(toAuditCitation),
    })),
    ...quizBlocks(payload.micro_checks),
    ...payload.hint_ladders.flatMap((ladder) => ladder.hints.map((hint) => ({
      blockId: `${ladder.objective_id}:hint-${hint.hint_level}`,
      text: hint.text,
      citations: hint.citations.map(toAuditCitation),
    }))),
    ...claimsFromRenderBlocks(payload.summary),
  ]
}

function claimsFromRenderBlocks(blocks: RenderBlock[]): GeneratedContentBlock[] {
  return blocks.flatMap((block) => {
    if ("claims" in block) return block.claims.map(claimToBlock)
    if (block.block_type === "hint") return [{ blockId: block.block_id, text: block.text, citations: block.citations.map(toAuditCitation) }]
    if (block.block_type === "quiz") return [{ blockId: block.block_id, text: block.prompt, citations: block.citations.map(toAuditCitation) }]
    return []
  })
}

function quizBlocks(blocks: ConceptLessonPayload["micro_checks"]): GeneratedContentBlock[] {
  return blocks.map((block) => ({
    blockId: block.block_id,
    text: block.prompt,
    citations: block.citations.map(toAuditCitation),
  }))
}

function claimToBlock(claim: Claim): GeneratedContentBlock {
  return {
    blockId: claim.claim_id,
    text: claim.text,
    citations: claim.citations.map(toAuditCitation),
  }
}

function toAuditCitation(citation: CitationRef): GeneratedContentBlock["citations"][number] {
  return {
    source_id: citation.source_id,
    fact_id: citation.fact_id,
  }
}
