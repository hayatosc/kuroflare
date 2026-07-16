import {
  hashBytesSha256,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeYDocId,
} from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { R2BucketBinding } from '../runtime/types'
import { verifySnapshotBytes, verifySnapshotObject } from './snapshot-health'

const docId = { kind: 'file' as const, ydocId: 'ydoc-snapshot-health' }

test('metadata snapshot health accepts grouped v2 and readable legacy flat values', async () => {
  const fileId = makeFileId('snapshot-meta-file')
  const deviceId = makeDeviceId('snapshot-meta-device')
  const grouped = new Y.Doc()
  const child = new Y.Map<unknown>()
  child.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId('snapshot-meta-doc'),
    createdAt: 1,
    createdBy: deviceId,
  })
  child.set('location', {
    path: 'Notes/Snapshot.md',
    canonicalPath: 'notes/snapshot.md',
    updatedAt: 1,
    updatedBy: deviceId,
    mtime: 1,
  })
  child.set('content', { contentUpdatedAt: 1, contentUpdatedBy: deviceId })
  child.set('deletion', { deleted: false })
  grouped.getMap('meta').set(fileId, child)
  const groupedBytes = Y.encodeStateAsUpdate(grouped)
  const groupedStateVector = Y.encodeStateVector(grouped)
  const groupedResult = await verifySnapshotBytes(
    groupedBytes,
    { kind: 'meta' },
    {
      byteLength: groupedBytes.byteLength,
      updateSha256: await hashBytesSha256(groupedBytes),
      stateVectorSha256: await hashBytesSha256(groupedStateVector),
    },
  )
  assert.equal(groupedResult.status, 'verified')
  grouped.destroy()

  const legacy = new Y.Doc()
  legacy.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Snapshot.md',
    canonicalPath: 'notes/snapshot.md',
    type: 'text',
    ydocId: makeYDocId('snapshot-meta-doc'),
    deleted: false,
    createdAt: 1,
    createdBy: deviceId,
    contentUpdatedAt: 1,
    contentUpdatedBy: deviceId,
    updatedAt: 1,
    updatedBy: deviceId,
    mtime: 1,
  })
  const legacyBytes = Y.encodeStateAsUpdate(legacy)
  const legacyResult = await verifySnapshotBytes(
    legacyBytes,
    { kind: 'meta' },
    {
      byteLength: legacyBytes.byteLength,
      updateSha256: await hashBytesSha256(legacyBytes),
      stateVectorSha256: await hashBytesSha256(Y.encodeStateVector(legacy)),
    },
  )
  assert.equal(legacyResult.status, 'verified')
  assert.deepEqual(legacyResult.reasons, [])
  legacy.destroy()
})

test('snapshot verifier accepts matching byte, update hash, state vector, and Yjs evidence', async () => {
  const source = new Y.Doc()
  source.getText('content').insert(0, 'healthy')
  const bytes = Y.encodeStateAsUpdate(source)
  const stateVector = Y.encodeStateVector(source)
  source.destroy()

  const result = await verifySnapshotBytes(bytes, docId, {
    byteLength: bytes.byteLength,
    updateSha256: await hashBytesSha256(bytes),
    stateVectorSha256: await hashBytesSha256(stateVector),
  })

  assert.equal(result.status, 'verified')
  assert.deepEqual(result.reasons, [])
  assert.deepEqual(result.stateVector, stateVector)
})

test('snapshot verifier reports hash and length mismatches without selecting the object', async () => {
  const bytes = Y.encodeStateAsUpdate(new Y.Doc())
  const result = await verifySnapshotBytes(bytes, docId, {
    byteLength: bytes.byteLength + 1,
    updateSha256: makeSha256Hex('0'.repeat(64)),
    stateVectorSha256: makeSha256Hex('0'.repeat(64)),
  })

  assert.equal(result.status, 'mismatch')
  assert.equal(result.reasons.includes('byte-length-mismatch'), true)
  assert.equal(result.reasons.includes('update-hash-mismatch'), true)
  assert.equal(result.reasons.includes('state-vector-hash-mismatch'), true)
})

test('legacy snapshots remain unverified until expected evidence is supplied', async () => {
  const bytes = Y.encodeStateAsUpdate(new Y.Doc())
  const result = await verifySnapshotObject(
    {
      async get() {
        return { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer } as const
      },
      async head() {
        return null
      },
      async list() {
        return { objects: [], truncated: false }
      },
      async put() {},
      async delete() {},
      async createMultipartUpload() {
        throw new Error('not implemented')
      },
      resumeMultipartUpload() {
        throw new Error('not implemented')
      },
    } satisfies R2BucketBinding,
    'snapshots/vault/files/ydoc/1.yupdate',
    docId,
    undefined,
  )

  assert.equal(result.status, 'unverified')
  assert.deepEqual(result.reasons, ['missing-evidence'])
})
