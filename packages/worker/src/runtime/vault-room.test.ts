import {
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
  type Ack,
  type NeedFullSnapshot,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../runtime'
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
  makeAuthenticatedWebSocketRequest,
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
  readonly events: readonly RetentionAdminEvent[]
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
    Array.isArray(Reflect.get(value, 'events')) &&
    Reflect.get(value, 'events').every(
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
    readonly yClientId?: unknown
    readonly accessToken?: unknown
    readonly refreshToken?: unknown
    readonly tokenVersion?: unknown
    readonly bootstrapMode?: unknown
  }
  assert.equal(body.endpoint, 'https://worker.example')
  assert.equal(body.vaultId, 'vault-1')
  assert.equal(body.yClientId, 2)
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
  assert.deepEqual(await response.json(), { error: 'setup-persist:transaction-failed' })
  assert(storage.sql.queries.includes('transaction begin'))
  assert(storage.sql.queries.includes('transaction rollback'))
  assert.equal(storage.sql.queries.includes('transaction commit'), false)
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
    error: 'auth-refresh-persist:transaction-failed',
  })
  assert(storage.sql.queries.includes('transaction begin'))
  assert(storage.sql.queries.includes('transaction rollback'))
  assert.equal(storage.sql.queries.includes('transaction commit'), false)
})

test('VaultRoom revokes devices through authenticated HTTP requests', async () => {
  const secret = 'test-device-token-secret'
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    yClientId: 2,
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
    yClientId: 2,
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
  assert.deepEqual(await response.json(), { error: 'blob/hash-mismatch' })
  assert.deepEqual(bucket.puts, [])
})

test('VaultRoom rejects multipart-sized blob proxy uploads until multipart is implemented', async () => {
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
    error: 'blob-upload-url:multipart-unimplemented',
  })
})

test('VaultRoom stores blob objects under a vault-scoped R2 prefix', async () => {
  const secret = TEST_DEVICE_TOKEN_SECRET
  const bucket = new FakeR2Bucket()
  const storage = new SqlOnlyStorage()
  storage.sql.devices.set('device-2', {
    deviceId: 'device-2',
    yClientId: 2,
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
  assert.deepEqual(await response.json(), { error: 'blob-manifest/hash-mismatch' })
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
    const updateJson = JSON.stringify(update)

    await room.webSocketMessage(firstServer, updateJson)

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.kind, 'meta')
    assert.equal(storage.sql.opLog.get('meta:message-sql')?.seq, 1)
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
    })

    const update = makeSyncUpdate(makeMessageId('rehydrate-failure'))
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 2)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 2)
    assert.equal(findAckForMessage(sender.sent, update.messageId), undefined)
    assert.equal(syncMessages(peer.sent).length, 1)
    assert.equal(sender.closeCode, 1011)
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
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2])

    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('after-migrate'))),
    )

    const insertedVersions = storage.sql.queries.filter((query) =>
      query.includes('insert into schema_migrations'),
    )
    assert.equal(insertedVersions.length, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
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

    assert.deepEqual([...storage.sql.migrationVersions], [1, 2])
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
    assert.deepEqual([...storage.sql.messageDedupColumns], ['update_sha256'])

    storage.sql.failOnQueryIncludes = undefined
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.deepEqual([...storage.sql.migrationVersions], [1, 2])
    assert.equal(
      storage.sql.queries.filter((query) => query.includes('alter table message_dedup')).length,
      1,
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
    const emptyDocUpdate = Y.encodeStateAsUpdate(new Y.Doc())

    await room.webSocketMessage(server, updateJson)

    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.has('file:large-file-doc'), false)
    assert.equal(storage.sql.messageDedup.has('file:large-file-doc:message-large-update'), false)
    assert.equal(syncMessages(server.sent).length, 0)
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'append-reject:large-update-requires-snapshot-import')
    const hydratedDoc = room.docs.get('file:large-file-doc')
    assert(hydratedDoc instanceof Y.Doc)
    assert.deepEqual(Y.encodeStateAsUpdate(hydratedDoc), emptyDocUpdate)

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const retryServer = state.accepted[1]
    assert(retryServer instanceof FakeSocket)
    await room.webSocketMessage(retryServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(retryServer, updateJson)

    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.has('file:large-file-doc'), false)
    assert.equal(storage.sql.messageDedup.has('file:large-file-doc:message-large-update'), false)
    assert.equal(syncMessages(retryServer.sent).length, 0)
    assert.equal(retryServer.closeCode, 1011)
    assert.equal(retryServer.closeReason, 'append-reject:large-update-requires-snapshot-import')
    assert.equal(room.docs.get('file:large-file-doc'), hydratedDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(hydratedDoc), emptyDocUpdate)
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

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 100), {
      action: 'skipped',
      reason: 'no-new-ops',
    })
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
    const coldUpdate = JSON.parse(coldResponse) as SyncUpdate
    const coldDoc = new Y.Doc()
    Y.applyUpdate(coldDoc, Y.encodeStateAsUpdate(importedSnapshotDoc))
    Y.applyUpdate(coldDoc, decodeTestBase64(coldUpdate.update))
    assert.deepEqual(Y.encodeStateAsUpdate(coldDoc), Y.encodeStateAsUpdate(expectedDoc))
    coldDoc.destroy()
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
      bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, Y.encodeStateAsUpdate(cumulativeDoc))
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
        body.events.some((event) => event.snapshotKey === 'snapshots/vault-1/meta/1.yupdate'),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
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
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
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
    yClientId: 1,
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

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'compacted')
  assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 2)
  assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
  assert.equal(storage.sql.opLog.has('meta:message-before-snapshot'), false)
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
    assert.equal(room.docWriteQueues.has('meta'), true)
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
    yClientId: 1,
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
      snapshotBytesBySeq.set(seq, snapshotBytes)
      snapshotStateVectors.set(seq, stateVector)
      storage.sql.opLog.set(`meta:message-orphan-retention-${seq}`, {
        docId: 'meta',
        seq,
        messageId: `message-orphan-retention-${seq}`,
        deviceId: 'device-1',
        yClientId: 1,
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
      restartQueries.some((query) => query.includes('select update_bytes')),
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
    const snapshotKey = 'snapshots/vault-1/pointers/meta.json'
    bucket.set(snapshotKey, makeYjsUpdateBytes(makeMessageId('message-snapshot')))
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.opLog.set('meta:message-residual', {
      docId: 'meta',
      seq: 2,
      messageId: 'message-residual',
      deviceId: 'device-1',
      yClientId: 1,
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

    assert.deepEqual(bucket.gets, [snapshotKey])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-snapshot')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
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
    bucket.set(fallbackKey, makeYjsUpdateBytes(makeMessageId('message-fallback-snapshot')))
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
    assert.deepEqual(bucket.gets, [fallbackKey])
    assert.equal(server.closed, false)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-fallback')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
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

test('VaultRoom blocks reinstalled and revoked devices before normal sync', async () => {
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

    await room.webSocketMessage(reinstalled, JSON.stringify({ ...makeHello(), yClientId: 2 }))
    storage.sql.devices.set('device-1', {
      deviceId: 'device-1',
      yClientId: 1,
      tokenVersion: 1,
      revokedAt: 50,
    })
    await room.webSocketMessage(revoked, JSON.stringify(makeHello()))

    assert.equal(reinstalled.closeCode, 1008)
    assert.equal(reinstalled.closeReason, 'hello-requires-full-snapshot:device-reinstalled')
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
      yClientId: 1,
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

    await room.webSocketMessage(
      firstServer,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-bad')),
        update: 'AQID',
      } satisfies SyncUpdate),
    )

    assert.deepEqual(syncMessages(firstServer.sent), [])
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

    assert.deepEqual(syncMessages(server.sent), [])
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

    const invalidUpdate = JSON.stringify({
      ...makeSyncUpdate(makeMessageId('message-repeat-bad')),
      update: 'AQID',
    } satisfies SyncUpdate)

    await room.webSocketMessage(server, invalidUpdate)
    await room.webSocketMessage(server, invalidUpdate)

    assert.deepEqual(syncMessages(server.sent), [])
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

    await room.webSocketMessage(
      firstServer,
      JSON.stringify({
        ...makeSyncUpdate(makeMessageId('message-bad-meta')),
        update: makeInvalidMetaSchemaYjsUpdateBase64(),
      } satisfies SyncUpdate),
    )

    assert.deepEqual(syncMessages(firstServer.sent), [])
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
    entries: [
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
    entry: listBody.entries[0],
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
  assert.deepEqual(await missingResponse.json(), { error: 'unknown-quarantine' })
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
    yClientId: 1,
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
    yClientId: 1,
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

test('VaultRoom rejects latest snapshot requests without a valid access token', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest'),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'auth-reject:invalid-token' })
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
  assert.deepEqual(await response.json(), { error: 'auth-reject:missing-scope' })
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
  assert.deepEqual(await response.json(), { error: 'doc-not-found' })
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
