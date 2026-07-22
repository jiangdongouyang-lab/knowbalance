import { C_SCHEMA_VERSION, stableId, type SchemaVersion } from "../contracts/common"
import type { LearningEvidenceEvent, ProfileDriftSuggestion } from "../contracts/learning-evidence-event"
import { decideNextAction, type NextActionDecision } from "./next-action-policy"
import { validateRoleCSchema } from "../validators/runtime-schema-validator"

export interface ObjectiveMasteryState {
  schema_version: SchemaVersion
  learner_id_hash: string
  profile_version: string
  objective_id: string
  alpha: number
  beta: number
  mastery: number
  evidence_batches: number
  observed_modalities: LearningEvidenceEvent["evidence"]["modality"][]
  /** Durable idempotency ledger: one frozen grade artifact updates an objective at most once. */
  processed_artifact_ids: string[]
  last_action: NextActionDecision["action"]
  revision: number
}

export interface MasteryStateStore {
  load(learnerIdHash: string, profileVersion: string, objectiveId: string): Promise<ObjectiveMasteryState | undefined>
  save(state: ObjectiveMasteryState, expectedRevision: number): Promise<void>
}

export class InMemoryMasteryStateStore implements MasteryStateStore {
  private readonly states = new Map<string, ObjectiveMasteryState>()

  async load(learnerIdHash: string, profileVersion: string, objectiveId: string): Promise<ObjectiveMasteryState | undefined> {
    const value = this.states.get(keyOf(learnerIdHash, profileVersion, objectiveId))
    return value ? structuredClone(value) : undefined
  }

  async save(state: ObjectiveMasteryState, expectedRevision: number): Promise<void> {
    const key = keyOf(state.learner_id_hash, state.profile_version, state.objective_id)
    const current = this.states.get(key)
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error("MASTERY_REVISION_CONFLICT")
    this.states.set(key, structuredClone(state))
  }
}

export interface MasteryUpdateResult {
  states: ObjectiveMasteryState[]
  decisions: Record<string, NextActionDecision>
}

/** One submission/artifact contributes at most one Beta update per objective. */
export async function updateMasteryFromEvidence(
  events: LearningEvidenceEvent[],
  store: MasteryStateStore,
): Promise<MasteryUpdateResult> {
  const seenEventIds = new Set<string>()
  for (const event of events) {
    const report = validateRoleCSchema("learning_evidence_event.schema.json", event)
    if (!report.ok) throw new Error(`INVALID_LEARNING_EVIDENCE:${report.issues.map((entry) => entry.path).join(",")}`)
    if (seenEventIds.has(event.event_id)) throw new Error(`DUPLICATE_LEARNING_EVIDENCE:${event.event_id}`)
    seenEventIds.add(event.event_id)
  }
  const grouped = groupEvidenceBatches(events)
  const states: ObjectiveMasteryState[] = []
  const decisions: Record<string, NextActionDecision> = {}
  for (const batch of grouped) {
    const first = batch[0]!
    const itemIds = batch.map((event) => event.provenance.item_id)
    if (new Set(itemIds).size !== itemIds.length) {
      throw new Error(`DUPLICATE_EVIDENCE_ITEM_IN_BATCH:${first.provenance.artifact_id}`)
    }
    const existing = await store.load(first.learner_id_hash, first.profile_version, first.objective_id)
    // Normalize states written before the durable idempotency ledger was introduced.
    // This keeps even the replay/no-save path conformant to the current interface.
    const base: ObjectiveMasteryState = existing
      ? { ...existing, processed_artifact_ids: existing.processed_artifact_ids ?? [] }
      : initialState(first)
    const processedArtifactIds = base.processed_artifact_ids
    if (processedArtifactIds.includes(first.provenance.artifact_id)) {
      const sufficient = base.observed_modalities.includes("code") || base.observed_modalities.includes("trace")
      states.push(base)
      decisions[base.objective_id] = decideNextAction({
        mastery: base.mastery,
        sufficient_modalities: sufficient,
        previous_action: base.last_action,
      })
      continue
    }
    const evidence = clamp01(batch.reduce((sum, event) => sum + event.evidence.evidence_score, 0) / batch.length)
    const modalities = [...new Set([...base.observed_modalities, ...batch.map((event) => event.evidence.modality)])]
    const alpha = base.alpha + evidence
    const beta = base.beta + (1 - evidence)
    const mastery = alpha / (alpha + beta)
    const sufficient = modalities.includes("code") || modalities.includes("trace")
    const decision = decideNextAction({ mastery, sufficient_modalities: sufficient, previous_action: base.last_action })
    const next: ObjectiveMasteryState = {
      ...base,
      alpha: round(alpha),
      beta: round(beta),
      mastery: round(mastery),
      evidence_batches: base.evidence_batches + 1,
      observed_modalities: modalities,
      processed_artifact_ids: [...processedArtifactIds, first.provenance.artifact_id],
      last_action: decision.action,
      revision: base.revision + 1,
    }
    await store.save(next, base.revision)
    states.push(next)
    decisions[next.objective_id] = decision
  }
  return { states, decisions }
}

export interface ProfileExpectationObservation {
  objective_id: string
  expected: "known" | "weak"
  mastery: number
}

export function detectProfileDrift(input: {
  learner_id_hash: string
  profile_version: string
  observations: ProfileExpectationObservation[]
  minimum_conflicts?: number
}): ProfileDriftSuggestion | undefined {
  const conflicts = input.observations.filter((observation) =>
    (observation.expected === "known" && observation.mastery < 0.45)
      || (observation.expected === "weak" && observation.mastery > 0.85),
  )
  const objectiveIds = [...new Set(conflicts.map((entry) => entry.objective_id))]
  if (objectiveIds.length < (input.minimum_conflicts ?? 2)) return undefined
  return {
    schema_version: C_SCHEMA_VERSION,
    suggestion_id: stableId("PDS", { learner: input.learner_id_hash, profile: input.profile_version, objectiveIds }),
    learner_id_hash: input.learner_id_hash,
    profile_version: input.profile_version,
    conflicting_objective_ids: objectiveIds,
    reason_codes: ["repeated_profile_evidence_conflict", "profile_refresh_recommended"],
    confidence: round(Math.min(0.95, 0.7 + objectiveIds.length * 0.08)),
    action: "reprofile",
  }
}

function groupEvidenceBatches(events: LearningEvidenceEvent[]): LearningEvidenceEvent[][] {
  const groups = new Map<string, LearningEvidenceEvent[]>()
  for (const event of events) {
    const key = `${event.learner_id_hash}\u0000${event.profile_version}\u0000${event.objective_id}\u0000${event.provenance.artifact_id}`
    const bucket = groups.get(key) ?? []
    bucket.push(event)
    groups.set(key, bucket)
  }
  return [...groups.values()]
}

function initialState(event: LearningEvidenceEvent): ObjectiveMasteryState {
  return {
    schema_version: C_SCHEMA_VERSION,
    learner_id_hash: event.learner_id_hash,
    profile_version: event.profile_version,
    objective_id: event.objective_id,
    alpha: 1,
    beta: 1,
    mastery: 0.5,
    evidence_batches: 0,
    observed_modalities: [],
    processed_artifact_ids: [],
    last_action: "reinforce",
    revision: 0,
  }
}

function keyOf(learner: string, profile: string, objective: string): string {
  return `${learner}\u0000${profile}\u0000${objective}`
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)) }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000 }
