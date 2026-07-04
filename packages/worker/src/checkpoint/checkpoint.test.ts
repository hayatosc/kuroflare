import { assert, test } from 'vitest'

import {
  decideCheckpointCompact,
  decideCheckpointWrite,
  decideOrphanedCheckpointRecovery,
  type CheckpointDocRecoveryState,
  type CheckpointRunRecoveryInput,
  type CheckpointSnapshotEvidence,
} from '../checkpoint/checkpoint'

const currentDoc: CheckpointDocRecoveryState = {
  latestSnapshotSeq: 10,
  pointerVerified: true,
}

const verifiedSnapshot: CheckpointSnapshotEvidence = {
  exists: true,
  verified: true,
}

function run(input: Partial<CheckpointRunRecoveryInput>): CheckpointRunRecoveryInput {
  return {
    status: 'r2-written',
    upperSeq: 10,
    snapshotKey: 'snapshots/vault-a/meta/10.yupdate',
    ...input,
  }
}

test('checkpoint write starts only when the doc has uncheckpointed ops', () => {
  assert.deepEqual(
    decideCheckpointWrite({
      latestSeq: 12,
      latestSnapshotSeq: 10,
      snapshotKey: 'snapshots/vault-a/meta/12.yupdate',
      now: 50,
    }),
    {
      action: 'write',
      runId: 'checkpoint:snapshots/vault-a/meta/12.yupdate:50',
      upperSeq: 12,
      snapshotKey: 'snapshots/vault-a/meta/12.yupdate',
      createdAt: 50,
    },
  )

  assert.deepEqual(
    decideCheckpointWrite({
      latestSeq: 12,
      latestSnapshotSeq: 12,
      snapshotKey: 'snapshots/vault-a/meta/12.yupdate',
      now: 50,
    }),
    { action: 'skip', reason: 'no-new-ops' },
  )
})

test('checkpoint write rejects invalid clocks', () => {
  assert.deepEqual(
    decideCheckpointWrite({
      latestSeq: undefined,
      latestSnapshotSeq: 0,
      snapshotKey: 'snapshots/vault-a/meta/0.yupdate',
      now: 50,
    }),
    { action: 'skip', reason: 'invalid-clock' },
  )

  assert.deepEqual(
    decideCheckpointWrite({
      latestSeq: 10,
      latestSnapshotSeq: 11,
      snapshotKey: 'snapshots/vault-a/meta/10.yupdate',
      now: 50,
    }),
    { action: 'skip', reason: 'invalid-clock' },
  )
})

test('checkpoint compact runs only after the pointer has advanced', () => {
  assert.deepEqual(
    decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: 12,
      latestSnapshotSeq: 12,
      retainedSnapshotFloorSeq: undefined,
      now: 60,
    }),
    { action: 'compact', compactedSeq: 12, compactedAt: 60 },
  )

  assert.deepEqual(
    decideCheckpointCompact({
      status: 'r2-written',
      upperSeq: 12,
      latestSnapshotSeq: 12,
      retainedSnapshotFloorSeq: undefined,
      now: 60,
    }),
    { action: 'skip', reason: 'not-pointer-updated' },
  )

  assert.deepEqual(
    decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: 12,
      latestSnapshotSeq: 11,
      retainedSnapshotFloorSeq: undefined,
      now: 60,
    }),
    { action: 'skip', reason: 'pointer-behind-run' },
  )
})

test('checkpoint compact clamps to the retained snapshot floor so rollback op_log survives', () => {
  assert.deepEqual(
    decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: 12,
      latestSnapshotSeq: 12,
      retainedSnapshotFloorSeq: 8,
      now: 60,
    }),
    { action: 'compact', compactedSeq: 8, compactedAt: 60 },
  )

  assert.deepEqual(
    decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: 12,
      latestSnapshotSeq: 12,
      retainedSnapshotFloorSeq: 12,
      now: 60,
    }),
    { action: 'compact', compactedSeq: 12, compactedAt: 60 },
  )

  assert.deepEqual(
    decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: 12,
      latestSnapshotSeq: 12,
      retainedSnapshotFloorSeq: -1,
      now: 60,
    }),
    { action: 'skip', reason: 'invalid-clock' },
  )
})

test('terminal checkpoint runs are ignored during cold-start recovery', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'compacted' }),
      doc: currentDoc,
      snapshot: verifiedSnapshot,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'ignore-terminal' },
  )

  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'failed' }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'ignore-terminal' },
  )
})

test('writing checkpoint recovery fails incomplete or unverified snapshots', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'writing', snapshotKey: undefined }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'fail-run', reason: 'missing-snapshot' },
  )

  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'writing' }),
      doc: currentDoc,
      snapshot: { exists: true, verified: false },
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'fail-run', reason: 'unverified-snapshot' },
  )
})

test('writing checkpoint recovery resumes only after the snapshot is verified', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'writing' }),
      doc: currentDoc,
      snapshot: verifiedSnapshot,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'mark-r2-written' },
  )
})

test('r2-written checkpoint recovery advances only non-stale verified snapshots', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'r2-written', upperSeq: 11 }),
      doc: currentDoc,
      snapshot: verifiedSnapshot,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'advance-pointer' },
  )

  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'r2-written', upperSeq: 9 }),
      doc: currentDoc,
      snapshot: verifiedSnapshot,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'mark-stale', reason: 'would-rewind-pointer' },
  )
})

test('r2-written checkpoint recovery refuses missing snapshots', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'r2-written' }),
      doc: currentDoc,
      snapshot: { exists: false, verified: false },
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'fail-run', reason: 'missing-snapshot' },
  )
})

test('pointer-updated checkpoint recovery compacts only after pointer verification', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'pointer-updated', upperSeq: 10 }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'compact-op-log', compactedSeq: 10 },
  )

  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'pointer-updated', upperSeq: 10 }),
      doc: { latestSnapshotSeq: 10, pointerVerified: false },
      snapshot: undefined,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'block-compact', reason: 'pointer-unverified' },
  )

  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'pointer-updated', upperSeq: 11 }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: undefined,
    }),
    { action: 'block-compact', reason: 'pointer-behind-run' },
  )
})

test('pointer-updated checkpoint recovery clamps compact to the retained snapshot floor', () => {
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'pointer-updated', upperSeq: 10 }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: 6,
    }),
    { action: 'compact-op-log', compactedSeq: 6 },
  )

  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'pointer-updated', upperSeq: 10 }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: 10,
    }),
    { action: 'compact-op-log', compactedSeq: 10 },
  )

  // An untrustworthy floor blocks compaction entirely rather than risk
  // deleting op_log a retained older snapshot still needs.
  assert.deepEqual(
    decideOrphanedCheckpointRecovery({
      run: run({ status: 'pointer-updated', upperSeq: 10 }),
      doc: currentDoc,
      snapshot: undefined,
      retainedSnapshotFloorSeq: -1,
    }),
    { action: 'block-compact', reason: 'invalid-retained-floor' },
  )
})
