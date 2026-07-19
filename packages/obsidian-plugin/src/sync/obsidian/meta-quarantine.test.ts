import {
  canonicalizeVaultPath,
  groupedEntryFromMetaFile,
  makeDeviceId,
  makeFileId,
  makeYDocId,
  type MetaFile,
} from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { KuroflareRepairLogEntry } from '../../types'
import { canDiscardInvalidMetaRepairEntry, planInvalidMetaIsolationDetail } from './meta-quarantine'

const fileId = makeFileId('invalid-meta-file-1')

test('invalid meta isolation exposes bounded raw detail for settings UI', () => {
  assert.deepEqual(
    planInvalidMetaIsolationDetail({
      entry: invalidMetaEntry(),
      current: { invalid: true, path: 'Bad.md', nested: { reason: 'wrong-shape' } },
      inspectedAt: 10,
      jsonLimit: 32,
    }),
    {
      action: 'isolate',
      detail: {
        fileId,
        reason: 'meta-schema-invalid',
        inspectedAt: 10,
        rawJson: '{\n  "invalid": true,\n  "path": "',
        truncated: true,
      },
    },
  )
})

test('invalid meta isolation treats missing or now-valid meta as stale', () => {
  assert.deepEqual(
    planInvalidMetaIsolationDetail({
      entry: invalidMetaEntry(),
      current: undefined,
      inspectedAt: 10,
    }),
    { action: 'stale' },
  )
  assert.deepEqual(
    planInvalidMetaIsolationDetail({
      entry: invalidMetaEntry(),
      current: validTextMeta(),
      inspectedAt: 10,
    }),
    { action: 'stale' },
  )
  const grouped = groupedEntryFromMetaFile(validTextMeta())
  const groupedDoc = new Y.Doc()
  const groupedMap = new Y.Map<unknown>()
  groupedMap.set('identity', grouped.identity)
  groupedMap.set('location', grouped.location)
  groupedMap.set('content', grouped.content)
  groupedMap.set('deletion', grouped.deletion)
  groupedDoc.getMap('meta').set(fileId, groupedMap)
  assert.deepEqual(
    planInvalidMetaIsolationDetail({
      entry: invalidMetaEntry(),
      current: groupedDoc.getMap('meta').get(fileId),
      inspectedAt: 10,
    }),
    { action: 'stale' },
  )
  assert.deepEqual(
    planInvalidMetaIsolationDetail({
      entry: invalidMetaEntry(),
      current: { schemaVersion: 3 },
      inspectedAt: 10,
    }),
    { action: 'stale' },
  )
  groupedDoc.destroy()
})

test('invalid meta isolation ignores non invalid-meta repair entries', () => {
  assert.deepEqual(
    planInvalidMetaIsolationDetail({
      entry: { ...invalidMetaEntry(), kind: 'path-conflict' },
      current: { invalid: true },
      inspectedAt: 10,
    }),
    { action: 'ignored-kind' },
  )
})

test('invalid meta discard requires read-write access and an invalid current value', () => {
  const input = {
    metadataAccess: 'read-write' as const,
    fileId,
    current: { invalid: true },
    confirmation: 'DISCARD INVALID META',
  }
  assert.equal(canDiscardInvalidMetaRepairEntry(input), true)
  assert.equal(canDiscardInvalidMetaRepairEntry({ ...input, metadataAccess: 'read-only' }), false)
  assert.equal(canDiscardInvalidMetaRepairEntry({ ...input, current: validTextMeta() }), false)
  assert.equal(
    canDiscardInvalidMetaRepairEntry({ ...input, confirmation: 'wrong confirmation' }),
    false,
  )
})

function invalidMetaEntry(): KuroflareRepairLogEntry {
  return {
    id: `invalid-meta:${fileId}`,
    kind: 'invalid-meta',
    fileId,
    reason: 'meta-schema-invalid',
    createdAt: 1,
  }
}

function validTextMeta(): MetaFile {
  return {
    schemaVersion: 1,
    fileId,
    path: 'Valid.md',
    canonicalPath: canonicalizeVaultPath('Valid.md'),
    type: 'text',
    ydocId: makeYDocId('valid-doc-1'),
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('invalid-meta-device-1'),
    contentUpdatedAt: 2,
    contentUpdatedBy: makeDeviceId('invalid-meta-device-1'),
    updatedAt: 3,
    updatedBy: makeDeviceId('invalid-meta-device-1'),
    mtime: 4,
  }
}
