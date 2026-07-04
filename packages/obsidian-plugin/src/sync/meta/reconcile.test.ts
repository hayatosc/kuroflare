import {
  canonicalizeVaultPath,
  isMetaFile,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeYDocId,
  type BinaryMetaFile,
  type FileId,
  type MetaFile,
} from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { reconcileMetaDoc } from '../meta/reconcile'

const REPAIR = makeDeviceId('repair')
const DEVICE_A = makeDeviceId('device-a')
const DEVICE_B = makeDeviceId('device-b')

test('reconcileMetaDoc converges concurrent same-path creates to identical entries', () => {
  // Two clients each create a file at the same canonical path while offline.
  const fileA = textMeta(makeFileId('file-a'), 'Note.md', 1)
  const fileB = textMeta(makeFileId('file-b'), 'note.md', 2)
  const a = metaDocWith(fileA)
  const b = metaDocWith(fileB)

  // CRDT merge: both docs now hold both entries at the conflicting canonical path.
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))

  // Each client repairs independently with the same actor + clock.
  reconcileMetaDoc(a.map, { updatedAt: 100, updatedBy: REPAIR })
  reconcileMetaDoc(b.map, { updatedAt: 100, updatedBy: REPAIR })

  assert.deepEqual(snapshot(a.map), snapshot(b.map))
  // Winner keeps its path (createdAt asc, then fileId asc); loser renames deterministically.
  assert.equal(getMeta(a.map, 'file-a').path, 'Note.md')
  assert.equal(getMeta(a.map, 'file-b').path, 'Note (conflict file-b).md')
})

test('reconcileMetaDoc restores text edited after a concurrent delete', () => {
  const file = {
    ...textMeta(makeFileId('file-a'), 'Note.md', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_A,
    contentUpdatedAt: 6,
    contentUpdatedBy: DEVICE_B,
  }
  const { map } = metaDocWith(file)

  const result = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })

  assert.equal(getMeta(map, 'file-a').deleted, false)
  assert.equal(result.repairs.length, 1)
})

test('reconcileMetaDoc keeps an unverified binary deleted and reports it', () => {
  const file = {
    ...binaryMeta(makeFileId('file-a'), 'image.png', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_A,
    contentUpdatedAt: 6,
    contentUpdatedBy: DEVICE_B,
  }
  const { map } = metaDocWith(file)

  const result = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })

  assert.equal(getMeta(map, 'file-a').deleted, true)
  const repair = result.repairs[0]
  assert.ok(repair && 'action' in repair && repair.action === 'keep-deleted')
})

test('reconcileMetaDoc restores a binary once its content is verified', () => {
  const file = {
    ...binaryMeta(makeFileId('file-a'), 'image.png', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_A,
    contentUpdatedAt: 6,
    contentUpdatedBy: DEVICE_B,
  }
  const { map } = metaDocWith(file)

  reconcileMetaDoc(map, {
    updatedAt: 100,
    updatedBy: REPAIR,
    restorableBinaryFileIds: new Set([file.fileId]),
  })

  assert.equal(getMeta(map, 'file-a').deleted, false)
})

test('reconcileMetaDoc is a no-op without conflicts', () => {
  const { map } = metaDocWith(
    textMeta(makeFileId('file-a'), 'A.md', 1),
    textMeta(makeFileId('file-b'), 'B.md', 2),
  )
  const before = snapshot(map)

  const result = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })

  assert.equal(result.repairs.length, 0)
  assert.deepEqual(snapshot(map), before)
})

test('reconcileMetaDoc reports schema-invalid entries without touching them', () => {
  const doc = new Y.Doc()
  const map = doc.getMap('meta')
  const valid = textMeta(makeFileId('file-a'), 'A.md', 1)
  doc.transact(() => {
    map.set('file-bad', { not: 'a meta file' })
    map.set(valid.fileId, valid)
  })

  const result = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })

  assert.deepEqual(result.invalidFileIds, ['file-bad'])
  assert.equal(result.repairs.length, 0)
})

function metaDocWith(...entries: readonly MetaFile[]): {
  readonly doc: Y.Doc
  readonly map: Y.Map<unknown>
} {
  const doc = new Y.Doc()
  const map = doc.getMap<unknown>('meta')
  doc.transact(() => {
    for (const entry of entries) {
      map.set(entry.fileId, entry)
    }
  })
  return { doc, map }
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

function compareCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  return left > right ? 1 : 0
}

function textMeta(fileId: FileId, path: string, createdAt: number): MetaFile {
  return {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: canonicalizeVaultPath(path),
    type: 'text',
    ydocId: makeYDocId(`doc-${fileId}`),
    deleted: false,
    createdAt,
    createdBy: DEVICE_A,
    contentUpdatedAt: createdAt,
    contentUpdatedBy: DEVICE_A,
    updatedAt: createdAt,
    updatedBy: DEVICE_A,
    mtime: createdAt,
  }
}

function binaryMeta(fileId: FileId, path: string, createdAt: number): BinaryMetaFile {
  return {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: canonicalizeVaultPath(path),
    type: 'binary',
    blobManifestHash: makeSha256Hex('a'.repeat(64)),
    blobChunks: [makeSha256Hex('b'.repeat(64))],
    deleted: false,
    createdAt,
    createdBy: DEVICE_A,
    contentUpdatedAt: createdAt,
    contentUpdatedBy: DEVICE_A,
    updatedAt: createdAt,
    updatedBy: DEVICE_A,
    mtime: createdAt,
  }
}
