import type { GenerationSpec } from "../contracts/generation-spec"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { ValidationIssue, ValidationReport } from "./citation-validator"

export function validateSpecEvidence(spec: GenerationSpec, evidence: RagEvidencePack): ValidationReport {
  const issues: ValidationIssue[] = []
  if (spec.evidence_ref !== evidence.retrieval_id) {
    issues.push({
      code: "evidence_ref_mismatch",
      path: "spec.evidence_ref",
      message: "GenerationSpec 引用的 retrieval_id 与实际 evidence_pack 不一致",
      severity: "critical",
    })
  }
  if (evidence.match_status !== "strong") {
    issues.push({
      code: "insufficient_match",
      path: "evidence.match_status",
      message: `只有 strong evidence 才允许发布，当前为 ${evidence.match_status}`,
      severity: "critical",
    })
  }

  const sources = new Set(evidence.results.map((item) => item.source_id))
  const facts = new Set(
    evidence.results.flatMap((item) => item.facts.map((fact) => `${fact.source_id}:${fact.fact_id}`)),
  )
  spec.targets.forEach((target, targetIndex) => {
    if (!sources.has(target.source_id)) {
      issues.push({
        code: "missing_target_source",
        path: `spec.targets[${targetIndex}].source_id`,
        message: `缺少目标知识点 ${target.source_id}`,
        severity: "critical",
      })
    }
    target.required_fact_ids.forEach((factId, factIndex) => {
      if (!facts.has(`${target.source_id}:${factId}`)) {
        issues.push({
          code: "missing_required_fact",
          path: `spec.targets[${targetIndex}].required_fact_ids[${factIndex}]`,
          message: `缺少目标事实 ${target.source_id}:${factId}`,
          severity: "critical",
        })
      }
    })
  })
  return { ok: issues.length === 0, issues }
}
