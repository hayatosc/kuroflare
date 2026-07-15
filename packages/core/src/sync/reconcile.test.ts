import {
  canonicalizeVaultPath,
  MetaFileSchema,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeYDocId,
  type BinaryMetaFile,
  type FileId,
  type MetaFile,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { applyMetaRepair, planDeleteVsEditRepairs, planPathConflictRepairs } from '../index'

const DEVICE_ID = makeDeviceId('repair')
const OTHER_DEVICE_ID = makeDeviceId('other-device')

test('planPathConflictRepairs renames deterministic losers for one path', () => {
  const winner = textMeta(makeFileId('file-a'), 'Notes/Idea.md', 1)
  const loser = textMeta(makeFileId('file-b'), 'notes/idea.md', 2)

  assert.deepEqual(planPathConflictRepairs([loser, winner], 10, DEVICE_ID), [
    {
      fileId: loser.fileId,
      fromPath: 'notes/idea.md',
      toPath: 'Notes/Idea (conflict file-b).md',
      toCanonicalPath: 'notes/idea (conflict file-b).md',
      updatedAt: 10,
      updatedBy: DEVICE_ID,
    },
  ])
})

test('planPathConflictRepairs breaks createdAt ties by fileId', () => {
  const winner = textMeta(makeFileId('file-a'), 'Note.md', 1)
  const loser = textMeta(makeFileId('file-b'), 'NOTE.md', 1)

  const repairs = planPathConflictRepairs([loser, winner], 10, DEVICE_ID)

  assert.equal(repairs.length, 1)
  assert.equal(repairs[0]?.fileId, loser.fileId)
})

test('planPathConflictRepairs allocates suffixes around existing paths', () => {
  const winner = textMeta(makeFileId('file-a'), 'Notes/Idea.md', 1)
  const loser = textMeta(makeFileId('file-b'), 'notes/idea.md', 2)
  const existing = textMeta(makeFileId('file-c'), 'Notes/Idea (conflict file-b).md', 3)

  const repairs = planPathConflictRepairs([winner, loser, existing], 10, DEVICE_ID)

  assert.equal(repairs[0]?.toPath, 'Notes/Idea (conflict file-b-2).md')
})

test('planPathConflictRepairs ignores deleted entries', () => {
  const active = textMeta(makeFileId('file-a'), 'Note.md', 1)
  const deleted = {
    ...textMeta(makeFileId('file-b'), 'NOTE.md', 2),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
  }

  assert.deepEqual(planPathConflictRepairs([active, deleted], 10, DEVICE_ID), [])
})

test('planDeleteVsEditRepairs restores text edited after delete', () => {
  const file = {
    ...textMeta(makeFileId('file-a'), 'Note.md', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
    deletedContentVersion: textDeletionVersion('a'),
    contentUpdatedAt: 6,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }

  assert.deepEqual(
    planDeleteVsEditRepairs(
      [file],
      new Set(),
      10,
      DEVICE_ID,
      new Map([
        [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) }],
      ]),
    ),
    [
      {
        action: 'restore',
        fileId: file.fileId,
        type: 'text',
        reason: 'concurrent-edit-after-delete',
        updatedAt: 10,
        updatedBy: DEVICE_ID,
      },
    ],
  )
})

test('planDeleteVsEditRepairs restores binary only after content verification', () => {
  const complete = {
    ...binaryMeta(makeFileId('file-a'), 'image.png', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
    deletedContentVersion: {
      kind: 'binary' as const,
      blobManifestHash: makeSha256Hex('a'.repeat(64)),
    },
    blobManifestHash: makeSha256Hex('c'.repeat(64)),
    contentUpdatedAt: 6,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }
  const missing = {
    ...binaryMeta(makeFileId('file-b'), 'missing.png', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
    deletedContentVersion: {
      kind: 'binary' as const,
      blobManifestHash: makeSha256Hex('a'.repeat(64)),
    },
    blobManifestHash: makeSha256Hex('c'.repeat(64)),
    contentUpdatedAt: 6,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }

  assert.deepEqual(
    planDeleteVsEditRepairs([missing, complete], new Set([complete.fileId]), 10, DEVICE_ID),
    [
      {
        action: 'keep-deleted',
        fileId: missing.fileId,
        type: 'binary',
        reason: 'missing-binary-content',
        updatedAt: 10,
        updatedBy: DEVICE_ID,
      },
      {
        action: 'restore',
        fileId: complete.fileId,
        type: 'binary',
        reason: 'concurrent-edit-after-delete',
        updatedAt: 10,
        updatedBy: DEVICE_ID,
      },
    ],
  )
})

test('planDeleteVsEditRepairs ignores same-device delete then edit evidence', () => {
  const file = {
    ...textMeta(makeFileId('file-a'), 'Note.md', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
    deletedContentVersion: textDeletionVersion('a'),
    contentUpdatedAt: 6,
    contentUpdatedBy: DEVICE_ID,
  }

  assert.deepEqual(
    planDeleteVsEditRepairs(
      [file],
      new Set(),
      10,
      DEVICE_ID,
      new Map([
        [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('a'.repeat(64)) }],
      ]),
    ),
    [],
  )
})

test('planDeleteVsEditRepairs ignores edits that happened before delete', () => {
  const file = {
    ...textMeta(makeFileId('file-a'), 'Note.md', 1),
    deleted: true as const,
    deletedAt: 6,
    deletedBy: DEVICE_ID,
    deletedContentVersion: textDeletionVersion('a'),
    contentUpdatedAt: 5,
  }

  assert.deepEqual(
    planDeleteVsEditRepairs(
      [file],
      new Set(),
      10,
      DEVICE_ID,
      new Map([
        [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('a'.repeat(64)) }],
      ]),
    ),
    [],
  )
})

test('defers text deletion until the current YDoc dominates the deletion base', () => {
  const baseDoc = new Y.Doc()
  baseDoc.getText('content').insert(0, 'base')
  const file = {
    ...textMeta(makeFileId('file-deferred'), 'Deferred.md', 1),
    deleted: true as const,
    deletedAt: 1,
    deletedBy: DEVICE_ID,
    deletedContentVersion: {
      kind: 'text' as const,
      stateVectorBase64: stateVectorBase64(baseDoc),
      contentSha256: makeSha256Hex('a'.repeat(64)),
    },
  }

  const unavailable = planDeleteVsEditRepairs([file], new Set(), 10, DEVICE_ID)
  assert.equal(unavailable[0]?.action, 'defer-deletion')
  assert.equal(unavailable[0]?.reason, 'deletion-evidence-unavailable')

  const incomplete = planDeleteVsEditRepairs(
    [file],
    new Set(),
    10,
    DEVICE_ID,
    new Map([
      [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) }],
    ]),
  )
  assert.equal(incomplete[0]?.action, 'defer-deletion')
  assert.equal(incomplete[0]?.reason, 'deletion-base-not-dominated')

  const currentDoc = new Y.Doc()
  Y.applyUpdate(currentDoc, Y.encodeStateAsUpdate(baseDoc))
  currentDoc.getText('content').insert(currentDoc.getText('content').length, ' edit')
  const restored = planDeleteVsEditRepairs(
    [file],
    new Set(),
    10,
    DEVICE_ID,
    new Map([
      [
        file.fileId,
        {
          stateVectorBase64: stateVectorBase64(currentDoc),
          contentSha256: makeSha256Hex('b'.repeat(64)),
        },
      ],
    ]),
  )
  assert.equal(restored[0]?.action, 'restore')
  baseDoc.destroy()
  currentDoc.destroy()
})

test('text decisions are invariant to arbitrary device clock skew', () => {
  const earlyDelete = {
    ...textMeta(makeFileId('file-clock-early'), 'Early.md', 1),
    deleted: true as const,
    deletedAt: 1,
    deletedBy: DEVICE_ID,
    deletedContentVersion: textDeletionVersion('a'),
    contentUpdatedAt: 9_000,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }
  const lateDelete = {
    ...textMeta(makeFileId('file-clock-late'), 'Late.md', 1),
    deleted: true as const,
    deletedAt: 9_000,
    deletedBy: DEVICE_ID,
    deletedContentVersion: textDeletionVersion('a'),
    contentUpdatedAt: 1,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }
  const repairs = planDeleteVsEditRepairs(
    [earlyDelete, lateDelete],
    new Set(),
    10,
    DEVICE_ID,
    new Map([
      [
        earlyDelete.fileId,
        { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) },
      ],
      [
        lateDelete.fileId,
        { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) },
      ],
    ]),
  )
  assert.deepEqual(
    repairs.map((repair) => repair.action),
    ['restore', 'restore'],
  )
})

test('applyMetaRepair applies path conflict repairs without mutating input', () => {
  const winner = textMeta(makeFileId('file-a'), 'Note.md', 1)
  const loser = textMeta(makeFileId('file-b'), 'note.md', 2)
  const repair = planPathConflictRepairs([winner, loser], 10, DEVICE_ID)[0]
  assert(repair)

  const repaired = applyMetaRepair(loser, repair)

  assert.equal(loser.path, 'note.md')
  assert.equal(repaired.path, 'Note (conflict file-b).md')
  assert.equal(repaired.canonicalPath, 'note (conflict file-b).md')
  assert.equal(repaired.updatedAt, 10)
  assert.equal(v.is(MetaFileSchema, repaired) && repaired.fileId === loser.fileId, true)
})

test('applyMetaRepair clears tombstone for restore plans', () => {
  const file = {
    ...textMeta(makeFileId('file-a'), 'Note.md', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
    deletedContentVersion: textDeletionVersion('a'),
    contentUpdatedAt: 6,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }
  const repair = planDeleteVsEditRepairs(
    [file],
    new Set(),
    10,
    DEVICE_ID,
    new Map([
      [file.fileId, { stateVectorBase64: 'AA==', contentSha256: makeSha256Hex('b'.repeat(64)) }],
    ]),
  )[0]
  assert(repair)

  const repaired = applyMetaRepair(file, repair)

  assert.equal(repaired.deleted, false)
  assert.equal(repaired.updatedAt, 10)
  assert.equal(repaired.updatedBy, DEVICE_ID)
  assert.equal(v.is(MetaFileSchema, repaired) && repaired.fileId === file.fileId, true)
})

test('applyMetaRepair leaves keep-deleted plans unchanged', () => {
  const file = {
    ...binaryMeta(makeFileId('file-a'), 'image.png', 1),
    deleted: true as const,
    deletedAt: 5,
    deletedBy: DEVICE_ID,
    contentUpdatedAt: 6,
    contentUpdatedBy: OTHER_DEVICE_ID,
  }
  const repair = planDeleteVsEditRepairs([file], new Set(), 10, DEVICE_ID)[0]
  assert(repair)

  const repaired = applyMetaRepair(file, repair)

  assert.deepEqual(repaired, file)
})

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
    createdBy: DEVICE_ID,
    contentUpdatedAt: createdAt,
    contentUpdatedBy: DEVICE_ID,
    updatedAt: createdAt,
    updatedBy: DEVICE_ID,
    mtime: createdAt,
  }
}

function textDeletionVersion(seed: string): {
  readonly kind: 'text'
  readonly stateVectorBase64: string
  readonly contentSha256: ReturnType<typeof makeSha256Hex>
} {
  return {
    kind: 'text',
    stateVectorBase64: 'AA==',
    contentSha256: makeSha256Hex(seed.repeat(64)),
  }
}

function stateVectorBase64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString('base64')
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
    createdBy: DEVICE_ID,
    contentUpdatedAt: createdAt,
    contentUpdatedBy: DEVICE_ID,
    updatedAt: createdAt,
    updatedBy: DEVICE_ID,
    mtime: createdAt,
  }
}
