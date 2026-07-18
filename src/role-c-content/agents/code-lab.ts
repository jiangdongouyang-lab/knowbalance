import { ModelProviderUnavailableError } from "../contracts/model-gateway"
import type { CodeLabArtifactPair } from "../contracts/artifacts"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import { finalizeDraft, invalidOutputEnvelope, isCodeLabPublicPayload, isCodeLabSecurePayload, providerBlockedEnvelope } from "./harness"
import type { CodeLabAgent, CodeLabRequest, RoleCContentProvider } from "./types"

export function generateCodeLab(request: CodeLabRequest, provider: RoleCContentProvider) {
  return createCodeLabAgent(provider).generate(request)
}

export function createCodeLabAgent(provider: RoleCContentProvider): CodeLabAgent {
  return {
    async generate(request): Promise<CodeLabArtifactPair> {
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
        const draft = await provider.generateCodeLab(request)
        if (!isCodeLabPublicPayload(draft.public_draft.payload) || !isCodeLabSecurePayload(draft.secure_draft.payload)) {
          return invalidPair(common, "code-lab provider 返回值不符合 public/secure lab 最小结构")
        }
        return {
          public_artifact: finalizeDraft({
            ...common,
            agent: "code-lab",
            artifact_type: "code_lab_public",
            draft: draft.public_draft,
            public_payload: true,
            objective_ids: draft.public_draft.payload.objective_ids,
            execution_verified: draft.execution_verified,
          }),
          secure_artifact: finalizeDraft({
            ...common,
            agent: "code-lab",
            artifact_type: "code_lab_secure",
            draft: draft.secure_draft,
            public_payload: false,
            objective_ids: draft.public_draft.payload.objective_ids,
            execution_verified: draft.execution_verified,
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
): CodeLabArtifactPair {
  return {
    public_artifact: invalidOutputEnvelope({ ...common, agent: "code-lab", artifact_type: "code_lab_public", message }),
    secure_artifact: invalidOutputEnvelope({ ...common, agent: "code-lab", artifact_type: "code_lab_secure", message }),
  }
}

function blockedPair(
  common: { spec: GenerationSpec; evidence: RagEvidencePack; input_refs: string[] },
  message: string,
): CodeLabArtifactPair {
  return {
    public_artifact: providerBlockedEnvelope({
      ...common,
      agent: "code-lab",
      artifact_type: "code_lab_public",
      message,
    }),
    secure_artifact: providerBlockedEnvelope({
      ...common,
      agent: "code-lab",
      artifact_type: "code_lab_secure",
      message,
    }),
  }
}
