import {
  decodeMetaValue,
  makeDeviceId,
  makeFileId,
  makeYDocId,
  type MetaFile,
} from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import {
  metaIdentityImmutable,
  metaRootMutationAllowed,
  metaYDocSchemaDisposition,
  metaYDocWritable,
  migrateLegacyMetaDoc,
  canApplyYjsUpdateToDoc,
  hasUnresolvedYjsState,
} from '../sync/yjs'

const DEVICE = makeDeviceId('device-v2')

test('rejects incremental updates whose predecessor state is missing', () => {
  const source = new Y.Doc()
  source.getMap('meta').set(makeFileId('causal-base'), groupedText(makeFileId('causal-base')))
  const baseUpdate = Y.encodeStateAsUpdate(source)
  const baseStateVector = Y.encodeStateVector(source)
  source.getMap('meta').set(makeFileId('causal-delta'), groupedText(makeFileId('causal-delta')))
  const delta = Y.encodeStateAsUpdate(source, baseStateVector)

  const empty = new Y.Doc()
  const base = new Y.Doc()
  Y.applyUpdate(base, baseUpdate)
  assert.equal(canApplyYjsUpdateToDoc(empty, delta), false)
  assert.equal(canApplyYjsUpdateToDoc(base, delta), true)
  empty.destroy()
  base.destroy()
  source.destroy()
})

test('rejects cross-client updates whose referenced parent is missing', () => {
  const parent = new Y.Doc()
  const child = new Y.Map<unknown>()
  parent.getMap('root').set('child', child)
  const parentUpdate = Y.encodeStateAsUpdate(parent)

  const client = new Y.Doc()
  Y.applyUpdate(client, parentUpdate)
  const clonedChild = client.getMap<Y.Map<unknown>>('root').get('child')
  assert.ok(clonedChild instanceof Y.Map)
  clonedChild.set('value', 'child-update')
  const childDelta = Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent))

  const missingParent = new Y.Doc()
  assert.equal(canApplyYjsUpdateToDoc(missingParent, childDelta), false)
  missingParent.destroy()
  client.destroy()
  parent.destroy()
})

test('fails closed for poisoned persisted docs but keeps tombstones writable', () => {
  const parent = new Y.Doc()
  parent.getMap('root').set('child', new Y.Map<unknown>())
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(parent))
  const child = client.getMap<Y.Map<unknown>>('root').get('child')
  assert.ok(child instanceof Y.Map)
  child.set('value', 'pending')
  const poisoned = new Y.Doc()
  Y.applyUpdate(poisoned, Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent)))
  assert.equal(hasUnresolvedYjsState(poisoned), true)
  assert.equal(metaYDocSchemaDisposition(poisoned), 'invalid')

  const tombstone = new Y.Doc()
  const map = tombstone.getMap('meta')
  map.set(makeFileId('tombstone'), { value: 'deleted' })
  map.delete(makeFileId('tombstone'))
  assert.equal(hasUnresolvedYjsState(tombstone), false)
  assert.equal(metaYDocWritable(tombstone), true)
  poisoned.destroy()
  tombstone.destroy()
  client.destroy()
  parent.destroy()
})

test('migrates every v1 entry in one transaction and preserves location mtime', () => {
  const doc = new Y.Doc()
  const fileId = makeFileId('legacy-file')
  doc.getMap('meta').set(fileId, legacyText(fileId))

  assert.equal(migrateLegacyMetaDoc(doc), true)
  assert.equal(metaYDocSchemaDisposition(doc), 'supported-v2')
  const value = decodeMetaValue(doc.getMap('meta').get(fileId), fileId)
  assert.equal(value.disposition, 'supported-v2')
  assert.equal(value.metaFile?.mtime, 41)
  assert.ok(doc.getMap('meta').get(fileId) instanceof Y.Map)
})

test('mixed and detached grouped values fail closed', () => {
  const doc = new Y.Doc()
  const fileId = makeFileId('legacy-file')
  doc.getMap('meta').set(fileId, legacyText(fileId))
  const detached = new Y.Map<unknown>()
  assert.equal(decodeMetaValue(detached, fileId).disposition, 'invalid')
  const other = new Y.Doc()
  const groupedId = makeFileId('grouped-file')
  other.getMap('meta').set(groupedId, groupedText(groupedId))
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other))
  assert.equal(metaYDocSchemaDisposition(doc), 'mixed')
  assert.equal(migrateLegacyMetaDoc(doc), false)
})

test('legacy metadata remains read-only without mutating the document', () => {
  const doc = new Y.Doc()
  const fileId = makeFileId('legacy-read-only')
  doc.getMap('meta').set(fileId, legacyText(fileId))
  const before = Y.encodeStateAsUpdate(doc)

  assert.equal(metaYDocWritable(doc), false)
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before)
  assert.equal(decodeMetaValue(doc.getMap('meta').get(fileId), fileId).disposition, 'legacy-v1')
})

test('legacy deleted tombstones fail closed before grouped identity conversion', () => {
  const legacy = new Y.Doc()
  const fileId = makeFileId('legacy-deleted-identity')
  legacy.getMap('meta').set(fileId, {
    ...legacyText(fileId),
    deleted: true,
    deletedAt: 42,
    deletedBy: DEVICE,
    deletedContentVersion: {
      kind: 'binary',
      blobManifestHash: '0'.repeat(64),
    },
  })

  const candidate = new Y.Doc()
  assert.doesNotThrow(() => metaIdentityImmutable(legacy, candidate))
  assert.equal(metaIdentityImmutable(legacy, candidate), false)
  candidate.destroy()
  legacy.destroy()
})

test('identity changes and removals are rejected while new entries are allowed', () => {
  const current = new Y.Doc()
  const fileId = makeFileId('file-a')
  current.getMap('meta').set(fileId, groupedText(fileId))
  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current))
  const child = candidate.getMap<Y.Map<unknown>>('meta').get(fileId)
  assert.ok(child instanceof Y.Map)
  child.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId(`doc-${fileId}`),
    createdAt: 1,
    createdBy: makeDeviceId('changed'),
  })
  assert.equal(metaIdentityImmutable(current, candidate), false)
})

test('legacy entries may migrate only with an equivalent grouped identity', () => {
  const legacy = new Y.Doc()
  const fileId = makeFileId('legacy-identity')
  legacy.getMap('meta').set(fileId, legacyText(fileId))

  const equivalent = new Y.Doc()
  Y.applyUpdate(equivalent, Y.encodeStateAsUpdate(legacy))
  assert.equal(migrateLegacyMetaDoc(equivalent), true)
  assert.equal(metaIdentityImmutable(legacy, equivalent), true)

  const changed = new Y.Doc()
  Y.applyUpdate(changed, Y.encodeStateAsUpdate(legacy))
  assert.equal(migrateLegacyMetaDoc(changed), true)
  const child = changed.getMap<Y.Map<unknown>>('meta').get(fileId)
  assert.ok(child instanceof Y.Map)
  const identity = child.get('identity')
  assert.ok(identity && typeof identity === 'object')
  child.set('identity', { ...(identity as Record<string, unknown>), createdAt: 99 })
  assert.equal(metaIdentityImmutable(legacy, changed), false)

  const removed = new Y.Doc()
  Y.applyUpdate(removed, Y.encodeStateAsUpdate(legacy))
  assert.equal(migrateLegacyMetaDoc(removed), true)
  removed.getMap('meta').delete(fileId)
  assert.equal(metaIdentityImmutable(legacy, removed), false)
})

test('grouped root replacements are rejected while nested group updates are allowed', () => {
  const current = new Y.Doc()
  const fileId = makeFileId('root-guard')
  current.getMap('meta').set(fileId, groupedText(fileId))
  const stateVector = Y.encodeStateVector(current)

  const replacement = new Y.Doc()
  Y.applyUpdate(replacement, Y.encodeStateAsUpdate(current))
  replacement.getMap('meta').set(fileId, groupedText(fileId))
  assert.equal(
    metaRootMutationAllowed(current, Y.encodeStateAsUpdate(replacement, stateVector)),
    false,
  )

  const nested = new Y.Doc()
  Y.applyUpdate(nested, Y.encodeStateAsUpdate(current))
  const child = nested.getMap<Y.Map<unknown>>('meta').get(fileId)
  assert.ok(child instanceof Y.Map)
  child.set('location', {
    path: 'Notes/Renamed.md',
    canonicalPath: 'notes/renamed.md',
    updatedAt: 4,
    updatedBy: DEVICE,
    mtime: 42,
  })
  assert.equal(metaRootMutationAllowed(current, Y.encodeStateAsUpdate(nested, stateVector)), true)

  const added = new Y.Doc()
  Y.applyUpdate(added, Y.encodeStateAsUpdate(current))
  const newFileId = makeFileId('root-guard-new')
  added.getMap('meta').set(newFileId, groupedText(newFileId))
  assert.equal(metaRootMutationAllowed(current, Y.encodeStateAsUpdate(added, stateVector)), true)
})

function legacyText(fileId: string): MetaFile {
  return {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Legacy.md',
    canonicalPath: 'notes/legacy.md',
    type: 'text',
    ydocId: makeYDocId(`doc-${fileId}`),
    deleted: false,
    createdAt: 1,
    createdBy: DEVICE,
    contentUpdatedAt: 2,
    contentUpdatedBy: DEVICE,
    updatedAt: 3,
    updatedBy: DEVICE,
    mtime: 41,
  }
}

function groupedText(fileId: string): Y.Map<unknown> {
  const child = new Y.Map<unknown>()
  child.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId(`doc-${fileId}`),
    createdAt: 1,
    createdBy: DEVICE,
  })
  child.set('location', {
    path: 'Notes/Legacy.md',
    canonicalPath: 'notes/legacy.md',
    updatedAt: 3,
    updatedBy: DEVICE,
    mtime: 41,
  })
  child.set('content', { contentUpdatedAt: 2, contentUpdatedBy: DEVICE })
  child.set('deletion', { deleted: false })
  return child
}
