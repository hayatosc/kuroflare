import assert from 'node:assert/strict'

import { makeVaultId, makeYDocId, type DocId } from '@kuroflare/protocol'
import * as v from 'valibot'
import { test } from 'vitest'

import {
  chooseSnapshotForRestore,
  SnapshotManifestSchema,
  makeLatestManifestKey,
  makeManifestKey,
  makeSnapshotListPrefix,
  makeSnapshotObjectKey,
  makeSnapshotPointerKey,
  type SnapshotCandidate,
} from './snapshots.js'

const vaultId = makeVaultId('vault-a')
const ydocId = makeYDocId('file-a')
const metaDocId: DocId = { kind: 'meta' }
const fileDocId: DocId = { kind: 'file', ydocId }
const sha256 = 'a'.repeat(64)

test('snapshot keys match the R2 naming scheme', () => {
  assert.equal(makeSnapshotObjectKey(vaultId, metaDocId, 7), 'snapshots/vault-a/meta/7.yupdate')
  assert.equal(makeSnapshotListPrefix(vaultId, metaDocId), 'snapshots/vault-a/meta/')
  assert.equal(
    makeSnapshotObjectKey(vaultId, fileDocId, 8),
    'snapshots/vault-a/files/file-a/8.yupdate',
  )
  assert.equal(makeSnapshotListPrefix(vaultId, fileDocId), 'snapshots/vault-a/files/file-a/')
  assert.equal(makeSnapshotPointerKey(vaultId, metaDocId), 'snapshots/vault-a/pointers/meta.json')
  assert.equal(
    makeSnapshotPointerKey(vaultId, fileDocId),
    'snapshots/vault-a/pointers/files/file-a.json',
  )
  assert.equal(makeManifestKey(vaultId, 3), 'snapshots/vault-a/manifests/3.json')
  assert.equal(makeLatestManifestKey(vaultId), 'snapshots/vault-a/manifests/latest.json')
})

test('snapshot keys reject non-positive sequence numbers', () => {
  assert.throws(() => makeSnapshotObjectKey(vaultId, metaDocId, 0), RangeError)
  assert.throws(() => makeManifestKey(vaultId, -1), RangeError)
})

test('snapshot manifest guard validates doc entries and hashes', () => {
  assert.equal(
    v.is(SnapshotManifestSchema, {
      version: 1,
      vaultId,
      manifestSeq: 1,
      createdAt: 2,
      docs: [
        {
          docId: metaDocId,
          snapshotSeq: 7,
          snapshotKey: 'snapshots/vault-a/meta/7.yupdate',
          updateSha256: sha256,
          stateVectorSha256: sha256,
        },
        {
          docId: fileDocId,
          snapshotSeq: 8,
          snapshotKey: 'snapshots/vault-a/files/file-a/8.yupdate',
          updateSha256: sha256,
          stateVectorSha256: sha256,
        },
      ],
    }),
    true,
  )

  assert.equal(
    v.is(SnapshotManifestSchema, {
      version: 1,
      vaultId,
      manifestSeq: 1,
      createdAt: 2,
      docs: [{ docId: metaDocId, snapshotSeq: 7, snapshotKey: '', updateSha256: sha256 }],
    }),
    false,
  )
})

test('restore choice trusts a healthy pointer when it is current', () => {
  const pointer: SnapshotCandidate = { key: 'pointer', upperSeq: 10, healthy: true }

  assert.deepEqual(
    chooseSnapshotForRestore(pointer, [
      { key: 'older', upperSeq: 5, healthy: true },
      { key: 'pointer', upperSeq: 10, healthy: true },
    ]),
    { key: 'pointer', upperSeq: 10, source: 'pointer' },
  )
})

test('restore choice falls back when pointer is stale or corrupt', () => {
  assert.deepEqual(
    chooseSnapshotForRestore({ key: 'stale', upperSeq: 5, healthy: true }, [
      { key: 'newer', upperSeq: 10, healthy: true },
    ]),
    { key: 'newer', upperSeq: 10, source: 'fallback-list' },
  )

  assert.deepEqual(
    chooseSnapshotForRestore({ key: 'corrupt', upperSeq: 20, healthy: false }, [
      { key: 'healthy', upperSeq: 10, healthy: true },
      { key: 'corrupt', upperSeq: 20, healthy: false },
    ]),
    { key: 'healthy', upperSeq: 10, source: 'fallback-list' },
  )
})

test('restore choice requires at least one healthy listed snapshot', () => {
  assert.throws(
    () => chooseSnapshotForRestore(undefined, [{ key: 'bad', upperSeq: 1, healthy: false }]),
    /No healthy snapshot candidate/,
  )
})
