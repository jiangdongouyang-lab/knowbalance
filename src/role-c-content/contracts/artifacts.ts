import type { ArtifactEnvelope, CitationRef } from "./common"

export interface HeadingBlock {
  block_id: string
  block_type: "heading"
  level: 1 | 2 | 3
  text: string
}

export interface ParagraphBlock {
  block_id: string
  block_type: "paragraph"
  text: string
  claims: Claim[]
}

export interface CodeBlock {
  block_id: string
  block_type: "code"
  language: string
  code: string
  caption?: string
  claims: Claim[]
}

export interface CalloutBlock {
  block_id: string
  block_type: "callout"
  tone: "info" | "warning" | "tip"
  title: string
  text: string
  claims: Claim[]
}

export interface ComparisonBlock {
  block_id: string
  block_type: "comparison"
  title: string
  columns: Array<{ heading: string; content: string }>
  claims: Claim[]
}

export interface QuizBlock {
  block_id: string
  block_type: "quiz"
  item_id: string
  prompt: string
  options?: PublicOption[]
}

export interface HintBlock {
  block_id: string
  block_type: "hint"
  hint_level: 1 | 2 | 3
  text: string
}

export interface CitationBlock {
  block_id: string
  block_type: "citation"
  citations: CitationRef[]
}

export type RenderBlock =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | CalloutBlock
  | ComparisonBlock
  | QuizBlock
  | HintBlock
  | CitationBlock

export interface Claim {
  claim_id: string
  text: string
  citations: CitationRef[]
}

export interface ObjectiveCoverageRef {
  objective_id: string
  block_ids: string[]
}

export interface HintLadder {
  objective_id: string
  hints: Array<{ hint_level: 1 | 2 | 3; text: string }>
}

export interface ConceptLessonPayload {
  title: string
  objective_ids: string[]
  prerequisite_bridge: RenderBlock[]
  explanation_blocks: RenderBlock[]
  worked_examples: RenderBlock[]
  misconceptions: Array<{ misconception_tag: string; explanation: string; objective_id: string }>
  micro_checks: QuizBlock[]
  hint_ladders: HintLadder[]
  summary: RenderBlock[]
  objective_coverage: ObjectiveCoverageRef[]
  used_evidence: CitationRef[]
}

export interface ExecutionContract {
  language: "python"
  execution_mode: "function" | "stdin_stdout"
  entry_point?: string
  allowed_imports: string[]
  input_contract: { type: string; constraints: string[] }
  output_contract: { type: string; constraints?: string[] }
  resource_limits: {
    timeout_ms: number
    memory_mb: number
    max_output_bytes: number
  }
}

export interface PublicTest {
  test_id: string
  description: string
  input: unknown
  expected_behavior: string
}

export interface CodeLabPublicPayload {
  lab_id: string
  title: string
  objective_ids: string[]
  instructions: RenderBlock[]
  execution_contract: ExecutionContract
  starter_code: string
  public_tests: PublicTest[]
  hint_ladders: HintLadder[]
  reflection_questions: string[]
  used_evidence: CitationRef[]
}

export interface HiddenTest {
  test_id: string
  input: unknown
  expected: unknown
  objective_id: string
  weight: number
}

export interface CodeLabSecurePayload {
  lab_id: string
  reference_solution: string
  hidden_tests: HiddenTest[]
  scoring_groups: Array<{ group_id: string; test_ids: string[]; weight: number }>
  misconception_map: Array<{ failed_test_id: string; misconception_tag: string }>
}

export interface PublicOption {
  option_id: string
  label: string
  text: string
}

export interface AssessmentItemPublic {
  item_id: string
  objective_id: string
  tier: 1 | 2 | 3
  modality: "mcq" | "true_false" | "trace" | "short_answer" | "code"
  prompt: string
  options?: PublicOption[]
  starter_code?: string
  max_score: number
  citations: CitationRef[]
}

export interface AssessmentPublicPayload {
  form_id: string
  title: string
  objective_ids: string[]
  items: AssessmentItemPublic[]
  submission_policy: {
    max_attempts: number
    formative: boolean
  }
}

export interface RubricCriterion {
  criterion_id: string
  description: string
  weight: number
  required_evidence: string[]
}

export type AnswerSpec =
  | {
      kind: "exact_set"
      accepted: string[]
      normalization: Array<"trim" | "casefold" | "unicode" | "collapse_whitespace">
    }
  | {
      kind: "numeric"
      target: number
      abs_tolerance: number
      rel_tolerance: number
      unit?: string
    }
  | {
      kind: "concept_rubric"
      criteria: RubricCriterion[]
      contradictions: string[]
    }
  | {
      kind: "code"
      test_suite_id: string
    }

export interface AssessmentItemSecure {
  item_id: string
  objective_id: string
  modality: "mcq" | "true_false" | "trace" | "short_answer" | "code"
  max_score: number
  answer_spec: AnswerSpec
  correct_option_id?: string
  misconception_by_option: Record<string, string>
  evidence_weight: number
}

export interface AssessmentSecurePayload {
  form_id: string
  items: AssessmentItemSecure[]
  option_order_seed: number
}

export interface SubmissionAnswer {
  item_id: string
  selected_option_id?: string
  text_response?: string
  code_response?: string
  hint_level_used: 0 | 1 | 2 | 3
}

export interface SubmissionEnvelope {
  schema_version: "1.0"
  submission_id: string
  run_id: string
  learner_id_hash: string
  form_id: string
  attempt_no: number
  answers: SubmissionAnswer[]
}

export interface SessionState {
  schema_version: "1.0"
  session_id: string
  run_id: string
  learner_id_hash: string
  current_path_node_id: string
  current_form_id?: string
  attempt_no: number
  revealed_hint_levels: Record<string, 0 | 1 | 2 | 3>
  public_artifact_refs: string[]
  secure_artifact_refs: string[]
}

export interface GradeItemResult {
  item_id: string
  objective_id: string
  raw_score: number
  evidence_score: number
  grader_confidence: number
  misconception_tags: string[]
  feedback_code: string
}

export interface GradeResultPayload {
  submission_id: string
  form_id: string
  score_frozen: true
  raw_score: number
  max_score: number
  item_results: GradeItemResult[]
  recommendation: {
    action: "remediate" | "reinforce" | "advance" | "reprofile"
    confidence: number
    reason_codes: string[]
  }
}

export type ConceptLessonArtifact = ArtifactEnvelope<ConceptLessonPayload>
export type CodeLabPublicArtifact = ArtifactEnvelope<CodeLabPublicPayload>
export type CodeLabSecureArtifact = ArtifactEnvelope<CodeLabSecurePayload>
export type AssessmentPublicArtifact = ArtifactEnvelope<AssessmentPublicPayload>
export type AssessmentSecureArtifact = ArtifactEnvelope<AssessmentSecurePayload>
export type GradeResultArtifact = ArtifactEnvelope<GradeResultPayload>

export interface CodeLabArtifactPair {
  public_artifact: CodeLabPublicArtifact
  secure_artifact: CodeLabSecureArtifact
}

export interface AssessmentArtifactPair {
  public_artifact: AssessmentPublicArtifact
  secure_artifact: AssessmentSecureArtifact
}
