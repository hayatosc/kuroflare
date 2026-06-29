import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  planSnapshotRetention,
  type SnapshotRetentionCandidate,
  type SnapshotRetentionCheckpointRun,
} from '../db/retention'

function snapshot(
  key: string,
  upperSeq: number,
  healthy: boolean = true,
): SnapshotRetentionCandidate {
  return { key, upperSeq, healthy }
}

test('retention keeps the newest configured generations', () => {
  assert.deepEqual(
    planSnapshotRetention({
      snapshots: [snapshot('s1', 1), snapshot('s3', 3), snapshot('s2', 2)],
      checkpointRuns: [],
      currentPointerKey: undefined,
      minGenerationCount: 2,
    }),
    {
      retainKeys: ['s2', 's3'],
      deleteKeys: ['s1'],
    },
  )
})

test('retention always keeps the current pointer even when it is old', () => {
  assert.deepEqual(
    planSnapshotRetention({
      snapshots: [snapshot('s1', 1), snapshot('s2', 2), snapshot('s3', 3)],
      checkpointRuns: [],
      currentPointerKey: 's1',
      minGenerationCount: 1,
    }),
    {
      retainKeys: ['s1', 's3'],
      deleteKeys: ['s2'],
    },
  )
})

test('retention keeps the newest healthy snapshot when newer snapshots are corrupt', () => {
  assert.deepEqual(
    planSnapshotRetention({
      snapshots: [snapshot('healthy', 7), snapshot('corrupt-newest', 9, false)],
      checkpointRuns: [],
      currentPointerKey: undefined,
      minGenerationCount: 1,
    }),
    {
      retainKeys: ['corrupt-newest', 'healthy'],
      deleteKeys: [],
    },
  )
})

test('retention keeps snapshots referenced by unfinished checkpoint runs', () => {
  const checkpointRuns: SnapshotRetentionCheckpointRun[] = [
    { status: 'r2-written', snapshotKey: 'unfinished-r2' },
    { status: 'pointer-updated', snapshotKey: 'unfinished-pointer' },
    { status: 'writing', snapshotKey: 'unfinished-writing' },
    { status: 'compacted', snapshotKey: 'old-compacted' },
    { status: 'failed', snapshotKey: 'old-failed' },
  ]

  assert.deepEqual(
    planSnapshotRetention({
      snapshots: [
        snapshot('newest', 10),
        snapshot('unfinished-r2', 4),
        snapshot('unfinished-pointer', 3),
        snapshot('unfinished-writing', 2),
        snapshot('old-compacted', 1),
        snapshot('old-failed', 0),
      ],
      checkpointRuns,
      currentPointerKey: undefined,
      minGenerationCount: 1,
    }),
    {
      retainKeys: ['newest', 'unfinished-pointer', 'unfinished-r2', 'unfinished-writing'],
      deleteKeys: ['old-compacted', 'old-failed'],
    },
  )
})

test('retention breaks same-sequence snapshot ties with deterministic code unit ordering', () => {
  assert.deepEqual(
    planSnapshotRetention({
      snapshots: [snapshot('snapshot-b', 10), snapshot('snapshot-a', 10)],
      checkpointRuns: [],
      currentPointerKey: undefined,
      minGenerationCount: 1,
    }),
    {
      retainKeys: ['snapshot-a'],
      deleteKeys: ['snapshot-b'],
    },
  )
})

test('retention validates the minimum generation count', () => {
  assert.throws(
    () =>
      planSnapshotRetention({
        snapshots: [],
        checkpointRuns: [],
        currentPointerKey: undefined,
        minGenerationCount: 0,
      }),
    RangeError,
  )
})
