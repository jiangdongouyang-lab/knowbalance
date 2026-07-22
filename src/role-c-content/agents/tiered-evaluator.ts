import { ModelOutputValidationError, ModelProviderUnavailableError } from "../contracts/model-gateway"
import type { AssessmentArtifactPair } from "../contracts/artifacts"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import {
  finalizeDraft,
  invalidOutputEnvelope,
  providerBlockedEnvelope,
} from "./harness"
import type {
  AssessmentDraftVerifier,
  RoleCContentProvider,
  TieredEvaluatorAgent,
  TieredEvaluatorRequest,
} from "./types"
import { validateAssessmentDraftStructure } from "../validators/assessment-validator"

export function generateAssessment(
  request: TieredEvaluatorRequest,
  provider: RoleCContentProvider,
  verifier?: AssessmentDraftVerifier,
) {
  return createTieredEvaluatorAgent(provider, verifier).generate(request)
}

export function createTieredEvaluatorAgent(
  provider: RoleCContentProvider,
  verifier?: AssessmentDraftVerifier,
): TieredEvaluatorAgent {
  return {
    async generate(request): Promise<AssessmentArtifactPair> {
      const common = {
        spec: request.generation_spec,
        evidence: request.evidence_pack,
        input_refs: [
          request.generation_spec.spec_id,
          request.evidence_pack.retrieval_id,
          request.concept_artifact.artifact_id,
        ],
      }
      try {
        const draft = await provider.generateAssessment(request)
        const structural = validateAssessmentDraftStructure(request, draft)
        if (!structural.ok) {
          return invalidPair(
            common,
            "tiered-evaluator Draft 未通过结构、答案合同、public/secure 或蓝图门禁",
            structural.issues.map((issue) => `${issue.path}: ${issue.message}`),
          )
        }
        const verification: Awaited<ReturnType<AssessmentDraftVerifier["verifyAssessment"]>> = verifier
          ? await verifier.verifyAssessment(request, draft)
          : { answer_key_verified: false, issues: ["未配置独立 assessment verifier"] }
        const citations = structural.citations
        const objectiveCoverage = verification.objective_coverage ?? structural.objective_coverage
        return {
          public_artifact: finalizeDraft({
            ...common,
            agent: "tiered-evaluator",
            artifact_type: "assessment_public",
            draft: draft.public_draft,
            public_payload: true,
            objective_ids: draft.public_draft.payload.objective_ids,
            trusted_citations: citations,
            trusted_objective_coverage: objectiveCoverage,
            answer_key_verified: verification.answer_key_verified,
            runner_image_digest: verification.runner_image_digest,
            verified_item_count: verification.verified_item_count,
            verified_test_count: verification.verified_test_count,
            verification_issues: verification.issues,
          }),
          secure_artifact: finalizeDraft({
            ...common,
            agent: "tiered-evaluator",
            artifact_type: "assessment_secure",
            draft: draft.secure_draft,
            public_payload: false,
            objective_ids: draft.public_draft.payload.objective_ids,
            trusted_citations: citations,
            trusted_objective_coverage: objectiveCoverage,
            answer_key_verified: verification.answer_key_verified,
            runner_image_digest: verification.runner_image_digest,
            verified_item_count: verification.verified_item_count,
            verified_test_count: verification.verified_test_count,
            verification_issues: verification.issues,
          }),
        }
      } catch (error) {
        if (error instanceof ModelOutputValidationError) {
          return invalidPair(common, `${error.stage} 未在有限修复次数内通过校验`, error.issues)
        }
        if (!(error instanceof ModelProviderUnavailableError)) throw error
        return blockedPair(common, error.message)
      }
    },
  }
}

function invalidPair(
  common: { spec: GenerationSpec; evidence: RagEvidencePack; input_refs: string[] },
  message: string,
  details: string[],
): AssessmentArtifactPair {
  return {
    public_artifact: invalidOutputEnvelope({
      ...common,
      agent: "tiered-evaluator",
      artifact_type: "assessment_public",
      message,
      details,
    }),
    secure_artifact: invalidOutputEnvelope({
      ...common,
      agent: "tiered-evaluator",
      artifact_type: "assessment_secure",
      message,
      details,
    }),
  }
}

function blockedPair(
  common: { spec: GenerationSpec; evidence: RagEvidencePack; input_refs: string[] },
  message: string,
): AssessmentArtifactPair {
  return {
    public_artifact: providerBlockedEnvelope({
      ...common,
      agent: "tiered-evaluator",
      artifact_type: "assessment_public",
      message,
    }),
    secure_artifact: providerBlockedEnvelope({
      ...common,
      agent: "tiered-evaluator",
      artifact_type: "assessment_secure",
      message,
    }),
  }
}
