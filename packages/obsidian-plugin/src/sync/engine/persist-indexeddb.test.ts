import { makeDeviceId, makeVaultId, type SetupExchangeResponse } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  LOCAL_AUTH_METADATA_KEY,
  LOCAL_SETUP_METADATA_KEY,
  planLocalSetupPersist,
  type LocalSetupMetadataPutOperation,
} from '../engine/setup'
import {
  applyLocalStoreIndexedDbMetadataWrites,
  commitLocalStoreIndexedDbMetadataTransaction,
  planLocalStoreIndexedDbMetadataWrites,
  readLocalStoreIndexedDbMetadataSnapshot,
  type LocalStoreIndexedDbMetadataDatabasePort,
  type LocalStoreIndexedDbMetadataObjectStorePort,
  type LocalStoreIndexedDbMetadataTransactionHandle,
  type LocalStoreIndexedDbMetadataWriteOperation,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'

const vaultId = makeVaultId('setup-indexeddb-vault-1')
const deviceId = makeDeviceId('setup-indexeddb-device-1')

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

test('setup persist metadata puts map to metadata object-store writes', () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)

  if (!plan.ok) {
    throw new Error(`unexpected setup persist rejection: ${plan.reason}`)
  }
  const setupPut = plan.metadataPuts[0]
  const authPut = plan.metadataPuts[1]
  if (setupPut === undefined || authPut === undefined) {
    throw new Error('setup persist plan did not include both metadata puts')
  }
  assert.deepEqual(planLocalStoreIndexedDbMetadataWrites(plan.metadataPuts), [
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_SETUP_METADATA_KEY,
      value: setupPut.value,
    },
    {
      kind: 'put',
      storeName: 'metadata',
      key: LOCAL_AUTH_METADATA_KEY,
      value: authPut.value,
    },
  ])
})

test('setup persist metadata writes are applied in order without token bodies', async () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    const store = new FakeMetadataObjectStore()
    const writes = planLocalStoreIndexedDbMetadataWrites(plan.metadataPuts)
    await applyLocalStoreIndexedDbMetadataWrites(store, writes)

    assert.deepEqual(store.operations, writes)
    assert.deepEqual(
      store.values().map(([key]) => key),
      [LOCAL_SETUP_METADATA_KEY, LOCAL_AUTH_METADATA_KEY],
    )
    assert.equal(JSON.stringify(store.values()).includes(setupResponse.accessToken), false)
    assert.equal(JSON.stringify(store.values()).includes(setupResponse.refreshToken), false)
  }
})

test('setup persist metadata writes queue all puts before awaiting request completion', async () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    const store = new DeferredMetadataObjectStore()
    const writes = planLocalStoreIndexedDbMetadataWrites(plan.metadataPuts)
    const applied = applyLocalStoreIndexedDbMetadataWrites(store, writes)

    assert.deepEqual(store.operations, writes)
    store.succeedAll()
    await applied
  }
})

test('setup persist metadata transaction waits for IndexedDB transaction completion', async () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)

  if (plan.ok) {
    const writes = planLocalStoreIndexedDbMetadataWrites(plan.metadataPuts)
    const database = new FakeMetadataDatabasePort()
    const committed = commitLocalStoreIndexedDbMetadataTransaction({ database, writes })
    let completed = false
    void committed.then(() => {
      completed = true
    })

    assert.deepEqual(database.transaction.store.operations, writes)
    database.transaction.store.succeedAll()
    await Promise.resolve()
    assert.equal(completed, false)

    database.transaction.lifecycle.complete()
    await committed
    assert.equal(completed, true)
  }
})

test('setup persist metadata snapshot reads setup and auth records before startup', async () => {
  const plan = planLocalSetupPersist({
    response: setupResponse,
    accessTokenExpiresAt: 10_000,
  })
  assert.equal(plan.ok, true)

  if (!plan.ok) {
    throw new Error(`unexpected setup persist rejection: ${plan.reason}`)
  }
  const setupPut = plan.metadataPuts[0]
  const authPut = plan.metadataPuts[1]
  if (setupPut === undefined || authPut === undefined) {
    throw new Error('setup persist plan did not include both metadata puts')
  }
  if (setupPut.key !== LOCAL_SETUP_METADATA_KEY || authPut.key !== LOCAL_AUTH_METADATA_KEY) {
    throw new Error('setup persist plan metadata puts were not in setup/auth order')
  }
  const database = new FakeMetadataDatabasePort()
  const writes = planLocalStoreIndexedDbMetadataWrites(plan.metadataPuts)
  const committed = commitLocalStoreIndexedDbMetadataTransaction({ database, writes })
  database.transaction.store.succeedAll()
  database.transaction.lifecycle.complete()
  await committed

  const read = readLocalStoreIndexedDbMetadataSnapshot({ database })
  let completed = false
  void read.then(() => {
    completed = true
  })

  assert.deepEqual(database.transaction.store.readKeys, [
    LOCAL_SETUP_METADATA_KEY,
    LOCAL_AUTH_METADATA_KEY,
  ])
  database.transaction.store.succeedAll()
  await Promise.resolve()
  assert.equal(completed, false)

  database.transaction.lifecycle.complete()
  assert.deepEqual(await read, {
    ok: true,
    snapshot: {
      setup: setupPut.value,
      auth: authPut.value,
    },
  })
})

test('setup persist metadata snapshot rejects missing or invalid records', async () => {
  const database = new FakeMetadataDatabasePort()
  const read = readLocalStoreIndexedDbMetadataSnapshot({ database })

  database.transaction.store.succeedAll()
  database.transaction.lifecycle.complete()

  assert.deepEqual(await read, {
    ok: false,
    reason: 'missing-setup-metadata',
  })
})

class FakeMetadataObjectStore implements LocalStoreIndexedDbMetadataObjectStorePort {
  readonly #values = new Map<
    LocalSetupMetadataPutOperation['key'],
    LocalSetupMetadataPutOperation['value']
  >()
  readonly operations: LocalStoreIndexedDbMetadataWriteOperation[] = []

  put(
    value: LocalSetupMetadataPutOperation['value'],
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<IDBValidKey> {
    this.#values.set(key, value)
    this.operations.push({ kind: 'put', storeName: 'metadata', key, value })
    return new SuccessfulIndexedDbRequest(key)
  }

  get(
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<LocalSetupMetadataPutOperation['value'] | undefined> {
    return new SuccessfulIndexedDbRequest(this.#values.get(key))
  }

  values(): readonly (readonly [
    LocalSetupMetadataPutOperation['key'],
    LocalSetupMetadataPutOperation['value'],
  ])[] {
    return [...this.#values.entries()]
  }
}

class FakeMetadataDatabasePort implements LocalStoreIndexedDbMetadataDatabasePort {
  transaction = new FakeMetadataTransactionHandle()

  openMetadataTransaction(): LocalStoreIndexedDbMetadataTransactionHandle {
    this.transaction = new FakeMetadataTransactionHandle(this.transaction.store.values())
    return this.transaction
  }
}

class FakeMetadataTransactionHandle implements LocalStoreIndexedDbMetadataTransactionHandle {
  readonly store: DeferredMetadataObjectStore
  readonly lifecycle = new DeferredTransactionLifecycle()

  constructor(
    values: readonly (readonly [
      LocalSetupMetadataPutOperation['key'],
      LocalSetupMetadataPutOperation['value'],
    ])[] = [],
  ) {
    this.store = new DeferredMetadataObjectStore(values)
  }
}

class DeferredMetadataObjectStore implements LocalStoreIndexedDbMetadataObjectStorePort {
  readonly operations: LocalStoreIndexedDbMetadataWriteOperation[] = []
  readonly readKeys: LocalSetupMetadataPutOperation['key'][] = []
  readonly #values = new Map<
    LocalSetupMetadataPutOperation['key'],
    LocalSetupMetadataPutOperation['value']
  >()
  readonly #requests: DeferredIndexedDbRequest<IDBValidKey>[] = []
  readonly #readRequests: DeferredIndexedDbRequest<
    LocalSetupMetadataPutOperation['value'] | undefined
  >[] = []

  constructor(
    values: readonly (readonly [
      LocalSetupMetadataPutOperation['key'],
      LocalSetupMetadataPutOperation['value'],
    ])[] = [],
  ) {
    for (const [key, value] of values) {
      this.#values.set(key, value)
    }
  }

  get(
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<LocalSetupMetadataPutOperation['value'] | undefined> {
    const request = new DeferredIndexedDbRequest<
      LocalSetupMetadataPutOperation['value'] | undefined
    >(this.#values.get(key))
    this.#readRequests.push(request)
    this.readKeys.push(key)
    return request
  }

  put(
    value: LocalSetupMetadataPutOperation['value'],
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<IDBValidKey> {
    const request = new DeferredIndexedDbRequest<IDBValidKey>(key)
    this.#requests.push(request)
    this.#values.set(key, value)
    this.operations.push({ kind: 'put', storeName: 'metadata', key, value })
    return request
  }

  succeedAll(): void {
    for (const request of this.#requests) {
      request.succeed()
    }
    for (const request of this.#readRequests) {
      request.succeed()
    }
  }

  values(): readonly (readonly [
    LocalSetupMetadataPutOperation['key'],
    LocalSetupMetadataPutOperation['value'],
  ])[] {
    return [...this.#values.entries()]
  }
}

class DeferredTransactionLifecycle implements LocalStoreIndexedDbTransactionLifecycle {
  readonly error = null
  onabort: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  #completed = false
  #oncomplete: ((event: Event) => void) | null = null

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

  complete(): void {
    if (this.oncomplete !== null) {
      this.oncomplete(new Event('complete'))
      return
    }
    this.#completed = true
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

class DeferredIndexedDbRequest<Result> implements LocalStoreIndexedDbRequest<Result> {
  readonly error = null
  onerror: ((event: Event) => void) | null = null
  onsuccess: ((event: Event) => void) | null = null

  constructor(readonly result: Result) {}

  succeed(): void {
    if (this.onsuccess !== null) {
      this.onsuccess(new Event('success'))
    }
  }
}
