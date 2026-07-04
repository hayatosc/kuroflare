import { makeSha256Hex, makeYDocId, type DocId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  decodeFullSnapshotBytesFromResponse,
  decideFullSnapshotApply,
  makeFullSnapshotApplyInputFromResponse,
} from '../sync/snapshot'

const firstHash = makeSha256Hex('a'.repeat(64))
const secondHash = makeSha256Hex('b'.repeat(64))
const abcHash = makeSha256Hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
const stateVectorHash = makeSha256Hex(
  '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
)
const fileDocId = { kind: 'file', ydocId: makeYDocId('doc-1') } satisfies DocId
const otherFileDocId = { kind: 'file', ydocId: makeYDocId('doc-2') } satisfies DocId
const metaDocId = { kind: 'meta' } satisfies DocId

test('full snapshot bytes decode and verify response update payloads', async () => {
  const result = await decodeFullSnapshotBytesFromResponse({
    response: {
      docId: fileDocId,
      manifestSeq: 3,
      snapshotKey: 'snapshots/vault-1/files/doc-1/20.yupdate',
      snapshotSeq: 20,
      updateSha256: abcHash,
      stateVectorSha256: stateVectorHash,
      stateVector: 'AQID',
      updateBytesBase64: 'YWJj',
    },
    maxUpdateBytes: 3,
    maxStateVectorBytes: 3,
  })

  assert.equal(result.ok, true)
  if (!result.ok) {
    throw new Error(`unexpected snapshot bytes rejection: ${result.reason}`)
  }
  assert.deepEqual(result.updateBytes, new TextEncoder().encode('abc'))
  assert.deepEqual(result.stateVectorBytes, Uint8Array.from([1, 2, 3]))
  assert.equal(result.actualUpdateSha256, abcHash)
  assert.equal(result.actualStateVectorSha256, stateVectorHash)
})

test('full snapshot bytes reject untrusted response update payloads', async () => {
  const response = {
    docId: fileDocId,
    manifestSeq: 3,
    snapshotKey: 'snapshots/vault-1/files/doc-1/20.yupdate',
    snapshotSeq: 20,
    updateSha256: abcHash,
    stateVectorSha256: stateVectorHash,
    stateVector: 'AQID',
    updateBytesBase64: 'YWJj',
  }

  assert.deepEqual(
    await decodeFullSnapshotBytesFromResponse({
      response: { ...response, updateBytesBase64: 'not base64!' },
    }),
    { ok: false, reason: 'invalid-base64' },
  )

  assert.deepEqual(
    await decodeFullSnapshotBytesFromResponse({
      response: { ...response, updateSha256: firstHash },
    }),
    { ok: false, reason: 'hash-mismatch' },
  )

  assert.deepEqual(
    await decodeFullSnapshotBytesFromResponse({
      response: { ...response, stateVectorSha256: firstHash },
    }),
    { ok: false, reason: 'state-vector-hash-mismatch' },
  )

  assert.deepEqual(
    await decodeFullSnapshotBytesFromResponse({
      response,
      maxUpdateBytes: 2,
    }),
    { ok: false, reason: 'snapshot-too-large' },
  )

  assert.deepEqual(
    await decodeFullSnapshotBytesFromResponse({
      response,
      maxStateVectorBytes: 2,
    }),
    { ok: false, reason: 'state-vector-too-large' },
  )

  assert.deepEqual(
    await decodeFullSnapshotBytesFromResponse({
      response,
      maxUpdateBytes: -1,
    }),
    { ok: false, reason: 'invalid-size-limit' },
  )
})

test('full snapshot apply accepts a newer verified inactive doc snapshot', () => {
  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      currentSnapshotSeq: 10,
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    {
      action: 'apply',
      patch: {
        docId: fileDocId,
        snapshotSeq: 20,
        remoteCursorSeq: 20,
        stateVectorBase64: 'AQID',
        clearPendingForDoc: true,
      },
    },
  )
})

test('full snapshot apply input normalizes latest snapshot HTTP responses', () => {
  assert.deepEqual(
    makeFullSnapshotApplyInputFromResponse({
      requestedDocId: fileDocId,
      response: {
        docId: fileDocId,
        manifestSeq: 3,
        snapshotKey: 'snapshots/vault-1/files/doc-1/20.yupdate',
        snapshotSeq: 20,
        updateSha256: firstHash,
        stateVectorSha256: stateVectorHash,
        stateVector: 'AQID',
        updateBytesBase64: 'BAUG',
      },
      actualUpdateSha256: firstHash,
      currentSnapshotSeq: 10,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    {
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      currentSnapshotSeq: 10,
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    },
  )

  assert.deepEqual(
    makeFullSnapshotApplyInputFromResponse({
      requestedDocId: metaDocId,
      response: {
        manifestSeq: 3,
        snapshotKey: 'snapshots/vault-1/meta/20.yupdate',
        snapshotSeq: 20,
        updateSha256: firstHash,
        stateVectorSha256: stateVectorHash,
        stateVector: 'AQID',
        updateBytesBase64: 'BAUG',
      },
      actualUpdateSha256: firstHash,
      currentSnapshotSeq: 10,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    {
      requestedDocId: metaDocId,
      snapshotDocId: metaDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      currentSnapshotSeq: 10,
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    },
  )
})

test('full snapshot apply input prevents meta responses from satisfying file resets', () => {
  const input = makeFullSnapshotApplyInputFromResponse({
    requestedDocId: fileDocId,
    response: {
      manifestSeq: 3,
      snapshotKey: 'snapshots/vault-1/meta/20.yupdate',
      snapshotSeq: 20,
      updateSha256: firstHash,
      stateVectorSha256: stateVectorHash,
      stateVector: 'AQID',
      updateBytesBase64: 'BAUG',
    },
    actualUpdateSha256: firstHash,
    currentSnapshotSeq: 10,
    hasPendingLocalUpdates: false,
    activeEditorBound: false,
  })

  assert.deepEqual(decideFullSnapshotApply(input), { action: 'reject', reason: 'doc-mismatch' })
})

test('full snapshot apply waits instead of overwriting unsent or active local state', () => {
  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      currentSnapshotSeq: 10,
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: true,
      activeEditorBound: false,
    }),
    { action: 'wait', reason: 'pending-local-updates' },
  )

  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      currentSnapshotSeq: 10,
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: true,
    }),
    { action: 'wait', reason: 'active-editor-bound' },
  )
})

test('full snapshot apply rejects mismatched identity, hash, or invalid sequence', () => {
  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: otherFileDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    { action: 'reject', reason: 'doc-mismatch' },
  )

  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: 20,
      stateVectorBase64: 'AQID',
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: secondHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    { action: 'reject', reason: 'hash-mismatch' },
  )

  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: -1,
      stateVectorBase64: 'AQID',
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    { action: 'reject', reason: 'invalid-snapshot-seq' },
  )
})

test('full snapshot apply skips snapshots that do not advance local cursor', () => {
  assert.deepEqual(
    decideFullSnapshotApply({
      requestedDocId: fileDocId,
      snapshotDocId: fileDocId,
      snapshotSeq: 10,
      stateVectorBase64: 'AQID',
      currentSnapshotSeq: 10,
      expectedUpdateSha256: firstHash,
      actualUpdateSha256: firstHash,
      hasPendingLocalUpdates: false,
      activeEditorBound: false,
    }),
    { action: 'skip', reason: 'stale-snapshot' },
  )
})
