import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  decideMaterializeWrite,
  decideWatcherHashGate,
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
      activeEditorBound: true,
      currentDiskHash: 'disk-a',
      lastMaterialized: last,
    }),
    { action: 'skip-active-editor' },
  )
})

test('materialize write allows a write only when the disk hash still matches the base', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      activeEditorBound: false,
      currentDiskHash: 'disk-a',
      lastMaterialized: last,
    }),
    { action: 'write' },
  )
})

test('materialize write blocks when base information is missing', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      activeEditorBound: false,
      currentDiskHash: 'disk-a',
      lastMaterialized: undefined,
    }),
    { action: 'block-conflict', reason: 'missing-last-materialized' },
  )
})

test('materialize write blocks when disk changed after the last materialize', () => {
  assert.deepEqual(
    decideMaterializeWrite({
      activeEditorBound: false,
      currentDiskHash: 'disk-external',
      lastMaterialized: last,
    }),
    { action: 'block-conflict', reason: 'disk-hash-changed' },
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
