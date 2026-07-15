import { makeDeviceId, makeFileId, makeYDocId } from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { LocalStoreOutboxRecord } from '../../sync/store/store'
import { insertMetaFile, metaMap } from '../meta'
import {
  hasRunnableOutboxWork,
  schedulerItemsForMetadataAccess,
  shouldSendMetadataOutbox,
} from './tick'

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

test('follow-up scheduling sees only unleased runnable sync-control rows', () => {
  const records: LocalStoreOutboxRecord[] = [
    {
      id: 'pending-y-update' as LocalStoreOutboxRecord['id'],
      kind: 'y-update',
      status: 'pending',
      dependsOn: [],
      nextAttemptAt: undefined,
    },
    {
      id: 'leased-y-update' as LocalStoreOutboxRecord['id'],
      kind: 'y-update',
      status: 'retrying',
      dependsOn: [],
      nextAttemptAt: undefined,
    },
    {
      id: 'paused-y-update' as LocalStoreOutboxRecord['id'],
      kind: 'y-update',
      status: 'paused',
      dependsOn: [],
      nextAttemptAt: undefined,
    },
    {
      id: 'blocked-meta-ref' as LocalStoreOutboxRecord['id'],
      kind: 'meta-ref-update',
      status: 'pending',
      dependsOn: ['pending-y-update' as LocalStoreOutboxRecord['id']],
      nextAttemptAt: undefined,
    },
    {
      id: 'future-y-update' as LocalStoreOutboxRecord['id'],
      kind: 'y-update',
      status: 'retrying',
      dependsOn: [],
      nextAttemptAt: 2_000,
    },
  ]
  assert.equal(
    hasRunnableOutboxWork(
      records,
      [
        {
          itemId: 'leased-y-update',
          kind: 'y-update',
          ownerId: 'worker',
          leaseExpiresAt: 2_000,
        },
      ],
      1_000,
    ),
    false,
  )
  assert.equal(
    hasRunnableOutboxWork(
      records.filter((record) => record.id !== 'pending-y-update'),
      [
        {
          itemId: 'leased-y-update',
          kind: 'y-update',
          ownerId: 'worker',
          leaseExpiresAt: 2_000,
        },
      ],
      1_000,
    ),
    false,
  )
  assert.equal(hasRunnableOutboxWork(records, [], 1_000), true)
  assert.equal(
    hasRunnableOutboxWork(
      records,
      [
        {
          itemId: 'leased-y-update',
          kind: 'y-update',
          ownerId: 'worker',
          leaseExpiresAt: 999,
        },
      ],
      1_000,
    ),
    true,
  )
  assert.equal(
    hasRunnableOutboxWork(
      records,
      [
        {
          itemId: 'leased-blob-put',
          kind: 'blob-put',
          ownerId: 'worker',
          leaseExpiresAt: 2_000,
        },
      ],
      1_000,
    ),
    true,
  )
})

test('follow-up scheduling respects read-only metadata access', () => {
  const records: LocalStoreOutboxRecord[] = [
    {
      id: 'meta-pending' as LocalStoreOutboxRecord['id'],
      kind: 'y-update',
      status: 'pending',
      dependsOn: [],
      nextAttemptAt: undefined,
      docId: { kind: 'meta' },
    },
    {
      id: 'file-pending' as LocalStoreOutboxRecord['id'],
      kind: 'y-update',
      status: 'pending',
      dependsOn: [],
      nextAttemptAt: undefined,
      docId: { kind: 'file', ydocId: makeYDocId('outbox-file') },
    },
  ]
  assert.equal(
    hasRunnableOutboxWork(
      schedulerItemsForMetadataAccess(records.slice(0, 1), 'read-only'),
      [],
      1_000,
    ),
    false,
  )
  assert.equal(
    hasRunnableOutboxWork(schedulerItemsForMetadataAccess(records, 'read-only'), [], 1_000),
    true,
  )
})
