/** Evidence needed to decide whether a hydrated document may leave memory. */
export interface DocEvictionInput {
  /** `true` for the meta doc, which stays resident at all times. */
  readonly isMeta: boolean
  /** `true` once the doc's op_log is fully covered by its latest snapshot. */
  readonly checkpointed: boolean
  /** Number of currently connected sockets that have touched this doc. */
  readonly activeSocketCount: number
  /** Timestamp (ms) the doc was last touched by a client or a checkpoint. */
  readonly lastAccessedAt: number
  /** Current time (ms). */
  readonly now: number
  /** Minimum idle time (ms) required before an eligible doc may evict. */
  readonly idleThresholdMs: number
}

/** Decision for whether a hydrated document may be evicted from memory. */
export type DocEvictionDecision =
  | { readonly action: 'evict' }
  | {
      readonly action: 'keep'
      readonly reason:
        | 'meta-doc'
        | 'not-checkpointed'
        | 'active-sockets'
        | 'recently-accessed'
        | 'invalid-clock'
    }

/**
 * Decides whether a hydrated file YDoc may be evicted from the in-memory doc
 * map. The meta doc is always resident. A file doc evicts only once it is fully
 * checkpointed, no currently connected socket has touched it, and it has been
 * idle for at least `idleThresholdMs`.
 *
 * @param input Document kind, checkpoint state, socket/access evidence, and clocks.
 * @returns `evict` once all three conditions hold, otherwise `keep` with the blocking reason.
 */
export function decideDocEviction(input: DocEvictionInput): DocEvictionDecision {
  if (input.isMeta) {
    return { action: 'keep', reason: 'meta-doc' }
  }

  if (!input.checkpointed) {
    return { action: 'keep', reason: 'not-checkpointed' }
  }

  if (input.activeSocketCount > 0) {
    return { action: 'keep', reason: 'active-sockets' }
  }

  if (
    !Number.isSafeInteger(input.lastAccessedAt) ||
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.idleThresholdMs) ||
    input.idleThresholdMs < 0
  ) {
    return { action: 'keep', reason: 'invalid-clock' }
  }

  if (input.now - input.lastAccessedAt < input.idleThresholdMs) {
    return { action: 'keep', reason: 'recently-accessed' }
  }

  return { action: 'evict' }
}
