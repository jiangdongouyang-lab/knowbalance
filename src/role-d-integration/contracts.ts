import type { RagResult } from "../rag/retriever"
import type { LearnerProfile } from "../role-b-profile/types"

export interface RoleDPublicCitation {
  source_id: string
  fact_id: string
}

export interface RoleDAssessmentItem {
  id: string
  tier: 1 | 2 | 3
  modality: "mcq" | "true_false" | "trace" | "short_answer" | "code"
  prompt: string
  options: string[]
  option_ids: string[]
  starter_code?: string
  citations: RoleDPublicCitation[]
}

export interface RoleDGeneratedArtifact {
  id: string
  kind: "lesson" | "lab" | "assessment"
  title: string
  status: "real"
  content: string
  options: string[]
  citations: RoleDPublicCitation[]
  items: RoleDAssessmentItem[]
}

export interface RoleDWorkflowEvent {
  id: string
  agent: string
  stage: string
  status: "pending" | "running" | "completed" | "review" | "blocked"
  summary: string
  timestamp: string
}

export type RoleCForRoleDResult =
  | {
      status: "ready"
      artifacts: RoleDGeneratedArtifact[]
      workflow: RoleDWorkflowEvent[]
      runId: string
    }
  | {
      status: "blocked" | "failed"
      artifacts: RoleDGeneratedArtifact[]
      workflow: RoleDWorkflowEvent[]
      runId: string
      reason: string
    }

export interface GenerateRoleCForRoleDInput {
  profile: LearnerProfile
  ragResult: RagResult
  kbVersion: string
  runId: string
}
