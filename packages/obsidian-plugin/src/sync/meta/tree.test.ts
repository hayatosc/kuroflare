import {
  isMetaFile,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeYDocId,
  type BinaryMetaFile,
  type MetaFile,
} from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { reconcileMetaDoc } from '../meta/reconcile'
import { applyFileCreate, applyFileDelete, applyFileRename } from '../meta/tree'

const DEVICE_A = makeDeviceId('device-a')
const DEVICE_B = makeDeviceId('device-b')
const REPAIR = makeDeviceId('repair')

test('applyFileCreate registers an active text entry keyed by file ID', () => {
  const { map } = metaDoc()
  const fileId = makeFileId('file-a')

  applyFileCreate(map, {
    fileId,
    path: 'Notes/Idea.md',
    ydocId: makeYDocId('doc-a'),
    deviceId: DEVICE_A,
    now: 1,
  })

  const entry = getMeta(map, fileId)
  assert.equal(entry.type, 'text')
  assert.equal(entry.path, 'Notes/Idea.md')
  assert.equal(entry.canonicalPath, 'notes/idea.md')
  assert.equal(entry.deleted, false)
})

test('applyFileRename updates the path on the same file ID instead of delete+create', () => {
  const { map } = metaDoc()
  const fileId = makeFileId('file-a')
  applyFileCreate(map, {
    fileId,
    path: 'Old.md',
    ydocId: makeYDocId('doc-a'),
    deviceId: DEVICE_A,
    now: 1,
  })

  const result = applyFileRename(map, {
    fromPath: 'Old.md',
    toPath: 'New.md',
    deviceId: DEVICE_B,
    now: 2,
  })

  assert.deepEqual(result, { action: 'renamed', fileId })
  // No new entry: the rename mutated the existing file ID's path only.
  assert.equal(map.size, 1)
  const entry = getMeta(map, fileId)
  assert.equal(entry.fileId, fileId)
  assert.equal(entry.path, 'New.md')
  assert.equal(entry.canonicalPath, 'new.md')
  assert.equal(entry.deleted, false)
  assert.equal(entry.createdAt, 1)
  assert.equal(entry.updatedAt, 2)
})

test('applyFileRename reports not-found for an unknown path and changes nothing', () => {
  const { map } = metaDoc()
  applyFileCreate(map, {
    fileId: makeFileId('file-a'),
    path: 'A.md',
    ydocId: makeYDocId('doc-a'),
    deviceId: DEVICE_A,
    now: 1,
  })

  const result = applyFileRename(map, {
    fromPath: 'Missing.md',
    toPath: 'B.md',
    deviceId: DEVICE_A,
    now: 2,
  })

  assert.deepEqual(result, { action: 'not-found' })
  assert.equal(getMeta(map, makeFileId('file-a')).path, 'A.md')
})

test('applyFileRename preserves binary blob references on the same file ID', () => {
  const { map } = metaDoc()
  const fileId = makeFileId('file-a')
  const manifestHash = makeSha256Hex('a'.repeat(64))
  const chunkHash = makeSha256Hex('b'.repeat(64))
  map.set(fileId, binaryMeta(fileId, 'Images/Old.png', manifestHash, [chunkHash], 1))

  const result = applyFileRename(map, {
    fromPath: 'Images/Old.png',
    toPath: 'Images/New.png',
    deviceId: DEVICE_B,
    now: 2,
  })

  assert.deepEqual(result, { action: 'renamed', fileId })
  const entry = getMeta(map, fileId)
  assert.equal(entry.type, 'binary')
  assert.equal(entry.path, 'Images/New.png')
  assert.equal(entry.canonicalPath, 'images/new.png')
  assert.equal(entry.type === 'binary' && entry.blobManifestHash, manifestHash)
  assert.deepEqual(entry.type === 'binary' ? entry.blobChunks : [], [chunkHash])
})

test('applyFileDelete tombstones the entry without removing it', () => {
  const { map } = metaDoc()
  const fileId = makeFileId('file-a')
  applyFileCreate(map, {
    fileId,
    path: 'A.md',
    ydocId: makeYDocId('doc-a'),
    deviceId: DEVICE_A,
    now: 1,
  })

  const result = applyFileDelete(map, { path: 'A.md', deviceId: DEVICE_B, now: 5 })

  assert.deepEqual(result, { action: 'deleted', fileId })
  assert.equal(map.size, 1)
  const entry = getMeta(map, fileId)
  assert.equal(entry.deleted, true)
  assert.equal(entry.deleted === true && entry.deletedAt, 5)
})

test('applyFileDelete tombstones binary entries without dropping blob references', () => {
  const { map } = metaDoc()
  const fileId = makeFileId('file-a')
  const manifestHash = makeSha256Hex('a'.repeat(64))
  const chunkHash = makeSha256Hex('b'.repeat(64))
  map.set(fileId, binaryMeta(fileId, 'Images/A.png', manifestHash, [chunkHash], 1))

  const result = applyFileDelete(map, { path: 'Images/A.png', deviceId: DEVICE_B, now: 5 })

  assert.deepEqual(result, { action: 'deleted', fileId })
  const entry = getMeta(map, fileId)
  assert.equal(entry.type, 'binary')
  assert.equal(entry.deleted, true)
  assert.equal(entry.deleted === true && entry.deletedAt, 5)
  assert.equal(entry.type === 'binary' && entry.blobManifestHash, manifestHash)
  assert.deepEqual(entry.type === 'binary' ? entry.blobChunks : [], [chunkHash])
})

test('a rename is no longer found at its old path but is found at its new path', () => {
  const { map } = metaDoc()
  applyFileCreate(map, {
    fileId: makeFileId('file-a'),
    path: 'Old.md',
    ydocId: makeYDocId('doc-a'),
    deviceId: DEVICE_A,
    now: 1,
  })
  applyFileRename(map, { fromPath: 'Old.md', toPath: 'New.md', deviceId: DEVICE_A, now: 2 })

  assert.deepEqual(applyFileDelete(map, { path: 'Old.md', deviceId: DEVICE_A, now: 3 }), {
    action: 'not-found',
  })
  assert.equal(
    applyFileDelete(map, { path: 'New.md', deviceId: DEVICE_A, now: 3 }).action,
    'deleted',
  )
})

test('concurrent renames into the same path converge after reconcile', () => {
  // Both files are created once on client A and replicated to B (shared create history).
  const a = metaDoc()
  applyFileCreate(a.map, {
    fileId: makeFileId('file-a'),
    path: 'a.md',
    ydocId: makeYDocId('doc-a'),
    deviceId: DEVICE_A,
    now: 1,
  })
  applyFileCreate(a.map, {
    fileId: makeFileId('file-b'),
    path: 'b.md',
    ydocId: makeYDocId('doc-b'),
    deviceId: DEVICE_A,
    now: 2,
  })
  const b = metaDoc()
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))

  // Concurrent rename: each client moves a different file onto the same target path.
  applyFileRename(a.map, { fromPath: 'a.md', toPath: 'Shared.md', deviceId: DEVICE_A, now: 10 })
  applyFileRename(b.map, { fromPath: 'b.md', toPath: 'Shared.md', deviceId: DEVICE_B, now: 10 })

  // CRDT merge, then each client repairs independently with the same actor + clock.
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
  reconcileMetaDoc(a.map, { updatedAt: 100, updatedBy: REPAIR })
  reconcileMetaDoc(b.map, { updatedAt: 100, updatedBy: REPAIR })

  assert.deepEqual(snapshot(a.map), snapshot(b.map))
  // file-a wins the path (createdAt asc); file-b takes a deterministic conflict path.
  assert.equal(getMeta(a.map, makeFileId('file-a')).path, 'Shared.md')
  assert.equal(getMeta(a.map, makeFileId('file-b')).path, 'Shared (conflict file-b).md')
})

function metaDoc(): { readonly doc: Y.Doc; readonly map: Y.Map<unknown> } {
  const doc = new Y.Doc()
  return { doc, map: doc.getMap<unknown>('meta') }
}

function getMeta(map: Y.Map<unknown>, fileId: string): MetaFile {
  const value = map.get(fileId)
  assert.ok(isMetaFile(value, fileId), `expected a valid meta entry for ${fileId}`)
  return value
}

function snapshot(map: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of [...map.keys()].sort(compareCodeUnit)) {
    out[key] = map.get(key)
  }
  return out
}

function binaryMeta(
  fileId: ReturnType<typeof makeFileId>,
  path: string,
  blobManifestHash: ReturnType<typeof makeSha256Hex>,
  blobChunks: readonly ReturnType<typeof makeSha256Hex>[],
  now: number,
): BinaryMetaFile {
  return {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: path.toLowerCase(),
    type: 'binary',
    blobManifestHash,
    blobChunks: [...blobChunks],
    deleted: false,
    createdAt: now,
    createdBy: DEVICE_A,
    contentUpdatedAt: now,
    contentUpdatedBy: DEVICE_A,
    updatedAt: now,
    updatedBy: DEVICE_A,
    mtime: now,
  }
}

function compareCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  return left > right ? 1 : 0
}
