import { encodeBlobManifestJson, makeDeviceId, makeSha256Hex, makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { VaultRoom } from '../../runtime'
import {
  TEST_DEVICE_TOKEN_SECRET,
  FakeR2Bucket,
  FakeState,
  SqlOnlyStorage,
  hashTestBytes,
  hashTestText,
  makeDeviceToken,
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  testBlobManifest,
} from '../support'

test('VaultRoom serves authenticated blob head, upload, and download proxy requests', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const existingBytes = new TextEncoder().encode('existing blob payload')
  const existingHash = makeSha256Hex(await hashTestText('existing blob payload'))
  const missingHash = makeSha256Hex('a'.repeat(64))
  bucket.set(`vaults/vault-1/blobs/${existingHash}`, existingBytes)

  const headResponse = await room.fetch(
    new Request('https://worker.example/blobs/head', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
      body: JSON.stringify({ hashes: [existingHash, missingHash] }),
    }),
  )

  assert.equal(headResponse.status, 200)
  assert.deepEqual(await headResponse.json(), {
    exists: {
      [existingHash]: { found: true, size: existingBytes.byteLength },
      [missingHash]: { found: false },
    },
  })
  assert.deepEqual(bucket.heads, [
    `vaults/vault-1/blobs/${existingHash}`,
    `vaults/vault-1/blobs/${missingHash}`,
  ])
  assert.equal(bucket.gets.length, 0)

  const uploadBytes = new TextEncoder().encode('new upload payload')
  const uploadHash = makeSha256Hex(await hashTestText('new upload payload'))
  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
      },
      body: JSON.stringify({ sha256: uploadHash, size: uploadBytes.byteLength }),
    }),
  )
  assert.equal(uploadUrlResponse.status, 200)
  const uploadUrlBody = (await uploadUrlResponse.json()) as {
    readonly kind?: unknown
    readonly url?: unknown
    readonly headers?: unknown
  }
  assert.equal(uploadUrlBody.kind, 'single-put')
  assert.equal(typeof uploadUrlBody.url, 'string')
  assert((uploadUrlBody.url as string).startsWith(`https://worker.example/blobs/${uploadHash}?`))
  assert.equal(
    new URL(uploadUrlBody.url as string).searchParams.get('size'),
    String(uploadBytes.byteLength),
  )
  assert.equal(new URL(uploadUrlBody.url as string).searchParams.get('expiresAt'), null)
  assert.deepEqual(uploadUrlBody.headers, {})

  const putResponse = await room.fetch(
    new Request(uploadUrlBody.url as string, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(uploadBytes.byteLength),
      },
      body: uploadBytes,
    }),
  )
  assert.equal(putResponse.status, 200)
  assert.deepEqual(await putResponse.json(), {
    status: 'stored',
    sha256: uploadHash,
    size: uploadBytes.byteLength,
  })
  assert.deepEqual(bucket.puts, [`vaults/vault-1/blobs/${uploadHash}`])

  const getResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${uploadHash}`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
    }),
  )
  assert.equal(getResponse.status, 200)
  assert.equal(getResponse.headers.get('x-content-sha256'), uploadHash)
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), uploadBytes)
  assert(bucket.gets.includes(`vaults/vault-1/blobs/${uploadHash}`))
})

test('VaultRoom rejects blob uploads whose body hash does not match the addressed hash', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const claimedHash = makeSha256Hex('b'.repeat(64))
  const bytes = new TextEncoder().encode('different bytes')

  const response = await room.fetch(
    new Request(`https://worker.example/blobs/${claimedHash}?size=${bytes.byteLength}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(bytes.byteLength),
      },
      body: bytes,
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { code: 'blob/hash-mismatch', retryable: false })
  assert.deepEqual(bucket.puts, [])
})

test('VaultRoom requires explicit multipart opt-in for at-or-above-threshold blob sizes', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const hash = makeSha256Hex('c'.repeat(64))

  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
      },
      body: JSON.stringify({ sha256: hash, size: 16 * 1024 * 1024 }),
    }),
  )

  assert.equal(uploadUrlResponse.status, 413)
  assert.deepEqual(await uploadUrlResponse.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'blob-upload-url:multipart-required',
  })
})

test('VaultRoom completes an opt-in multipart blob upload and verifies content hash', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const bytes = new TextEncoder().encode('multipart upload payload')
  const hash = makeSha256Hex(await hashTestBytes(bytes))
  const writeToken = `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`

  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: { Authorization: writeToken },
      body: JSON.stringify({ sha256: hash, size: bytes.byteLength, multipart: true }),
    }),
  )
  assert.equal(uploadUrlResponse.status, 200)
  const uploadUrlBody = (await uploadUrlResponse.json()) as {
    readonly kind?: unknown
    readonly uploadId?: unknown
    readonly parts?: readonly { readonly partNumber: number; readonly url: string }[]
  }
  assert.equal(uploadUrlBody.kind, 'multipart')
  assert.equal(typeof uploadUrlBody.uploadId, 'string')
  assert.equal(uploadUrlBody.parts?.length, 1)
  const part = uploadUrlBody.parts?.[0]
  assert(part !== undefined)

  const partPutResponse = await room.fetch(
    new Request(part.url, {
      method: 'PUT',
      headers: { Authorization: writeToken, 'content-length': String(bytes.byteLength) },
      body: bytes,
    }),
  )
  assert.equal(partPutResponse.status, 200)
  const partPutBody = (await partPutResponse.json()) as { readonly etag?: unknown }
  assert.equal(typeof partPutBody.etag, 'string')

  const completeResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${hash}/complete`, {
      method: 'POST',
      headers: { Authorization: writeToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: uploadUrlBody.uploadId,
        parts: [{ partNumber: 1, etag: partPutBody.etag }],
      }),
    }),
  )
  assert.equal(completeResponse.status, 200)
  assert.deepEqual(await completeResponse.json(), {
    status: 'stored',
    sha256: hash,
    size: bytes.byteLength,
  })

  const getResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${hash}`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
    }),
  )
  assert.equal(getResponse.status, 200)
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), bytes)
})

test('VaultRoom aborts a multipart blob upload and clears its pending session', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const hash = makeSha256Hex('d'.repeat(64))
  const writeToken = `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`

  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: { Authorization: writeToken },
      body: JSON.stringify({ sha256: hash, size: 10, multipart: true }),
    }),
  )
  const uploadUrlBody = (await uploadUrlResponse.json()) as { readonly uploadId?: unknown }

  const abortResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${hash}/abort`, {
      method: 'POST',
      headers: { Authorization: writeToken, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: uploadUrlBody.uploadId }),
    }),
  )
  assert.equal(abortResponse.status, 200)
  assert.deepEqual(await abortResponse.json(), { status: 'aborted', sha256: hash })

  // Idempotent: a retried abort against an already-cleared session still reports success.
  const secondAbortResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${hash}/abort`, {
      method: 'POST',
      headers: { Authorization: writeToken, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: uploadUrlBody.uploadId }),
    }),
  )
  assert.equal(secondAbortResponse.status, 200)
})

test('VaultRoom rejects a multipart completion whose assembled content does not match the addressed hash', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const declaredBytes = new TextEncoder().encode('declared-content-under-hash')
  const uploadedBytes = new Uint8Array(declaredBytes.byteLength).fill(7)
  const hash = makeSha256Hex(await hashTestBytes(declaredBytes))
  const writeToken = `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`

  const uploadUrlResponse = await room.fetch(
    new Request('https://worker.example/blobs/upload-url', {
      method: 'POST',
      headers: { Authorization: writeToken },
      body: JSON.stringify({ sha256: hash, size: declaredBytes.byteLength, multipart: true }),
    }),
  )
  const uploadUrlBody = (await uploadUrlResponse.json()) as {
    readonly uploadId?: unknown
    readonly parts?: readonly { readonly partNumber: number; readonly url: string }[]
  }
  const part = uploadUrlBody.parts?.[0]
  assert(part !== undefined)

  const partPutResponse = await room.fetch(
    new Request(part.url, {
      method: 'PUT',
      headers: { Authorization: writeToken, 'content-length': String(uploadedBytes.byteLength) },
      body: uploadedBytes,
    }),
  )
  const partPutBody = (await partPutResponse.json()) as { readonly etag?: unknown }

  const completeResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${hash}/complete`, {
      method: 'POST',
      headers: { Authorization: writeToken, 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: uploadUrlBody.uploadId,
        parts: [{ partNumber: 1, etag: partPutBody.etag }],
      }),
    }),
  )
  assert.equal(completeResponse.status, 400)
  assert.deepEqual(await completeResponse.json(), { code: 'blob/hash-mismatch', retryable: false })

  const getResponse = await room.fetch(
    new Request(`https://worker.example/blobs/${hash}`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
    }),
  )
  assert.equal(getResponse.status, 404)
})

test('VaultRoom stores blob objects under a vault-scoped R2 prefix', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    tokenVersion: 1,
    revokedAt: undefined,
  })
  const bytes = new TextEncoder().encode('same hash in another vault')
  const hash = makeSha256Hex(await hashTestText('same hash in another vault'))
  bucket.set(`vaults/vault-2/blobs/${hash}`, bytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )

  const response = await room.fetch(
    new Request('https://worker.example/blobs/head', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, {
          aud: makeVaultId('vault-1'),
          sub: makeDeviceId('device-1'),
          scope: ['blob:read'],
          tokenVersion: 1,
        })}`,
      },
      body: JSON.stringify({ hashes: [hash] }),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { exists: { [hash]: { found: false } } })
  assert.deepEqual(bucket.heads, [`vaults/vault-1/blobs/${hash}`])
})

test('VaultRoom serves authenticated blob manifest upload and download proxy requests', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const manifest = testBlobManifest()
  const canonicalBytes = encodeBlobManifestJson(manifest)
  const manifestHash = makeSha256Hex(await hashTestBytes(canonicalBytes))

  const putResponse = await room.fetch(
    new Request(`https://worker.example/blob-manifests/${manifestHash}.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(canonicalBytes.byteLength),
      },
      body: JSON.stringify({
        createdAt: manifest.createdAt,
        createdBy: manifest.createdBy,
        chunks: manifest.chunks,
        size: manifest.size,
        contentSha256: manifest.contentSha256,
        fileId: manifest.fileId,
        version: manifest.version,
      }),
    }),
  )

  assert.equal(putResponse.status, 200)
  assert.deepEqual(await putResponse.json(), {
    status: 'stored',
    sha256: manifestHash,
    size: canonicalBytes.byteLength,
  })
  assert.deepEqual(bucket.puts, [`vaults/vault-1/blob-manifests/${manifestHash}.json`])

  const getResponse = await room.fetch(
    new Request(`https://worker.example/blob-manifests/${manifestHash}.json`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:read'], tokenVersion: 1 })}`,
      },
    }),
  )

  assert.equal(getResponse.status, 200)
  assert.equal(getResponse.headers.get('x-content-sha256'), manifestHash)
  assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), canonicalBytes)
  assert(bucket.gets.includes(`vaults/vault-1/blob-manifests/${manifestHash}.json`))
})

test('VaultRoom rejects blob manifest uploads whose canonical body hash does not match the addressed hash', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, secret),
  )
  const manifest = testBlobManifest()

  const response = await room.fetch(
    new Request(`https://worker.example/blob-manifests/${makeSha256Hex('0'.repeat(64))}.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['blob:write'], tokenVersion: 1 })}`,
        'content-length': String(encodeBlobManifestJson(manifest).byteLength),
      },
      body: JSON.stringify(manifest),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'blob/hash-mismatch',
    retryable: false,
    detail: 'blob-manifest/hash-mismatch',
  })
  assert.deepEqual(bucket.puts, [])
})
