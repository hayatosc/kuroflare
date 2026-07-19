import { CURRENT_PROTOCOL_VERSION, makeDeviceId, makeMessageId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { VaultRoom } from '../../runtime'
import {
  TEST_DEVICE_TOKEN_SECRET,
  FakeSocket,
  FakeState,
  installFakeWebSocketPair,
  installFakeUpgradeResponse,
  restoreWebSocketPair,
  restoreResponse,
  makeEnv,
  makeEnvWithDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  syncMessages,
  hashTestText,
  makeDeviceToken,
  makeAuthenticatedWebSocketRequest,
} from '../support'

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
