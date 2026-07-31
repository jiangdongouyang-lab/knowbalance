import { auditGeneratedContent } from "../src/fact-audit/auditor"
import { adaptRoleCBlocksToFactAuditInput, type RoleCBlockContract } from "../src/fact-audit/adapters/role-c-block-adapter"
import { retrieveKnowledge } from "../src/rag/retriever"
import type { KnowledgeDifficulty } from "../src/knowledge/types"
import type { FactAuditInput } from "../src/fact-audit/types"
import type { RagEvidencePack } from "../src/role-c-content/contracts/evidence-pack"

interface RoleCArtifactJson {
  artifactId: string
  query?: string
  learnerLevel?: KnowledgeDifficulty
  topK?: number
  blocks: RoleCBlockContract[]
}

const { inputFile, evidenceFile, expectedEvidenceHash } = parseArgs(process.argv.slice(2))

if (!inputFile) {
  printValidationError("MISSING_INPUT_FILE", "Usage: bun scripts/audit-role-c-json.ts <role-c-artifact.json>", 1)
}

const artifact = await readAndValidateArtifact(inputFile)
const { auditInput, evidenceSource, ragSources } = await buildAuditInput(artifact)

console.log(JSON.stringify({
  workflow: "Audit_RoleC_JSON_File",
  ok: true,
  input_file: inputFile,
  evidence_source: evidenceSource,
  rag_sources: ragSources,
  audit: auditGeneratedContent(auditInput),
}, null, 2))

function parseArgs(args: string[]): { inputFile?: string; evidenceFile?: string; expectedEvidenceHash?: string } {
  const parsed: { inputFile?: string; evidenceFile?: string; expectedEvidenceHash?: string } = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--evidence") {
      parsed.evidenceFile = args[index + 1]
      index += 1
      continue
    }
    if (arg === "--expected-evidence-hash") {
      parsed.expectedEvidenceHash = args[index + 1]
      index += 1
      continue
    }
    if (!parsed.inputFile) {
      parsed.inputFile = arg
      continue
    }
    printValidationError("UNKNOWN_ARGUMENT", `Unknown argument: ${arg}`)
  }
  return parsed
}

async function buildAuditInput(artifact: RoleCArtifactJson): Promise<{
  auditInput: FactAuditInput
  evidenceSource: { kind: "rag_result" } | { kind: "frozen_evidence_pack"; retrieval_id: string }
  ragSources: Array<{ source_id: string; title: string }>
}> {
  if (evidenceFile) {
    const evidencePack = await readAndValidateEvidencePack(evidenceFile)
    return {
      auditInput: {
        artifactId: artifact.artifactId,
        evidencePack,
        expectedEvidenceContentHash: expectedEvidenceHash,
        generatedContent: {
          blocks: artifact.blocks.map((block) => ({
            blockId: block.blockId,
            text: block.text,
            citations: block.citations.map((citation) => ({ source_id: citation.source_id, fact_id: citation.fact_id })),
          })),
        },
      },
      evidenceSource: { kind: "frozen_evidence_pack", retrieval_id: evidencePack.retrieval_id },
      ragSources: evidencePack.results.map((item) => ({ source_id: item.source_id, title: item.title })),
    }
  }

  const ragResult = await retrieveKnowledge({
    query: artifact.query ?? "初学者，不会循环，需要完成成绩统计程序",
    learnerLevel: artifact.learnerLevel ?? "beginner",
    topK: artifact.topK ?? 3,
  })
  return {
    auditInput: adaptRoleCBlocksToFactAuditInput({
      artifactId: artifact.artifactId,
      ragResult,
      blocks: artifact.blocks,
    }),
    evidenceSource: { kind: "rag_result" },
    ragSources: ragResult.results.map((item) => ({ source_id: item.source_id, title: item.title })),
  }
}

async function readAndValidateEvidencePack(path: string): Promise<RagEvidencePack> {
  if (!path) printValidationError("MISSING_EVIDENCE_FILE", "--evidence requires a file path.")
  const file = Bun.file(path)
  if (!(await file.exists())) printValidationError("EVIDENCE_FILE_NOT_FOUND", `Evidence file not found: ${path}`)
  let value: unknown
  try {
    value = await file.json()
  } catch (error) {
    printValidationError("INVALID_EVIDENCE_JSON", error instanceof Error ? error.message : "Invalid evidence JSON")
  }
  validateEvidencePack(value)
  return value
}

function validateEvidencePack(value: unknown): asserts value is RagEvidencePack {
  if (!isRecord(value)) printValidationError("INVALID_EVIDENCE_PACK", "Evidence pack must be a JSON object.")
  if (value.schema_version !== "1.0") printValidationError("INVALID_EVIDENCE_SCHEMA", "Evidence pack schema_version must be 1.0.")
  if (typeof value.retrieval_id !== "string" || value.retrieval_id.trim() === "") {
    printValidationError("MISSING_RETRIEVAL_ID", "Evidence pack requires a non-empty retrieval_id.")
  }
  if (!Array.isArray(value.results)) printValidationError("INVALID_EVIDENCE_RESULTS", "Evidence pack results must be an array.")
  value.results.forEach((item, itemIndex) => {
    if (!isRecord(item) || typeof item.source_id !== "string" || typeof item.title !== "string" || !Array.isArray(item.facts)) {
      printValidationError("INVALID_EVIDENCE_ITEM", `results[${itemIndex}] must include source_id, title and facts[].`)
    }
    item.facts.forEach((fact, factIndex) => {
      if (!isRecord(fact) || typeof fact.source_id !== "string" || typeof fact.fact_id !== "string" || typeof fact.content !== "string") {
        printValidationError("INVALID_EVIDENCE_FACT", `results[${itemIndex}].facts[${factIndex}] requires source_id, fact_id and content.`)
      }
    })
  })
}

async function readAndValidateArtifact(path: string): Promise<RoleCArtifactJson> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    printValidationError("INPUT_FILE_NOT_FOUND", `Input file not found: ${path}`)
  }

  let value: unknown
  try {
    value = await file.json()
  } catch (error) {
    printValidationError("INVALID_JSON", error instanceof Error ? error.message : "Invalid JSON")
  }

  validateArtifact(value)
  return value
}

function validateArtifact(value: unknown): asserts value is RoleCArtifactJson {
  if (!isRecord(value)) printValidationError("INVALID_ARTIFACT", "Role C artifact must be a JSON object.")
  if (typeof value.artifactId !== "string" || value.artifactId.trim() === "") {
    printValidationError("MISSING_ARTIFACT_ID", "Role C artifact requires a non-empty artifactId.")
  }
  if (!("blocks" in value)) printValidationError("MISSING_BLOCKS", "Role C artifact requires a blocks array.")
  if (!Array.isArray(value.blocks)) printValidationError("INVALID_BLOCKS", "Role C artifact blocks must be an array.")
  if (value.learnerLevel !== undefined && !["beginner", "intermediate", "advanced"].includes(String(value.learnerLevel))) {
    printValidationError("INVALID_LEARNER_LEVEL", "learnerLevel must be beginner, intermediate or advanced.")
  }
  if (value.topK !== undefined && (!Number.isInteger(value.topK) || value.topK <= 0)) {
    printValidationError("INVALID_TOP_K", "topK must be a positive integer.")
  }

  const seenBlockIds = new Set<string>()
  value.blocks.forEach((block, blockIndex) => {
    if (!isRecord(block)) printValidationError("INVALID_BLOCK", `blocks[${blockIndex}] must be an object.`)
    if (typeof block.blockId !== "string" || block.blockId.trim() === "") {
      printValidationError("MISSING_BLOCK_ID", `blocks[${blockIndex}] requires a non-empty blockId.`)
    }
    if (seenBlockIds.has(block.blockId)) {
      printValidationError("DUPLICATE_BLOCK_ID", `Duplicate blockId: ${block.blockId}`)
    }
    seenBlockIds.add(block.blockId)

    if (typeof block.text !== "string" || block.text.trim() === "") {
      printValidationError("MISSING_TEXT", `blocks[${blockIndex}] requires non-empty text.`)
    }
    if (!Array.isArray(block.citations)) {
      printValidationError("INVALID_CITATIONS", `blocks[${blockIndex}].citations must be an array.`)
    }
    block.citations.forEach((citation, citationIndex) => {
      if (!isRecord(citation) || typeof citation.source_id !== "string" || citation.source_id.trim() === "" || typeof citation.fact_id !== "string" || citation.fact_id.trim() === "") {
        printValidationError("INVALID_CITATION", `blocks[${blockIndex}].citations[${citationIndex}] requires source_id and fact_id.`)
      }
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function printValidationError(code: string, message: string, exitCode = 2): never {
  console.log(JSON.stringify({
    workflow: "Audit_RoleC_JSON_File",
    ok: false,
    input_file: inputFile ?? null,
    error: { code, message },
  }, null, 2))
  process.exit(exitCode)
}
