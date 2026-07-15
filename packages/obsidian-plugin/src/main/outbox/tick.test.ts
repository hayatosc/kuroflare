import { makeDeviceId, makeFileId, makeYDocId } from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { LocalStoreOutboxRecord } from '../../sync/store/store'
import { insertMetaFile, metaMap } from '../meta'
import { schedulerItemsForMetadataAccess, shouldSendMetadataOutbox } from './tick'

test('metadata outbox refuses flat-v1 records until migration completes', () => {
  const fileId = makeFileId('outbox-migration')
  const value = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Notes/Outbox.md',
    canonicalPath: 'notes/outbox.md',
    type: 'text' as const,
    ydocId: makeYDocId('outbox-migration-doc'),
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('outbox-device'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('outbox-device'),
    updatedAt: 1,
    updatedBy: makeDeviceId('outbox-device'),
    mtime: 1,
  }
  const legacy = new Y.Doc()
  legacy.getMap('meta').set(fileId, value)
  const record = {
    docId: { kind: 'meta' as const },
    metadataSchemaVersion: undefined,
  }
  const plugin = { metadataAccess: 'read-write' as const, metaDoc: legacy }
  assert.equal(shouldSendMetadataOutbox(plugin, record), false)

  const grouped = new Y.Doc()
  insertMetaFile(metaMap({ metaDoc: grouped }), value)
  assert.equal(
    shouldSendMetadataOutbox(
      { metadataAccess: 'read-write', metaDoc: grouped },
      { ...record, metadataSchemaVersion: 2 },
    ),
    true,
  )
  legacy.destroy()
  grouped.destroy()
})

test('read-only scheduling blocks metadata starts without changing file lanes', () => {
  const records: LocalStoreOutboxRecord[] = [
    {
      id: 'meta-pending' as LocalStoreOutboxRecord['id'],
      kind: 'y-update' as const,
      status: 'pending' as const,
      dependsOn: [],
      nextAttemptAt: undefined,
      docId: { kind: 'meta' as const },
    },
    {
      id: 'file-pending' as LocalStoreOutboxRecord['id'],
      kind: 'y-update' as const,
      status: 'pending' as const,
      dependsOn: [],
      nextAttemptAt: undefined,
      docId: { kind: 'file' as const, ydocId: makeYDocId('outbox-file') },
    },
  ]
  const filtered = schedulerItemsForMetadataAccess(records, 'read-only')
  assert.equal(filtered[0]?.status, 'blocked')
  assert.equal(filtered[1]?.status, 'pending')
})
