import { type ClientAuthMetadata } from '@kuroflare/core'
import { makeDeviceId, type RevokeDeviceResponse } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  createAuthRevokeIndexedDbMetadataPort,
  persistLocalDeviceRevoke,
  type AuthRevokeMetadataPort,
  type AuthRevokeSecretStoragePort,
} from '../auth/revoke'
import { LOCAL_AUTH_METADATA_KEY, type LocalSetupMetadataPutOperation } from '../engine/setup'
import {
  type LocalStoreIndexedDbMetadataDatabasePort,
  type LocalStoreIndexedDbMetadataObjectStorePort,
  type LocalStoreIndexedDbMetadataTransactionHandle,
  type LocalStoreIndexedDbMetadataWriteOperation,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'

const deviceId = makeDeviceId('auth-revoke-device-1')
const otherDeviceId = makeDeviceId('auth-revoke-device-2')

const activeMetadata = {
  deviceId,
  authState: 'active',
  tokenVersion: 4,
  accessTokenExpiresAt: 10_000,
  refreshState: 'idle',
  retryCount: 0,
  accessTokenSecretKey: 'kuroflare:auth-revoke-device-1:access-token',
  refreshTokenSecretKey: 'kuroflare:auth-revoke-device-1:refresh-token',
} satisfies ClientAuthMetadata

const revokeResponse = {
  deviceId,
  status: 'revoked',
  revokedAt: 12_000,
  tokenVersion: 5,
} satisfies RevokeDeviceResponse

test('auth revoke runtime deletes token secrets before committing revoked metadata', async () => {
  const secretStorage = new FakeAuthRevokeSecretStorage([
    activeMetadata.accessTokenSecretKey,
    activeMetadata.refreshTokenSecretKey,
  ])
  const metadataStore = new FakeAuthRevokeMetadataStore()
  const result = await persistLocalDeviceRevoke({
    response: revokeResponse,
    metadata: activeMetadata,
    secretStorage,
    metadataStore,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(secretStorage.operations, [
    { kind: 'delete', key: activeMetadata.accessTokenSecretKey },
    { kind: 'delete', key: activeMetadata.refreshTokenSecretKey },
  ])
  assert.deepEqual(metadataStore.commits, [
    {
      kind: 'put-metadata-record',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        deviceId,
        authState: 'revoked',
        tokenVersion: 5,
        revokedAt: 12_000,
        refreshState: 'idle',
        retryCount: 0,
      },
    },
  ])
  if (result.ok) {
    assert.equal(result.stopSync, true)
    assert.deepEqual(result.secretDeleteFailures, [])
  }
})

test('auth revoke runtime commits revoked metadata even when stale secret cleanup fails', async () => {
  const secretStorage = new FakeAuthRevokeSecretStorage(
    [activeMetadata.accessTokenSecretKey, activeMetadata.refreshTokenSecretKey],
    activeMetadata.refreshTokenSecretKey,
  )
  const metadataStore = new FakeAuthRevokeMetadataStore()
  const result = await persistLocalDeviceRevoke({
    response: revokeResponse,
    metadata: activeMetadata,
    secretStorage,
    metadataStore,
  })

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(
      result.secretDeleteFailures.map((failure) => failure.key),
      [activeMetadata.refreshTokenSecretKey],
    )
  }
  assert.equal(secretStorage.has(activeMetadata.accessTokenSecretKey), false)
  assert.equal(secretStorage.has(activeMetadata.refreshTokenSecretKey), true)
  assert.equal(
    JSON.stringify(metadataStore.commits).includes(activeMetadata.refreshTokenSecretKey),
    false,
  )
})

test('auth revoke runtime rejects invalid or mismatched revoke evidence before side effects', async () => {
  const secretStorage = new FakeAuthRevokeSecretStorage([
    activeMetadata.accessTokenSecretKey,
    activeMetadata.refreshTokenSecretKey,
  ])
  const metadataStore = new FakeAuthRevokeMetadataStore()

  assert.deepEqual(
    await persistLocalDeviceRevoke({
      response: { ...revokeResponse, revokedAt: -1 },
      metadata: activeMetadata,
      secretStorage,
      metadataStore,
    }),
    { ok: false, phase: 'response', reason: 'invalid-revoke-response' },
  )

  assert.deepEqual(
    await persistLocalDeviceRevoke({
      response: { ...revokeResponse, deviceId: otherDeviceId },
      metadata: activeMetadata,
      secretStorage,
      metadataStore,
    }),
    {
      ok: false,
      phase: 'revoke-decision',
      response: { ...revokeResponse, deviceId: otherDeviceId },
      revokeDecision: { action: 'reject', reason: 'device-mismatch' },
    },
  )
  assert.deepEqual(secretStorage.operations, [])
  assert.deepEqual(metadataStore.commits, [])
})

test('auth revoke runtime reports metadata commit failure after deleting secrets', async () => {
  const secretStorage = new FakeAuthRevokeSecretStorage([
    activeMetadata.accessTokenSecretKey,
    activeMetadata.refreshTokenSecretKey,
  ])
  const result = await persistLocalDeviceRevoke({
    response: revokeResponse,
    metadata: activeMetadata,
    secretStorage,
    metadataStore: new FakeAuthRevokeMetadataStore(new Error('commit failed')),
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.phase, 'metadata-commit')
  }
  assert.equal(secretStorage.has(activeMetadata.accessTokenSecretKey), false)
  assert.equal(secretStorage.has(activeMetadata.refreshTokenSecretKey), false)
})

test('auth revoke runtime can commit revoked metadata through the IndexedDB adapter', async () => {
  const secretStorage = new FakeAuthRevokeSecretStorage([
    activeMetadata.accessTokenSecretKey,
    activeMetadata.refreshTokenSecretKey,
  ])
  const database = new FakeAuthRevokeMetadataDatabasePort()
  const result = await persistLocalDeviceRevoke({
    response: revokeResponse,
    metadata: activeMetadata,
    secretStorage,
    metadataStore: createAuthRevokeIndexedDbMetadataPort(database),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(database.transaction.store.operations, [
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        deviceId,
        authState: 'revoked',
        tokenVersion: 5,
        revokedAt: 12_000,
        refreshState: 'idle',
        retryCount: 0,
      },
    },
  ])
})

type SecretOperation = { readonly kind: 'delete'; readonly key: string }

class FakeAuthRevokeSecretStorage implements AuthRevokeSecretStoragePort {
  readonly operations: SecretOperation[] = []
  readonly #secrets = new Set<string>()

  constructor(
    keys: readonly string[] = [],
    private readonly failingDeleteKey?: string,
  ) {
    for (const key of keys) {
      this.#secrets.add(key)
    }
  }

  async delete(key: string): Promise<void> {
    this.operations.push({ kind: 'delete', key })
    if (key === this.failingDeleteKey) {
      throw new Error('delete failed')
    }
    this.#secrets.delete(key)
  }

  has(key: string): boolean {
    return this.#secrets.has(key)
  }
}

class FakeAuthRevokeMetadataStore implements AuthRevokeMetadataPort {
  readonly commits: LocalSetupMetadataPutOperation[] = []

  constructor(private readonly error?: Error) {}

  async commit(write: LocalSetupMetadataPutOperation): Promise<void> {
    this.commits.push(write)
    if (this.error !== undefined) {
      throw this.error
    }
  }
}

class FakeAuthRevokeMetadataDatabasePort implements LocalStoreIndexedDbMetadataDatabasePort {
  transaction = new FakeAuthRevokeMetadataTransactionHandle()

  openMetadataTransaction(): LocalStoreIndexedDbMetadataTransactionHandle {
    this.transaction = new FakeAuthRevokeMetadataTransactionHandle()
    return this.transaction
  }
}

class FakeAuthRevokeMetadataTransactionHandle implements LocalStoreIndexedDbMetadataTransactionHandle {
  readonly store = new FakeAuthRevokeMetadataObjectStore()
  readonly lifecycle = new AutoCompleteTransactionLifecycle()
}

class FakeAuthRevokeMetadataObjectStore implements LocalStoreIndexedDbMetadataObjectStorePort {
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
