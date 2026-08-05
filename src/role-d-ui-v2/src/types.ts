import type { RenderBlock } from "../../role-c-content/contracts/artifacts"

export interface Citation {
  source_id: string
  fact_id: string
  relation?: string
}

export interface LessonPayload {
  title: string
  objective_ids: string[]
  prerequisite_bridge: RenderBlock[]
  explanation_blocks: RenderBlock[]
  worked_examples: RenderBlock[]
  misconceptions: Array<{
    misconception_tag: string
    explanation: string
    objective_id: string
    citations: Citation[]
  }>
  micro_checks: Array<{
    block_id: string
    item_id: string
    prompt: string
    options?: Array<{ option_id: string; label: string; text: string }>
    citations: Citation[]
  }>
  hint_ladders: Array<{
    objective_id: string
    hints: Array<{ hint_level: 1 | 2 | 3; text: string; citations: Citation[] }>
  }>
  summary: RenderBlock[]
  used_evidence: Citation[]
}

export interface CodeLabPayload {
  lab_id: string
  title: string
  objective_ids: string[]
  instructions: RenderBlock[]
  execution_contract: {
    language: "python"
    execution_mode: "function" | "stdin_stdout"
    entry_point?: string
    allowed_imports: string[]
    resource_limits: { timeout_ms: number; memory_mb: number; max_output_bytes: number }
  }
  starter_code: string
  public_tests: Array<{
    test_id: string
    objective_id: string
    description: string
    input: unknown
    expected_behavior: string
    citations: Citation[]
  }>
  hint_ladders: LessonPayload["hint_ladders"]
  reflection_questions: string[]
  used_evidence: Citation[]
}

export interface AssessmentPayload {
  title: string
  items: Array<{
    item_id: string
    display_no: number
    objective_id: string
    tier: 1 | 2 | 3
    modality: "mcq" | "true_false" | "trace" | "short_answer" | "code"
    prompt: string
    options?: Array<{ option_id: string; label: string; text: string }>
    starter_code?: string
    max_score: number
    citations: Citation[]
  }>
}

export interface PublicSessionFixture {
  session_id: string
  run_id: string
  status: string
  current_stage: string
  round_no: number
  revision?: number
  waiting_for?: null | { type: string; items: any[] }
  worker_ledger: Array<{
    worker: string
    status: string
    summary?: string
  }>
  profile?: {
    learner_id: string
    level: string
    known_concepts: string[]
    weak_concepts: string[]
    goal: string
  }
  formal_path?: unknown
  current_path_node?: {
    node_id: string
    goal: string
    objectives: Array<{
      objective_id: string
      source_id: string
      required_fact_ids: string[]
      observable_behavior: string
      importance: string
    }>
  }
  rag_result?: unknown
  learning_resources: {
    concept_lesson?: { payload: LessonPayload; citations: Citation[]; status: string }
    code_lab?: { payload: CodeLabPayload; citations: Citation[]; status: string }
  }
  assessment?: { payload: AssessmentPayload; citations: Citation[]; status: string }
  feedback?: unknown
  blocked_reason?: string | null
  events: Array<{
    seq?: number
    agent?: string
    worker?: string
    status?: string
    event_type?: string
    summary?: string
    occurred_at?: string
  }>
  updated_at: string
}
