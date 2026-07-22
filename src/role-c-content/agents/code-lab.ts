import { ModelOutputValidationError, ModelProviderUnavailableError } from "../contracts/model-gateway"
import type { CodeLabArtifactPair } from "../contracts/artifacts"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import { finalizeDraft, invalidOutputEnvelope, providerBlockedEnvelope } from "./harness"
import type { CodeLabAgent, CodeLabDraftVerifier, CodeLabRequest, RoleCContentProvider } from "./types"
import { validateCodeLabDraftStructure } from "../validators/code-lab-validator"

export function generateCodeLab(
  request: CodeLabRequest,
  provider: RoleCContentProvider,
  verifier?: CodeLabDraftVerifier,
) {
  return createCodeLabAgent(provider, verifier).generate(request)
}

export function createCodeLabAgent(
  provider: RoleCContentProvider,
  verifier?: CodeLabDraftVerifier,
): CodeLabAgent {
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
        const structural = validateCodeLabDraftStructure(request, draft)
        if (!structural.ok) {
          return invalidPair(
            common,
            "code-lab Draft 未通过结构、引用、public/secure 或目标覆盖门禁",
            structural.issues.map((issue) => `${issue.path}: ${issue.message}`),
          )
        }
        const verification = verifier
          ? await verifier.verifyCodeLab(request, draft)
          : { execution_verified: false, issues: ["未配置独立 code-lab verifier"] }
        const objectiveCoverage = verification.objective_coverage ?? structural.objective_coverage
        return {
          public_artifact: finalizeDraft({
            ...common,
            agent: "code-lab",
            artifact_type: "code_lab_public",
            draft: draft.public_draft,
            public_payload: true,
            objective_ids: draft.public_draft.payload.objective_ids,
            execution_verified: verification.execution_verified,
            runner_image_digest: verification.runner_image_digest,
            mutation_kill_rate: verification.mutation_kill_rate,
            verified_test_count: verification.verified_test_count,
            trusted_objective_coverage: objectiveCoverage,
            verification_issues: verification.issues,
          }),
          secure_artifact: finalizeDraft({
            ...common,
            agent: "code-lab",
            artifact_type: "code_lab_secure",
            draft: draft.secure_draft,
            public_payload: false,
            objective_ids: draft.public_draft.payload.objective_ids,
            execution_verified: verification.execution_verified,
            runner_image_digest: verification.runner_image_digest,
            mutation_kill_rate: verification.mutation_kill_rate,
            verified_test_count: verification.verified_test_count,
            trusted_objective_coverage: objectiveCoverage,
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
): CodeLabArtifactPair {
  return {
    public_artifact: invalidOutputEnvelope({
      ...common,
      agent: "code-lab",
      artifact_type: "code_lab_public",
      message,
      details,
    }),
    secure_artifact: invalidOutputEnvelope({
      ...common,
      agent: "code-lab",
      artifact_type: "code_lab_secure",
      message,
      details,
    }),
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
