import { canonicalizeVaultPath, makeDeviceId, makeFileId, makeYDocId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import type { KuroflareRepairLogEntry } from '../../main-types'
import { planInvalidMetaIsolationDetail } from './invalid-meta-isolation'

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

function invalidMetaEntry(): KuroflareRepairLogEntry {
  return {
    id: `invalid-meta:${fileId}`,
    kind: 'invalid-meta',
    fileId,
    reason: 'meta-schema-invalid',
    createdAt: 1,
  }
}

function validTextMeta() {
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
