import {
  canonicalizeVaultPath,
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

import { insertMetaFile, readMetaFile } from '../../main/meta'
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

test('reconcileMetaDoc sanitizes a Windows reserved device name and is a no-op on rescan', () => {
  const file = textMeta(makeFileId('file-a'), 'Notes/CON.md', 1)
  const { map } = metaDocWith(file)

  const result = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })

  assert.equal(result.repairs.length, 1)
  assert.equal(getMeta(map, 'file-a').path, 'Notes/CON_.md')

  const rescanned = reconcileMetaDoc(map, { updatedAt: 101, updatedBy: REPAIR })
  assert.equal(rescanned.repairs.length, 0)
  assert.equal(getMeta(map, 'file-a').path, 'Notes/CON_.md')
})

test('reconcileMetaDoc resolves a portable-path collision through the existing path-conflict repair', () => {
  // Two devices independently create files whose paths only collide after portable sanitization.
  const fileA = textMeta(makeFileId('file-a'), 'CON.md', 1)
  const fileB = textMeta(makeFileId('file-b'), 'CON_.md', 2)
  const { map } = metaDocWith(fileA, fileB)

  const result = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })

  assert.equal(result.repairs.length, 2)
  assert.equal(getMeta(map, 'file-a').path, 'CON_.md')
  assert.equal(getMeta(map, 'file-b').path, 'CON_ (conflict file-b).md')
})

test('reconcileMetaDoc restores text edited after a concurrent delete', () => {
  const file = {
    ...textMeta(makeFileId('file-a'), 'Note.md', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_A,
    deletedContentVersion: textDeletionVersion(),
    contentUpdatedAt: 6,
    contentUpdatedBy: DEVICE_B,
  }
  const { map } = metaDocWith(file)

  const result = reconcileMetaDoc(map, {
    updatedAt: 100,
    updatedBy: REPAIR,
    textDeletionEvidence: new Map([
      [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) }],
    ]),
  })

  assert.equal(getMeta(map, 'file-a').deleted, false)
  assert.equal(result.repairs.length, 1)
})

test('reconcileMetaDoc defers an unloaded text YDoc and converges after it arrives', () => {
  const file = {
    ...textMeta(makeFileId('file-late-text'), 'Late.md', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_A,
    deletedContentVersion: textDeletionVersion(),
  }
  const { map } = metaDocWith(file)

  const deferred = reconcileMetaDoc(map, { updatedAt: 100, updatedBy: REPAIR })
  assert.ok(deferred.repairs[0] && 'action' in deferred.repairs[0])
  assert.equal(
    deferred.repairs[0] && 'action' in deferred.repairs[0] ? deferred.repairs[0].action : undefined,
    'defer-deletion',
  )
  assert.equal(getMeta(map, file.fileId).deleted, true)

  const restored = reconcileMetaDoc(map, {
    updatedAt: 101,
    updatedBy: REPAIR,
    textDeletionEvidence: new Map([
      [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) }],
    ]),
  })
  assert.ok(restored.repairs[0] && 'action' in restored.repairs[0])
  assert.equal(
    restored.repairs[0] && 'action' in restored.repairs[0] ? restored.repairs[0].action : undefined,
    'restore',
  )
  assert.equal(getMeta(map, file.fileId).deleted, false)
})

test('reconcileMetaDoc keeps an unverified binary deleted and reports it', () => {
  const file = {
    ...binaryMeta(makeFileId('file-a'), 'image.png', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_A,
    deletedContentVersion: {
      kind: 'binary' as const,
      blobManifestHash: makeSha256Hex('a'.repeat(64)),
    },
    blobManifestHash: makeSha256Hex('c'.repeat(64)),
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
    deletedContentVersion: {
      kind: 'binary' as const,
      blobManifestHash: makeSha256Hex('a'.repeat(64)),
    },
    blobManifestHash: makeSha256Hex('c'.repeat(64)),
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
    insertMetaFile(map, valid)
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
      insertMetaFile(map, entry)
    }
  })
  return { doc, map }
}

function getMeta(map: Y.Map<unknown>, fileId: string): MetaFile {
  const value = readMetaFile(map, fileId)
  assert.ok(value !== undefined, `expected a valid meta entry for ${fileId}`)
  assertGroupedEntry(map, fileId)
  return value
}

function assertGroupedEntry(map: Y.Map<unknown>, fileId: string): void {
  const child = map.get(fileId)
  assert.ok(child instanceof Y.Map)
  assert.deepEqual([...child.keys()].sort(compareCodeUnit), [
    'content',
    'deletion',
    'identity',
    'location',
  ])
  for (const group of ['identity', 'location', 'content', 'deletion']) {
    assert.ok(!(child.get(group) instanceof Y.Map), `${group} must remain a plain group object`)
  }
}

function snapshot(map: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of [...map.keys()].sort(compareCodeUnit)) {
    out[key] = getMeta(map, key)
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

function textDeletionVersion(): {
  readonly kind: 'text'
  readonly stateVectorBase64: string
  readonly contentSha256: ReturnType<typeof makeSha256Hex>
} {
  return {
    kind: 'text',
    stateVectorBase64: 'AA==',
    contentSha256: makeSha256Hex('a'.repeat(64)),
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
