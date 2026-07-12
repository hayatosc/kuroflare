import { hashBytesSha256, makeSha256Hex } from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { R2BucketBinding } from '../runtime/types'
import { verifySnapshotBytes, verifySnapshotObject } from './snapshot-health'

const docId = { kind: 'file' as const, ydocId: 'ydoc-snapshot-health' }

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
    } satisfies R2BucketBinding,
    'snapshots/vault/files/ydoc/1.yupdate',
    docId,
    undefined,
  )

  assert.equal(result.status, 'unverified')
  assert.deepEqual(result.reasons, ['missing-evidence'])
})
