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
  | { readonly action: 'compact-op-log' }
  | {
      readonly action: 'block-compact'
      readonly reason: 'pointer-unverified' | 'pointer-behind-run'
    }

/** Input for deciding how to recover a checkpoint run after a crash. */
export interface OrphanedCheckpointRecoveryInput {
  readonly run: CheckpointRunRecoveryInput
  readonly doc: CheckpointDocRecoveryState
  readonly snapshot: CheckpointSnapshotEvidence | undefined
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
 * @param input Checkpoint run state, current doc pointer, and timestamp.
 * @returns A compact plan once the pointer is confirmed, otherwise a skip reason.
 */
export function decideCheckpointCompact(input: CheckpointCompactInput): CheckpointCompactDecision {
  if (
    !isPositiveSafeInteger(input.upperSeq) ||
    !isNonNegativeSafeInteger(input.latestSnapshotSeq) ||
    !isNonNegativeSafeInteger(input.now)
  ) {
    return { action: 'skip', reason: 'invalid-clock' }
  }

  if (input.status !== 'pointer-updated') {
    return { action: 'skip', reason: 'not-pointer-updated' }
  }

  if (input.latestSnapshotSeq < input.upperSeq) {
    return { action: 'skip', reason: 'pointer-behind-run' }
  }

  return {
    action: 'compact',
    compactedSeq: input.upperSeq,
    compactedAt: input.now,
  }
}

/**
 * Decides the next safe recovery step for a checkpoint run left mid-flight.
 *
 * The decision never rewinds the document pointer. Snapshot evidence must be
 * gathered from R2 before adopting an orphaned snapshot or compacting op_log.
 *
 * @param input Checkpoint run row, current doc pointer state, and R2 evidence.
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
      return decidePointerUpdatedRecovery(input.run, input.doc)
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
): OrphanedCheckpointRecoveryDecision {
  if (!doc.pointerVerified) {
    return { action: 'block-compact', reason: 'pointer-unverified' }
  }

  if (doc.latestSnapshotSeq < run.upperSeq) {
    return { action: 'block-compact', reason: 'pointer-behind-run' }
  }

  return { action: 'compact-op-log' }
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
