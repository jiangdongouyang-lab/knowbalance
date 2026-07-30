interface RunJournalEntry<TBinding, TResult> {
  requestHash: string
  binding: TBinding
  resultPromise?: Promise<TResult>
}

export interface RunJournalExecution<TBinding, TResult> {
  runId: string
  requestHash: string
  createBinding: () => TBinding
  generate: (binding: TBinding) => Promise<TResult>
  /** Defaults to retaining every resolved result. */
  shouldRetainResult?: (result: TResult) => boolean
}

/**
 * Process-local idempotency journal for expensive generation calls.
 *
 * Matching retries share one in-flight/result promise. A conflicting request
 * for the same run is rejected. Rejected promises and resolved results declined
 * by shouldRetainResult are removed so they can be retried deliberately.
 */
export class SingleFlightRunJournal<TBinding, TResult> {
  private readonly entries =
    new Map<string, RunJournalEntry<TBinding, TResult>>()

  async execute(
    execution: RunJournalExecution<TBinding, TResult>,
  ): Promise<TResult> {
    const existing = this.entries.get(execution.runId)
    if (existing && existing.requestHash !== execution.requestHash) {
      throw new Error("ROLE_B_GENERATION_RUN_CONFLICT")
    }
    const entry = existing ?? {
      requestHash: execution.requestHash,
      binding: execution.createBinding(),
    }
    if (!existing) this.entries.set(execution.runId, entry)

    if (!entry.resultPromise) {
      entry.resultPromise = Promise.resolve().then(
        () => execution.generate(entry.binding),
      )
    }
    try {
      const result = await entry.resultPromise
      if (execution.shouldRetainResult
        && !execution.shouldRetainResult(result)
        && this.entries.get(execution.runId) === entry) {
        this.entries.delete(execution.runId)
      }
      return structuredClone(result)
    } catch (error) {
      if (this.entries.get(execution.runId) === entry) {
        this.entries.delete(execution.runId)
      }
      throw error
    }
  }
}
