import { makeDeviceId, makeVaultId, type SetupExchangeResponse } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  createLocalSetupPersistIndexedDbMetadataPort,
  persistLocalSetupResponse,
  type LocalSetupPersistMetadataPort,
  type LocalSetupPersistSecretStoragePort,
} from '../engine/persist'
import {
  LOCAL_AUTH_METADATA_KEY,
  LOCAL_SETUP_METADATA_KEY,
  type LocalSetupMetadataPutOperation,
} from '../engine/setup'
import {
  type LocalStoreIndexedDbMetadataDatabasePort,
  type LocalStoreIndexedDbMetadataObjectStorePort,
  type LocalStoreIndexedDbMetadataTransactionHandle,
  type LocalStoreIndexedDbMetadataWriteOperation,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'

const vaultId = makeVaultId('setup-runtime-vault-1')
const deviceId = makeDeviceId('setup-runtime-device-1')

const setupResponse = {
  endpoint: 'https://sync.example.test',
  vaultId,
  deviceId,
  accessToken: 'signed-access-token',
  refreshToken: 'opaque-refresh-token',
  tokenVersion: 3,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

test('setup persist runtime writes secrets before committing metadata', async () => {
  const secretStorage = new FakeSecretStorage()
  const metadata = new FakeMetadataPort()
  const result = await persistLocalSetupResponse({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
    secretStorage,
    metadata,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(secretStorage.operations, [
    {
      kind: 'set',
      key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:access-token',
      value: 'signed-access-token',
    },
    {
      kind: 'set',
      key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:refresh-token',
      value: 'opaque-refresh-token',
    },
  ])
  assert.equal(metadata.commits.length, 1)
  assert.deepEqual(metadata.commits[0], [
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_SETUP_METADATA_KEY,
      value: {
        endpoint: 'https://sync.example.test',
        vaultId,
        deviceId,
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
        tokenVersion: 3,
      },
    },
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_AUTH_METADATA_KEY,
      value: {
        deviceId,
        authState: 'active',
        tokenVersion: 3,
        accessTokenExpiresAt: 10_000,
        refreshState: 'idle',
        retryCount: 0,
        accessTokenSecretKey: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:access-token',
        refreshTokenSecretKey:
          'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:refresh-token',
      },
    },
  ])
  assert.equal(JSON.stringify(metadata.commits).includes(setupResponse.accessToken), false)
  assert.equal(JSON.stringify(metadata.commits).includes(setupResponse.refreshToken), false)
})

test('setup persist runtime can commit metadata through the IndexedDB adapter', async () => {
  const secretStorage = new FakeSecretStorage()
  const database = new FakeMetadataDatabasePort()
  const result = await persistLocalSetupResponse({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
    secretStorage,
    metadata: createLocalSetupPersistIndexedDbMetadataPort(database),
  })

  assert.equal(result.ok, true)
  if (!result.ok) {
    throw new Error(`unexpected setup persist failure: ${result.phase}`)
  }
  assert.deepEqual(
    database.transaction.store.operations.map((operation) => operation.key),
    [LOCAL_SETUP_METADATA_KEY, LOCAL_AUTH_METADATA_KEY],
  )
  assert.deepEqual(database.transaction.store.operations, result.metadataWrites)
  assert.equal(
    JSON.stringify(database.transaction.store.operations).includes(setupResponse.accessToken),
    false,
  )
  assert.equal(
    JSON.stringify(database.transaction.store.operations).includes(setupResponse.refreshToken),
    false,
  )
})

test('setup persist runtime cleans up completed secrets when metadata commit fails', async () => {
  const secretStorage = new FakeSecretStorage()
  const metadata = new FakeMetadataPort(new Error('metadata failed'))
  const result = await persistLocalSetupResponse({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
    secretStorage,
    metadata,
  })

  assert.equal(result.ok, false)
  if (result.ok || result.phase !== 'metadata-commit') {
    throw new Error(`unexpected result ${JSON.stringify(result)}`)
  }
  assert.deepEqual(
    secretStorage.operations.map((operation) => operation.kind),
    ['set', 'set', 'delete', 'delete'],
  )
  assert.deepEqual(secretStorage.operations.slice(2), [
    {
      kind: 'delete',
      key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:refresh-token',
    },
    {
      kind: 'delete',
      key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:access-token',
    },
  ])
  assert.deepEqual(result.cleanupFailures, [])
})

test('setup persist runtime cleans up completed subset when a later secret write fails', async () => {
  const secretStorage = new FakeSecretStorage(
    'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:refresh-token',
  )
  const metadata = new FakeMetadataPort()
  const result = await persistLocalSetupResponse({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
    secretStorage,
    metadata,
  })

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.phase, 'secret-write')
    assert.equal(metadata.commits.length, 0)
    assert.deepEqual(secretStorage.operations, [
      {
        kind: 'set',
        key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:access-token',
        value: 'signed-access-token',
      },
      {
        kind: 'set',
        key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:refresh-token',
        value: 'opaque-refresh-token',
      },
      {
        kind: 'delete',
        key: 'kuroflare:setup-runtime-vault-1:setup-runtime-device-1:access-token',
      },
    ])
  }
})

test('setup persist runtime rejects unsafe evidence before storage side effects', async () => {
  const secretStorage = new FakeSecretStorage()
  const metadata = new FakeMetadataPort()
  const result = await persistLocalSetupResponse({
    response: setupResponse,
    accessTokenExpiresAt: -1,
    secretStorage,
    metadata,
  })

  assert.deepEqual(result, {
    ok: false,
    phase: 'plan',
    setupPlan: {
      ok: false,
      reason: 'invalid-token-expiry',
      authDecision: { action: 'reject', reason: 'invalid-token-expiry' },
    },
  })
  assert.deepEqual(secretStorage.operations, [])
  assert.deepEqual(metadata.commits, [])
})

type SecretStorageOperation =
  | { readonly kind: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'delete'; readonly key: string }

class FakeSecretStorage implements LocalSetupPersistSecretStoragePort {
  readonly operations: SecretStorageOperation[] = []

  constructor(private readonly failingSetKey?: string) {}

  async set(key: string, value: string): Promise<void> {
    this.operations.push({ kind: 'set', key, value })
    if (key === this.failingSetKey) {
      throw new Error('secret set failed')
    }
  }

  async delete(key: string): Promise<void> {
    this.operations.push({ kind: 'delete', key })
  }
}

class FakeMetadataPort implements LocalSetupPersistMetadataPort {
  readonly commits: LocalStoreIndexedDbMetadataWriteOperation[][] = []

  constructor(private readonly commitError?: Error) {}

  async commit(writes: readonly LocalStoreIndexedDbMetadataWriteOperation[]): Promise<void> {
    this.commits.push([...writes])
    if (this.commitError !== undefined) {
      throw this.commitError
    }
  }
}

class FakeMetadataDatabasePort implements LocalStoreIndexedDbMetadataDatabasePort {
  transaction = new FakeMetadataTransactionHandle()

  openMetadataTransaction(): LocalStoreIndexedDbMetadataTransactionHandle {
    this.transaction = new FakeMetadataTransactionHandle()
    return this.transaction
  }
}

class FakeMetadataTransactionHandle implements LocalStoreIndexedDbMetadataTransactionHandle {
  readonly store = new FakeMetadataObjectStore()
  readonly lifecycle = new AutoCompleteTransactionLifecycle()
}

class FakeMetadataObjectStore implements LocalStoreIndexedDbMetadataObjectStorePort {
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
