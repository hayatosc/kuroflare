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
 * Decides whether an in-memory document state can be removed from memory.
 *
 * The metadata document is always kept in memory. Other documents can be
 * removed if they are fully saved, have no active client connections, and
 * have been idle for a threshold duration.
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

/** Evidence needed to decide whether a doc load may proceed or must wait out memory pressure. */
export interface DocLoadAdmissionInput {
  /** `true` for the meta doc, which is always admitted and never evicted. */
  readonly isMeta: boolean
  /** `true` when the doc is already resident; re-entrant access is never blocked. */
  readonly alreadyHydrated: boolean
  /** Number of non-meta docs currently resident, after the room's eviction pass has run. */
  readonly hydratedFileDocCount: number
  /** Maximum number of non-meta docs a room may keep resident at once. */
  readonly maxHydratedFileDocs: number
}

/** Decision for whether a doc load may proceed. */
export type DocLoadAdmissionDecision =
  | { readonly action: 'admit' }
  | { readonly action: 'degraded' }

/**
 * Decides whether a new (not-yet-resident) file doc may be hydrated, or whether
 * the room is degraded and must refuse the load.
 *
 * The meta doc and re-entrant access to an already-resident doc are always
 * admitted. A genuinely new file doc load is refused once the room's eviction
 * pass has already run and the room is still at capacity, matching the
 * "flush + evict first, degrade only if that isn't enough" rule.
 */
export function decideDocLoadAdmission(input: DocLoadAdmissionInput): DocLoadAdmissionDecision {
  if (input.isMeta || input.alreadyHydrated) {
    return { action: 'admit' }
  }

  return input.hydratedFileDocCount < input.maxHydratedFileDocs
    ? { action: 'admit' }
    : { action: 'degraded' }
}
