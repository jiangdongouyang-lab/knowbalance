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
import type { RagEvidencePack } from "../contracts/evidence-pack"
import type { GenerationSpec } from "../contracts/generation-spec"
import type { AlignmentObjection } from "../validators/alignment-validator"

export interface ConceptTutorRequest {
  generation_spec: GenerationSpec
  evidence_pack: RagEvidencePack
  prior_feedback_ref?: string
  revision_objections?: AlignmentObjection[]
}

export interface CodeLabRequest {
  generation_spec: GenerationSpec
  evidence_pack: RagEvidencePack
  concept_artifact: ConceptLessonArtifact
  revision_objections?: AlignmentObjection[]
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
  revision_objections?: AlignmentObjection[]
}

export interface ArtifactDraft<TPayload> {
  payload: TPayload
}

export interface CodeLabDraft {
  public_draft: ArtifactDraft<CodeLabPublicPayload>
  secure_draft: ArtifactDraft<CodeLabSecurePayload>
}

export interface AssessmentDraft {
  public_draft: ArtifactDraft<AssessmentPublicPayload>
  secure_draft: ArtifactDraft<AssessmentSecurePayload>
}

export interface CodeLabDraftVerifier {
  verifyCodeLab(request: CodeLabRequest, draft: CodeLabDraft): Promise<{
    execution_verified: boolean
    issues: string[]
    runner_image_digest?: string
    mutation_kill_rate?: number
    verified_test_count?: number
    objective_coverage?: number
  }>
}

export interface AssessmentDraftVerifier {
  verifyAssessment(request: TieredEvaluatorRequest, draft: AssessmentDraft): Promise<{
    answer_key_verified: boolean
    issues: string[]
    runner_image_digest?: string
    verified_item_count?: number
    verified_test_count?: number
    objective_coverage?: number
  }>
}

export interface GeneratedContentVerifiers {
  code_lab?: CodeLabDraftVerifier
  assessment?: AssessmentDraftVerifier
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
