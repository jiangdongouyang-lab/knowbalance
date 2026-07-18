import type {
  AssessmentArtifactPair,
  AssessmentPublicPayload,
  AssessmentSecurePayload,
  CodeLabArtifactPair,
  CodeLabPublicPayload,
  CodeLabSecurePayload,
  ConceptLessonArtifact,
  ConceptLessonPayload,
} from "../contracts/artifacts"
import type { CitationRef } from "../contracts/common"
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"

export interface ConceptTutorRequest {
  generation_spec: GenerationSpec
  evidence_pack: RagEvidencePack
  prior_feedback_ref?: string
}

export interface CodeLabRequest {
  generation_spec: GenerationSpec
  evidence_pack: RagEvidencePack
  concept_artifact: ConceptLessonArtifact
}

export interface TieredEvaluatorRequest {
  generation_spec: GenerationSpec
  evidence_pack: RagEvidencePack
  concept_artifact: ConceptLessonArtifact
  code_lab_summary?: {
    lab_id: string
    objective_ids: string[]
    execution_verified: boolean
  }
}

export interface ArtifactDraft<TPayload> {
  payload: TPayload
  citations: CitationRef[]
  factual_claim_count: number
  cited_claim_count: number
}

export interface CodeLabDraft {
  public_draft: ArtifactDraft<CodeLabPublicPayload>
  secure_draft: ArtifactDraft<CodeLabSecurePayload>
  execution_verified: boolean
}

export interface AssessmentDraft {
  public_draft: ArtifactDraft<AssessmentPublicPayload>
  secure_draft: ArtifactDraft<AssessmentSecurePayload>
  answer_key_verified: boolean
}

/** Prompt/model implementation boundary owned independently from contracts and validators. */
export interface RoleCContentProvider {
  generateConceptLesson(request: ConceptTutorRequest): Promise<ArtifactDraft<ConceptLessonPayload>>
  generateCodeLab(request: CodeLabRequest): Promise<CodeLabDraft>
  generateAssessment(request: TieredEvaluatorRequest): Promise<AssessmentDraft>
}

export interface ConceptTutorAgent {
  generate(request: ConceptTutorRequest): Promise<ConceptLessonArtifact>
}

export interface CodeLabAgent {
  generate(request: CodeLabRequest): Promise<CodeLabArtifactPair>
}

export interface TieredEvaluatorAgent {
  generate(request: TieredEvaluatorRequest): Promise<AssessmentArtifactPair>
}

export interface RoleCAgents {
  concept_tutor: ConceptTutorAgent
  code_lab: CodeLabAgent
  tiered_evaluator: TieredEvaluatorAgent
}
