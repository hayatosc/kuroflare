import type { CheckpointRunStatus } from '../checkpoint/checkpoint'

/** Snapshot metadata needed before R2 retention cleanup. */
export interface SnapshotRetentionCandidate {
  readonly key: string
  readonly upperSeq: number
  readonly healthy: boolean
}

/** Checkpoint run metadata that can pin an otherwise old snapshot. */
export interface SnapshotRetentionCheckpointRun {
  readonly status: CheckpointRunStatus
  readonly snapshotKey: string | undefined
}

/** Input for planning snapshot retention cleanup. */
export interface SnapshotRetentionPlanInput {
  readonly snapshots: readonly SnapshotRetentionCandidate[]
  readonly checkpointRuns: readonly SnapshotRetentionCheckpointRun[]
  readonly currentPointerKey: string | undefined
  readonly minGenerationCount: number
}

/** Snapshot retention cleanup plan. */
export interface SnapshotRetentionPlan {
  readonly retainKeys: readonly string[]
  readonly deleteKeys: readonly string[]
}

/**
 * Plans which snapshot objects may be deleted during retention cleanup.
 *
 * @param input Snapshot list, current pointer, active checkpoint runs, and minimum generation count.
 * @returns Deterministic retain/delete key lists. The caller should only delete keys in `deleteKeys`.
 * @throws If `minGenerationCount` is not a positive safe integer.
 */
export function planSnapshotRetention(input: SnapshotRetentionPlanInput): SnapshotRetentionPlan {
  if (!Number.isSafeInteger(input.minGenerationCount) || input.minGenerationCount <= 0) {
    throw new RangeError('minGenerationCount must be a positive safe integer')
  }

  const sortedSnapshots = [...input.snapshots].sort(compareSnapshotsNewestFirst)
  const retainKeys = new Set<string>()

  for (const snapshot of sortedSnapshots.slice(0, input.minGenerationCount)) {
    retainKeys.add(snapshot.key)
  }

  if (input.currentPointerKey) {
    retainKeys.add(input.currentPointerKey)
  }

  const newestHealthySnapshot = sortedSnapshots.find((snapshot) => snapshot.healthy)
  if (newestHealthySnapshot) {
    retainKeys.add(newestHealthySnapshot.key)
  }

  for (const run of input.checkpointRuns) {
    if (run.status !== 'compacted' && run.status !== 'failed' && run.snapshotKey) {
      retainKeys.add(run.snapshotKey)
    }
  }

  const allKeys = sortedUnique(input.snapshots.map((snapshot) => snapshot.key))
  return {
    retainKeys: sortedUnique([...retainKeys]),
    deleteKeys: allKeys.filter((key) => !retainKeys.has(key)),
  }
}

function compareSnapshotsNewestFirst(
  left: SnapshotRetentionCandidate,
  right: SnapshotRetentionCandidate,
): number {
  const seqComparison = right.upperSeq - left.upperSeq
  return seqComparison === 0 ? compareCodeUnitString(left.key, right.key) : seqComparison
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnitString)
}

function compareCodeUnitString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}
