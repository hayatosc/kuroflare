import {
  DEVICE_TOKEN_ISSUER,
  makeDeviceId,
  makeVaultId,
  type ClientAuthMetadata,
  type DeviceTokenClaims,
  type DeviceTokenRefreshRequest,
  type DeviceTokenScope,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import { createRemoteSetupAccessTokenVerifier } from '../../host/auth'
import {
  createAuthRefreshIndexedDbMetadataPort,
  persistAuthRefreshStart,
  recoverStaleAuthRefreshStart,
  runAuthRefreshAttempt,
  type AuthRefreshAccessTokenVerifierPort,
  type AuthRefreshHttpPort,
  type AuthRefreshHttpResult,
  type AuthRefreshMetadataPort,
  type AuthRefreshSecretStoragePort,
} from '../auth/refresh'
import { LOCAL_AUTH_METADATA_KEY, type LocalSetupMetadataPutOperation } from '../engine/setup'
import {
  type LocalStoreIndexedDbMetadataDatabasePort,
  type LocalStoreIndexedDbMetadataObjectStorePort,
  type LocalStoreIndexedDbMetadataTransactionHandle,
  type LocalStoreIndexedDbMetadataWriteOperation,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'

const vaultId = makeVaultId('auth-refresh-vault-1')
const deviceId = makeDeviceId('auth-refresh-device-1')
const requiredScopes: DeviceTokenScope[] = ['sync:read', 'sync:write', 'blob:read', 'blob:write']

const activeMetadata = {
  deviceId,
  authState: 'active',
  tokenVersion: 3,
  accessTokenExpiresAt: 1_000,
  refreshState: 'idle',
  retryCount: 0,
  accessTokenSecretKey: 'kuroflare:auth-refresh-vault-1:auth-refresh-device-1:access-token',
  refreshTokenSecretKey: 'kuroflare:auth-refresh-vault-1:auth-refresh-device-1:refresh-token',
} satisfies ClientAuthMetadata

const refreshedClaims = {
  iss: DEVICE_TOKEN_ISSUER,
  aud: vaultId,
  sub: deviceId,
  scope: requiredScopes,
  iat: 1_000,
  exp: 10_000,
  tokenVersion: 4,
} satisfies DeviceTokenClaims

test('auth refresh runtime writes refreshed tokens before auth metadata and emits resume event', async () => {
  const secretStorage = new FakeAuthSecretStorage([
    [activeMetadata.accessTokenSecretKey, 'access-token-3'],
    [activeMetadata.refreshTokenSecretKey, 'refresh-token-3'],
  ])
  const http = new FakeAuthRefreshHttp({
    ok: true,
    response: {
      accessToken: 'access-token-4',
      refreshToken: 'refresh-token-4',
      tokenVersion: 4,
      expiresAt: 10_000,
      protocolVersion: 1,
    },
  })
  const metadataStore = new FakeAuthMetadataStore()
  const result = await runAuthRefreshAttempt({
    endpoint: 'https://sync.example.test',
    vaultId,
    metadata: activeMetadata,
    requiredScopes,
    now: 2_000,
    secretStorage,
    http,
    verifier: new FakeAccessTokenVerifier(refreshedClaims),
    metadataStore,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(http.requests, [
    {
      vaultId,
      deviceId,
      refreshToken: 'refresh-token-3',
      previousTokenVersion: 3,
    },
  ])
  assert.deepEqual(secretStorage.operations, [
    {
      kind: 'get',
      key: activeMetadata.accessTokenSecretKey,
    },
    {
      kind: 'get',
      key: activeMetadata.refreshTokenSecretKey,
    },
    {
      kind: 'set',
      key: activeMetadata.accessTokenSecretKey,
      value: 'access-token-4',
    },
    {
      kind: 'set',
      key: activeMetadata.refreshTokenSecretKey,
      value: 'refresh-token-4',
    },
  ])
  assert.deepEqual(metadataStore.commits, [
    {
      kind: 'put-metadata-record',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        deviceId,
        authState: 'active',
        tokenVersion: 4,
        accessTokenExpiresAt: 10_000,
        refreshState: 'idle',
        retryCount: 0,
        accessTokenSecretKey: activeMetadata.accessTokenSecretKey,
        refreshTokenSecretKey: activeMetadata.refreshTokenSecretKey,
      },
    },
  ])
  if (result.ok) {
    assert.equal(result.emitResumeEvent, 'auth-refresh')
  }
})

test('auth refresh rejects a forged response through remote verification before overwriting SecretStorage', async () => {
  const secretStorage = new FakeAuthSecretStorage([
    [activeMetadata.accessTokenSecretKey, 'access-token-3'],
    [activeMetadata.refreshTokenSecretKey, 'refresh-token-3'],
  ])
  const metadataStore = new FakeAuthMetadataStore()
  let verifyRequest: { readonly url: string; readonly authorization: string | null } | undefined
  const verifier = createRemoteSetupAccessTokenVerifier({
    endpoint: 'https://sync.example.test',
    fetch: async (input, init) => {
      verifyRequest = {
        url:
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        authorization: new Headers(init?.headers).get('Authorization'),
      }
      return new Response(JSON.stringify({ error: 'auth-reject:invalid-token' }), { status: 401 })
    },
  })

  const result = await runAuthRefreshAttempt({
    endpoint: 'https://sync.example.test',
    vaultId,
    metadata: activeMetadata,
    requiredScopes,
    now: 2_000,
    secretStorage,
    http: new FakeAuthRefreshHttp({
      ok: true,
      response: {
        accessToken: 'forged-access-token',
        refreshToken: 'forged-refresh-token',
        tokenVersion: 4,
        expiresAt: 10_000,
        protocolVersion: 1,
      },
    }),
    verifier,
    metadataStore,
  })

  assert.equal(result.ok, false)
  assert.equal('phase' in result && result.phase, 'claims')
  assert.deepEqual(verifyRequest, {
    url: 'https://sync.example.test/auth/verify',
    authorization: 'Bearer forged-access-token',
  })
  assert.deepEqual(
    secretStorage.operations.filter((operation) => operation.kind === 'set'),
    [],
  )
  assert.equal(secretStorage.value(activeMetadata.accessTokenSecretKey), 'access-token-3')
  assert.equal(secretStorage.value(activeMetadata.refreshTokenSecretKey), 'refresh-token-3')
})

test('auth refresh runtime can commit auth metadata through the IndexedDB adapter', async () => {
  const secretStorage = new FakeAuthSecretStorage([
    [activeMetadata.accessTokenSecretKey, 'access-token-3'],
    [activeMetadata.refreshTokenSecretKey, 'refresh-token-3'],
  ])
  const database = new FakeAuthMetadataDatabasePort()
  const result = await runAuthRefreshAttempt({
    endpoint: 'https://sync.example.test',
    vaultId,
    metadata: activeMetadata,
    requiredScopes,
    now: 2_000,
    secretStorage,
    http: new FakeAuthRefreshHttp({
      ok: true,
      response: {
        accessToken: 'access-token-4',
        refreshToken: 'refresh-token-4',
        tokenVersion: 4,
        expiresAt: 10_000,
        protocolVersion: 1,
      },
    }),
    verifier: new FakeAccessTokenVerifier(refreshedClaims),
    metadataStore: createAuthRefreshIndexedDbMetadataPort(database),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(database.transaction.store.operations, [
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        deviceId,
        authState: 'active',
        tokenVersion: 4,
        accessTokenExpiresAt: 10_000,
        refreshState: 'idle',
        retryCount: 0,
        accessTokenSecretKey: activeMetadata.accessTokenSecretKey,
        refreshTokenSecretKey: activeMetadata.refreshTokenSecretKey,
      },
    },
  ])
  assert.equal(
    JSON.stringify(database.transaction.store.operations).includes('access-token-4'),
    false,
  )
  assert.equal(
    JSON.stringify(database.transaction.store.operations).includes('refresh-token-4'),
    false,
  )
})

test('auth refresh start persists refreshing metadata before HTTP attempt', async () => {
  const metadataStore = new FakeAuthMetadataStore()
  const result = await persistAuthRefreshStart({
    metadata: activeMetadata,
    request: {
      action: 'request-refresh',
      reason: 'token-expiring-soon',
      requestedAt: 2_000,
      blockedItemIds: [],
    },
    metadataStore,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(metadataStore.commits, [
    {
      kind: 'put-metadata-record',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        ...activeMetadata,
        refreshState: 'refreshing',
        refreshStartedAt: 2_000,
      },
    },
  ])
})

test('auth refresh start rejects non-request and duplicate refreshing evidence', async () => {
  const metadataStore = new FakeAuthMetadataStore()

  assert.deepEqual(
    await persistAuthRefreshStart({
      metadata: activeMetadata,
      request: { action: 'noop', reason: 'no-auth-blocks' },
      metadataStore,
    }),
    {
      ok: false,
      phase: 'request',
      reason: 'noop',
      request: { action: 'noop', reason: 'no-auth-blocks' },
    },
  )

  assert.deepEqual(
    await persistAuthRefreshStart({
      metadata: { ...activeMetadata, refreshState: 'refreshing' },
      request: {
        action: 'request-refresh',
        reason: 'token-expired',
        requestedAt: 2_000,
        blockedItemIds: [],
      },
      metadataStore,
    }),
    {
      ok: false,
      phase: 'refresh-start',
      refreshStart: { action: 'reject', reason: 'refresh-already-running' },
    },
  )
  assert.deepEqual(metadataStore.commits, [])
})

test('auth refresh start can commit refreshing metadata through the IndexedDB adapter', async () => {
  const database = new FakeAuthMetadataDatabasePort()
  const result = await persistAuthRefreshStart({
    metadata: activeMetadata,
    request: {
      action: 'request-refresh',
      reason: 'token-expired',
      requestedAt: 2_000,
      blockedItemIds: [],
    },
    metadataStore: createAuthRefreshIndexedDbMetadataPort(database),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(database.transaction.store.operations, [
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        ...activeMetadata,
        refreshState: 'refreshing',
        refreshStartedAt: 2_000,
      },
    },
  ])
})

test('auth refresh stale start recovery persists backoff metadata', async () => {
  const metadataStore = new FakeAuthMetadataStore()
  const result = await recoverStaleAuthRefreshStart({
    metadata: {
      ...activeMetadata,
      refreshState: 'refreshing',
      refreshStartedAt: 2_000,
    },
    now: 7_000,
    staleAfterMs: 5_000,
    metadataStore,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(metadataStore.commits, [
    {
      kind: 'put-metadata-record',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        ...activeMetadata,
        refreshState: 'backing-off',
        retryCount: 1,
        nextAllowedRefreshAt: 8_000,
      },
    },
  ])
})

test('auth refresh stale start recovery waits before timeout and can use IndexedDB adapter', async () => {
  const wait = await recoverStaleAuthRefreshStart({
    metadata: {
      ...activeMetadata,
      refreshState: 'refreshing',
      refreshStartedAt: 2_000,
    },
    now: 6_000,
    staleAfterMs: 5_000,
    metadataStore: new FakeAuthMetadataStore(),
  })
  assert.deepEqual(wait, {
    ok: false,
    phase: 'recovery',
    recovery: { action: 'wait', refreshStartedAt: 2_000, staleAt: 7_000 },
  })

  const database = new FakeAuthMetadataDatabasePort()
  const recovered = await recoverStaleAuthRefreshStart({
    metadata: {
      ...activeMetadata,
      refreshState: 'refreshing',
      refreshStartedAt: 2_000,
    },
    now: 7_000,
    staleAfterMs: 5_000,
    metadataStore: createAuthRefreshIndexedDbMetadataPort(database),
  })

  assert.equal(recovered.ok, true)
  assert.deepEqual(
    database.transaction.store.operations.map((operation) => operation.key),
    [LOCAL_AUTH_METADATA_KEY],
  )
})

test('auth refresh runtime persists retryable failures as backoff without touching secrets', async () => {
  const secretStorage = new FakeAuthSecretStorage([
    [activeMetadata.accessTokenSecretKey, 'access-token-3'],
    [activeMetadata.refreshTokenSecretKey, 'refresh-token-3'],
  ])
  const metadataStore = new FakeAuthMetadataStore()
  const result = await runAuthRefreshAttempt({
    endpoint: 'https://sync.example.test',
    vaultId,
    metadata: { ...activeMetadata, retryCount: 1 },
    requiredScopes,
    now: 2_000,
    secretStorage,
    http: new FakeAuthRefreshHttp({
      ok: false,
      reason: 'server-retryable',
      retryAfterMs: 60_000,
    }),
    verifier: new FakeAccessTokenVerifier(refreshedClaims),
    metadataStore,
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.phase, 'http')
  }
  assert.deepEqual(secretStorage.operations, [
    {
      kind: 'get',
      key: activeMetadata.accessTokenSecretKey,
    },
    {
      kind: 'get',
      key: activeMetadata.refreshTokenSecretKey,
    },
  ])
  assert.deepEqual(metadataStore.commits, [
    {
      kind: 'put-metadata-record',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        ...activeMetadata,
        retryCount: 2,
        refreshState: 'backing-off',
        nextAllowedRefreshAt: 62_000,
      },
    },
  ])
})

test('auth refresh runtime restores overwritten secrets when metadata commit fails', async () => {
  const secretStorage = new FakeAuthSecretStorage([
    [activeMetadata.accessTokenSecretKey, 'access-token-3'],
    [activeMetadata.refreshTokenSecretKey, 'refresh-token-3'],
  ])
  const result = await runAuthRefreshAttempt({
    endpoint: 'https://sync.example.test',
    vaultId,
    metadata: activeMetadata,
    requiredScopes,
    now: 2_000,
    secretStorage,
    http: new FakeAuthRefreshHttp({
      ok: true,
      response: {
        accessToken: 'access-token-4',
        refreshToken: 'refresh-token-4',
        tokenVersion: 4,
        expiresAt: 10_000,
        protocolVersion: 1,
      },
    }),
    verifier: new FakeAccessTokenVerifier(refreshedClaims),
    metadataStore: new FakeAuthMetadataStore(new Error('commit failed')),
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.phase, 'metadata-commit')
  }
  assert.deepEqual(
    secretStorage.operations.map((operation) => operation.kind),
    ['get', 'get', 'set', 'set', 'set', 'set'],
  )
  assert.deepEqual(secretStorage.operations.slice(4), [
    {
      kind: 'set',
      key: activeMetadata.refreshTokenSecretKey,
      value: 'refresh-token-3',
    },
    {
      kind: 'set',
      key: activeMetadata.accessTokenSecretKey,
      value: 'access-token-3',
    },
  ])
  assert.equal(secretStorage.value(activeMetadata.accessTokenSecretKey), 'access-token-3')
  assert.equal(secretStorage.value(activeMetadata.refreshTokenSecretKey), 'refresh-token-3')
})

test('auth refresh runtime stops before HTTP when refresh token secret is missing', async () => {
  const secretStorage = new FakeAuthSecretStorage()
  const http = new FakeAuthRefreshHttp({
    ok: false,
    reason: 'network',
  })
  const metadataStore = new FakeAuthMetadataStore()
  const result = await runAuthRefreshAttempt({
    endpoint: 'https://sync.example.test',
    vaultId,
    metadata: activeMetadata,
    requiredScopes,
    now: 2_000,
    secretStorage,
    http,
    verifier: new FakeAccessTokenVerifier(refreshedClaims),
    metadataStore,
  })

  assert.deepEqual(result, {
    ok: false,
    phase: 'secret-read',
    reason: 'missing-refresh-token',
  })
  assert.deepEqual(secretStorage.operations, [
    {
      kind: 'get',
      key: activeMetadata.accessTokenSecretKey,
    },
    {
      kind: 'get',
      key: activeMetadata.refreshTokenSecretKey,
    },
  ])
  assert.deepEqual(http.requests, [])
  assert.deepEqual(metadataStore.commits, [])
})

type SecretOperation =
  | { readonly kind: 'get'; readonly key: string }
  | { readonly kind: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'delete'; readonly key: string }

class FakeAuthSecretStorage implements AuthRefreshSecretStoragePort {
  readonly operations: SecretOperation[] = []
  readonly #secrets = new Map<string, string>()

  constructor(entries: readonly (readonly [string, string])[] = []) {
    for (const [key, value] of entries) {
      this.#secrets.set(key, value)
    }
  }

  async get(key: string): Promise<string | undefined> {
    this.operations.push({ kind: 'get', key })
    return this.#secrets.get(key)
  }

  async set(key: string, value: string): Promise<void> {
    this.operations.push({ kind: 'set', key, value })
    this.#secrets.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.operations.push({ kind: 'delete', key })
    this.#secrets.delete(key)
  }

  value(key: string): string | undefined {
    return this.#secrets.get(key)
  }
}

class FakeAuthRefreshHttp implements AuthRefreshHttpPort {
  readonly requests: DeviceTokenRefreshRequest[] = []

  constructor(private readonly result: AuthRefreshHttpResult) {}

  async refresh(request: DeviceTokenRefreshRequest): Promise<AuthRefreshHttpResult> {
    this.requests.push(request)
    return this.result
  }
}

class FakeAccessTokenVerifier implements AuthRefreshAccessTokenVerifierPort {
  constructor(private readonly claims: DeviceTokenClaims | undefined) {}

  async verify(): Promise<DeviceTokenClaims | undefined> {
    return this.claims
  }
}

class FakeAuthMetadataStore implements AuthRefreshMetadataPort {
  readonly commits: LocalSetupMetadataPutOperation[] = []

  constructor(private readonly error?: Error) {}

  async commit(write: LocalSetupMetadataPutOperation): Promise<void> {
    this.commits.push(write)
    if (this.error !== undefined) {
      throw this.error
    }
  }
}

class FakeAuthMetadataDatabasePort implements LocalStoreIndexedDbMetadataDatabasePort {
  transaction = new FakeAuthMetadataTransactionHandle()

  openMetadataTransaction(): LocalStoreIndexedDbMetadataTransactionHandle {
    this.transaction = new FakeAuthMetadataTransactionHandle()
    return this.transaction
  }
}

class FakeAuthMetadataTransactionHandle implements LocalStoreIndexedDbMetadataTransactionHandle {
  readonly store = new FakeAuthMetadataObjectStore()
  readonly lifecycle = new AutoCompleteTransactionLifecycle()
}

class FakeAuthMetadataObjectStore implements LocalStoreIndexedDbMetadataObjectStorePort {
  readonly operations: LocalStoreIndexedDbMetadataWriteOperation[] = []

  get(
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<LocalSetupMetadataPutOperation['value'] | undefined> {
    void key
    return new SuccessfulIndexedDbRequest(undefined)
  }

  put(
    value: LocalSetupMetadataPutOperation['value'],
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<IDBValidKey> {
    this.operations.push({ kind: 'put', storeName: 'metadata', key, value })
    return new SuccessfulIndexedDbRequest(key)
  }
}

class AutoCompleteTransactionLifecycle implements LocalStoreIndexedDbTransactionLifecycle {
  readonly error = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  #completed = false
  #oncomplete: ((event: Event) => void) | null = null

  constructor() {
    queueMicrotask(() => {
      this.complete()
    })
  }

  get oncomplete(): ((event: Event) => void) | null {
    return this.#oncomplete
  }

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.#oncomplete = handler
    if (handler !== null && this.#completed) {
      queueMicrotask(() => {
        handler(new Event('complete'))
      })
    }
  }

  private complete(): void {
    if (this.#oncomplete === null) {
      this.#completed = true
      return
    }
    this.#oncomplete(new Event('complete'))
  }
}

class SuccessfulIndexedDbRequest<Result> implements LocalStoreIndexedDbRequest<Result> {
  readonly error = null
  onerror: ((event: Event) => void) | null = null
  onsuccess: ((event: Event) => void) | null = null

  constructor(readonly result: Result) {
    queueMicrotask(() => {
      if (this.onsuccess !== null) {
        this.onsuccess(new Event('success'))
      }
    })
  }
}
