import { assert, test } from 'vitest'

import {
  decideMaterializeWrite,
  decideWatcherHashGate,
  decideWatcherStatPrefilter,
  makeLastMaterializedRecord,
  type LastMaterializedRecord,
} from '../local-store/materialize'

const last: LastMaterializedRecord = {
  ydocHash: 'ydoc-a',
  diskHash: 'disk-a',
  path: 'notes/a.md',
  writtenAt: 1,
}

test("watcher hash gate ignores the materializer's own write", () => {
  assert.deepEqual(
    decideWatcherHashGate({
      currentDiskHash: 'disk-a',
      currentYDocHash: 'ydoc-b',
      lastMaterialized: last,
    }),
    { action: 'ignore-own-write' },
  )
})

test('watcher hash gate ignores already converged disk content', () => {
  assert.deepEqual(
    decideWatcherHashGate({
      currentDiskHash: 'ydoc-a',
      currentYDocHash: 'ydoc-a',
      lastMaterialized: last,
    }),
    { action: 'ignore-converged-write' },
  )
})

test('watcher hash gate imports unobserved external edits', () => {
  assert.deepEqual(
    decideWatcherHashGate({
      currentDiskHash: 'disk-external',
      currentYDocHash: 'ydoc-a',
      lastMaterialized: last,
    }),
    { action: 'import-external-edit' },
  )
})

test('materialize write skips files bound to the active editor', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      path: last.path,
      activeFilePath: last.path,
      currentDiskHash: 'disk-a',
      lastMaterialized: last,
    }),
    { action: 'skip-active-editor' },
  )
})

test('materialize write does not skip when the active editor is bound to a different file', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      path: last.path,
      activeFilePath: 'notes/other.md',
      currentDiskHash: 'disk-a',
      lastMaterialized: last,
    }),
    { action: 'write' },
  )
})

test('materialize write allows a write only when the disk hash still matches the base', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      path: last.path,
      activeFilePath: undefined,
      currentDiskHash: 'disk-a',
      lastMaterialized: last,
    }),
    { action: 'write' },
  )
})

test('materialize write blocks when base information is missing', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      path: last.path,
      activeFilePath: undefined,
      currentDiskHash: 'disk-a',
      lastMaterialized: undefined,
    }),
    { action: 'block-conflict', reason: 'missing-last-materialized' },
  )
})

test('materialize write blocks when disk changed after the last materialize', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      path: last.path,
      activeFilePath: undefined,
      currentDiskHash: 'disk-external',
      lastMaterialized: last,
    }),
    { action: 'block-conflict', reason: 'disk-hash-changed' },
  )
})

const withStat: LastMaterializedRecord = { ...last, diskMtimeMs: 1000, diskSize: 42 }

test('watcher stat prefilter skips hashing when mtime and size are unchanged', () => {
  assert.deepEqual(
    decideWatcherStatPrefilter({
      currentMtimeMs: 1000,
      currentSize: 42,
      lastMaterialized: withStat,
    }),
    { action: 'skip-unchanged-stat' },
  )
})

test('watcher stat prefilter requires a hash check when mtime changed', () => {
  assert.deepEqual(
    decideWatcherStatPrefilter({
      currentMtimeMs: 1001,
      currentSize: 42,
      lastMaterialized: withStat,
    }),
    { action: 'check-hash' },
  )
})

test('watcher stat prefilter requires a hash check when size changed', () => {
  assert.deepEqual(
    decideWatcherStatPrefilter({
      currentMtimeMs: 1000,
      currentSize: 43,
      lastMaterialized: withStat,
    }),
    { action: 'check-hash' },
  )
})

test('watcher stat prefilter requires a hash check when no baseline stat is recorded', () => {
  assert.deepEqual(
    decideWatcherStatPrefilter({
      currentMtimeMs: 1000,
      currentSize: 42,
      lastMaterialized: last,
    }),
    { action: 'check-hash' },
  )
})

test('watcher stat prefilter requires a hash check when the file was never observed', () => {
  assert.deepEqual(
    decideWatcherStatPrefilter({
      currentMtimeMs: 1000,
      currentSize: 42,
      lastMaterialized: undefined,
    }),
    { action: 'check-hash' },
  )
})

test('last-materialized records omit absent writeId under exact optional property types', () => {
  const record = makeLastMaterializedRecord(last)

  assert.equal('writeId' in record, false)
  assert.deepEqual(makeLastMaterializedRecord({ ...last, writeId: 'write-1' }), {
    ...last,
    writeId: 'write-1',
  })
})

test('last-materialized records omit absent disk stat fields', () => {
  const record = makeLastMaterializedRecord(last)

  assert.equal('diskMtimeMs' in record, false)
  assert.equal('diskSize' in record, false)
  assert.deepEqual(makeLastMaterializedRecord(withStat), withStat)
})
