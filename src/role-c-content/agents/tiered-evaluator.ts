import { ModelProviderUnavailableError } from "../contracts/model-gateway"
import type { AssessmentArtifactPair } from "../contracts/artifacts"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import {
  finalizeDraft,
  invalidOutputEnvelope,
  isAssessmentPublicPayload,
  isAssessmentSecurePayload,
  providerBlockedEnvelope,
} from "./harness"
import type { RoleCContentProvider, TieredEvaluatorAgent, TieredEvaluatorRequest } from "./types"

export function generateAssessment(request: TieredEvaluatorRequest, provider: RoleCContentProvider) {
  return createTieredEvaluatorAgent(provider).generate(request)
}

export function createTieredEvaluatorAgent(provider: RoleCContentProvider): TieredEvaluatorAgent {
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
        if (!isAssessmentPublicPayload(draft.public_draft.payload) || !isAssessmentSecurePayload(draft.secure_draft.payload)) {
          return invalidPair(common, "tiered-evaluator provider 返回值不符合 public/secure assessment 最小结构")
        }
        return {
          public_artifact: finalizeDraft({
            ...common,
            agent: "tiered-evaluator",
            artifact_type: "assessment_public",
            draft: draft.public_draft,
            public_payload: true,
            objective_ids: draft.public_draft.payload.objective_ids,
            answer_key_verified: draft.answer_key_verified,
          }),
          secure_artifact: finalizeDraft({
            ...common,
            agent: "tiered-evaluator",
            artifact_type: "assessment_secure",
            draft: draft.secure_draft,
            public_payload: false,
            objective_ids: draft.public_draft.payload.objective_ids,
            answer_key_verified: draft.answer_key_verified,
          }),
        }
      } catch (error) {
        if (!(error instanceof ModelProviderUnavailableError)) throw error
        return blockedPair(common, error.message)
      }
    },
  }
}

function invalidPair(
  common: { spec: GenerationSpec; evidence: RagEvidencePack; input_refs: string[] },
  message: string,
): AssessmentArtifactPair {
  return {
    public_artifact: invalidOutputEnvelope({ ...common, agent: "tiered-evaluator", artifact_type: "assessment_public", message }),
    secure_artifact: invalidOutputEnvelope({ ...common, agent: "tiered-evaluator", artifact_type: "assessment_secure", message }),
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
