import {
  ApiErrorSchema,
  CURRENT_PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeBlobManifestJson,
  decodeFullSnapshotBytesFromResponse,
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  groupedEntryFromMetaFile,
  type Ack,
  type NeedFullSnapshot,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, expect, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../runtime'
import { MAX_HYDRATED_FILE_DOCS } from '../runtime/constants'
import { ensureSchema } from '../runtime/storage'
import { ensureDocHydrated } from '../runtime/sync'
import { encodeBase64 } from '../runtime/utils'
import {
  metaIdentityImmutable,
  metaRootMutationAllowed,
  metaYDocSchemaDisposition,
  metaYDocWritable,
} from '../runtime/yjs-validation'
import {
  TEST_DEVICE_TOKEN_SECRET,
  FakeSocket,
  FakeState,
  installFakeWebSocketPair,
  installFakeUpgradeResponse,
  restoreWebSocketPair,
  restoreResponse,
  makeEnv,
  makeDeviceToken,
  makeEnvWithDeviceTokenSecret,
  makeEnvWithSnapshotBucket,
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  syncMessages,
  hashTestBytes,
  makeInvalidMetaSchemaYjsUpdateBase64,
  makeYjsUpdateBase64,
  makeAuthenticatedWebSocketRequest,
  makeAwarenessUpdate,
  makeSyncRequest,
  makeLargeFileYjsUpdateBase64,
  makeYjsUpdateBytes,
  makeStateVectorBase64,
  decodeTestBase64,
  testBlobManifest,
  FakeR2Bucket,
  hashTestText,
  stringMessageAt,
  findAckForMessage,
  makeArrayBuffer,
} from './test-helpers'

interface RetentionAdminResponse {
  readonly items: readonly RetentionAdminEvent[]
  readonly nextCursor?: string
}

interface RetentionAdminEvent {
  readonly docId: string
  readonly snapshotKey: string
  readonly action: string
  readonly error: string | null
  readonly attemptedAt: number
}

function isRetentionAdminResponse(value: unknown): value is RetentionAdminResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(Reflect.get(value, 'items')) &&
    Reflect.get(value, 'items').every(
      (event: unknown) =>
        typeof event === 'object' &&
        event !== null &&
        !Array.isArray(event) &&
        typeof Reflect.get(event, 'docId') === 'string' &&
        typeof Reflect.get(event, 'snapshotKey') === 'string' &&
        typeof Reflect.get(event, 'action') === 'string' &&
        (Reflect.get(event, 'error') === null || typeof Reflect.get(event, 'error') === 'string') &&
        typeof Reflect.get(event, 'attemptedAt') === 'number',
    )
  )
}

function makePoisonedMetaDoc(fileId: ReturnType<typeof makeFileId>): Y.Doc {
  const parent = new Y.Doc()
  const parentEntry = new Y.Map<unknown>()
  parentEntry.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId(`poison-${fileId}`),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
  })
  parentEntry.set('location', {
    path: 'Notes/Poison.md',
    canonicalPath: 'notes/poison.md',
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  parentEntry.set('content', { contentUpdatedAt: 1, contentUpdatedBy: makeDeviceId('device-1') })
  parentEntry.set('deletion', { deleted: false })
  parent.getMap('meta').set(fileId, parentEntry)

  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(parent))
  const clientEntry = client.getMap<Y.Map<unknown>>('meta').get(fileId)
  assert(clientEntry instanceof Y.Map)
  clientEntry.set('location', {
    path: 'Notes/Poisoned.md',
    canonicalPath: 'notes/poisoned.md',
    updatedAt: 2,
    updatedBy: makeDeviceId('device-1'),
    mtime: 2,
  })
  const pendingUpdate = Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent))

  const poisoned = new Y.Doc()
  Y.applyUpdate(poisoned, pendingUpdate)
  client.destroy()
  parent.destroy()
  return poisoned
}

async function seedVerifiedSnapshotEvidence(
  storage: SqlOnlyStorage,
  snapshotKey: string,
  docId: 'meta' | `file:${string}`,
  bytes: Uint8Array,
  authorityStatus: 'candidate' | 'authoritative' = 'authoritative',
): Promise<void> {
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, bytes)
  const stateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  const seqText = snapshotKey.slice(snapshotKey.lastIndexOf('/') + 1, -'.yupdate'.length)
  const upperSeq = Number(seqText)
  const expectedUpdateSha256 = await hashTestBytes(bytes)
  const expectedStateVectorSha256 = await hashTestBytes(stateVector)
  const base = {
    id: storage.sql.snapshotHealthEvents.length + 1,
    docId,
    snapshotKey,
    upperSeq,
    actor: 'system:verifier',
    authorityStatus,
    expectedByteLength: bytes.byteLength,
    expectedUpdateSha256,
    expectedStateVectorSha256,
    actualByteLength: bytes.byteLength,
    actualUpdateSha256: expectedUpdateSha256,
    actualStateVectorSha256: expectedStateVectorSha256,
    physicalStatus: 'verified',
    logicalStatus: 'healthy',
    reasons: '[]',
    observedAt: 1,
  } as const
  storage.sql.snapshotHealthEvents.push({ ...base, event: 'verification' })
}

test('VaultRoom accepts websocket upgrades and rejects malformed binary frames', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState()
    const room = new VaultRoom(state, makeEnv())
    const request = new Request('https://worker.example/ws/vault-1', {
      headers: { Upgrade: 'websocket' },
    })

    const firstResponse = await room.fetch(request)
    const secondResponse = await room.fetch(request)
    assert.equal(firstResponse.status, 101)
    assert.equal(secondResponse.status, 101)
    assert.equal(state.accepted.length, 2)

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    const update = new Uint8Array([1, 2, 3]).buffer
    await room.webSocketMessage(firstServer, update)

    assert.deepEqual(syncMessages(firstServer.sent), [])
    assert.equal(firstServer.closed, true)
    assert.equal(firstServer.closeReason, 'invalid-binary-frame')
    assert.deepEqual(syncMessages(secondServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom seeds an admin snapshot and records verified evidence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))
  const update = makeYjsUpdateBytes(makeMessageId('message-admin-snapshot-seed'))
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultId: makeVaultId('vault-1'),
        docId: { kind: 'meta' },
        latestSeq: 3,
        update: encodeBase64(update),
      }),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    vaultId: makeVaultId('vault-1'),
    docId: { kind: 'meta' },
    snapshotKey: 'snapshots/vault-1/meta/3.yupdate',
  })
  assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/3.yupdate'])
  assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, 'snapshots/vault-1/meta/3.yupdate')
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.physicalStatus, 'verified')
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
})

test('VaultRoom exchanges setup tokens for device credentials', async () => {
  const storage = new SqlOnlyStorage()
  const setupToken = 'setup-token-1'
  const setupTokenHash = await hashTestText(setupToken)
  storage.sql.setupTokens.set(setupTokenHash, {
    tokenHash: setupTokenHash,
    vaultId: 'vault-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    consumedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/setup/exchange', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken,
        requestedDeviceName: 'Laptop',
      }),
    }),
  )

  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly endpoint?: unknown
    readonly vaultId?: unknown
    readonly deviceId?: unknown
    readonly accessToken?: unknown
    readonly refreshToken?: unknown
    readonly tokenVersion?: unknown
    readonly bootstrapMode?: unknown
  }
  assert.equal(body.endpoint, 'https://worker.example')
  assert.equal(body.vaultId, 'vault-1')
  assert.equal(body.tokenVersion, 1)
  assert.equal(body.bootstrapMode, 'new-vault')
  assert.equal(typeof body.deviceId, 'string')
  assert.equal(typeof body.accessToken, 'string')
  assert.equal(typeof body.refreshToken, 'string')
  assert.equal((body.accessToken as string).split('.').length, 3)
  assert.equal(storage.sql.setupTokens.get(setupTokenHash)?.consumedAt !== undefined, true)
  assert.equal(storage.sql.refreshTokens.size, 1)
  assert.equal(storage.sql.devices.size, 2)
  assert(storage.sql.queries.includes('transaction begin'))
  assert(storage.sql.queries.includes('transaction commit'))
  assert.equal(storage.sql.queries.includes('transaction rollback'), false)
})

test('VaultRoom rolls back setup exchange persistence failures', async () => {
  const storage = new SqlOnlyStorage()
  const setupToken = 'setup-token-rollback'
  const setupTokenHash = await hashTestText(setupToken)
  storage.sql.setupTokens.set(setupTokenHash, {
    tokenHash: setupTokenHash,
    vaultId: 'vault-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    consumedAt: undefined,
  })
  storage.sql.failOnQueryIncludes = 'insert into device_refresh_tokens'
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/setup/exchange', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken,
        requestedDeviceName: 'Laptop',
      }),
    }),
  )

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    code: 'server/error',
    retryable: true,
    detail: 'setup-persist:transaction-failed',
  })
  assert(storage.sql.queries.includes('transaction begin'))
  assert(storage.sql.queries.includes('transaction rollback'))
  assert.equal(storage.sql.queries.at(-1), 'transaction rollback')
})

test('VaultRoom refreshes device access tokens and rotates refresh tokens', async () => {
  const storage = new SqlOnlyStorage()
  const refreshToken = 'refresh-token-1'
  const refreshTokenHash = await hashTestText(refreshToken)
  storage.sql.refreshTokens.set(refreshTokenHash, {
    tokenHash: refreshTokenHash,
    deviceId: 'device-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    revokedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        deviceId: 'device-1',
        refreshToken,
        previousTokenVersion: 1,
      }),
    }),
  )

  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly accessToken?: unknown
    readonly refreshToken?: unknown
    readonly tokenVersion?: unknown
    readonly expiresAt?: unknown
    readonly protocolVersion?: unknown
  }
  assert.equal(typeof body.accessToken, 'string')
  assert.equal(typeof body.refreshToken, 'string')
  assert.equal(body.tokenVersion, 1)
  assert.equal(body.protocolVersion, CURRENT_PROTOCOL_VERSION)
  assert.equal(typeof body.expiresAt, 'number')
  assert.equal(storage.sql.refreshTokens.get(refreshTokenHash)?.revokedAt !== undefined, true)
  assert.equal(storage.sql.refreshTokens.size, 2)
  assert(storage.sql.queries.includes('transaction begin'))
  assert(storage.sql.queries.includes('transaction commit'))
})

test('VaultRoom maps a revoked device refresh rejection to the auth/revoked ApiError code', async () => {
  const storage = new SqlOnlyStorage()
  const refreshToken = 'refresh-token-revoked-device'
  const refreshTokenHash = await hashTestText(refreshToken)
  storage.sql.refreshTokens.set(refreshTokenHash, {
    tokenHash: refreshTokenHash,
    deviceId: 'device-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    revokedAt: undefined,
  })
  storage.sql.devices.set('device-1', {
    deviceId: 'device-1',
    tokenVersion: 1,
    revokedAt: Date.now(),
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        deviceId: 'device-1',
        refreshToken,
        previousTokenVersion: 1,
      }),
    }),
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    code: 'auth/revoked',
    retryable: false,
    detail: 'auth-refresh:device-revoked',
  })
})

test('VaultRoom rolls back auth refresh rotation failures', async () => {
  const storage = new SqlOnlyStorage()
  const refreshToken = 'refresh-token-rollback'
  const refreshTokenHash = await hashTestText(refreshToken)
  storage.sql.refreshTokens.set(refreshTokenHash, {
    tokenHash: refreshTokenHash,
    deviceId: 'device-1',
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    revokedAt: undefined,
  })
  storage.sql.failOnQueryIncludes = 'insert into device_refresh_tokens'
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret('secret'))

  const response = await room.fetch(
    new Request('https://worker.example/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        deviceId: 'device-1',
        refreshToken,
        previousTokenVersion: 1,
      }),
    }),
  )

  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    code: 'server/error',
    retryable: true,
    detail: 'auth-refresh-persist:transaction-failed',
  })
  assert(storage.sql.queries.includes('transaction begin'))
  assert(storage.sql.queries.includes('transaction rollback'))
  assert.equal(storage.sql.queries.at(-1), 'transaction rollback')
})

test('VaultRoom revokes devices through authenticated HTTP requests', async () => {
  const secret = 'test-device-token-secret'
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    tokenVersion: 3,
    revokedAt: undefined,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret(secret))

  const response = await room.fetch(
    new Request('https://worker.example/devices/device-2/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
      body: JSON.stringify({ reason: 'lost' }),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    deviceId: 'device-2',
    status: 'revoked',
    revokedAt: storage.sql.devices.get('device-2')?.revokedAt,
    tokenVersion: 4,
  })
  assert.equal(storage.sql.devices.get('device-2')?.tokenVersion, 4)
  assert.equal(typeof storage.sql.devices.get('device-2')?.revokedAt, 'number')
})

test('VaultRoom device revoke is idempotent for already revoked devices', async () => {
  const secret = 'test-device-token-secret'
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    tokenVersion: 4,
    revokedAt: 123,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithDeviceTokenSecret(secret))

  const response = await room.fetch(
    new Request('https://worker.example/devices/device-2/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
      body: JSON.stringify({}),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    deviceId: 'device-2',
    status: 'already-revoked',
    revokedAt: 123,
    tokenVersion: 4,
  })
  assert.equal(storage.sql.devices.get('device-2')?.revokedAt, 123)
})

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

test('VaultRoom appends JSON sync updates, acks the sender, and broadcasts to peers', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    const unauthenticatedServer = state.accepted[2]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)
    assert(unauthenticatedServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-1'))
    const updateJson = JSON.stringify(update)

    await room.webSocketMessage(firstServer, updateJson)

    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected ack string')
    }
    assert.deepEqual(JSON.parse(ack) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])

    await room.webSocketMessage(firstServer, updateJson)

    const duplicateAck = stringMessageAt(firstServer.sent, 1)
    if (typeof duplicateAck !== 'string') {
      throw new Error('expected duplicate ack string')
    }
    assert.deepEqual(JSON.parse(duplicateAck) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom broadcasts awareness updates to other vault peers without persisting them', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    const update = makeAwarenessUpdate(1, { cursor: { anchor: 0, head: 0 } })
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.deepEqual(syncMessages(sender.sent), [])
    assert.deepEqual(syncMessages(peer.sent), [JSON.stringify(update)])
    assert.equal(storage.sql.docs.size, 0)
    assert.equal(storage.sql.opLog.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom broadcasts a removal when a socket advertising awareness disconnects', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    const update = makeAwarenessUpdate(1, { cursor: { anchor: 0, head: 0 } })
    await room.webSocketMessage(sender, JSON.stringify(update))
    peer.sent.length = 0

    room.webSocketClose(sender)

    assert.deepEqual(syncMessages(peer.sent), [JSON.stringify({ ...update, state: null })])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom silently drops an oversized awareness update without closing the session', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    const oversized = makeAwarenessUpdate(1, { blob: 'x'.repeat(5_000) })
    await room.webSocketMessage(sender, JSON.stringify(oversized))

    assert.equal(sender.closed, false)
    assert.deepEqual(syncMessages(peer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom persists JSON sync updates through Durable Object SQL storage', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const request = await makeAuthenticatedWebSocketRequest()

    void room.fetch(request)
    void room.fetch(request)

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const peerSend = secondServer.send.bind(secondServer)
    secondServer.send = (message) => {
      assert(storage.sql.queries.includes('transaction commit'))
      peerSend(message)
    }

    const update = makeSyncUpdate(makeMessageId('message-sql'))
    const updateJson = JSON.stringify({ ...update, actor: 'spoofed-audit-device' })

    await room.webSocketMessage(firstServer, updateJson)

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.kind, 'meta')
    assert.equal(storage.sql.opLog.get('meta:message-sql')?.seq, 1)
    assert.equal(storage.sql.opLog.get('meta:message-sql')?.deviceId, 'device-1')
    assert.equal(storage.sql.messageDedup.has('meta:message-sql'), true)
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])

    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected SQL ack string')
    }
    assert.equal((JSON.parse(ack) as Ack).durableSeq, 1)

    await room.webSocketMessage(firstServer, updateJson)

    const duplicateAck = stringMessageAt(firstServer.sent, 1)
    if (typeof duplicateAck !== 'string') {
      throw new Error('expected SQL duplicate ack string')
    }
    assert.equal((JSON.parse(duplicateAck) as Ack).durableSeq, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rolls back every append SQL statement failure and retries at the same durable sequence', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    for (const [failureIndex, failureNeedle] of [
      'insert into op_log',
      'insert into docs',
      'insert into message_dedup',
    ].entries()) {
      const storage = new SqlOnlyStorage()
      const state = new FakeState(storage)
      const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

      void room.fetch(await makeAuthenticatedWebSocketRequest())
      void room.fetch(await makeAuthenticatedWebSocketRequest())
      const sender = state.accepted[0]
      const peer = state.accepted[1]
      assert(sender instanceof FakeSocket)
      assert(peer instanceof FakeSocket)
      await room.webSocketMessage(sender, JSON.stringify(makeHello()))
      await room.webSocketMessage(peer, JSON.stringify(makeHello()))

      const update = makeSyncUpdate(makeMessageId(`append-failure-${failureIndex}`))
      storage.sql.failAfterQueryIncludes = failureNeedle
      let failure: unknown
      try {
        await room.webSocketMessage(sender, JSON.stringify(update))
      } catch (error) {
        failure = error
      }

      assert(failure instanceof Error)
      assert.equal(storage.sql.opLog.size, 0)
      assert.equal(storage.sql.docs.size, 0)
      assert.equal(storage.sql.messageDedup.size, 0)
      assert.deepEqual(syncMessages(sender.sent), [])
      assert.deepEqual(syncMessages(peer.sent), [])

      storage.sql.failAfterQueryIncludes = undefined
      await room.webSocketMessage(sender, JSON.stringify(update))

      assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
      assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
      assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 1)
      assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 1)
      assert.equal(syncMessages(peer.sent).length, 1)
    }
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rehydrates committed state after an active YDoc apply failure', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    const baseUpdate = makeSyncUpdate(makeMessageId('apply-base'))
    await room.webSocketMessage(sender, JSON.stringify(baseUpdate))
    const staleDoc = room.docs.get('meta')
    assert(staleDoc instanceof Y.Doc)
    staleDoc.on('update', () => {
      throw new Error('injected active YDoc observer failure')
    })

    const update = makeSyncUpdate(makeMessageId('apply-rehydrate'))
    const expected = new Y.Doc()
    Y.applyUpdate(expected, decodeTestBase64(baseUpdate.update))
    Y.applyUpdate(expected, decodeTestBase64(update.update))
    const expectedUpdate = Y.encodeStateAsUpdate(expected)
    const assertRehydrated = (): void => {
      const recovered = room.docs.get('meta')
      assert(recovered instanceof Y.Doc)
      assert.notEqual(recovered, staleDoc)
      assert.equal(room.hydratedDocs.has('meta'), true)
      assert.deepEqual(Y.encodeStateAsUpdate(recovered), expectedUpdate)
    }
    const senderSend = sender.send.bind(sender)
    sender.send = (message) => {
      if (typeof message === 'string' && message.includes(update.messageId)) assertRehydrated()
      senderSend(message)
    }
    const peerSend = peer.send.bind(peer)
    peer.send = (message) => {
      if (typeof message === 'string' && message.includes(update.messageId)) assertRehydrated()
      peerSend(message)
    }

    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 2)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 2)
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 2)
    assert.equal(syncMessages(peer.sent).length, 2)

    sender.sent.length = 0
    peer.sent.length = 0
    await room.webSocketMessage(sender, JSON.stringify(update))
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 2)
    assert.equal(syncMessages(peer.sent).length, 0)
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom withholds ack and broadcast when post-commit rehydration fails', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(new FakeR2Bucket(), TEST_DEVICE_TOKEN_SECRET),
    )

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    await room.webSocketMessage(
      sender,
      JSON.stringify(makeSyncUpdate(makeMessageId('rehydrate-base'))),
    )
    const staleDoc = room.docs.get('meta')
    assert(staleDoc instanceof Y.Doc)
    staleDoc.on('update', () => {
      throw new Error('injected active YDoc observer failure')
    })
    const existingDoc = storage.sql.docs.get('meta')
    assert(existingDoc)
    storage.sql.docs.set('meta', {
      ...existingDoc,
      latestSnapshotSeq: 1,
      latestSnapshotKey: 'snapshots/vault-1/meta/missing.yupdate',
      minRetainedSeq: 1,
    })

    const update = makeSyncUpdate(makeMessageId('rehydrate-failure'))
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 2)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 2)
    assert.equal(findAckForMessage(sender.sent, update.messageId), undefined)
    assert.equal(syncMessages(peer.sent).length, 1)
    assert.equal(sender.closeReason, 'hydrate-failed')
    assert.equal(room.docs.has('meta'), false)
    assert.equal(room.hydratedDocs.has('meta'), false)

    peer.sent.length = 0
    await room.webSocketMessage(peer, JSON.stringify(update))
    assert.equal(peer.closeCode, 1011)
    assert.equal(peer.closeReason, 'hydrate-failed')
    assert.equal(findAckForMessage(peer.sent, update.messageId), undefined)
    assert.deepEqual(syncMessages(peer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom still acks and broadcasts when checkpoint scheduling fails after append', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.setAlarm = async () => {
      throw new Error('injected checkpoint alarm failure')
    }
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(new FakeR2Bucket(), TEST_DEVICE_TOKEN_SECRET),
    )

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('checkpoint-alarm-failure'))
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 1)
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 1)
    assert.equal(syncMessages(peer.sent).length, 1)

    sender.sent.length = 0
    peer.sent.length = 0
    await room.webSocketMessage(sender, JSON.stringify(update))
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 1)
    assert.equal(syncMessages(peer.sent).length, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom applies pending schema migrations once before serving SQL traffic', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const created = storage.sql.queries.filter((query) =>
      query.includes('create table if not exists devices'),
    )
    assert.equal(created.length, 1)
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])

    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('after-migrate'))),
    )

    const insertedVersions = storage.sql.queries.filter((query) =>
      query.includes('insert into schema_migrations'),
    )
    assert.equal(insertedVersions.length, 6)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('ensureSchema coalesces concurrent cold-start migrations', async () => {
  const storage = new SqlOnlyStorage()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  await Promise.all([ensureSchema(room), ensureSchema(room)])

  assert.equal(room.schemaReady, true)
  assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
  assert.equal(
    storage.sql.queries.filter((query) => query.includes('create table if not exists devices'))
      .length,
    1,
  )
})

test('schema fault injection fires after the fake DDL mutation', () => {
  const storage = new SqlOnlyStorage()
  storage.sql.failAfterQueryIncludes = 'drop table devices'

  expect(() => storage.sql.exec('drop table devices')).toThrow(/injected SQL failure after query/)
  assert.equal(storage.sql.tableColumns.has('devices'), false)
  assert.equal(storage.sql.tableRowCounts.has('devices'), false)
})

test('ensureSchema rolls back every device identity DDL boundary before retrying', async () => {
  const ddlBoundaries = [
    'create table devices__dr007',
    'insert into devices__dr007',
    'drop table devices',
    'alter table devices__dr007 rename to devices',
    'create table op_log__dr007',
    'insert into op_log__dr007',
    'drop table op_log',
    'alter table op_log__dr007 rename to op_log',
    'create index if not exists idx_op_log_doc_seq',
    'create table connected_devices__dr007',
    'insert into connected_devices__dr007',
    'drop table connected_devices',
    'alter table connected_devices__dr007 rename to connected_devices',
    'insert into schema_migrations',
  ] as const
  const legacyColumns = {
    devices: [
      'device_id',
      'y_client_id',
      'token_version',
      'revoked_at',
      'created_at',
      'last_seen_at',
    ],
    op_log: [
      'doc_id',
      'seq',
      'message_id',
      'device_id',
      'y_client_id',
      'update_bytes',
      'update_sha256',
      'created_at',
    ],
    connected_devices: [
      'device_id',
      'y_client_id',
      'last_seen_at',
      'user_agent',
      'protocol_version',
    ],
  } as const
  const legacyColumnDetails = {
    devices: [
      { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'y_client_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'token_version', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
      { cid: 3, name: 'revoked_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 4, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: 'last_seen_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    ],
    op_log: [
      { cid: 0, name: 'doc_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: 'seq', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: 'message_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'device_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: 'y_client_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: 'update_bytes', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 6, name: 'update_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 7, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ],
    connected_devices: [
      { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'y_client_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 2, name: 'last_seen_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'user_agent', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 4, name: 'protocol_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ],
  } as const

  for (const boundary of ddlBoundaries) {
    const storage = new SqlOnlyStorage()
    storage.sql.migrationVersions.add(1)
    storage.sql.migrationVersions.add(2)
    storage.sql.migrationVersions.add(3)
    for (const [table, columns] of Object.entries(legacyColumns)) {
      storage.sql.tableColumns.set(table, columns)
      storage.sql.tableColumnDetails.set(
        table,
        legacyColumnDetails[table as keyof typeof legacyColumnDetails],
      )
      storage.sql.tableRowCounts.set(table, table === 'op_log' ? 2 : 1)
    }
    storage.sql.tableIndexes.set('devices', [
      { name: 'sqlite_autoindex_devices_1', unique: true, columns: ['device_id'] },
      { name: 'sqlite_autoindex_devices_2', unique: true, columns: ['y_client_id'] },
    ])
    storage.sql.tableRows.set('devices', [['device-1', 7, 1, null, 10, 11]])
    storage.sql.tableRows.set('op_log', [
      ['meta', 2, 'message-2', 'device-1', 7, new Uint8Array([2]), 'sha-2', 2],
      ['meta', 1, 'message-1', 'device-1', 7, new Uint8Array([1]), 'sha-1', 1],
    ])
    storage.sql.tableRowCounts.set('op_log', 2)
    storage.sql.tableRows.set('connected_devices', [['device-1', 7, 11, 'ua', 1]])
    const beforeRows = new Map(storage.sql.tableRows)
    const beforeColumns = new Map(storage.sql.tableColumns)
    const beforeColumnDetails = new Map(storage.sql.tableColumnDetails)
    const beforeRowCounts = new Map(storage.sql.tableRowCounts)
    const beforeIndexes = new Map(storage.sql.tableIndexes)
    const beforeForeignKeys = new Map(storage.sql.tableForeignKeys)
    const room = new VaultRoom(
      new FakeState(storage),
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    storage.sql.failAfterQueryIncludes = boundary

    await expect(ensureSchema(room)).rejects.toThrow(/injected SQL failure/)
    assert.equal(room.schemaReady, false)
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3])
    assert.deepEqual(storage.sql.tableColumns, beforeColumns)
    assert.deepEqual(storage.sql.tableColumnDetails, beforeColumnDetails)
    assert.deepEqual(storage.sql.tableRowCounts, beforeRowCounts)
    assert.deepEqual(storage.sql.tableRows, beforeRows)
    assert.deepEqual(storage.sql.tableIndexes, beforeIndexes)
    assert.deepEqual(storage.sql.tableForeignKeys, beforeForeignKeys)

    storage.sql.failAfterQueryIncludes = undefined
    await ensureSchema(room)
    assert.equal(room.schemaReady, true)
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
    assert.deepEqual(storage.sql.tableColumns.get('devices'), [
      'device_id',
      'token_version',
      'revoked_at',
      'created_at',
      'last_seen_at',
    ])
    assert.deepEqual(
      [...storage.sql.exec('pragma table_info(devices)')],
      [
        { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'token_version', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
        { cid: 2, name: 'revoked_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 3, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 4, name: 'last_seen_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      ],
    )
    assert.deepEqual(
      [...storage.sql.exec('pragma table_info(op_log)')],
      [
        { cid: 0, name: 'doc_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: 'seq', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
        { cid: 2, name: 'message_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: 'device_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 4, name: 'update_bytes', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 5, name: 'update_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 6, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      ],
    )
    assert.deepEqual(
      [...storage.sql.exec('pragma table_info(connected_devices)')],
      [
        { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'last_seen_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: 'user_agent', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 3, name: 'protocol_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      ],
    )
    assert.deepEqual(
      storage.sql.tableRowCounts,
      new Map([
        ['devices', 1],
        ['op_log', 2],
        ['connected_devices', 1],
        ['schema_migrations', 0],
        ['blob_multipart_uploads', 0],
        ['blob_multipart_parts', 0],
        ['quarantine_audit_events', 0],
      ]),
    )
    assert.deepEqual(storage.sql.tableRows.get('devices'), [['device-1', 1, null, 10, 11]])
    assert.deepEqual(storage.sql.tableRows.get('op_log'), [
      ['meta', 1, 'message-1', 'device-1', new Uint8Array([1]), 'sha-1', 1],
      ['meta', 2, 'message-2', 'device-1', new Uint8Array([2]), 'sha-2', 2],
    ])
    assert.deepEqual(storage.sql.tableRows.get('connected_devices'), [['device-1', 11, 'ua', 1]])
    assert.deepEqual(storage.sql.tableForeignKeys.get('device_refresh_tokens'), [
      { table: 'devices', from: 'device_id', to: 'device_id' },
    ])
    assert.equal(
      storage.sql.tableIndexes.get('op_log')?.some((index) => index.name === 'idx_op_log_doc_seq'),
      true,
    )
    assert.deepEqual(storage.sql.tableIndexes.get('devices'), [
      { name: 'sqlite_autoindex_devices_1', unique: true, columns: ['device_id'] },
    ])
    assert.deepEqual(storage.sql.tableIndexes.get('op_log'), [
      { name: 'sqlite_autoindex_op_log_1', unique: true, columns: ['doc_id', 'seq'] },
      { name: 'sqlite_autoindex_op_log_2', unique: true, columns: ['doc_id', 'message_id'] },
      { name: 'idx_op_log_doc_seq', unique: false, columns: ['doc_id', 'seq'] },
    ])
    assert.deepEqual(storage.sql.tableIndexes.get('connected_devices'), [
      { name: 'sqlite_autoindex_connected_devices_1', unique: true, columns: ['device_id'] },
    ])
  }
})

test('ensureSchema rejects a malformed temp table even when its row count matches', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.migrationVersions.add(1)
  storage.sql.migrationVersions.add(2)
  storage.sql.migrationVersions.add(3)
  storage.sql.tableColumns.set('devices', [
    'device_id',
    'y_client_id',
    'token_version',
    'revoked_at',
    'created_at',
    'last_seen_at',
  ])
  storage.sql.tableRowCounts.set('devices', 1)
  storage.sql.tableColumns.set('devices__dr007', ['device_id', 'unexpected_column'])
  storage.sql.tableRowCounts.set('devices__dr007', 1)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  await expect(ensureSchema(room)).rejects.toThrow(
    'schema-migration:devices__dr007-unexpected-columns',
  )
  assert.equal(room.schemaReady, false)
  assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3])
  assert.deepEqual(storage.sql.tableColumns.get('devices__dr007'), [
    'device_id',
    'unexpected_column',
  ])
})

test('VaultRoom upgrades an existing v1 schema before serving SQL traffic', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.sql.migrationVersions.add(1)
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
    assert.equal(
      storage.sql.queries.filter((query) => query.includes('alter table message_dedup')).length,
      1,
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom retries v2 schema migration after ALTER succeeds before recording the version', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.sql.migrationVersions.add(1)
    storage.sql.failOnQueryIncludes = 'insert into schema_migrations'
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    let firstFailure: unknown
    try {
      await room.webSocketMessage(server, JSON.stringify(makeHello()))
    } catch (error) {
      firstFailure = error
    }
    assert(firstFailure instanceof Error)
    assert.deepEqual([...storage.sql.migrationVersions], [1])
    assert.deepEqual([...storage.sql.messageDedupColumns], [])

    storage.sql.failOnQueryIncludes = undefined
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
    assert.equal(
      storage.sql.queries.filter((query) => query.includes('alter table message_dedup')).length,
      2,
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom serializes concurrent sync update appends per document', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    await Promise.all([
      room.webSocketMessage(
        firstServer,
        JSON.stringify(makeSyncUpdate(makeMessageId('message-concurrent-a'))),
      ),
      room.webSocketMessage(
        secondServer,
        JSON.stringify(makeSyncUpdate(makeMessageId('message-concurrent-b'))),
      ),
    ])

    const rows = [...storage.sql.opLog.values()]
      .filter(
        (row) =>
          row.messageId === 'message-concurrent-a' || row.messageId === 'message-concurrent-b',
      )
      .sort((left, right) => left.seq - right.seq)
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2],
    )
    const firstAck = findAckForMessage(firstServer.sent, 'message-concurrent-a')
    const secondAck = findAckForMessage(secondServer.sent, 'message-concurrent-b')
    assert.equal(firstAck?.durableSeq, storage.sql.opLog.get('meta:message-concurrent-a')?.seq)
    assert.equal(secondAck?.durableSeq, storage.sql.opLog.get('meta:message-concurrent-b')?.seq)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects large live updates without acknowledging or advancing durable state', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const docId = { kind: 'file', ydocId: makeYDocId('large-file-doc') } as const
    const update = {
      ...makeSyncUpdate(makeMessageId('message-large-update')),
      docId,
      update: makeLargeFileYjsUpdateBase64(),
    } satisfies SyncUpdate
    const updateJson = JSON.stringify(update)
    await room.webSocketMessage(server, updateJson)

    const rejection = JSON.parse(stringMessageAt(server.sent, 0)) as Record<string, unknown>
    assert.deepEqual(rejection, {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'large-update-requires-snapshot-import',
      retryable: false,
    })
    assert.equal(syncMessages(server.sent).length, 1)
    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.has('file:large-file-doc'), false)
    assert.equal(storage.sql.messageDedup.has('file:large-file-doc:message-large-update'), false)
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'append-reject:large-update-requires-snapshot-import')
    assert.equal(room.docs.has('file:large-file-doc'), false)

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const retryServer = state.accepted[1]
    assert(retryServer instanceof FakeSocket)
    await room.webSocketMessage(retryServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(retryServer, updateJson)

    assert.equal(syncMessages(retryServer.sent).length, 1)
    assert.equal(JSON.parse(stringMessageAt(retryServer.sent, 0)).type, 'sync-update-rejected')
    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.has('file:large-file-doc'), false)
    assert.equal(storage.sql.messageDedup.has('file:large-file-doc:message-large-update'), false)
    assert.equal(retryServer.closeCode, 1011)
    assert.equal(retryServer.closeReason, 'append-reject:large-update-requires-snapshot-import')
    assert.equal(room.docs.has('file:large-file-doc'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom refuses a live update that would load a new file doc while at capacity', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    for (let index = 0; index < MAX_HYDRATED_FILE_DOCS; index += 1) {
      room.hydratedDocs.add(`file:${makeYDocId(`padding-${index}`)}`)
    }

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const docId = { kind: 'file', ydocId: makeYDocId('degraded-new-file') } as const
    const messageId = makeMessageId('message-degraded-new-file')
    const update = {
      ...makeSyncUpdate(messageId),
      docId,
      update: makeYjsUpdateBase64(messageId),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'doc-load-degraded')
    assert.equal(storage.sql.opLog.has(`file:degraded-new-file:${messageId}`), false)
    assert.equal(storage.sql.docs.has('file:degraded-new-file'), false)
    assert.equal(room.hydratedDocs.has('file:degraded-new-file'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines a live delta with a missing predecessor without appending it', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const docId = { kind: 'file', ydocId: makeYDocId('causal-live-file') } as const
    await ensureDocHydrated(room, docId)
    const source = new Y.Doc()
    source.getText('body').insert(0, 'base')
    const baseStateVector = Y.encodeStateVector(source)
    source.getText('body').insert(4, ' delta')
    const delta = Y.encodeStateAsUpdate(source, baseStateVector)
    const update = {
      ...makeSyncUpdate(makeMessageId('message-causal-live-delta')),
      docId,
      update: Buffer.from(delta).toString('base64'),
    } satisfies SyncUpdate

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await room.webSocketMessage(server, JSON.stringify(update))
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert(
      events.some(
        (event) =>
          event.event === 'quarantine' &&
          event.reason === 'yjs-apply-failed' &&
          typeof event.quarantineId === 'string',
      ),
    )
    assert.equal(storage.sql.opLog.has('file:causal-live-file:message-causal-live-delta'), false)
    assert.equal(
      storage.sql.messageDedup.has('file:causal-live-file:message-causal-live-delta'),
      false,
    )
    assert.equal(server.closeCode, undefined)
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'yjs-apply-failed',
      retryable: false,
    })
    assert.equal(syncMessages(server.sent).length, 1)
    source.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom leaves an already-hydrated document byte-for-byte unchanged after oversized rejection', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const docId = { kind: 'file', ydocId: makeYDocId('already-hydrated-large-file') } as const
    await ensureDocHydrated(room, docId)
    const hydrated = room.docs.get('file:already-hydrated-large-file')
    assert(hydrated !== undefined)
    hydrated.getText('body').insert(0, 'preserved local state')
    const before = Y.encodeStateAsUpdate(hydrated)

    const update = {
      ...makeSyncUpdate(makeMessageId('message-large-update-hydrated')),
      docId,
      update: makeLargeFileYjsUpdateBase64(),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(Y.encodeStateAsUpdate(hydrated), before)
    assert.equal(syncMessages(server.sent).length, 1)
    assert.equal(JSON.parse(stringMessageAt(server.sent, 0)).type, 'sync-update-rejected')
    assert.equal(
      storage.sql.opLog.has('file:already-hydrated-large-file:message-large-update-hydrated'),
      false,
    )
    assert.equal(
      storage.sql.messageDedup.has(
        'file:already-hydrated-large-file:message-large-update-hydrated',
      ),
      false,
    )
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'append-reject:large-update-requires-snapshot-import')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires hello before accepting binary sync frames', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState(new SqlOnlyStorage())
    const room = new VaultRoom(state, makeEnv())
    const request = new Request('https://worker.example/ws/vault-1', {
      headers: { Upgrade: 'websocket' },
    })

    void room.fetch(request)
    void room.fetch(request)
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    const update = makeSyncUpdate(makeMessageId('message-binary-before-hello'))
    const frame = makeArrayBuffer(
      encodeBinaryFrame(
        {
          type: 'sync-update',
          protocolVersion: update.protocolVersion,
          vaultId: update.vaultId,
          deviceId: update.deviceId,
          messageId: update.messageId,
          docId: update.docId,
        },
        makeYjsUpdateBytes(update.messageId),
      ),
    )

    await room.webSocketMessage(firstServer, frame)

    assert.equal(firstServer.closed, true)
    assert.equal(firstServer.closeReason, 'hello-required')
    assert.deepEqual(syncMessages(secondServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom persists binary sync frames before acking and broadcasting', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const request = await makeAuthenticatedWebSocketRequest()

    void room.fetch(request)
    void room.fetch(request)
    void room.fetch(request)
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    const unauthenticatedServer = state.accepted[2]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)
    assert(unauthenticatedServer instanceof FakeSocket)
    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-binary'))
    const payload = makeYjsUpdateBytes(update.messageId)
    const frame = makeArrayBuffer(
      encodeBinaryFrame(
        {
          type: 'sync-update',
          protocolVersion: update.protocolVersion,
          vaultId: update.vaultId,
          deviceId: update.deviceId,
          messageId: update.messageId,
          docId: update.docId,
        },
        payload,
      ),
    )

    await room.webSocketMessage(firstServer, frame)

    assert.equal(storage.sql.opLog.get('meta:message-binary')?.seq, 1)
    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected binary ack string')
    }
    assert.equal((JSON.parse(ack) as Ack).durableSeq, 1)
    assert.equal(syncMessages(secondServer.sent).length, 1)
    const broadcast = syncMessages(secondServer.sent)[0]
    assert(broadcast !== undefined)
    if (typeof broadcast === 'string') {
      throw new Error('expected binary broadcast frame')
    }
    const decoded = decodeBinaryFrame(new Uint8Array(broadcast))
    assert(decoded)
    assert.deepEqual(decoded.header, {
      type: 'sync-update',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      durableSeq: 1,
    })
    assert.deepEqual(decoded.payload, payload)
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom restores WebSocket sessions from hibernation attachments', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const request = await makeAuthenticatedWebSocketRequest()

    const initialRoom = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void initialRoom.fetch(request)
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await initialRoom.webSocketMessage(server, JSON.stringify(makeHello()))

    const resumedRoom = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    await resumedRoom.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-hibernation'))),
    )

    assert.equal(server.closed, false)
    const ack = stringMessageAt(server.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected resumed session ack string')
    }
    assert.deepEqual(JSON.parse(ack) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-after-hibernation'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.equal(storage.sql.opLog.get('meta:message-after-hibernation')?.seq, 1)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom checkpoints an active document to R2 and advances the SQL snapshot pointer', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(server, JSON.stringify(makeSyncUpdate(makeMessageId('message-cp'))))

    const result = await room.checkpointDoc({ kind: 'meta' }, 99)

    assert.deepEqual(result, {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })
    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 1)
    assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
    assert.equal(storage.sql.opLog.has('meta:message-cp'), false)
    assert.equal(
      storage.sql.docs.get('meta')?.latestSnapshotKey,
      'snapshots/vault-1/meta/1.yupdate',
    )
    const run = storage.sql.checkpointRuns.get('checkpoint:snapshots/vault-1/meta/1.yupdate:99')
    assert(run)
    assert.equal(run.status, 'compacted')
    assert.equal(run.r2WrittenAt, 99)
    assert.equal(run.pointerUpdatedAt, 99)
    assert.equal(run.compactedAt, 99)
    assert.equal(
      storage.sql.snapshotHealthEvents.find((event) => event.event === 'expected')?.actor,
      'system:checkpoint',
    )
    assert.equal(
      storage.sql.snapshotHealthEvents.find((event) => event.event === 'verification')?.actor,
      'system:verifier',
    )

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 100), {
      action: 'skipped',
      reason: 'no-new-ops',
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed after complete SQLite loss even when R2 retains a checkpoint', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const checkpointedUpdate = makeSyncUpdate(makeMessageId('message-disaster-checkpoint'))
    await room.webSocketMessage(server, JSON.stringify(checkpointedUpdate))
    assert.equal(findAckForMessage(server.sent, checkpointedUpdate.messageId)?.durableSeq, 1)
    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })
    const authoritativeEvent = storage.sql.snapshotHealthEvents
      .filter((event) => event.event === 'verification')
      .at(-1)
    assert(authoritativeEvent)
    assert.equal(authoritativeEvent.snapshotKey, 'snapshots/vault-1/meta/1.yupdate')
    assert.equal(authoritativeEvent.upperSeq, 1)
    assert.equal(authoritativeEvent.physicalStatus, 'verified')
    assert.equal(authoritativeEvent.logicalStatus, 'healthy')
    assert.equal(authoritativeEvent.authorityStatus, 'authoritative')
    assert.equal(authoritativeEvent.expectedByteLength !== undefined, true)
    assert.equal(authoritativeEvent.expectedUpdateSha256 !== undefined, true)
    assert.equal(authoritativeEvent.expectedStateVectorSha256 !== undefined, true)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, authoritativeEvent.snapshotKey)
    assert.equal(storage.sql.opLog.has(`meta:${checkpointedUpdate.messageId}`), false)

    const residualUpdate = makeSyncUpdate(makeMessageId('message-disaster-residual'))
    await room.webSocketMessage(server, JSON.stringify(residualUpdate))
    assert.equal(findAckForMessage(server.sent, residualUpdate.messageId)?.durableSeq, 2)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${residualUpdate.messageId}`)?.seq, 2)
    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])

    const lostStorage = new SqlOnlyStorage()
    const recoveredRoom = new VaultRoom(
      new FakeState(lostStorage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    recoveredRoom.vaultId = makeVaultId('vault-1')
    const putsBeforeHydration = [...bucket.puts]
    const deletesBeforeHydration = [...bucket.deletes]

    await expect(ensureDocHydrated(recoveredRoom, { kind: 'meta' })).rejects.toThrow(
      'snapshot-health:no-verified-generation',
    )

    assert.equal(recoveredRoom.docs.has('meta'), false)
    assert.equal(recoveredRoom.hydratedDocs.has('meta'), false)
    assert.equal(lostStorage.sql.docs.size, 0)
    assert.equal(lostStorage.sql.opLog.size, 0)
    assert.equal(lostStorage.sql.messageDedup.size, 0)
    assert.equal(lostStorage.sql.snapshotHealthEvents.length, 0)
    assert.deepEqual(bucket.puts, putsBeforeHydration)
    assert.deepEqual(bucket.deletes, deletesBeforeHydration)

    const recoveredSocket = new FakeSocket()
    const recoveredPeer = new FakeSocket()
    recoveredRoom.sessions.add(recoveredSocket)
    recoveredRoom.sessions.add(recoveredPeer)
    recoveredRoom.sessionStates.set(recoveredSocket, {
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      metadataAccess: 'read-write',
      metadataCapabilityAdvertised: true,
    })
    recoveredRoom.sessionStates.set(recoveredPeer, {
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      metadataAccess: 'read-write',
      metadataCapabilityAdvertised: true,
    })
    recoveredRoom.schemaReady = true
    await recoveredRoom.webSocketMessage(recoveredSocket, JSON.stringify(residualUpdate))
    assert.equal(recoveredSocket.closeReason, 'hydrate-failed')
    assert.deepEqual(recoveredSocket.sent, [])
    assert.deepEqual(recoveredPeer.sent, [])
    assert.equal(lostStorage.sql.docs.size, 0)
    assert.equal(lostStorage.sql.opLog.size, 0)
    assert.equal(lostStorage.sql.messageDedup.size, 0)
    assert.deepEqual(bucket.puts, putsBeforeHydration)
    assert.deepEqual(bucket.deletes, deletesBeforeHydration)
    assert.isFalse(
      lostStorage.sql.queries.some((query) => /\b(insert|update|delete)\b/.test(query)),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom acks a compacted duplicate using its durable update hash', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-compacted-duplicate'))
    await room.webSocketMessage(server, JSON.stringify(update))
    await room.checkpointDoc({ kind: 'meta' }, 99)

    assert.equal(storage.sql.opLog.has(`meta:${update.messageId}`), false)
    assert.equal(
      typeof storage.sql.messageDedup.get(`meta:${update.messageId}`)?.updateSha256,
      'string',
    )

    server.sent.length = 0
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(findAckForMessage(server.sent, update.messageId)?.durableSeq, 1)
    assert.equal(server.closed, false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects a legacy dedup row without hash evidence', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-legacy-dedup'))
    await room.webSocketMessage(server, JSON.stringify(update))
    const dedup = storage.sql.messageDedup.get(`meta:${update.messageId}`)
    assert(dedup)
    storage.sql.messageDedup.set(`meta:${update.messageId}`, { ...dedup, updateSha256: undefined })
    server.sent.length = 0

    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'duplicate-unsafe')
    assert.equal(findAckForMessage(server.sent, update.messageId), undefined)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom captures checkpoint bytes and state vector before later appends', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const firstUpdate = makeSyncUpdate(makeMessageId('message-checkpoint-boundary-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))

    let notifyPutStarted: () => void = () => {}
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    bucket.beforePut = async (key) => {
      if (key === 'snapshots/vault-1/meta/1.yupdate') {
        notifyPutStarted()
        await putGate
      }
    }

    const checkpoint = room.checkpointDoc({ kind: 'meta' }, 99)
    await putStarted

    const secondUpdate = makeSyncUpdate(makeMessageId('message-checkpoint-boundary-2'))
    await room.webSocketMessage(server, JSON.stringify(secondUpdate))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 2)

    releasePut()
    assert.deepEqual(await checkpoint, {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })

    const snapshotObject = await bucket.get('snapshots/vault-1/meta/1.yupdate')
    assert(snapshotObject)
    const snapshotDoc = new Y.Doc()
    Y.applyUpdate(snapshotDoc, new Uint8Array(await snapshotObject.arrayBuffer()))
    const firstDoc = new Y.Doc()
    Y.applyUpdate(firstDoc, decodeTestBase64(firstUpdate.update))
    assert.deepEqual(Y.encodeStateAsUpdate(snapshotDoc), Y.encodeStateAsUpdate(firstDoc))
    assert.deepEqual(
      storage.sql.checkpointRuns.get('checkpoint:snapshots/vault-1/meta/1.yupdate:99')?.stateVector,
      Y.encodeStateVector(firstDoc),
    )
    assert.equal(storage.sql.opLog.has(`meta:${firstUpdate.messageId}`), false)
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 2)
    snapshotDoc.destroy()
    firstDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when a checkpoint target key already exists', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const updateBytes = makeYjsUpdateBytes(makeMessageId('message-checkpoint-target-conflict'))
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:checkpoint-target-conflict', {
    docId: 'meta',
    seq: 1,
    messageId: 'checkpoint-target-conflict',
    deviceId: 'device-1',
    updateBytes,
    updateSha256: await hashTestBytes(updateBytes),
    createdAt: 1,
  })
  const targetKey = 'snapshots/vault-1/meta/1.yupdate'
  const existingBytes = makeYjsUpdateBytes(makeMessageId('checkpoint-target-existing'))
  bucket.set(targetKey, existingBytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failure: unknown
  try {
    await room.checkpointDoc({ kind: 'meta' }, 99)
  } catch (error) {
    failure = error
  }
  assert(failure instanceof Error)
  assert.match(failure.message, /snapshot-checkpoint-target-exists/)
  const persisted = await bucket.get(targetKey)
  assert(persisted)
  assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), existingBytes)
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('VaultRoom serializes snapshot import with a concurrent live append', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const firstUpdate = makeSyncUpdate(makeMessageId('message-import-boundary-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))
    const importUpdate = makeYjsUpdateBytes(makeMessageId('message-import-boundary-import'))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, decodeTestBase64(firstUpdate.update))
    Y.applyUpdate(expectedDoc, importUpdate)

    let notifyPutStarted: () => void = () => {}
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    bucket.beforePut = async (key) => {
      if (key === 'snapshots/vault-1/meta/2.yupdate') {
        notifyPutStarted()
        await putGate
      }
    }

    const importRequest = room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )
    await putStarted

    let appendSettled = false
    const secondUpdate = makeSyncUpdate(makeMessageId('message-import-boundary-2'))
    const append = room.webSocketMessage(server, JSON.stringify(secondUpdate)).finally(() => {
      appendSettled = true
    })
    await Promise.resolve()
    assert.equal(appendSettled, false)

    releasePut()
    const importResponse = await importRequest
    await append
    assert.equal(importResponse.status, 200)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 3)
    const importRun = [...storage.sql.checkpointRuns.values()].find(
      (run) => run.snapshotKey === 'snapshots/vault-1/meta/2.yupdate',
    )
    assert.equal(importRun?.status, 'pointer-updated')
    assert.deepEqual(importRun?.stateVector, Y.encodeStateVector(expectedDoc))

    const importedSnapshot = await bucket.get('snapshots/vault-1/meta/2.yupdate')
    assert(importedSnapshot)
    const importedBytes = new Uint8Array(await importedSnapshot.arrayBuffer())
    const importedDoc = new Y.Doc()
    Y.applyUpdate(importedDoc, importedBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(importedDoc), Y.encodeStateAsUpdate(expectedDoc))
    importedDoc.destroy()
    expectedDoc.destroy()

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 100), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/3.yupdate',
      upperSeq: 3,
      compactedSeq: 2,
    })
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when an import target key already exists', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const targetKey = 'snapshots/vault-1/meta/1.yupdate'
  const existingBytes = makeYjsUpdateBytes(makeMessageId('import-target-existing'))
  bucket.set(targetKey, existingBytes)
  const importBytes = makeYjsUpdateBytes(makeMessageId('import-target-conflict'))
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(importBytes).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 409)
  assert.deepEqual(bucket.puts, [])
  const persisted = await bucket.get(targetKey)
  assert(persisted)
  assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), existingBytes)
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('VaultRoom requires explicit v2 evidence for metadata snapshot imports', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(
          makeYjsUpdateBytes(makeMessageId('meta-evidence-missing')),
        ).toString('base64'),
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'metadata-schema-v2-evidence-required',
  })
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('VaultRoom rejects snapshot imports that would convert a legacy deleted tombstone', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const fileId = makeFileId('legacy-deleted-import')
  const legacy = new Y.Doc()
  legacy.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Deleted.md',
    canonicalPath: 'notes/deleted.md',
    type: 'text',
    ydocId: makeYDocId('legacy-deleted-import-doc'),
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('legacy-deleter'),
    deletedContentVersion: {
      kind: 'binary',
      blobManifestHash: '0'.repeat(64),
    },
    createdAt: 1,
    createdBy: makeDeviceId('legacy-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('legacy-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('legacy-creator'),
    mtime: 1,
  })
  room.docs.set('meta', legacy)
  room.hydratedDocs.add('meta')
  const before = Y.encodeStateAsUpdate(legacy)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 0,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    latestStateVector: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })

  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(legacy))
  const active = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Notes/Deleted.md',
    canonicalPath: 'notes/deleted.md',
    type: 'text' as const,
    ydocId: makeYDocId('legacy-deleted-import-doc'),
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('legacy-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('legacy-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('legacy-creator'),
    mtime: 1,
  }
  candidate.getMap('meta').set(fileId, groupedEntryFromMetaFile(active))
  const update = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(legacy))
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(update).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'invalid-snapshot-import-meta-schema',
  })
  assert.deepEqual(bucket.puts, [])
  assert.deepEqual(Y.encodeStateAsUpdate(legacy), before)
  assert.equal(room.docs.get('meta'), legacy)
  assert.equal(storage.sql.checkpointRuns.size, 0)
  candidate.destroy()
  legacy.destroy()
})

test('VaultRoom rejects unresolved snapshot-import deltas without advancing the sequence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const source = new Y.Doc()
  const firstFileId = makeFileId('causal-import-base')
  source.getMap('meta').set(
    firstFileId,
    groupedEntryFromMetaFile({
      schemaVersion: 1,
      fileId: firstFileId,
      path: 'Notes/Base.md',
      canonicalPath: 'notes/base.md',
      type: 'text',
      ydocId: makeYDocId('causal-import-base-doc'),
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('causal-import-device'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('causal-import-device'),
      updatedAt: 1,
      updatedBy: makeDeviceId('causal-import-device'),
      mtime: 1,
    }),
  )
  const baseStateVector = Y.encodeStateVector(source)
  const secondFileId = makeFileId('causal-import-delta')
  source.getMap('meta').set(
    secondFileId,
    groupedEntryFromMetaFile({
      schemaVersion: 1,
      fileId: secondFileId,
      path: 'Notes/Delta.md',
      canonicalPath: 'notes/delta.md',
      type: 'text',
      ydocId: makeYDocId('causal-import-delta-doc'),
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('causal-import-device'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('causal-import-device'),
      updatedAt: 1,
      updatedBy: makeDeviceId('causal-import-device'),
      mtime: 1,
    }),
  )
  const unresolvedDelta = Y.encodeStateAsUpdate(source, baseStateVector)
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(unresolvedDelta).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'invalid-snapshot-import-update',
  })
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.docs.size, 0)
  source.destroy()
})

test('VaultRoom rejects metadata snapshot imports when the current document is poisoned', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const poisoned = makePoisonedMetaDoc(makeFileId('poisoned-import-meta'))
  room.docs.set('meta', poisoned)
  room.hydratedDocs.add('meta')
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    latestStateVector: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })

  const beforeStateVector = Y.encodeStateVector(poisoned)
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: makeYjsUpdateBase64(makeMessageId('poisoned-import-v2-root')),
        latestSeq: 1,
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'invalid-snapshot-import-meta-schema',
  })
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.checkpointRuns.size, 0)
  assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)
  assert.deepEqual(Y.encodeStateVector(poisoned), beforeStateVector)
  assert.equal(metaYDocSchemaDisposition(poisoned), 'invalid')
  assert.equal(room.docs.get('meta'), poisoned)
})

test('VaultRoom rejects stale snapshot import sequences without durable mutation', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-seq-1'))),
    )
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-seq-2'))),
    )

    const staleDoc = room.docs.get('meta')
    assert(staleDoc)
    const omittedSeqResponse = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(
            makeYjsUpdateBytes(makeMessageId('message-import-seq-omitted')),
          ).toString('base64'),
          metadataSchemaVersion: 2,
        }),
      }),
    )
    assert.equal(omittedSeqResponse.status, 409)
    for (const latestSeq of [1, 3]) {
      const response = await room.fetch(
        new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
              tokenVersion: 1,
            })}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            updateBytesBase64: Buffer.from(
              makeYjsUpdateBytes(makeMessageId(`message-import-seq-stale-${latestSeq}`)),
            ).toString('base64'),
            latestSeq,
            metadataSchemaVersion: 2,
          }),
        }),
      )
      assert.equal(response.status, 409)
    }

    assert.deepEqual(bucket.puts, [])
    assert.equal(storage.sql.checkpointRuns.size, 0)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)
    assert.equal(room.docs.get('meta'), staleDoc)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom lets only one snapshot importer win an identical latest sequence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })
  const request = (updateBytesBase64: string): Promise<Response> =>
    Promise.resolve(
      room.fetch(
        new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ updateBytesBase64, metadataSchemaVersion: 2 }),
        }),
      ),
    )

  const first = await request(makeYjsUpdateBase64(makeMessageId('cas-first')))
  assert.equal(first.status, 200)
  const second = await request(makeYjsUpdateBase64(makeMessageId('cas-second')))
  assert.equal(second.status, 409)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
  assert.equal(bucket.puts.length, 1)
  const active = room.docs.get('meta')
  assert(active)
  assert.equal(active.getMap('meta').size, 1)
  assert.equal(active.getMap('meta').has(makeFileId('file-cas-first')), true)
  assert.equal(active.getMap('meta').has(makeFileId('file-cas-second')), false)
})

test('VaultRoom rejects invalid meta snapshot imports without replacing the active document', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-meta-valid'))),
    )
    const activeDoc = room.docs.get('meta')
    assert(activeDoc)

    const response = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: makeInvalidMetaSchemaYjsUpdateBase64(),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(bucket.puts, [])
    assert.equal(storage.sql.checkpointRuns.size, 0)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)
    assert.equal(room.docs.get('meta'), activeDoc)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects metadata snapshot imports that mutate immutable identity', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-identity-base'))),
    )
    const activeDoc = room.docs.get('meta')
    assert(activeDoc)
    const fileId = [...activeDoc.getMap('meta').keys()][0]
    assert(fileId)

    const candidate = new Y.Doc()
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(activeDoc))
    const child = candidate.getMap<Y.Map<unknown>>('meta').get(fileId)
    assert(child instanceof Y.Map)
    const identity = child.get('identity')
    assert(typeof identity === 'object' && identity !== null)
    child.set('identity', { ...(identity as Record<string, unknown>), createdAt: 2 })
    const importUpdate = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(activeDoc))
    candidate.destroy()

    const response = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(bucket.puts, [])
    assert.equal(storage.sql.checkpointRuns.size, 0)
    assert.equal(room.docs.get('meta'), activeDoc)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rehydrates an active document after recovering a failed snapshot import', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const firstUpdate = makeSyncUpdate(makeMessageId('message-import-recovery-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))
    const importUpdate = makeYjsUpdateBytes(makeMessageId('message-import-recovery-import'))
    const expectedImportedDoc = new Y.Doc()
    Y.applyUpdate(expectedImportedDoc, decodeTestBase64(firstUpdate.update))
    Y.applyUpdate(expectedImportedDoc, importUpdate)

    storage.sql.failOnQueryIncludes = 'insert into docs'
    const importResponse = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )
    assert.equal(importResponse.status, 500)
    storage.sql.failOnQueryIncludes = undefined

    const importRun = [...storage.sql.checkpointRuns.values()].find(
      (run) => run.snapshotKey === 'snapshots/vault-1/meta/2.yupdate',
    )
    assert.equal(importRun?.status, 'r2-written')

    await room.alarm()

    assert(importRun)
    assert.equal(storage.sql.checkpointRuns.get(importRun.runId)?.status, 'pointer-updated')
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    const recoveredDoc = room.docs.get('meta')
    assert(recoveredDoc)
    assert.deepEqual(
      Y.encodeStateAsUpdate(recoveredDoc),
      Y.encodeStateAsUpdate(expectedImportedDoc),
    )

    const emptyStateVector = makeStateVectorBase64(new Y.Doc())
    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-import-recovery-sync'), emptyStateVector),
      ),
    )
    const syncResponse = syncMessages(server.sent).at(-1)
    assert(typeof syncResponse === 'string')
    const syncUpdate = JSON.parse(syncResponse) as SyncUpdate
    const syncDoc = new Y.Doc()
    Y.applyUpdate(syncDoc, decodeTestBase64(syncUpdate.update))
    assert.deepEqual(Y.encodeStateAsUpdate(syncDoc), Y.encodeStateAsUpdate(expectedImportedDoc))
    syncDoc.destroy()

    const append = makeSyncUpdate(makeMessageId('message-import-recovery-append'))
    Y.applyUpdate(expectedImportedDoc, decodeTestBase64(append.update))
    await room.webSocketMessage(server, JSON.stringify(append))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    const appendedDoc = room.docs.get('meta')
    assert(appendedDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(appendedDoc), Y.encodeStateAsUpdate(expectedImportedDoc))

    const checkpointResult = await room.checkpointDoc({ kind: 'meta' }, 100)
    if (checkpointResult.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpointResult.snapshotKey, 'snapshots/vault-1/meta/3.yupdate')
    assert.equal(checkpointResult.upperSeq, 3)
    const checkpointObject = await bucket.get('snapshots/vault-1/meta/3.yupdate')
    assert(checkpointObject)
    const checkpointDoc = new Y.Doc()
    Y.applyUpdate(checkpointDoc, new Uint8Array(await checkpointObject.arrayBuffer()))
    assert.deepEqual(
      Y.encodeStateAsUpdate(checkpointDoc),
      Y.encodeStateAsUpdate(expectedImportedDoc),
    )
    checkpointDoc.destroy()
    expectedImportedDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom preserves an imported document when pointer run status fails after SQL commit', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const firstUpdate = makeSyncUpdate(makeMessageId('message-import-status-failure-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))
    const staleDoc = room.docs.get('meta')
    assert(staleDoc)
    const importUpdate = makeYjsUpdateBytes(makeMessageId('message-import-status-failure-import'))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, decodeTestBase64(firstUpdate.update))
    Y.applyUpdate(expectedDoc, importUpdate)
    const importedSnapshotDoc = new Y.Doc()
    Y.applyUpdate(importedSnapshotDoc, Y.encodeStateAsUpdate(expectedDoc))

    storage.sql.failOnQueryIncludes = 'pointer_updated_at'
    const importResponse = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )
    assert.equal(importResponse.status, 500)
    storage.sql.failOnQueryIncludes = undefined
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
    const importRun = [...storage.sql.checkpointRuns.values()].find(
      (run) => run.snapshotKey === 'snapshots/vault-1/meta/2.yupdate',
    )
    assert.equal(importRun?.status, 'r2-written')

    const activeAfterFailure = room.docs.get('meta')
    assert(activeAfterFailure)
    assert.notEqual(activeAfterFailure, staleDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(activeAfterFailure), Y.encodeStateAsUpdate(expectedDoc))

    const append = makeSyncUpdate(makeMessageId('message-import-status-failure-append'))
    Y.applyUpdate(expectedDoc, decodeTestBase64(append.update))
    await room.webSocketMessage(server, JSON.stringify(append))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    const checkpointResult = await room.checkpointDoc({ kind: 'meta' }, 100)
    if (checkpointResult.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpointResult.upperSeq, 3)

    const coldRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void coldRoom.fetch(await makeAuthenticatedWebSocketRequest())
    const coldServer = (coldRoom.state.getWebSockets?.() ?? [])[0]
    assert(coldServer instanceof FakeSocket)
    await coldRoom.webSocketMessage(coldServer, JSON.stringify(makeHello()))
    await coldRoom.webSocketMessage(
      coldServer,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-import-status-failure-cold'),
          makeStateVectorBase64(importedSnapshotDoc),
        ),
      ),
    )
    const coldResponse = syncMessages(coldServer.sent).at(-1)
    assert(typeof coldResponse === 'string')
    assert.deepEqual(JSON.parse(coldResponse) as NeedFullSnapshot, {
      type: 'need-full-snapshot',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      docId: { kind: 'meta' },
      reason: 'state-vector-too-old',
    })
    importedSnapshotDoc.destroy()
    expectedDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom runs snapshot retention cleanup after checkpoint and exposes admin events', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    bucket.listPageSize = 1
    const cumulativeDoc = new Y.Doc()
    const updates = Array.from({ length: 5 }, (_, index) =>
      makeSyncUpdate(makeMessageId(`message-retention-${index + 1}`)),
    )
    const snapshotStateVectors = new Map<number, Uint8Array>()
    for (const [index, update] of updates.entries()) {
      Y.applyUpdate(cumulativeDoc, decodeTestBase64(update.update))
      const seq = index + 1
      const snapshotBytes = Y.encodeStateAsUpdate(cumulativeDoc)
      bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, snapshotBytes)
      await seedVerifiedSnapshotEvidence(
        storage,
        `snapshots/vault-1/meta/${seq}.yupdate`,
        'meta',
        snapshotBytes,
      )
      snapshotStateVectors.set(seq, Y.encodeStateVector(cumulativeDoc))
      storage.sql.checkpointRuns.set(`seed-retention-${seq}`, {
        runId: `seed-retention-${seq}`,
        docId: 'meta',
        upperSeq: seq,
        snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
        stateVector: snapshotStateVectors.get(seq) ?? new Uint8Array(),
        status: 'compacted',
        createdAt: seq,
        r2WrittenAt: seq,
        pointerUpdatedAt: seq,
        compactedAt: seq,
      })
    }
    const expectedFinalUpdate = Y.encodeStateAsUpdate(cumulativeDoc)
    cumulativeDoc.destroy()
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 0,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    for (const update of updates) {
      await room.webSocketMessage(server, JSON.stringify(update))
    }

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/5.yupdate',
      upperSeq: 5,
      compactedSeq: 3,
    })

    assert.deepEqual(
      [...storage.sql.opLog.values()].map((row) => row.seq).sort((left, right) => left - right),
      [4, 5],
    )

    assert.deepEqual(bucket.deletes, [
      'snapshots/vault-1/meta/1.yupdate',
      'snapshots/vault-1/meta/2.yupdate',
    ])
    assert.equal(bucket.lists.length, 10)
    assert.deepEqual(storage.sql.docs.get('meta')?.horizonStateVector, snapshotStateVectors.get(3))
    assert.equal(await bucket.get('snapshots/vault-1/meta/1.yupdate'), null)
    assert.notEqual(await bucket.get('snapshots/vault-1/meta/3.yupdate'), null)
    assert.deepEqual(
      storage.sql.snapshotRetentionEvents.map((event) => ({
        snapshotKey: event.snapshotKey,
        error: event.error,
      })),
      [
        { snapshotKey: 'snapshots/vault-1/meta/1.yupdate', error: undefined },
        { snapshotKey: 'snapshots/vault-1/meta/2.yupdate', error: undefined },
      ],
    )
    for (const snapshotKey of [
      'snapshots/vault-1/meta/1.yupdate',
      'snapshots/vault-1/meta/2.yupdate',
    ]) {
      const deleted = storage.sql.snapshotHealthEvents
        .filter((event) => event.snapshotKey === snapshotKey)
        .at(-1)
      assert.equal(deleted?.physicalStatus, 'mismatch')
      assert.equal(JSON.parse(deleted?.reasons ?? '[]').includes('missing-object'), true)
    }

    restoreResponse(previousResponse)
    const healthResponse = await room.fetch(
      new Request('https://worker.example/admin/snapshots?docId=meta&limit=64', {
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
        },
      }),
    )
    assert.equal(healthResponse.status, 200)
    const healthBody = (await healthResponse.json()) as {
      readonly entries: readonly {
        snapshotKey: string
        physicalStatus: string
        allowedActions: readonly string[]
        actionBlockReason?: string
      }[]
    }
    const deletedEntry = healthBody.entries.find(
      (entry) => entry.snapshotKey === 'snapshots/vault-1/meta/1.yupdate',
    )
    assert(deletedEntry)
    assert.equal(deletedEntry.physicalStatus, 'mismatch')
    assert.deepEqual(deletedEntry.allowedActions, [])
    assert.equal(deletedEntry.actionBlockReason, 'snapshot-health-deleted')
    const deleteCount = bucket.deletes.length
    await room.alarm()
    assert.equal(bucket.deletes.length, deleteCount)

    const restoredBucket = new FakeR2Bucket()
    const snapshot3Bytes = await bucket.get('snapshots/vault-1/meta/3.yupdate')
    assert(snapshot3Bytes)
    restoredBucket.set(
      'snapshots/vault-1/meta/3.yupdate',
      new Uint8Array(await snapshot3Bytes.arrayBuffer()),
    )
    const restoredSnapshotDoc = new Y.Doc()
    Y.applyUpdate(restoredSnapshotDoc, new Uint8Array(await snapshot3Bytes.arrayBuffer()))
    const restoredSnapshotStateVector = Y.encodeStateVector(restoredSnapshotDoc)
    const existingDoc = storage.sql.docs.get('meta')
    assert(existingDoc)
    storage.sql.docs.set('meta', {
      ...existingDoc,
      latestSnapshotSeq: 3,
      latestSnapshotKey: 'snapshots/vault-1/meta/3.yupdate',
      minRetainedSeq: 3,
      horizonStateVector: restoredSnapshotStateVector,
    })
    const restoredRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(restoredBucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void restoredRoom.fetch(await makeAuthenticatedWebSocketRequest())
    const restoredServer = (restoredRoom.state.getWebSockets?.() ?? [])[0]
    assert(restoredServer instanceof FakeSocket)
    await restoredRoom.webSocketMessage(restoredServer, JSON.stringify(makeHello()))
    await restoredRoom.webSocketMessage(
      restoredServer,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-retention-residual'),
          makeStateVectorBase64(restoredSnapshotDoc),
        ),
      ),
    )
    const residualMessage = syncMessages(restoredServer.sent).at(-1)
    assert(typeof residualMessage === 'string')
    const residualUpdate = JSON.parse(residualMessage) as SyncUpdate
    restoredSnapshotDoc.destroy()
    const residualDoc = new Y.Doc()
    Y.applyUpdate(residualDoc, new Uint8Array(await snapshot3Bytes.arrayBuffer()))
    Y.applyUpdate(residualDoc, decodeTestBase64(residualUpdate.update))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, expectedFinalUpdate)
    assert.deepEqual(Y.encodeStateAsUpdate(residualDoc), Y.encodeStateAsUpdate(expectedDoc))
    residualDoc.destroy()
    expectedDoc.destroy()

    restoreResponse(previousResponse)
    const response = await room.fetch(
      new Request('https://worker.example/admin/retention', {
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
        },
      }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert(
      isRetentionAdminResponse(body) &&
        body.items.some((event) => event.snapshotKey === 'snapshots/vault-1/meta/1.yupdate'),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('GET /admin/retention paginates newest-first with a cursor and rejects out-of-range limits', async () => {
  const storage = new SqlOnlyStorage()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(new FakeR2Bucket(), TEST_DEVICE_TOKEN_SECRET),
  )
  await ensureSchema(room)
  for (let seq = 1; seq <= 3; seq += 1) {
    storage.sql.snapshotRetentionEvents.push({
      id: seq,
      docId: 'meta',
      snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
      action: 'delete',
      error: undefined,
      attemptedAt: seq,
    })
  }
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const firstPage = await room.fetch(
    new Request('https://worker.example/admin/retention?limit=2', { headers: authHeader }),
  )
  assert.equal(firstPage.status, 200)
  const firstBody = await firstPage.json()
  assert(isRetentionAdminResponse(firstBody))
  assert.deepEqual(
    firstBody.items.map((event) => event.snapshotKey),
    ['snapshots/vault-1/meta/3.yupdate', 'snapshots/vault-1/meta/2.yupdate'],
  )
  assert.equal(firstBody.nextCursor, '2')

  const secondPage = await room.fetch(
    new Request(`https://worker.example/admin/retention?limit=2&cursor=${firstBody.nextCursor}`, {
      headers: authHeader,
    }),
  )
  assert.equal(secondPage.status, 200)
  const secondBody = await secondPage.json()
  assert(isRetentionAdminResponse(secondBody))
  assert.deepEqual(
    secondBody.items.map((event) => event.snapshotKey),
    ['snapshots/vault-1/meta/1.yupdate'],
  )
  assert.equal(secondBody.nextCursor, undefined)

  const invalidLimit = await room.fetch(
    new Request('https://worker.example/admin/retention?limit=0', { headers: authHeader }),
  )
  assert.equal(invalidLimit.status, 400)
  assert.equal(v.is(ApiErrorSchema, await invalidLimit.json()), true)

  const invalidCursor = await room.fetch(
    new Request('https://worker.example/admin/retention?cursor=not-a-number', {
      headers: authHeader,
    }),
  )
  assert.equal(invalidCursor.status, 400)
  assert.equal(v.is(ApiErrorSchema, await invalidCursor.json()), true)
})

test('VaultRoom blocks compaction when snapshot retention candidates are invalid', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    bucket.set('snapshots/vault-1/meta/not-a-snapshot.yupdate', new Uint8Array([1]))
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-retention-invalid'))
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: undefined,
    })
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 0)
    assert.deepEqual(bucket.deletes, [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks compaction and fails closed when SNAPSHOT_RETENTION_MIN_GENERATIONS is invalid', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const env = {
      ...makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
      SNAPSHOT_RETENTION_MIN_GENERATIONS: 'not-a-positive-integer',
    }
    const room = new VaultRoom(state, env)
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-retention-config-invalid'))
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: undefined,
    })
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 0)
    assert.deepEqual(bucket.deletes, [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks compaction when R2 pagination is malformed', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-retention-pagination-invalid'))
    await room.webSocketMessage(server, JSON.stringify(update))
    bucket.listOverride = async () => ({ objects: [], truncated: true })

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: undefined,
    })
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
    assert.deepEqual(bucket.deletes, [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom schedules and runs checkpoint alarms after durable appends', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const env = makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET)
    const room = new VaultRoom(state, env)
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-alarm'))),
    )

    assert.equal(storage.alarms.length, 1)
    assert.equal(typeof storage.alarms[0], 'number')
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)

    const resumedRoom = new VaultRoom(new FakeState(storage), env)
    await resumedRoom.alarm()

    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(
      storage.sql.docs.get('meta')?.latestSnapshotKey,
      'snapshots/vault-1/meta/1.yupdate',
    )
    assert.equal(storage.sql.opLog.has('meta:message-alarm'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom schedules an immediate checkpoint alarm after the op threshold', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 127,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    for (let seq = 1; seq <= 127; seq += 1) {
      storage.sql.opLog.set(`meta:threshold-seq-${seq}`, {
        docId: 'meta',
        seq,
        messageId: `threshold-seq-${seq}`,
        deviceId: 'device-1',
        updateBytes: makeYjsUpdateBytes(makeMessageId(`threshold-seq-${seq}`)),
        updateSha256: 'a'.repeat(64),
        createdAt: seq,
      })
    }
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-threshold'))),
    )

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 128)
    assert.equal(storage.alarms.length, 1)
    const scheduled = storage.alarms[0]
    assert(typeof scheduled === 'number')
    assert(scheduled <= Date.now())
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom alarm recovers orphaned checkpoint runs before new checkpoints', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-recovered-snapshot'))
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, snapshotBytes)
  const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshotBytes)
  await seedVerifiedSnapshotEvidence(
    storage,
    'snapshots/vault-1/meta/2.yupdate',
    'meta',
    snapshotBytes,
  )
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 3,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.checkpointRuns.set('run-writing', {
    runId: 'run-writing',
    docId: 'meta',
    upperSeq: 2,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: snapshotStateVector,
    status: 'writing',
    createdAt: 1,
    r2WrittenAt: undefined,
    pointerUpdatedAt: undefined,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-writing')?.status, 'r2-written')
  assert.equal(storage.sql.checkpointRuns.get('run-writing')?.r2WrittenAt !== undefined, true)
})

test('VaultRoom alarm advances and compacts recovered checkpoint pointers', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-pointer-snapshot'))
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, snapshotBytes)
  const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshotBytes)
  await seedVerifiedSnapshotEvidence(
    storage,
    'snapshots/vault-1/meta/2.yupdate',
    'meta',
    snapshotBytes,
  )
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:message-before-snapshot', {
    docId: 'meta',
    seq: 1,
    messageId: 'message-before-snapshot',
    deviceId: 'device-1',
    updateBytes: makeYjsUpdateBytes(makeMessageId('message-before-snapshot')),
    updateSha256: 'sha',
    createdAt: 1,
  })
  storage.sql.checkpointRuns.set('run-r2', {
    runId: 'run-r2',
    docId: 'meta',
    upperSeq: 2,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: snapshotStateVector,
    status: 'r2-written',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: undefined,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'pointer-updated')
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, 'snapshots/vault-1/meta/2.yupdate')
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.authorityStatus, 'authoritative')

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'compacted')
  assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 2)
  assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
  assert.equal(storage.sql.opLog.has('meta:message-before-snapshot'), false)
})

test('VaultRoom alarm evicts a checkpointed, idle file doc at the tail of the checkpoint pass', async () => {
  const storage = new SqlOnlyStorage()
  const ydocId = makeYDocId('ydoc-evict-idle')
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: 'snapshots/vault-1/files/ydoc-evict-idle/1.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnv())
  room.docs.set(`file:${ydocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${ydocId}`)
  room.docLastAccessedAt.set(`file:${ydocId}`, 0)

  await room.alarm()

  assert.equal(room.docs.has(`file:${ydocId}`), false)
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom alarm keeps dirty and recently-accessed file docs resident', async () => {
  const storage = new SqlOnlyStorage()
  const dirtyYDocId = makeYDocId('ydoc-evict-dirty')
  const recentYDocId = makeYDocId('ydoc-evict-recent')
  storage.sql.docs.set(`file:${dirtyYDocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 1,
    latestSnapshotKey: 'snapshots/vault-1/files/ydoc-evict-dirty/1.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.docs.set(`file:${recentYDocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: 'snapshots/vault-1/files/ydoc-evict-recent/1.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnv())
  room.docs.set(`file:${dirtyYDocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${dirtyYDocId}`)
  room.docLastAccessedAt.set(`file:${dirtyYDocId}`, 0)
  room.docs.set(`file:${recentYDocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${recentYDocId}`)
  room.docLastAccessedAt.set(`file:${recentYDocId}`, Date.now())

  await room.alarm()

  assert.equal(room.hydratedDocs.has(`file:${dirtyYDocId}`), true)
  assert.equal(room.hydratedDocs.has(`file:${recentYDocId}`), true)
})

test('VaultRoom waits for stale hydration before rehydrating an orphaned pointer', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const oldSnapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const recoveredSnapshotKey = 'snapshots/vault-1/meta/2.yupdate'
    const latestSnapshotKey = 'snapshots/vault-1/meta/3.yupdate'
    const oldSnapshotUpdate = makeYjsUpdateBytes(makeMessageId('message-hydration-old'))
    const oldSnapshotDoc = new Y.Doc()
    Y.applyUpdate(oldSnapshotDoc, oldSnapshotUpdate)
    const oldSnapshotBytes = Y.encodeStateAsUpdate(oldSnapshotDoc)
    oldSnapshotDoc.destroy()

    const recoveredDoc = new Y.Doc()
    Y.applyUpdate(recoveredDoc, oldSnapshotUpdate)
    Y.applyUpdate(recoveredDoc, makeYjsUpdateBytes(makeMessageId('message-hydration-recovered')))
    const recoveredSnapshotBytes = Y.encodeStateAsUpdate(recoveredDoc)
    const recoveredStateVector = Y.encodeStateVector(recoveredDoc)
    bucket.set(oldSnapshotKey, oldSnapshotBytes)
    bucket.set(recoveredSnapshotKey, recoveredSnapshotBytes)
    await seedVerifiedSnapshotEvidence(storage, oldSnapshotKey, 'meta', oldSnapshotBytes)
    await seedVerifiedSnapshotEvidence(
      storage,
      recoveredSnapshotKey,
      'meta',
      recoveredSnapshotBytes,
    )

    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: oldSnapshotKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.checkpointRuns.set('run-hydration-recovery', {
      runId: 'run-hydration-recovery',
      docId: 'meta',
      upperSeq: 2,
      snapshotKey: recoveredSnapshotKey,
      stateVector: recoveredStateVector,
      status: 'r2-written',
      createdAt: 1,
      r2WrittenAt: 2,
      pointerUpdatedAt: undefined,
      compactedAt: undefined,
    })
    await storage.put('vault:id', 'vault-1')

    let notifyListStarted: () => void = () => {}
    const listStarted = new Promise<void>((resolve) => {
      notifyListStarted = resolve
    })
    let releaseList: () => void = () => {}
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    let listCalls = 0
    bucket.listOverride = async () => {
      listCalls += 1
      if (listCalls === 1) {
        notifyListStarted()
        await listGate
        return { objects: [{ key: oldSnapshotKey }], truncated: false }
      }
      return {
        objects:
          listCalls === 2
            ? [{ key: oldSnapshotKey }, { key: recoveredSnapshotKey }]
            : [{ key: oldSnapshotKey }, { key: recoveredSnapshotKey }, { key: latestSnapshotKey }],
        truncated: false,
      }
    }

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const emptyDoc = new Y.Doc()
    const hydrationRequest = room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-hydration-request'),
          makeStateVectorBase64(emptyDoc),
        ),
      ),
    )
    emptyDoc.destroy()
    await listStarted

    const alarm = room.alarm()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(room.docWriteQueues.has('meta'), false)
    releaseList()
    await Promise.all([hydrationRequest, alarm])

    const activeDoc = room.docs.get('meta')
    assert(activeDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(activeDoc), recoveredSnapshotBytes)

    const append = makeSyncUpdate(makeMessageId('message-hydration-append'))
    Y.applyUpdate(recoveredDoc, decodeTestBase64(append.update))
    await room.webSocketMessage(server, JSON.stringify(append))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    const appendedDoc = room.docs.get('meta')
    assert(appendedDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(appendedDoc), Y.encodeStateAsUpdate(recoveredDoc))

    const checkpointResult = await room.checkpointDoc({ kind: 'meta' }, 100)
    if (checkpointResult.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpointResult.snapshotKey, latestSnapshotKey)
    assert.equal(checkpointResult.upperSeq, 3)
    recoveredDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks orphan recovery when snapshot key sequence mismatches the run', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshot2 = makeYjsUpdateBytes(makeMessageId('message-orphan-key-2'))
  const snapshot5 = makeYjsUpdateBytes(makeMessageId('message-orphan-key-5'))
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshot2)
  bucket.set('snapshots/vault-1/meta/5.yupdate', snapshot5)
  const snapshot2Doc = new Y.Doc()
  Y.applyUpdate(snapshot2Doc, snapshot2)
  const snapshot2StateVector = Y.encodeStateVector(snapshot2Doc)
  snapshot2Doc.destroy()
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 5,
    latestSnapshotSeq: 5,
    latestSnapshotKey: 'snapshots/vault-1/meta/5.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:message-orphan-key-row', {
    docId: 'meta',
    seq: 1,
    messageId: 'message-orphan-key-row',
    deviceId: 'device-1',
    updateBytes: snapshot2,
    updateSha256: 'sha',
    createdAt: 1,
  })
  storage.sql.checkpointRuns.set('run-orphan-key-mismatch', {
    runId: 'run-orphan-key-mismatch',
    docId: 'meta',
    upperSeq: 5,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: snapshot2StateVector,
    status: 'pointer-updated',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: 3,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-orphan-key-mismatch')?.status, 'pointer-updated')
  assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 0)
  assert.equal(storage.sql.opLog.has('meta:message-orphan-key-row'), true)
  assert.deepEqual(bucket.deletes, [])
})

test('VaultRoom applies the retained snapshot floor while recovering orphaned checkpoints', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const cumulativeDoc = new Y.Doc()
    const snapshotStateVectors = new Map<number, Uint8Array>()
    const snapshotBytesBySeq = new Map<number, Uint8Array>()
    for (const seq of [1, 2, 3, 4, 5]) {
      const updateBytes = makeYjsUpdateBytes(makeMessageId(`message-orphan-retention-${seq}`))
      Y.applyUpdate(cumulativeDoc, updateBytes)
      const snapshotBytes = Y.encodeStateAsUpdate(cumulativeDoc)
      const stateVector = Y.encodeStateVector(cumulativeDoc)
      bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, snapshotBytes)
      await seedVerifiedSnapshotEvidence(
        storage,
        `snapshots/vault-1/meta/${seq}.yupdate`,
        'meta',
        snapshotBytes,
      )
      snapshotBytesBySeq.set(seq, snapshotBytes)
      snapshotStateVectors.set(seq, stateVector)
      storage.sql.opLog.set(`meta:message-orphan-retention-${seq}`, {
        docId: 'meta',
        seq,
        messageId: `message-orphan-retention-${seq}`,
        deviceId: 'device-1',
        updateBytes,
        updateSha256: 'sha',
        createdAt: seq,
      })
      storage.sql.checkpointRuns.set(`seed-orphan-retention-${seq}`, {
        runId: `seed-orphan-retention-${seq}`,
        docId: 'meta',
        upperSeq: seq,
        snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
        stateVector,
        status: 'compacted',
        createdAt: seq,
        r2WrittenAt: seq,
        pointerUpdatedAt: seq,
        compactedAt: seq,
      })
    }
    const snapshotStateVector = snapshotStateVectors.get(5)
    assert(snapshotStateVector)
    const expectedFinalUpdate = Y.encodeStateAsUpdate(cumulativeDoc)
    cumulativeDoc.destroy()
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 5,
      latestSnapshotSeq: 5,
      latestSnapshotKey: 'snapshots/vault-1/meta/5.yupdate',
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.checkpointRuns.set('run-orphan-retention', {
      runId: 'run-orphan-retention',
      docId: 'meta',
      upperSeq: 5,
      snapshotKey: 'snapshots/vault-1/meta/5.yupdate',
      stateVector: snapshotStateVector,
      status: 'pointer-updated',
      createdAt: 1,
      r2WrittenAt: 2,
      pointerUpdatedAt: 3,
      compactedAt: undefined,
    })
    await storage.put('vault:id', 'vault-1')
    const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

    await room.alarm()

    assert.equal(storage.sql.checkpointRuns.get('run-orphan-retention')?.status, 'compacted')
    assert.deepEqual(
      [...storage.sql.opLog.values()].map((row) => row.seq).sort((left, right) => left - right),
      [4, 5],
    )
    assert.deepEqual(bucket.deletes, [
      'snapshots/vault-1/meta/1.yupdate',
      'snapshots/vault-1/meta/2.yupdate',
    ])
    assert.deepEqual(storage.sql.docs.get('meta')?.horizonStateVector, snapshotStateVectors.get(3))

    const oldestRetainedSnapshot = snapshotBytesBySeq.get(3)
    const oldestRetainedStateVector = snapshotStateVectors.get(3)
    assert(oldestRetainedSnapshot)
    assert(oldestRetainedStateVector)
    const restoredBucket = new FakeR2Bucket()
    restoredBucket.set('snapshots/vault-1/meta/3.yupdate', oldestRetainedSnapshot)
    const existingDoc = storage.sql.docs.get('meta')
    assert(existingDoc)
    storage.sql.docs.set('meta', {
      ...existingDoc,
      latestSnapshotSeq: 3,
      latestSnapshotKey: 'snapshots/vault-1/meta/3.yupdate',
      minRetainedSeq: 3,
      horizonStateVector: oldestRetainedStateVector,
    })
    const restoredRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(restoredBucket, TEST_DEVICE_TOKEN_SECRET),
    )
    await restoredRoom.fetch(await makeAuthenticatedWebSocketRequest())
    const restoredServer = (restoredRoom.state.getWebSockets?.() ?? [])[0]
    assert(restoredServer instanceof FakeSocket)
    const oldestSnapshotDoc = new Y.Doc()
    Y.applyUpdate(oldestSnapshotDoc, oldestRetainedSnapshot)
    await restoredRoom.webSocketMessage(restoredServer, JSON.stringify(makeHello()))
    await restoredRoom.webSocketMessage(
      restoredServer,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-orphan-retention-residual'),
          makeStateVectorBase64(oldestSnapshotDoc),
        ),
      ),
    )
    const residualMessage = syncMessages(restoredServer.sent).at(-1)
    assert(typeof residualMessage === 'string')
    const residualUpdate = JSON.parse(residualMessage) as SyncUpdate
    const restoredDoc = new Y.Doc()
    Y.applyUpdate(restoredDoc, oldestRetainedSnapshot)
    Y.applyUpdate(restoredDoc, decodeTestBase64(residualUpdate.update))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, expectedFinalUpdate)
    assert.deepEqual(Y.encodeStateAsUpdate(restoredDoc), Y.encodeStateAsUpdate(expectedDoc))
    oldestSnapshotDoc.destroy()
    restoredDoc.destroy()
    expectedDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom honors an operator-configured minimum generation count during retention cleanup', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const cumulativeDoc = new Y.Doc()
  const snapshotStateVectors = new Map<number, Uint8Array>()
  for (const seq of [1, 2, 3, 4, 5]) {
    const updateBytes = makeYjsUpdateBytes(makeMessageId(`message-min-generations-${seq}`))
    Y.applyUpdate(cumulativeDoc, updateBytes)
    const snapshotBytes = Y.encodeStateAsUpdate(cumulativeDoc)
    const stateVector = Y.encodeStateVector(cumulativeDoc)
    bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, snapshotBytes)
    await seedVerifiedSnapshotEvidence(
      storage,
      `snapshots/vault-1/meta/${seq}.yupdate`,
      'meta',
      snapshotBytes,
    )
    snapshotStateVectors.set(seq, stateVector)
    storage.sql.opLog.set(`meta:message-min-generations-${seq}`, {
      docId: 'meta',
      seq,
      messageId: `message-min-generations-${seq}`,
      deviceId: 'device-1',
      updateBytes,
      updateSha256: 'sha',
      createdAt: seq,
    })
    storage.sql.checkpointRuns.set(`seed-min-generations-${seq}`, {
      runId: `seed-min-generations-${seq}`,
      docId: 'meta',
      upperSeq: seq,
      snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
      stateVector,
      status: 'compacted',
      createdAt: seq,
      r2WrittenAt: seq,
      pointerUpdatedAt: seq,
      compactedAt: seq,
    })
  }
  cumulativeDoc.destroy()
  const snapshotStateVector = snapshotStateVectors.get(5)
  assert(snapshotStateVector)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 5,
    latestSnapshotSeq: 5,
    latestSnapshotKey: 'snapshots/vault-1/meta/5.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.checkpointRuns.set('run-min-generations', {
    runId: 'run-min-generations',
    docId: 'meta',
    upperSeq: 5,
    snapshotKey: 'snapshots/vault-1/meta/5.yupdate',
    stateVector: snapshotStateVector,
    status: 'pointer-updated',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: 3,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), {
    ...makeEnvWithSnapshotBucket(bucket),
    SNAPSHOT_RETENTION_MIN_GENERATIONS: '1',
  })

  await room.alarm()

  // The hardcoded default (3, see the sibling "applies the retained snapshot
  // floor" test) would only delete generations 1 and 2. Overriding to 1 keeps
  // just the newest generation.
  assert.deepEqual(bucket.deletes, [
    'snapshots/vault-1/meta/1.yupdate',
    'snapshots/vault-1/meta/2.yupdate',
    'snapshots/vault-1/meta/3.yupdate',
    'snapshots/vault-1/meta/4.yupdate',
  ])
})

test('VaultRoom answers sync requests with Yjs diffs and no-ops empty diffs', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-sync-source'))
    await room.webSocketMessage(server, JSON.stringify(update))

    const emptyStateVector = makeStateVectorBase64(new Y.Doc())
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncRequest(makeMessageId('message-sync-request'), emptyStateVector)),
    )

    const response = stringMessageAt(server.sent, 1)
    if (typeof response !== 'string') {
      throw new Error('expected sync-request response string')
    }
    const parsed = JSON.parse(response) as SyncUpdate
    assert.equal(parsed.type, 'sync-update')
    assert.equal(parsed.messageId, makeMessageId('message-sync-request'))
    assert.equal(parsed.baseStateVector, emptyStateVector)

    const localDoc = new Y.Doc()
    Y.applyUpdate(localDoc, decodeTestBase64(update.update))
    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-sync-current'), makeStateVectorBase64(localDoc)),
      ),
    )

    assert.equal(syncMessages(server.sent).length, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires a full snapshot when sync request state vector is older than horizon', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-horizon'))),
    )
    await room.checkpointDoc({ kind: 'meta' }, 10)

    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-old-horizon'), makeStateVectorBase64(new Y.Doc())),
      ),
    )

    const response = stringMessageAt(server.sent, 1)
    if (typeof response !== 'string') {
      throw new Error('expected need-full-snapshot response string')
    }
    assert.deepEqual(JSON.parse(response) as NeedFullSnapshot, {
      type: 'need-full-snapshot',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      docId: { kind: 'meta' },
      reason: 'state-vector-too-old',
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom hydrates active Y.Doc from SQL op_log after Durable Object restart', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const request = await makeAuthenticatedWebSocketRequest()

    const firstState = new FakeState(storage)
    const firstRoom = new VaultRoom(
      firstState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    void firstRoom.fetch(request)
    const firstServer = firstState.accepted[0]
    assert(firstServer instanceof FakeSocket)
    await firstRoom.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await firstRoom.webSocketMessage(
      firstServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-before-restart'))),
    )

    const queryCountBeforeRestart = storage.sql.queries.length
    const secondState = new FakeState(storage)
    const secondRoom = new VaultRoom(
      secondState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    void secondRoom.fetch(request)
    const secondServer = secondState.accepted[0]
    assert(secondServer instanceof FakeSocket)
    await secondRoom.webSocketMessage(secondServer, JSON.stringify(makeHello()))
    await secondRoom.webSocketMessage(
      secondServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-restart'))),
    )

    const restartQueries = storage.sql.queries.slice(queryCountBeforeRestart)
    assert(
      restartQueries.some((query) => query.includes('update_bytes')),
      'expected restarted room to replay op_log before appending',
    )
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get('meta:message-before-restart')?.seq, 1)
    assert.equal(storage.sql.opLog.get('meta:message-after-restart')?.seq, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom hydrates active Y.Doc from R2 snapshot plus residual SQL op_log', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-snapshot'))
    bucket.set(snapshotKey, snapshotBytes)
    await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 1,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.opLog.set('meta:message-residual', {
      docId: 'meta',
      seq: 2,
      messageId: 'message-residual',
      deviceId: 'device-1',
      updateBytes: makeYjsUpdateBytes(makeMessageId('message-residual')),
      updateSha256: 'a'.repeat(64),
      createdAt: 2,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-snapshot'))),
    )

    assert.deepEqual(bucket.gets, [snapshotKey, snapshotKey])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-snapshot')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when residual op_log sequences contain a gap', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-oplog-gap')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('oplog-gap-snapshot'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 3,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const seq3 = makeYjsUpdateBytes(makeMessageId('oplog-gap-seq3'))
  storage.sql.opLog.set(`file:${ydocId}:oplog-gap-seq3`, {
    docId: `file:${ydocId}`,
    seq: 3,
    messageId: 'oplog-gap-seq3',
    deviceId: 'device-1',
    updateBytes: seq3,
    updateSha256: await hashTestBytes(seq3),
    createdAt: 3,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    failed = error instanceof Error && error.message === 'op_log sequence gap'
  }
  assert.equal(failed, true)
  assert.equal(room.docs.has(`file:${ydocId}`), false)
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom fails closed when residual op_log rows stop before the durable tail', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-oplog-tail-gap')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('oplog-tail-snapshot'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 3,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const seq2 = makeYjsUpdateBytes(makeMessageId('oplog-tail-seq2'))
  storage.sql.opLog.set(`file:${ydocId}:oplog-tail-seq2`, {
    docId: `file:${ydocId}`,
    seq: 2,
    messageId: 'oplog-tail-seq2',
    deviceId: 'device-1',
    updateBytes: seq2,
    updateSha256: await hashTestBytes(seq2),
    createdAt: 2,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    failed = error instanceof Error && error.message === 'op_log sequence gap'
  }
  assert.equal(failed, true)
  assert.equal(room.docs.has(`file:${ydocId}`), false)
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom stops sync updates when the recorded R2 snapshot is missing', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 1,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-missing-snapshot'))),
    )

    assert.deepEqual(bucket.gets, [snapshotKey])
    assert.equal(server.closed, true)
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'hydrate-failed')
    assert.deepEqual(syncMessages(server.sent), [])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.opLog.has('meta:message-after-missing-snapshot'), false)
    assert.equal(storage.sql.quarantines.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom falls back from a missing snapshot pointer to the newest listed snapshot', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const stalePointerKey = 'snapshots/vault-1/meta/1.yupdate'
    const fallbackKey = 'snapshots/vault-1/meta/2.yupdate'
    const fallbackBytes = makeYjsUpdateBytes(makeMessageId('message-fallback-snapshot'))
    bucket.set(fallbackKey, fallbackBytes)
    await seedVerifiedSnapshotEvidence(storage, fallbackKey, 'meta', fallbackBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: stalePointerKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-fallback'))),
    )

    assert.deepEqual(bucket.lists, ['snapshots/vault-1/meta/'])
    assert.deepEqual(bucket.gets, [fallbackKey, fallbackKey])
    assert.equal(server.closed, false)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-fallback')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom skips a corrupt newest generation and replays residual op_log from an older verified snapshot', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-fallback')
  const docId = { kind: 'file' as const, ydocId }
  const olderKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const newestKey = `snapshots/vault-1/files/${ydocId}/3.yupdate`
  const olderDoc = new Y.Doc()
  olderDoc.getText('content').insert(0, 'older')
  const olderBytes = Y.encodeStateAsUpdate(olderDoc)
  const newestDoc = new Y.Doc()
  newestDoc.getText('content').insert(0, 'newest')
  const newestBytes = Y.encodeStateAsUpdate(newestDoc)
  olderDoc.destroy()
  newestDoc.destroy()
  bucket.set(olderKey, olderBytes)
  bucket.set(newestKey, newestBytes)
  await seedVerifiedSnapshotEvidence(storage, olderKey, `file:${ydocId}`, olderBytes)
  await seedVerifiedSnapshotEvidence(storage, newestKey, `file:${ydocId}`, newestBytes)
  const corruptNewest = newestBytes.slice()
  corruptNewest[corruptNewest.length - 1] = (corruptNewest.at(-1) ?? 0) ^ 0xff
  bucket.set(newestKey, corruptNewest)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 3,
    latestSnapshotSeq: 3,
    latestSnapshotKey: newestKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const residual = makeYjsUpdateBytes(makeMessageId('health-fallback-residual'))
  storage.sql.opLog.set(`file:${ydocId}:health-fallback-residual`, {
    docId: `file:${ydocId}`,
    seq: 2,
    messageId: 'health-fallback-residual',
    deviceId: 'device-1',
    updateBytes: residual,
    updateSha256: await hashTestBytes(residual),
    createdAt: 2,
  })
  const tail = makeYjsUpdateBytes(makeMessageId('health-fallback-tail'))
  storage.sql.opLog.set(`file:${ydocId}:health-fallback-tail`, {
    docId: `file:${ydocId}`,
    seq: 3,
    messageId: 'health-fallback-tail',
    deviceId: 'device-1',
    updateBytes: tail,
    updateSha256: await hashTestBytes(tail),
    createdAt: 3,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  await ensureDocHydrated(room, docId)

  assert(room.docs.get(`file:${ydocId}`))
  const newestEvents = storage.sql.snapshotHealthEvents.filter(
    (row) => row.snapshotKey === newestKey,
  )
  assert.equal(newestEvents.at(-1)?.physicalStatus, 'mismatch')
  assert.equal(newestEvents.at(-1)?.event, 'verification')
  assert.equal(storage.sql.opLog.has(`file:${ydocId}:health-fallback-residual`), true)
})

test('legacy snapshot verification is explicit and the last healthy generation cannot be quarantined', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-legacy-health')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-health-snapshot'))
  bucket.set(snapshotKey, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  let hydrateFailed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    hydrateFailed =
      error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(hydrateFailed, true)

  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const mismatchedRoute = await room.fetch(
    new Request('https://worker.example/admin/snapshots/wrong-doc/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'route mismatch must be rejected',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(mismatchedRoute.status, 400)
  const verifyResponse = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Approve current legacy bytes after operator inspection',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(verifyResponse.status, 200)
  const verifyBody = (await verifyResponse.json()) as {
    readonly entry: { readonly actor: string }
  }
  assert.equal(verifyBody.entry.actor, 'device-1')
  await ensureDocHydrated(room, docId)
  assert(room.docs.get(`file:${ydocId}`))

  const quarantineResponse = await room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Operator quarantined generation for inspection',
        confirmation: 'quarantine',
      }),
    }),
  )
  assert.equal(quarantineResponse.status, 409)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
  room.docs.get(`file:${ydocId}`)?.destroy()
  room.docs.delete(`file:${ydocId}`)
  room.hydratedDocs.delete(`file:${ydocId}`)
  hydrateFailed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    hydrateFailed =
      error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(hydrateFailed, false)
})

test('rollback writes a new audited generation and preserves the source object', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-health')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const currentKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-source'))
  const currentBytes = makeYjsUpdateBytes(makeMessageId('rollback-current'))
  bucket.set(sourceKey, sourceBytes)
  bucket.set(currentKey, currentBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, currentKey, `file:${ydocId}`, currentBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 2,
    latestSnapshotKey: currentKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:rollback-current`, {
    docId: `file:${ydocId}`,
    seq: 2,
    messageId: 'rollback-current',
    deviceId: 'device-1',
    updateBytes: currentBytes,
    updateSha256: await hashTestBytes(currentBytes),
    createdAt: 2,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Rollback to the last verified operator-approved generation',
        confirmation: 'rollback',
      }),
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly actor: string
    readonly snapshotKey: string
    readonly snapshotSeq: number
  }
  assert.equal(body.actor, 'device-1')
  assert.equal(body.snapshotSeq, 3)
  assert.equal(body.snapshotKey, `snapshots/vault-1/files/${ydocId}/3.yupdate`)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotSeq, 3)
  assert.equal((await bucket.get(sourceKey)) !== null, true)
  assert.equal(
    storage.sql.snapshotHealthEvents.some(
      (event) => event.snapshotKey === body.snapshotKey && event.event === 'rollback',
    ),
    true,
  )
  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const coldHydrated = coldRoom.docs.get(`file:${ydocId}`)
  assert(coldHydrated)
  const expectedColdDoc = new Y.Doc()
  Y.applyUpdate(expectedColdDoc, sourceBytes)
  Y.applyUpdate(expectedColdDoc, currentBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(coldHydrated), Y.encodeStateAsUpdate(expectedColdDoc))
  expectedColdDoc.destroy()
})

test('rollback accepts and preserves grouped metadata generations', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const sourceKey = 'snapshots/vault-1/meta/1.yupdate'
  const currentKey = 'snapshots/vault-1/meta/2.yupdate'
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-meta-source'))
  const currentBytes = makeYjsUpdateBytes(makeMessageId('rollback-meta-current'))
  bucket.set(sourceKey, sourceBytes)
  bucket.set(currentKey, currentBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, 'meta', sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, currentKey, 'meta', currentBytes)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
    latestSnapshotSeq: 2,
    latestSnapshotKey: currentKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:rollback-meta-current', {
    docId: 'meta',
    seq: 2,
    messageId: 'rollback-meta-current',
    deviceId: 'device-1',
    updateBytes: currentBytes,
    updateSha256: await hashTestBytes(currentBytes),
    createdAt: 2,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: { kind: 'meta' },
        snapshotKey: sourceKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Rollback grouped metadata to the last verified generation',
        confirmation: 'rollback',
      }),
    }),
  )

  assert.equal(response.status, 200)
  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, { kind: 'meta' })
  const coldMeta = coldRoom.docs.get('meta')
  assert(coldMeta)
  for (const value of coldMeta.getMap('meta').values()) {
    assert(value instanceof Y.Map)
  }
})

test('rollback refuses to overwrite an existing target key', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-target-conflict')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const targetKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-target-source'))
  const existingBytes = makeYjsUpdateBytes(makeMessageId('rollback-target-existing'))
  bucket.set(sourceKey, sourceBytes)
  bucket.set(targetKey, existingBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Do not overwrite an immutable target generation',
        confirmation: 'rollback',
      }),
    }),
  )

  assert.equal(response.status, 409)
  const persisted = await bucket.get(targetKey)
  assert(persisted)
  assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), existingBytes)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, sourceKey)
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('rollback pointer failure leaves the orphan target out of cold hydration', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-pointer-failure')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-pointer-source'))
  bucket.set(sourceKey, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  storage.sql.failOnQueryIncludes = 'update docs'
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Pointer failure must not authorize an orphan object',
        confirmation: 'rollback',
      }),
    }),
  )
  storage.sql.failOnQueryIncludes = undefined

  assert.equal(response.status, 500)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, sourceKey)
  const run = [...storage.sql.checkpointRuns.values()].at(-1)
  assert.equal(run?.status, 'failed')
  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const cold = coldRoom.docs.get(`file:${ydocId}`)
  assert(cold)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, sourceBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(cold), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('rollback rejects candidate and failed-run source generations at the API boundary', async () => {
  for (const sourceState of ['candidate', 'failed'] as const) {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId(`ydoc-rollback-${sourceState}`)
    const docId = { kind: 'file' as const, ydocId }
    const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const sourceBytes = makeYjsUpdateBytes(makeMessageId(`rollback-${sourceState}-source`))
    bucket.set(sourceKey, sourceBytes)
    await seedVerifiedSnapshotEvidence(
      storage,
      sourceKey,
      `file:${ydocId}`,
      sourceBytes,
      sourceState === 'candidate' ? 'candidate' : 'authoritative',
    )
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: 1,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    if (sourceState === 'failed') {
      storage.sql.checkpointRuns.set('rollback-failed-source', {
        runId: 'rollback-failed-source',
        docId: `file:${ydocId}`,
        upperSeq: 1,
        snapshotKey: sourceKey,
        stateVector: new Uint8Array(),
        status: 'failed',
        createdAt: 1,
        r2WrittenAt: undefined,
        pointerUpdatedAt: undefined,
        compactedAt: undefined,
      })
    }
    const room = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/rollback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey: sourceKey,
          upperSeq: 1,
          reason: 'Reject uncommitted rollback sources',
          confirmation: 'rollback',
        }),
      }),
    )
    assert.equal(response.status, 409, sourceState)
    assert.equal(storage.sql.checkpointRuns.size, sourceState === 'failed' ? 1 : 0)
  }
})

test('rollback serializes a concurrent append at the document write queue', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId('ydoc-rollback-append-queue')
    const docId = { kind: 'file' as const, ydocId }
    const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-append-source'))
    bucket.set(sourceKey, sourceBytes)
    await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: sourceKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    let releaseSourceRead: () => void = () => {}
    const sourceReadGate = new Promise<void>((resolve) => {
      releaseSourceRead = resolve
    })
    let sourceReads = 0
    let notifySourceRead: () => void = () => {}
    const sourceReadStarted = new Promise<void>((resolve) => {
      notifySourceRead = resolve
    })
    bucket.beforeGet = async (key) => {
      if (key !== sourceKey || sourceReads > 0) return
      sourceReads += 1
      notifySourceRead()
      await sourceReadGate
    }
    const rollbackRequest = room.fetch(
      new Request('https://worker.example/admin/snapshots/rollback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey: sourceKey,
          upperSeq: 1,
          reason: 'Serialize rollback with a concurrent append',
          confirmation: 'rollback',
        }),
      }),
    )
    await sourceReadStarted

    let appendSettled = false
    const appendUpdate = {
      ...makeSyncUpdate(makeMessageId('rollback-append-after')),
      docId,
    }
    const append = room.webSocketMessage(server, JSON.stringify(appendUpdate)).finally(() => {
      appendSettled = true
    })
    await Promise.resolve()
    assert.equal(appendSettled, false)

    releaseSourceRead()
    const rollbackResponse = await rollbackRequest
    await append
    assert.equal(rollbackResponse.status, 200)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get(`file:${ydocId}:${appendUpdate.messageId}`)?.seq, 3)

    const targetKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
    const target = await bucket.get(targetKey)
    assert(target)
    const rollbackDoc = new Y.Doc()
    Y.applyUpdate(rollbackDoc, new Uint8Array(await target.arrayBuffer()))
    const expected = new Y.Doc()
    Y.applyUpdate(expected, sourceBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(rollbackDoc), Y.encodeStateAsUpdate(expected))
    rollbackDoc.destroy()
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('rollback linearizes before a queued source quarantine', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-quarantine-race')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-quarantine-source'))
  bucket.set(sourceKey, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  let sourceReads = 0
  let quarantineRequest: Promise<Response> | undefined
  bucket.beforeGet = async (key) => {
    if (key !== sourceKey) return
    sourceReads += 1
    if (sourceReads !== 2) return
    quarantineRequest = Promise.resolve(
      room.fetch(
        new Request('https://worker.example/admin/snapshots/quarantine', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            docId,
            snapshotKey: sourceKey,
            upperSeq: 1,
            reason: 'Source quarantined during rollback construction',
            confirmation: 'quarantine',
          }),
        }),
      ),
    )
  }

  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Do not commit a rollback from a quarantined source',
        confirmation: 'rollback',
      }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(
    storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey,
    `snapshots/vault-1/files/${ydocId}/2.yupdate`,
  )
  assert(quarantineRequest)
  const quarantine = await quarantineRequest
  assert.equal(quarantine.status, 200)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'quarantined')
  assert.equal(
    storage.sql.snapshotHealthEvents.some(
      (event) => event.snapshotKey !== sourceKey && event.event === 'rollback',
    ),
    true,
  )
})

test('rollback keeps the last healthy source when quarantine is rejected first', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-quarantine-first')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-quarantine-first-source'))
  bucket.set(sourceKey, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const quarantine = await room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Quarantine source before rollback admission',
        confirmation: 'quarantine',
      }),
    }),
  )
  assert.equal(quarantine.status, 409)

  const rollback = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Do not roll back from quarantined source',
        confirmation: 'rollback',
      }),
    }),
  )
  assert.equal(rollback.status, 200)
  assert.equal(
    storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey,
    `snapshots/vault-1/files/${ydocId}/2.yupdate`,
  )
})

test('rollback refreshes state after an in-flight stale hydration settles', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId('ydoc-rollback-hydration-race')
    const docId = { kind: 'file' as const, ydocId }
    const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-hydration-source'))
    bucket.set(sourceKey, sourceBytes)
    await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: sourceKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    let releaseHydration: () => void = () => {}
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    let hydrationReadStarted: () => void = () => {}
    const hydrationStarted = new Promise<void>((resolve) => {
      hydrationReadStarted = resolve
    })
    let firstSourceRead = true
    bucket.beforeGet = async (key) => {
      if (key !== sourceKey || !firstSourceRead) return
      firstSourceRead = false
      hydrationReadStarted()
      await hydrationGate
    }
    const staleHydration = ensureDocHydrated(room, docId)
    await hydrationStarted

    const rollbackPromise = room.fetch(
      new Request('https://worker.example/admin/snapshots/rollback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey: sourceKey,
          upperSeq: 1,
          reason: 'Refresh after stale hydration settles',
          confirmation: 'rollback',
        }),
      }),
    )
    await Promise.resolve()
    releaseHydration()
    await staleHydration
    const rollbackResponse = await rollbackPromise
    assert.equal(rollbackResponse.status, 200)

    const targetKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
    const active = room.docs.get(`file:${ydocId}`)
    assert(active)
    const expected = new Y.Doc()
    Y.applyUpdate(expected, sourceBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(active), Y.encodeStateAsUpdate(expected))

    const appendUpdate = { ...makeSyncUpdate(makeMessageId('rollback-hydration-append')), docId }
    await room.webSocketMessage(server, JSON.stringify(appendUpdate))
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSeq, 3)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, targetKey)
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('snapshot health inspection paginates newest generations in descending order', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-pagination')
  for (const seq of [1, 2, 3]) {
    const key = `snapshots/vault-1/files/${ydocId}/${seq}.yupdate`
    const bytes = makeYjsUpdateBytes(makeMessageId(`health-pagination-${seq}`))
    bucket.set(key, bytes)
    await seedVerifiedSnapshotEvidence(storage, key, `file:${ydocId}`, bytes)
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const unauthenticated = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=1`),
  )
  assert.equal(unauthenticated.status, 401)
  const first = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(first.status, 200)
  const firstBody = (await first.json()) as {
    entries: readonly [{ actor: string; upperSeq: number }]
    nextCursor: string
  }
  assert.equal(firstBody.entries[0]?.upperSeq, 3)
  assert.equal(firstBody.entries[0]?.actor, 'system:verifier')
  const second = await room.fetch(
    new Request(
      `https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=1&cursor=${firstBody.nextCursor}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  )
  assert.equal(second.status, 200)
  const secondBody = (await second.json()) as { entries: readonly [{ upperSeq: number }] }
  assert.equal(secondBody.entries[0]?.upperSeq, 2)
})

test('snapshot health verify rejects out-of-range and incomplete-run generations', async () => {
  const cases = [
    { name: 'future', latestSeq: 1, minRetainedSeq: 0, upperSeq: 2, status: undefined },
    { name: 'below-floor', latestSeq: 3, minRetainedSeq: 2, upperSeq: 1, status: undefined },
    { name: 'r2-written', latestSeq: 2, minRetainedSeq: 0, upperSeq: 2, status: 'r2-written' },
    { name: 'failed-run', latestSeq: 2, minRetainedSeq: 0, upperSeq: 2, status: 'failed' },
  ] as const
  for (const testCase of cases) {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId(`ydoc-verify-${testCase.name}`)
    const docId = { kind: 'file' as const, ydocId }
    const snapshotKey = `snapshots/vault-1/files/${ydocId}/${testCase.upperSeq}.yupdate`
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId(`verify-${testCase.name}`))
    bucket.set(snapshotKey, snapshotBytes)
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: testCase.latestSeq,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: testCase.minRetainedSeq,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    if (testCase.status !== undefined) {
      storage.sql.checkpointRuns.set(`verify-${testCase.name}`, {
        runId: `verify-${testCase.name}`,
        docId: `file:${ydocId}`,
        upperSeq: testCase.upperSeq,
        snapshotKey,
        stateVector: new Uint8Array(),
        status: testCase.status,
        createdAt: 1,
        r2WrittenAt: undefined,
        pointerUpdatedAt: undefined,
        compactedAt: undefined,
      })
    }
    const room = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey,
          upperSeq: testCase.upperSeq,
          reason: 'Reject unverifiable authority transitions',
          confirmation: 'verify',
        }),
      }),
    )
    assert.equal(response.status, 409, testCase.name)
    assert.equal(storage.sql.snapshotHealthEvents.length, 0, testCase.name)
  }
})

test('snapshot health list keeps latest rows after high-volume audit history', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-high-volume')
  const key1 = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const key2 = `snapshots/vault-1/files/${ydocId}/2.yupdate`
  const bytes1 = makeYjsUpdateBytes(makeMessageId('health-high-volume-1'))
  const bytes2 = makeYjsUpdateBytes(makeMessageId('health-high-volume-2'))
  bucket.set(key1, bytes1)
  bucket.set(key2, bytes2)
  await seedVerifiedSnapshotEvidence(storage, key1, `file:${ydocId}`, bytes1)
  await seedVerifiedSnapshotEvidence(storage, key2, `file:${ydocId}`, bytes2)
  const latest = storage.sql.snapshotHealthEvents.at(-1)
  assert(latest)
  for (let index = 0; index < 8_300; index += 1) {
    storage.sql.snapshotHealthEvents.push({
      ...latest,
      id: storage.sql.snapshotHealthEvents.length + 1,
      snapshotKey: key2,
      upperSeq: 2,
      event: 'verification',
      observedAt: index + 2,
    })
  }
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 2,
    latestSnapshotKey: key2,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=2`, {
      headers: { Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}` },
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly entries: readonly { snapshotKey: string; upperSeq: number }[]
  }
  assert.deepEqual(
    body.entries.map((entry) => entry.snapshotKey),
    [key2, key1],
  )
  assert.equal(body.entries[0]?.upperSeq, 2)
})

test('snapshot health list normalizes legacy zero-seq orphan rows from key and run evidence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-legacy-orphan')
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/4.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('health-legacy-orphan'))
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  const legacy = storage.sql.snapshotHealthEvents.at(-1)
  assert(legacy)
  storage.sql.snapshotHealthEvents[storage.sql.snapshotHealthEvents.length - 1] = {
    ...legacy,
    upperSeq: 0,
  }
  storage.sql.checkpointRuns.set('legacy-orphan-run', {
    runId: 'legacy-orphan-run',
    docId: `file:${ydocId}`,
    upperSeq: 4,
    snapshotKey,
    stateVector: new Uint8Array(),
    status: 'completed',
    createdAt: 1,
    r2WrittenAt: 1,
    pointerUpdatedAt: 1,
    compactedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}`, {
      headers: { Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}` },
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly entries: readonly { upperSeq: number }[]
  }
  assert.equal(body.entries[0]?.upperSeq, 4)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.upperSeq, 4)
})

test('snapshot health verify rejects an untracked legacy generation without a checkpoint run', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-legacy-no-run')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-legacy-no-run'))
  bucket.set(snapshotKey, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Approve a legacy generation within the replay horizon',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 409)
  assert.equal(storage.sql.snapshotHealthEvents.length, 0)
})

test('snapshot health verify preserves live op-log state for an untracked legacy object', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-legacy-oplog')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-legacy-oplog-object'))
  const liveUpdate = makeYjsUpdateBytes(makeMessageId('verify-legacy-oplog-live'))
  bucket.set(snapshotKey, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:verify-legacy-oplog-live`, {
    docId: `file:${ydocId}`,
    seq: 1,
    messageId: 'verify-legacy-oplog-live',
    deviceId: 'device-1',
    updateBytes: liveUpdate,
    updateSha256: await hashTestBytes(liveUpdate),
    createdAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Untracked bytes cannot replace the live op-log boundary',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 409)
  assert.equal(storage.sql.snapshotHealthEvents.length, 0)

  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const hydrated = coldRoom.docs.get(`file:${ydocId}`)
  assert(hydrated)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, liveUpdate)
  assert.deepEqual(Y.encodeStateAsUpdate(hydrated), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('snapshot health verify recovers an R2-only generation into a cold room', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-r2-only')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/7.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-r2-only'))
  bucket.set(snapshotKey, snapshotBytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const coldBeforeVerify = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldBeforeVerify.vaultId = makeVaultId('vault-1')
  let coldHydrationFailed = false
  try {
    await ensureDocHydrated(coldBeforeVerify, docId)
  } catch (error) {
    coldHydrationFailed =
      error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(coldHydrationFailed, true)
  assert.equal(coldBeforeVerify.hydratedDocs.has(`file:${ydocId}`), false)
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const list = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(list.status, 200)
  room.docs.set(`file:${ydocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${ydocId}`)
  const verify = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 7,
        reason: 'Recover a verified R2-only generation',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(verify.status, 200)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, snapshotKey)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.actor, 'device-1')
  const recoveredInRoom = room.docs.get(`file:${ydocId}`)
  assert(recoveredInRoom)
  const recoveredExpected = new Y.Doc()
  Y.applyUpdate(recoveredExpected, snapshotBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(recoveredInRoom), Y.encodeStateAsUpdate(recoveredExpected))
  recoveredExpected.destroy()
  const eventCountAfterVerify = storage.sql.snapshotHealthEvents.length
  const repeatedVerify = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 7,
        reason: 'Repeated approval is idempotent',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(repeatedVerify.status, 200)
  assert.equal(storage.sql.snapshotHealthEvents.length, eventCountAfterVerify)

  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const hydrated = coldRoom.docs.get(`file:${ydocId}`)
  assert(hydrated)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, snapshotBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(hydrated), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('snapshot health verify fails closed for a concurrent first append during pending recovery', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId('ydoc-verify-concurrent-append')
    const docId = { kind: 'file' as const, ydocId }
    const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-concurrent-snapshot'))
    bucket.set(snapshotKey, snapshotBytes)
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    let releaseVerification: () => void = () => {}
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve
    })
    let verificationStarted: () => void = () => {}
    const verificationStartedPromise = new Promise<void>((resolve) => {
      verificationStarted = resolve
    })
    bucket.beforeGet = async (key) => {
      if (key !== snapshotKey) return
      verificationStarted()
      await verificationGate
      bucket.beforeGet = undefined
    }
    const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
    const verifyRequest = room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'Concurrent append must remain durable',
          confirmation: 'verify',
        }),
      }),
    )
    await verificationStartedPromise
    const appendUpdate = { ...makeSyncUpdate(makeMessageId('verify-concurrent-append')), docId }
    await room.webSocketMessage(server, JSON.stringify(appendUpdate))
    assert.equal(server.closed, true)
    assert.equal(storage.sql.docs.has(`file:${ydocId}`), false)
    releaseVerification()
    const verifyResponse = await verifyRequest
    assert.equal(verifyResponse.status, 200)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSeq, 1)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, snapshotKey)
    assert.equal(storage.sql.opLog.get(`file:${ydocId}:${appendUpdate.messageId}`), undefined)
    assert.equal(
      storage.sql.snapshotHealthEvents.some((event) => event.event === 'approval'),
      true,
    )
    const coldRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    coldRoom.vaultId = makeVaultId('vault-1')
    await ensureDocHydrated(coldRoom, docId)
    const cold = coldRoom.docs.get(`file:${ydocId}`)
    assert(cold)
    const expected = new Y.Doc()
    Y.applyUpdate(expected, snapshotBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(cold), Y.encodeStateAsUpdate(expected))
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('snapshot health verify rejects when quarantine commits during the pending read', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-quarantine-pending')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  bucket.set(snapshotKey, makeYjsUpdateBytes(makeMessageId('verify-quarantine-pending')))
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  let releaseVerification: () => void = () => {}
  const verificationGate = new Promise<void>((resolve) => {
    releaseVerification = resolve
  })
  let verificationStarted: () => void = () => {}
  const verificationStartedPromise = new Promise<void>((resolve) => {
    verificationStarted = resolve
  })
  bucket.beforeGet = async (key) => {
    if (key !== snapshotKey) return
    verificationStarted()
    await verificationGate
    bucket.beforeGet = undefined
  }
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const verifyRequest = room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Quarantine must win while verification is reading R2',
        confirmation: 'verify',
      }),
    }),
  )
  await verificationStartedPromise
  const quarantineRequest = room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Operator quarantine during pending verification',
        confirmation: 'quarantine',
      }),
    }),
  )
  releaseVerification()
  const [verifyResponse, quarantineResponse] = await Promise.all([
    Promise.resolve(verifyRequest),
    Promise.resolve(quarantineRequest),
  ])
  assert.equal(quarantineResponse.status, 200)
  assert.equal(verifyResponse.status, 409)
  assert.deepEqual(await verifyResponse.json(), {
    code: 'request/conflict',
    retryable: false,
    detail: 'snapshot-health-quarantined',
  })
  assert.equal(storage.sql.docs.has(`file:${ydocId}`), false)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'quarantined')
  assert.equal(
    storage.sql.snapshotHealthEvents.some((event) => event.event === 'approval'),
    false,
  )
})

test('hydration ignores R2-only candidate evidence without durable authority', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-uncommitted-candidate')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('uncommitted-snapshot'))
  const durableUpdate = makeYjsUpdateBytes(makeMessageId('durable-op'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(
    storage,
    snapshotKey,
    `file:${ydocId}`,
    snapshotBytes,
    'candidate',
  )
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:durable-op`, {
    docId: `file:${ydocId}`,
    seq: 1,
    messageId: 'durable-op',
    deviceId: 'device-1',
    updateBytes: durableUpdate,
    updateSha256: await hashTestBytes(durableUpdate),
    createdAt: 1,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))
  room.vaultId = makeVaultId('vault-1')

  await ensureDocHydrated(room, docId)
  const hydrated = room.docs.get(`file:${ydocId}`)
  assert(hydrated)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, durableUpdate)
  assert.deepEqual(Y.encodeStateAsUpdate(hydrated), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('hydration rejects an authoritative candidate below the retained floor', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-below-retained-floor')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('below-retained-floor'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 2,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    failed = error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(failed, true)
})

test('health quarantine is idempotently blocked for the last healthy generation', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-history-latest')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const bytes = makeYjsUpdateBytes(makeMessageId('health-history-latest'))
  bucket.set(snapshotKey, bytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, bytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const seed = storage.sql.snapshotHealthEvents.at(-1)
  assert(seed)
  for (let index = 0; index < 260; index += 1) {
    storage.sql.snapshotHealthEvents.push({
      ...seed,
      id: storage.sql.snapshotHealthEvents.length + 1,
      event: 'verification',
      observedAt: index + 2,
    })
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const quarantineResponse = await room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'latest audit verdict must win',
        confirmation: 'quarantine',
      }),
    }),
  )
  assert.equal(quarantineResponse.status, 409)
  await ensureDocHydrated(room, docId)
  assert(room.docs.get(`file:${ydocId}`))
})

test('hydration preserves the last healthy generation when quarantine races R2 verification', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-quarantine-race')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const bytes = makeYjsUpdateBytes(makeMessageId('health-quarantine-race'))
  bucket.set(snapshotKey, bytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, bytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  let quarantined = false
  bucket.beforeGet = async (key) => {
    if (key !== snapshotKey || quarantined) return
    quarantined = true
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/quarantine', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'quarantine raced physical verification',
          confirmation: 'quarantine',
        }),
      }),
    )
    assert.equal(response.status, 409)
  }
  await ensureDocHydrated(room, docId)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
})

test('snapshot health verify is idempotent for an already authoritative generation', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-quarantine-race')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-quarantine-race'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const eventCount = storage.sql.snapshotHealthEvents.length

  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Do not approve after quarantine wins',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(storage.sql.snapshotHealthEvents.length, eventCount)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
})

test('VaultRoom validates client hello against the SQL device registry', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.sql.devices.delete('device-1')
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.equal(server.closed, true)
    assert.equal(server.closeCode, 1008)
    assert.equal(server.closeReason, 'auth-reject:unknown-device')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom grants grouped metadata write access only to clients advertising v2', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify({ ...makeHello(), capabilities: [] }))

    const helloAcceptedRaw = server.sent[0]
    if (typeof helloAcceptedRaw !== 'string') throw new Error('missing hello-accepted frame')
    const helloAccepted = JSON.parse(helloAcceptedRaw) as { metadataAccess?: string }
    assert.equal(helloAccepted.metadataAccess, 'read-only')
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const modernServer = state.accepted[1]
    assert(modernServer instanceof FakeSocket)
    await room.webSocketMessage(modernServer, JSON.stringify(makeHello()))
    const modernHelloAcceptedRaw = modernServer.sent[0]
    if (typeof modernHelloAcceptedRaw !== 'string') {
      throw new Error('missing modern hello-accepted frame')
    }
    const modernHelloAccepted = JSON.parse(modernHelloAcceptedRaw) as {
      metadataAccess?: string
    }
    assert.equal(modernHelloAccepted.metadataAccess, 'read-write')
    await room.webSocketMessage(
      server,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-legacy-meta-write')),
        updateSha256: undefined,
      }),
    )
    assert.equal(server.closeReason, 'metadata-read-only')
    assert.equal(storage.sql.opLog.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom admits a hello advertising an unrecognized optional capability (DR-012)', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(
      server,
      JSON.stringify({
        ...makeHello(),
        capabilities: ['metadata-schema-v2', 'future-capability'],
      }),
    )

    assert.equal(server.closed, false)
    const helloAcceptedRaw = server.sent[0]
    if (typeof helloAcceptedRaw !== 'string') throw new Error('missing hello-accepted frame')
    const helloAccepted = JSON.parse(helloAcceptedRaw) as { metadataAccess?: string }
    assert.equal(helloAccepted.metadataAccess, 'read-write')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines live v1-to-v2 migration updates instead of appending them', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const fileId = makeFileId('live-v1-root')
    const legacy = new Y.Doc()
    legacy.getMap('meta').set(fileId, {
      schemaVersion: 1,
      fileId,
      path: 'Notes/Legacy.md',
      canonicalPath: 'notes/legacy.md',
      type: 'text',
      ydocId: makeYDocId('live-v1-doc'),
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('device-1'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('device-1'),
      updatedAt: 1,
      updatedBy: makeDeviceId('device-1'),
      mtime: 1,
    })
    room.docs.set('meta', legacy)
    room.hydratedDocs.add('meta')
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 0,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      latestStateVector: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const migrated = new Y.Doc()
    Y.applyUpdate(migrated, Y.encodeStateAsUpdate(legacy))
    const child = new Y.Map<unknown>()
    child.set('identity', {
      schemaVersion: 2,
      fileId,
      type: 'text',
      ydocId: makeYDocId('live-v1-doc'),
      createdAt: 1,
      createdBy: makeDeviceId('device-1'),
    })
    child.set('location', {
      path: 'Notes/Legacy.md',
      canonicalPath: 'notes/legacy.md',
      updatedAt: 1,
      updatedBy: makeDeviceId('device-1'),
      mtime: 1,
    })
    child.set('content', { contentUpdatedAt: 1, contentUpdatedBy: makeDeviceId('device-1') })
    child.set('deletion', { deleted: false })
    migrated.getMap('meta').set(fileId, child)
    const update = Y.encodeStateAsUpdate(migrated, Y.encodeStateVector(legacy))
    const message = {
      ...makeSyncUpdate(makeMessageId('live-v1-to-v2')),
      docId: { kind: 'meta' as const },
      update: Buffer.from(update).toString('base64'),
    }
    await room.webSocketMessage(server, JSON.stringify(message))
    assert.equal(storage.sql.opLog.size, 0)
    assert.equal(
      storage.sql.quarantines.get(`q-${message.messageId}`)?.reason,
      'meta-schema-invalid',
    )
    migrated.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines live metadata updates when the current document is poisoned', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const poisoned = makePoisonedMetaDoc(makeFileId('poisoned-live-meta'))
    room.docs.set('meta', poisoned)
    room.hydratedDocs.add('meta')
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 0,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      latestStateVector: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const beforeStateVector = Y.encodeStateVector(poisoned)
    const message = {
      ...makeSyncUpdate(makeMessageId('message-poisoned-live-meta')),
      update: makeYjsUpdateBase64(makeMessageId('poisoned-live-v2-root')),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(message))

    assert.equal(storage.sql.opLog.size, 0)
    assert.equal(storage.sql.messageDedup.size, 0)
    assert.equal(
      storage.sql.quarantines.get(`q-${message.messageId}`)?.reason,
      'meta-schema-invalid',
    )
    assert.deepEqual(Y.encodeStateVector(poisoned), beforeStateVector)
    assert.equal(metaYDocSchemaDisposition(poisoned), 'invalid')
    assert.equal(room.docs.get('meta'), poisoned)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom accepts a v1 migration delta against an empty sequence-0 snapshot', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const fileId = makeFileId('seq-zero-migration')
  const legacyFile = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Notes/Legacy.md',
    canonicalPath: 'notes/legacy.md',
    type: 'text' as const,
    ydocId: makeYDocId('seq-zero-migration-doc'),
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  }
  const legacy = new Y.Doc()
  legacy.getMap('meta').set(fileId, legacyFile)
  room.docs.set('meta', legacy)
  room.hydratedDocs.add('meta')
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 0,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    latestStateVector: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })

  const migrated = new Y.Doc()
  Y.applyUpdate(migrated, Y.encodeStateAsUpdate(legacy))
  const grouped = groupedEntryFromMetaFile(legacyFile)
  const groupedMap = new Y.Map<unknown>()
  groupedMap.set('identity', grouped.identity)
  groupedMap.set('location', grouped.location)
  groupedMap.set('content', grouped.content)
  groupedMap.set('deletion', grouped.deletion)
  migrated.getMap('meta').set(fileId, groupedMap)
  const migrationDelta = Y.encodeStateAsUpdate(migrated, Y.encodeStateVector(legacy))
  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(legacy))
  Y.applyUpdate(candidate, migrationDelta)
  assert.equal(metaYDocWritable(candidate), true)
  assert.equal(metaIdentityImmutable(legacy, candidate), true)
  assert.equal(metaRootMutationAllowed(legacy, migrationDelta, true), true)
  candidate.destroy()
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(migrationDelta).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
  assert.equal(bucket.puts.length, 1)
  migrated.destroy()
  legacy.destroy()
})

test('metadata read-only sessions still append file YDoc updates', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify({ ...makeHello(), capabilities: [] }))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-read-only-file')),
      docId: { kind: 'file', ydocId: makeYDocId('read-only-file') },
    }
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(server.closed, false)
    assert.ok(findAckForMessage(server.sent, update.messageId))
    assert.equal(storage.sql.opLog.has(`file:${update.docId.ydocId}:${update.messageId}`), true)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks revoked devices before normal sync', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const reinstalled = state.accepted[0]
    const revoked = state.accepted[1]
    assert(reinstalled instanceof FakeSocket)
    assert(revoked instanceof FakeSocket)

    await room.webSocketMessage(reinstalled, JSON.stringify(makeHello()))
    storage.sql.devices.set('device-1', {
      deviceId: 'device-1',
      tokenVersion: 1,
      revokedAt: 50,
    })
    await room.webSocketMessage(revoked, JSON.stringify(makeHello()))

    assert.equal(revoked.closeCode, 1008)
    assert.equal(revoked.closeReason, 'auth-reject:device-revoked')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects sync messages that do not match the accepted hello identity', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-mismatch')),
        deviceId: makeDeviceId('device-2'),
      }),
    )

    assert.equal(server.closeCode, 1008)
    assert.equal(server.closeReason, 'session-mismatch')
    assert.equal(storage.sql.opLog.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires a valid signed device token when WS auth is configured', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const secret = 'test-device-token-secret'
    const token = await makeDeviceToken(secret)
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(secret))
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
    )
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )
    const authorized = state.accepted[0]
    const missingToken = state.accepted[1]
    assert(authorized instanceof FakeSocket)
    assert(missingToken instanceof FakeSocket)

    await room.webSocketMessage(authorized, JSON.stringify(makeHello()))
    await room.webSocketMessage(missingToken, JSON.stringify(makeHello()))

    assert.equal(authorized.closed, false)
    assert.equal(missingToken.closeCode, 1008)
    assert.equal(missingToken.closeReason, 'auth-reject:missing-token')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom accepts browser-compatible WebSocket token transports', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const secret = 'test-device-token-secret'
    const queryToken = await makeDeviceToken(secret)
    const protocolToken = await makeDeviceToken(secret)
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(secret))
    void room.fetch(
      new Request(`https://worker.example/ws/vault-1?access_token=${queryToken}`, {
        headers: { Upgrade: 'websocket' },
      }),
    )
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': `kuroflare.v1, ${protocolToken}`,
        },
      }),
    )
    const querySocket = state.accepted[0]
    const protocolSocket = state.accepted[1]
    assert(querySocket instanceof FakeSocket)
    assert(protocolSocket instanceof FakeSocket)

    await room.webSocketMessage(querySocket, JSON.stringify(makeHello()))
    await room.webSocketMessage(protocolSocket, JSON.stringify(makeHello()))

    assert.equal(querySocket.closed, false)
    assert.equal(protocolSocket.closed, false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when SQL device auth is configured without a token secret', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnv())
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.equal(server.closed, true)
    assert.equal(server.closeReason, 'auth-reject:missing-secret')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom applies signed token scopes and tokenVersion to hello admission', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const secret = 'test-device-token-secret'
    const storage = new SqlOnlyStorage()
    storage.sql.devices.set('device-1', {
      deviceId: 'device-1',
      tokenVersion: 2,
      revokedAt: undefined,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(secret))
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${await makeDeviceToken(secret, { tokenVersion: 1 })}`,
        },
      }),
    )
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${await makeDeviceToken(secret, { scope: ['sync:read'] })}`,
        },
      }),
    )
    const staleToken = state.accepted[0]
    const missingScope = state.accepted[1]
    assert(staleToken instanceof FakeSocket)
    assert(missingScope instanceof FakeSocket)

    await room.webSocketMessage(staleToken, JSON.stringify(makeHello()))
    await room.webSocketMessage(missingScope, JSON.stringify(makeHello()))

    assert.equal(staleToken.closeCode, 1008)
    assert.equal(staleToken.closeReason, 'auth-reject:stale-token')
    assert.equal(missingScope.closeCode, 1008)
    assert.equal(missingScope.closeReason, 'auth-reject:missing-scope')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires hello before sync updates', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState()
    const room = new VaultRoom(state, makeEnv())
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeSyncUpdate(makeMessageId('message-1'))))

    assert.equal(server.closed, true)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines invalid Yjs updates without acking or broadcasting', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-bad')),
      update: 'AQID',
    } satisfies SyncUpdate
    await room.webSocketMessage(firstServer, JSON.stringify(update))

    assert.deepEqual(JSON.parse(stringMessageAt(firstServer.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'yjs-apply-failed',
      retryable: false,
    })
    assert.equal(syncMessages(firstServer.sent).length, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [])
    const quarantined = storage.sql.quarantines.get('q-message-bad')
    assert(quarantined)
    assert.equal(Number.isSafeInteger(quarantined.createdAt), true)
    assert.deepEqual(quarantined, {
      id: 'q-message-bad',
      docId: 'meta',
      messageId: makeMessageId('message-bad'),
      deviceId: makeDeviceId('device-1'),
      reason: 'yjs-apply-failed',
      updateSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      updateBytes: Uint8Array.from([1, 2, 3]),
      createdAt: quarantined.createdAt,
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines updates with mismatched wire hashes', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-hash-mismatch')),
      updateSha256: makeSha256Hex('0'.repeat(64)),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'hash-mismatch',
      retryable: false,
    })
    assert.equal(syncMessages(server.sent).length, 1)
    assert.equal(storage.sql.opLog.has('meta:message-hash-mismatch'), false)
    assert.equal(storage.sql.quarantines.get('q-message-hash-mismatch')?.reason, 'hash-mismatch')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom treats repeated quarantine inserts as idempotent', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-repeat-bad')),
      update: 'AQID',
    } satisfies SyncUpdate
    const invalidUpdate = JSON.stringify(update)

    await room.webSocketMessage(server, invalidUpdate)
    await room.webSocketMessage(server, invalidUpdate)

    const expectedRejection = {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'yjs-apply-failed',
      retryable: false,
    }
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 0)), expectedRejection)
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 1)), expectedRejection)
    assert.equal(syncMessages(server.sent).length, 2)
    assert.equal(server.closed, false)
    assert.equal(storage.sql.quarantines.get('q-message-repeat-bad')?.reason, 'yjs-apply-failed')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines meta updates that fail MetaFile schema validation', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-bad-meta')),
      update: makeInvalidMetaSchemaYjsUpdateBase64(),
    } satisfies SyncUpdate
    await room.webSocketMessage(firstServer, JSON.stringify(update))

    assert.deepEqual(JSON.parse(stringMessageAt(firstServer.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'meta-schema-invalid',
      retryable: false,
    })
    assert.equal(syncMessages(firstServer.sent).length, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [])
    const quarantined = storage.sql.quarantines.get('q-message-bad-meta')
    assert(quarantined)
    assert.equal(quarantined.reason, 'meta-schema-invalid')
    assert.equal(quarantined.docId, 'meta')
    assert.equal(quarantined.messageId, makeMessageId('message-bad-meta'))
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom exposes authenticated quarantine list and detail inspection', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.quarantines.set('q-message-bad', {
    id: 'q-message-bad',
    docId: 'meta',
    messageId: 'message-bad',
    deviceId: 'device-1',
    reason: 'yjs-apply-failed',
    updateSha256: 'a'.repeat(64),
    updateBytes: Uint8Array.from([1, 2, 3]),
    createdAt: 123,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const listResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(listResponse.status, 200)
  const listBody = await listResponse.json()
  assert.equal(v.is(QuarantinedUpdateListResponseSchema, listBody), true)
  assert.deepEqual(listBody, {
    items: [
      {
        id: 'q-message-bad',
        docId: { kind: 'meta' },
        messageId: 'message-bad',
        deviceId: 'device-1',
        reason: 'yjs-apply-failed',
        updateSha256: 'a'.repeat(64),
        updateBytesLength: 3,
        createdAt: 123,
      },
    ],
  })

  const detailResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-message-bad', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(detailResponse.status, 200)
  const detailBody = await detailResponse.json()
  assert.equal(v.is(QuarantinedUpdateDetailResponseSchema, detailBody), true)
  assert.deepEqual(detailBody, {
    entry: listBody.items[0],
    updateBytesBase64: 'AQID',
  })

  const missingResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-missing', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )
  assert.equal(missingResponse.status, 404)
  assert.deepEqual(await missingResponse.json(), {
    code: 'request/not-found',
    retryable: false,
    detail: 'unknown-quarantine',
  })
})

test('GET /admin/quarantine paginates newest-first with a cursor', async () => {
  const storage = new SqlOnlyStorage()
  for (let index = 1; index <= 3; index += 1) {
    storage.sql.quarantines.set(`q-message-${index}`, {
      id: `q-message-${index}`,
      docId: 'meta',
      messageId: `message-${index}`,
      deviceId: 'device-1',
      reason: 'yjs-apply-failed',
      updateSha256: 'a'.repeat(64),
      updateBytes: Uint8Array.from([index]),
      createdAt: index,
    })
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const firstPage = await room.fetch(
    new Request('https://worker.example/admin/quarantine?limit=2', { headers: authHeader }),
  )
  assert.equal(firstPage.status, 200)
  const firstBody = await firstPage.json()
  assert.equal(v.is(QuarantinedUpdateListResponseSchema, firstBody), true)
  assert.deepEqual(
    firstBody.items.map((entry: { id: string }) => entry.id),
    ['q-message-3', 'q-message-2'],
  )
  assert.equal(firstBody.nextCursor, '2:q-message-2')

  const secondPage = await room.fetch(
    new Request(`https://worker.example/admin/quarantine?limit=2&cursor=${firstBody.nextCursor}`, {
      headers: authHeader,
    }),
  )
  assert.equal(secondPage.status, 200)
  const secondBody = await secondPage.json()
  assert.deepEqual(
    secondBody.items.map((entry: { id: string }) => entry.id),
    ['q-message-1'],
  )
  assert.equal(secondBody.nextCursor, undefined)

  const invalidLimit = await room.fetch(
    new Request('https://worker.example/admin/quarantine?limit=0', { headers: authHeader }),
  )
  assert.equal(invalidLimit.status, 400)
  assert.equal(v.is(ApiErrorSchema, await invalidLimit.json()), true)
})

test('POST /admin/quarantine/:id/force-apply merges the update, advances the op log, and records an audit entry', async () => {
  const storage = new SqlOnlyStorage()
  const state = new FakeState(storage)
  const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
  storage.sql.docs.set('file:force-apply-file', {
    kind: 'file',
    latestSeq: 0,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const source = new Y.Doc()
  source.getText('body').insert(0, 'hello')
  const updateBytes = Y.encodeStateAsUpdate(source)
  storage.sql.quarantines.set('q-force-apply', {
    id: 'q-force-apply',
    docId: 'file:force-apply-file',
    messageId: 'message-force-apply',
    deviceId: 'device-2',
    reason: 'yjs-apply-failed',
    updateSha256: 'a'.repeat(64),
    updateBytes,
    createdAt: 100,
  })
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const dryRun = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-force-apply/force-apply', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dry-run' }),
    }),
  )
  assert.equal(dryRun.status, 200)
  const dryRunBody = await dryRun.json()
  assert.equal(dryRunBody.confirmationRequired, true)
  assert.deepEqual(dryRunBody.effects, [
    { kind: 'quarantine-force-apply', count: 1, detail: 'seq=1' },
  ])

  const execute = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-force-apply/force-apply', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', confirmationToken: dryRunBody.confirmationToken }),
    }),
  )
  assert.equal(execute.status, 200)
  const executeBody = await execute.json()
  assert.equal(executeBody.applied, true)
  assert.deepEqual(executeBody.effects, [
    { kind: 'quarantine-force-apply', count: 1, detail: 'seq=1' },
  ])

  assert.equal(storage.sql.quarantines.has('q-force-apply'), false)
  assert.equal(storage.sql.docs.get('file:force-apply-file')?.latestSeq, 1)
  assert.equal(storage.sql.opLog.has('file:force-apply-file:message-force-apply'), true)
  assert.equal(storage.sql.messageDedup.has('file:force-apply-file:message-force-apply'), true)
  assert.equal(room.docs.get('file:force-apply-file')?.getText('body').toJSON(), 'hello')
  assert.equal(storage.sql.quarantineAuditEvents.length, 1)
  const auditEvent = storage.sql.quarantineAuditEvents[0]
  assert(auditEvent !== undefined)
  assert.deepEqual(auditEvent, {
    id: 1,
    quarantineId: 'q-force-apply',
    docId: 'file:force-apply-file',
    messageId: 'message-force-apply',
    deviceId: 'device-2',
    reason: 'yjs-apply-failed',
    action: 'force-applied-by-admin',
    actor: 'device-1',
    appliedSeq: 1,
    quarantinedAt: 100,
    resolvedAt: auditEvent.resolvedAt,
  })

  // The confirmation token is single-use; replaying it must fail closed.
  const replay = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-force-apply/force-apply', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', confirmationToken: dryRunBody.confirmationToken }),
    }),
  )
  assert.equal(replay.status, 404)
  source.destroy()
})

test('POST /admin/quarantine/:id/discard removes the row and records an audit entry without touching the op log', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.quarantines.set('q-discard', {
    id: 'q-discard',
    docId: 'meta',
    messageId: 'message-discard',
    deviceId: 'device-2',
    reason: 'hash-mismatch',
    updateSha256: 'a'.repeat(64),
    updateBytes: Uint8Array.from([9]),
    createdAt: 200,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const dryRun = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-discard/discard', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dry-run' }),
    }),
  )
  assert.equal(dryRun.status, 200)
  const dryRunBody = await dryRun.json()

  const execute = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-discard/discard', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', confirmationToken: dryRunBody.confirmationToken }),
    }),
  )
  assert.equal(execute.status, 200)

  assert.equal(storage.sql.quarantines.has('q-discard'), false)
  assert.equal(storage.sql.opLog.size, 0)
  assert.equal(storage.sql.quarantineAuditEvents.length, 1)
  assert.equal(storage.sql.quarantineAuditEvents[0]?.action, 'discarded-by-admin')
  assert.equal(storage.sql.quarantineAuditEvents[0]?.actor, 'device-1')
  assert.equal(storage.sql.quarantineAuditEvents[0]?.appliedSeq, undefined)
})

test('GET /admin/quarantine/audit paginates the resolved-quarantine trail newest-first', async () => {
  const storage = new SqlOnlyStorage()
  for (let index = 1; index <= 3; index += 1) {
    storage.sql.quarantineAuditEvents.push({
      id: index,
      quarantineId: `q-${index}`,
      docId: 'meta',
      messageId: `message-${index}`,
      deviceId: 'device-2',
      reason: 'hash-mismatch',
      action: 'discarded-by-admin',
      actor: 'device-1',
      appliedSeq: undefined,
      quarantinedAt: index,
      resolvedAt: index + 100,
    })
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const firstPage = await room.fetch(
    new Request('https://worker.example/admin/quarantine/audit?limit=2', { headers: authHeader }),
  )
  assert.equal(firstPage.status, 200)
  const firstBody = await firstPage.json()
  assert.deepEqual(
    firstBody.items.map((entry: { quarantineId: string }) => entry.quarantineId),
    ['q-3', 'q-2'],
  )
  assert.equal(firstBody.nextCursor, '2')

  const secondPage = await room.fetch(
    new Request(
      `https://worker.example/admin/quarantine/audit?limit=2&cursor=${firstBody.nextCursor}`,
      { headers: authHeader },
    ),
  )
  assert.equal(secondPage.status, 200)
  const secondBody = await secondPage.json()
  assert.deepEqual(
    secondBody.items.map((entry: { quarantineId: string }) => entry.quarantineId),
    ['q-1'],
  )
  assert.equal(secondBody.nextCursor, undefined)
})

test('VaultRoom serves the latest meta snapshot from the production HTTP route', async () => {
  const storage = new SqlOnlyStorage()
  const messageId = makeMessageId('message-meta-snapshot')
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`meta:${messageId}`, {
    docId: 'meta',
    seq: 1,
    messageId,
    deviceId: 'device-1',
    updateBytes: makeYjsUpdateBytes(messageId),
    updateSha256: 'a'.repeat(64),
    createdAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  assert(v.is(MetaLatestSnapshotResponseSchema, body))
  assert.equal(body.snapshotSeq, 1)
  assert.equal(body.manifestSeq, 1)

  const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
  assert(decoded.ok)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, decoded.updateBytes)
  assert.equal(doc.getMap('meta').has(makeFileId('file-message-meta-snapshot')), true)
})

test('VaultRoom serves the latest file snapshot from the production HTTP route', async () => {
  const storage = new SqlOnlyStorage()
  const ydocId = makeYDocId('ydoc-file-snapshot')
  const messageId = makeMessageId('message-file-snapshot')
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:${messageId}`, {
    docId: `file:${ydocId}`,
    seq: 1,
    messageId,
    deviceId: 'device-1',
    updateBytes: makeYjsUpdateBytes(messageId),
    updateSha256: 'a'.repeat(64),
    createdAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request(`https://worker.example/vaults/vault-1/files/${ydocId}/latest`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  assert(v.is(DocLatestSnapshotResponseSchema, body))
  assert.deepEqual(body.docId, { kind: 'file', ydocId })
  assert.equal(body.snapshotSeq, 1)
})

test('VaultRoom refuses to load a new file doc as degraded once the room is at capacity', async () => {
  const storage = new SqlOnlyStorage()
  const ydocId = makeYDocId('ydoc-file-degraded')
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  for (let index = 0; index < MAX_HYDRATED_FILE_DOCS; index += 1) {
    room.hydratedDocs.add(`file:${makeYDocId(`ydoc-padding-${index}`)}`)
  }

  const response = await room.fetch(
    new Request(`https://worker.example/vaults/vault-1/files/${ydocId}/latest`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    code: 'server/degraded',
    retryable: true,
    detail: 'doc-load-degraded',
  })
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom rejects latest snapshot requests without a valid access token', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest'),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    code: 'auth/rejected',
    retryable: false,
    detail: 'auth-reject:invalid-token',
  })
})

test('VaultRoom rejects latest snapshot requests missing the sync:read scope', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
          scope: ['sync:write'],
        })}`,
      },
    }),
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    code: 'auth/rejected',
    retryable: false,
    detail: 'auth-reject:missing-scope',
  })
})

test('VaultRoom returns doc-not-found for a latest snapshot request on an unknown doc', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request(
      `https://worker.example/vaults/vault-1/files/${makeYDocId('ydoc-missing')}/latest`,
      {
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
        },
      },
    ),
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    code: 'snapshot/not-found',
    retryable: false,
    detail: 'doc-not-found',
  })
})

test('VaultRoom logs a structured event when a checkpoint fails', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-checkpoint-fail'))),
    )

    storage.sql.failOnQueryIncludes = 'insert into checkpoint_runs'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let thrown: unknown
    try {
      await room.checkpointDoc({ kind: 'meta' }, 99)
    } catch (error) {
      thrown = error
    }
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert(thrown instanceof Error)
    assert(events.some((event) => event.event === 'checkpoint-start'))
    assert(
      events.some(
        (event) => event.event === 'checkpoint-failed' && typeof event.error === 'string',
      ),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs a structured event when an HTTP request is auth-rejected', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const response = await room.fetch(
    new Request('https://worker.example/admin/quarantine', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    }),
  )
  const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
  logSpy.mockRestore()

  assert.equal(response.status, 401)
  assert(events.some((event) => event.event === 'auth-reject' && event.reason === 'invalid-token'))
})

test('VaultRoom rejects non-upgrade requests', async () => {
  const room = new VaultRoom(new FakeState(), makeEnv())

  const response = await room.fetch(new Request('https://worker.example/ws/vault-1'))

  assert.equal(response.status, 426)
})

test('hydration replays only the op-log through its captured document clock', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 3,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  for (const seq of [1, 2, 3]) {
    const updateBytes = makeYjsUpdateBytes(makeMessageId(`captured-clock-${seq}`))
    storage.sql.opLog.set(`meta:captured-clock-${seq}`, {
      docId: 'meta',
      seq,
      messageId: `captured-clock-${seq}`,
      deviceId: 'device-1',
      updateBytes,
      updateSha256: await hashTestBytes(updateBytes),
      createdAt: seq,
    })
  }
  let appended = false
  bucket.listOverride = async () => {
    if (!appended) {
      appended = true
      const updateBytes = makeYjsUpdateBytes(makeMessageId('captured-clock-4'))
      storage.sql.opLog.set('meta:captured-clock-4', {
        docId: 'meta',
        seq: 4,
        messageId: 'captured-clock-4',
        deviceId: 'device-1',
        updateBytes,
        updateSha256: await hashTestBytes(updateBytes),
        createdAt: 4,
      })
    }
    return { objects: [], truncated: false }
  }
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))
  room.vaultId = makeVaultId('vault-1')

  await ensureDocHydrated(room, { kind: 'meta' })

  assert(room.docs.has('meta'))
})

test('legacy snapshot approval records state-vector run evidence for compaction', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-run-evidence'))
    const snapshotDoc = new Y.Doc()
    Y.applyUpdate(snapshotDoc, snapshotBytes)
    const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
    snapshotDoc.destroy()
    bucket.set(snapshotKey, snapshotBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    const room = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: { kind: 'meta' },
          snapshotKey,
          upperSeq: 1,
          reason: 'Record durable state-vector evidence',
          confirmation: 'verify',
        }),
      }),
    )
    assert.equal(response.status, 200)
    const run = [...storage.sql.checkpointRuns.values()].find(
      (candidate) => candidate.snapshotKey === snapshotKey,
    )
    assert(run)
    assert.equal(run.status, 'completed')
    assert.deepEqual(run.stateVector, snapshotStateVector)

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = (room.state.getWebSockets?.() ?? [])[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('legacy-run-evidence-tail'))),
    )
    const checkpoint = await room.checkpointDoc({ kind: 'meta' }, 100)
    assert.equal(checkpoint.action, 'checkpointed')
    if (checkpoint.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpoint.compactedSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 1)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('authoritative snapshot verification backfills one missing run idempotently', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-backfill-run'))
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, snapshotBytes)
  const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    latestStateVector: snapshotStateVector,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const request = async (): Promise<Response> =>
    await room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: { kind: 'meta' },
          snapshotKey,
          upperSeq: 1,
          reason: 'Backfill the missing checkpoint evidence',
          confirmation: 'verify',
        }),
      }),
    )

  assert.equal((await request()).status, 200)
  const eventCount = storage.sql.checkpointRuns.size
  assert.equal(eventCount, 1)
  assert.equal((await request()).status, 200)
  assert.equal(storage.sql.checkpointRuns.size, eventCount)
  assert.deepEqual([...storage.sql.checkpointRuns.values()][0]?.stateVector, snapshotStateVector)
})

test('authoritative health evidence without a document uses the full recovery path', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-orphan-recovery'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId: { kind: 'meta' },
        snapshotKey,
        upperSeq: 1,
        reason: 'Recover the durable document pointer',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, snapshotKey)
  assert.equal(room.hydratedDocs.has('meta'), true)
  assert.equal(
    [...storage.sql.checkpointRuns.values()].some(
      (run) => run.snapshotKey === snapshotKey && run.status === 'completed',
    ),
    true,
  )
})

test('every public HTTP failure across auth, blob, and snapshot routes uses the guarded ApiError envelope', async () => {
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })

  const unauthenticated = await room.fetch(new Request('https://worker.example/admin/retention'))
  assert.equal(unauthenticated.status, 401)
  assert.equal(v.is(ApiErrorSchema, await unauthenticated.json()), true)

  const malformedSetup = await room.fetch(
    new Request('https://worker.example/setup/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
  assert.equal(malformedSetup.status, 400)
  assert.equal(v.is(ApiErrorSchema, await malformedSetup.json()), true)

  const missingDoc = await room.fetch(
    new Request(
      `https://worker.example/vaults/vault-1/files/${makeYDocId('ydoc-contract-missing')}/latest`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  )
  assert.equal(missingDoc.status, 404)
  assert.equal(v.is(ApiErrorSchema, await missingDoc.json()), true)

  const blobToken = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
    tokenVersion: 1,
    scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  })
  const missingBlob = await room.fetch(
    new Request(`https://worker.example/blobs/${makeSha256Hex('d'.repeat(64))}`, {
      headers: { Authorization: `Bearer ${blobToken}` },
    }),
  )
  assert.equal(missingBlob.status, 404)
  assert.equal(v.is(ApiErrorSchema, await missingBlob.json()), true)

  const unknownQuarantine = await room.fetch(
    new Request('https://worker.example/admin/quarantine/does-not-exist', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(unknownQuarantine.status, 404)
  assert.equal(v.is(ApiErrorSchema, await unknownQuarantine.json()), true)
})
