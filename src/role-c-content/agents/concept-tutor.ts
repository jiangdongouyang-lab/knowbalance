import { ModelProviderUnavailableError } from "../contracts/model-gateway"
import { finalizeDraft, invalidOutputEnvelope, isConceptLessonPayload, providerBlockedEnvelope } from "./harness"
import type { ConceptTutorAgent, ConceptTutorRequest, RoleCContentProvider } from "./types"

export function generateConceptLesson(request: ConceptTutorRequest, provider: RoleCContentProvider) {
  return createConceptTutorAgent(provider).generate(request)
}

export function createConceptTutorAgent(provider: RoleCContentProvider): ConceptTutorAgent {
  return {
    async generate(request) {
      try {
        const draft = await provider.generateConceptLesson(request)
        if (!isConceptLessonPayload(draft.payload)) {
          return invalidOutputEnvelope({
            spec: request.generation_spec,
            evidence: request.evidence_pack,
            agent: "concept-tutor",
            artifact_type: "concept_lesson",
            input_refs: [request.generation_spec.spec_id, request.evidence_pack.retrieval_id],
            message: "concept-tutor provider 返回值不符合 concept_artifact 最小结构",
          })
        }
        return finalizeDraft({
          spec: request.generation_spec,
          evidence: request.evidence_pack,
          agent: "concept-tutor",
          artifact_type: "concept_lesson",
          draft,
          input_refs: [request.generation_spec.spec_id, request.evidence_pack.retrieval_id],
          public_payload: true,
          objective_ids: draft.payload.objective_ids,
        })
      } catch (error) {
        if (!(error instanceof ModelProviderUnavailableError)) throw error
        return providerBlockedEnvelope({
          spec: request.generation_spec,
          evidence: request.evidence_pack,
          agent: "concept-tutor",
          artifact_type: "concept_lesson",
          input_refs: [request.generation_spec.spec_id, request.evidence_pack.retrieval_id],
          message: error.message,
        })
      }
    },
  }
}
