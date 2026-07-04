/** Durable checkpoint run states stored in the Durable Object database. */
export type CheckpointRunStatus =
  | 'writing'
  | 'r2-written'
  | 'pointer-updated'
  | 'compacted'
  | 'failed'

/** Input for planning a new checkpoint write. */
export interface CheckpointWriteInput {
  readonly latestSeq: number | undefined
  readonly latestSnapshotSeq: number
  readonly snapshotKey: string
  readonly now: number
}

/** Decision for starting or skipping a checkpoint write. */
export type CheckpointWriteDecision =
  | { readonly action: 'skip'; readonly reason: 'invalid-clock' | 'no-new-ops' }
  | {
      readonly action: 'write'
      readonly runId: string
      readonly upperSeq: number
      readonly snapshotKey: string
      readonly createdAt: number
    }

/** Input for planning op-log compaction after a checkpoint pointer update. */
export interface CheckpointCompactInput {
  readonly status: CheckpointRunStatus
  readonly upperSeq: number
  readonly latestSnapshotSeq: number
  /**
   * The `upperSeq` of the oldest snapshot that snapshot retention (see
   * `db/retention.ts`) still requires op_log to roll back to, or `undefined`
   * when no other retained snapshot predates this checkpoint. Op-log rows
   * newer than this floor must survive compaction so a rollback to that
   * older snapshot can still replay forward to it.
   */
  readonly retainedSnapshotFloorSeq: number | undefined
  readonly now: number
}

/** Decision for compacting op-log rows covered by a durable snapshot. */
export type CheckpointCompactDecision =
  | {
      readonly action: 'skip'
      readonly reason: 'not-pointer-updated' | 'pointer-behind-run' | 'invalid-clock'
    }
  | { readonly action: 'compact'; readonly compactedSeq: number; readonly compactedAt: number }

/** Checkpoint run row subset needed during cold-start recovery. */
export interface CheckpointRunRecoveryInput {
  readonly status: CheckpointRunStatus
  readonly upperSeq: number
  readonly snapshotKey: string | undefined
}

/** Current per-document snapshot pointer state from the docs table. */
export interface CheckpointDocRecoveryState {
  readonly latestSnapshotSeq: number
  readonly pointerVerified: boolean
}

/** Evidence gathered from R2 before deciding how to close an orphaned run. */
export interface CheckpointSnapshotEvidence {
  readonly exists: boolean
  readonly verified: boolean
}

/** Recovery action for an orphaned checkpoint run discovered on cold start. */
export type OrphanedCheckpointRecoveryDecision =
  | { readonly action: 'ignore-terminal' }
  | { readonly action: 'fail-run'; readonly reason: 'missing-snapshot' | 'unverified-snapshot' }
  | { readonly action: 'mark-r2-written' }
  | { readonly action: 'advance-pointer' }
  | { readonly action: 'mark-stale'; readonly reason: 'would-rewind-pointer' }
  | { readonly action: 'compact-op-log'; readonly compactedSeq: number }
  | {
      readonly action: 'block-compact'
      readonly reason: 'pointer-unverified' | 'pointer-behind-run' | 'invalid-retained-floor'
    }

/** Input for deciding how to recover a checkpoint run after a crash. */
export interface OrphanedCheckpointRecoveryInput {
  readonly run: CheckpointRunRecoveryInput
  readonly doc: CheckpointDocRecoveryState
  readonly snapshot: CheckpointSnapshotEvidence | undefined
  /**
   * The `upperSeq` of the oldest snapshot that snapshot retention still
   * requires op_log to roll back to, or `undefined` when no other retained
   * snapshot predates this run. Only consulted when `run.status` is
   * `pointer-updated`; see `decideCheckpointCompact` for the same clamp
   * applied to normal (non-recovery) compaction.
   */
  readonly retainedSnapshotFloorSeq: number | undefined
}

/**
 * Decides whether a document needs a new checkpoint snapshot.
 *
 * @param input Current document sequence state and caller-built snapshot key.
 * @returns A write plan when the doc has uncheckpointed ops, otherwise a skip reason.
 */
export function decideCheckpointWrite(input: CheckpointWriteInput): CheckpointWriteDecision {
  if (
    !isPositiveSafeInteger(input.latestSeq) ||
    !isNonNegativeSafeInteger(input.latestSnapshotSeq) ||
    input.latestSnapshotSeq > input.latestSeq ||
    !isNonNegativeSafeInteger(input.now) ||
    input.snapshotKey.length === 0
  ) {
    return { action: 'skip', reason: 'invalid-clock' }
  }

  if (input.latestSnapshotSeq === input.latestSeq) {
    return { action: 'skip', reason: 'no-new-ops' }
  }

  return {
    action: 'write',
    runId: `checkpoint:${input.snapshotKey}:${input.now}`,
    upperSeq: input.latestSeq,
    snapshotKey: input.snapshotKey,
    createdAt: input.now,
  }
}

/**
 * Decides whether op-log rows covered by a checkpoint can be compacted.
 *
 * The compaction boundary is clamped to `retainedSnapshotFloorSeq` so that
 * op_log needed to roll back to an older snapshot retained by
 * `planSnapshotRetention` (see `db/retention.ts`) and replay forward is never
 * deleted.
 *
 * @param input Checkpoint run state, current doc pointer, retention floor, and timestamp.
 * @returns A compact plan once the pointer is confirmed, otherwise a skip reason.
 */
export function decideCheckpointCompact(input: CheckpointCompactInput): CheckpointCompactDecision {
  if (
    !isPositiveSafeInteger(input.upperSeq) ||
    !isNonNegativeSafeInteger(input.latestSnapshotSeq) ||
    !isNonNegativeSafeInteger(input.now) ||
    (input.retainedSnapshotFloorSeq !== undefined &&
      !isPositiveSafeInteger(input.retainedSnapshotFloorSeq))
  ) {
    return { action: 'skip', reason: 'invalid-clock' }
  }

  if (input.status !== 'pointer-updated') {
    return { action: 'skip', reason: 'not-pointer-updated' }
  }

  if (input.latestSnapshotSeq < input.upperSeq) {
    return { action: 'skip', reason: 'pointer-behind-run' }
  }

  const compactedSeq =
    input.retainedSnapshotFloorSeq === undefined
      ? input.upperSeq
      : Math.min(input.upperSeq, input.retainedSnapshotFloorSeq)

  return {
    action: 'compact',
    compactedSeq,
    compactedAt: input.now,
  }
}

/**
 * Decides the next safe recovery step for a checkpoint run left mid-flight.
 *
 * The decision never rewinds the document pointer. Snapshot evidence must be
 * gathered from R2 before adopting an orphaned snapshot or compacting op_log.
 * When resuming a `pointer-updated` run, `compact-op-log` clamps its
 * `compactedSeq` to `retainedSnapshotFloorSeq` the same way
 * `decideCheckpointCompact` does for normal compaction, so recovery cannot
 * delete op_log a retained older snapshot still needs.
 *
 * @param input Checkpoint run row, current doc pointer state, R2 evidence, and retention floor.
 * @returns The single recovery action the caller should apply transactionally.
 */
export function decideOrphanedCheckpointRecovery(
  input: OrphanedCheckpointRecoveryInput,
): OrphanedCheckpointRecoveryDecision {
  switch (input.run.status) {
    case 'compacted':
    case 'failed':
      return { action: 'ignore-terminal' }
    case 'writing':
      return decideWritingRecovery(input.run, input.snapshot)
    case 'r2-written':
      return decideR2WrittenRecovery(input.run, input.doc, input.snapshot)
    case 'pointer-updated':
      return decidePointerUpdatedRecovery(input.run, input.doc, input.retainedSnapshotFloorSeq)
  }
}

function decideWritingRecovery(
  run: CheckpointRunRecoveryInput,
  snapshot: CheckpointSnapshotEvidence | undefined,
): OrphanedCheckpointRecoveryDecision {
  const snapshotProblem = classifySnapshotProblem(run, snapshot)
  if (snapshotProblem) {
    return snapshotProblem
  }

  return { action: 'mark-r2-written' }
}

function decideR2WrittenRecovery(
  run: CheckpointRunRecoveryInput,
  doc: CheckpointDocRecoveryState,
  snapshot: CheckpointSnapshotEvidence | undefined,
): OrphanedCheckpointRecoveryDecision {
  const snapshotProblem = classifySnapshotProblem(run, snapshot)
  if (snapshotProblem) {
    return snapshotProblem
  }

  if (run.upperSeq < doc.latestSnapshotSeq) {
    return { action: 'mark-stale', reason: 'would-rewind-pointer' }
  }

  return { action: 'advance-pointer' }
}

function decidePointerUpdatedRecovery(
  run: CheckpointRunRecoveryInput,
  doc: CheckpointDocRecoveryState,
  retainedSnapshotFloorSeq: number | undefined,
): OrphanedCheckpointRecoveryDecision {
  if (!doc.pointerVerified) {
    return { action: 'block-compact', reason: 'pointer-unverified' }
  }

  if (doc.latestSnapshotSeq < run.upperSeq) {
    return { action: 'block-compact', reason: 'pointer-behind-run' }
  }

  if (retainedSnapshotFloorSeq !== undefined && !isPositiveSafeInteger(retainedSnapshotFloorSeq)) {
    // Retention evidence could not be trusted: refuse to compact rather than
    // risk deleting op_log still needed to roll back to an older snapshot.
    return { action: 'block-compact', reason: 'invalid-retained-floor' }
  }

  const compactedSeq =
    retainedSnapshotFloorSeq === undefined
      ? run.upperSeq
      : Math.min(run.upperSeq, retainedSnapshotFloorSeq)

  return { action: 'compact-op-log', compactedSeq }
}

function classifySnapshotProblem(
  run: CheckpointRunRecoveryInput,
  snapshot: CheckpointSnapshotEvidence | undefined,
): Extract<OrphanedCheckpointRecoveryDecision, { readonly action: 'fail-run' }> | null {
  if (!run.snapshotKey || !snapshot?.exists) {
    return { action: 'fail-run', reason: 'missing-snapshot' }
  }

  if (!snapshot.verified) {
    return { action: 'fail-run', reason: 'unverified-snapshot' }
  }

  return null
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
