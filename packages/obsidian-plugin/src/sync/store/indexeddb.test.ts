import {
  CURRENT_PROTOCOL_VERSION,
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  makeDeviceId,
  makeMessageId,
  makeOutboxPlanItemId,
  makeVaultId,
  makeYDocId,
  type DocId,
  type LocalStoreObjectStore,
  type OutboxPlanItemId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import { assert, expect, test } from 'vitest'

import { planOutboundQueueAckCompletion, planOutboundQueueSuccessCompletion } from '../engine/queue'
import {
  applyLocalStoreIndexedDbOpenEffect,
  commitLocalStoreIndexedDbConcreteWriteTransaction,
  commitLocalStoreIndexedDbDatabaseTransaction,
  commitLocalStoreIndexedDbTransaction,
  createLocalStoreIndexedDbTransactionPort,
  planLocalStoreIndexedDbReads,
  planLocalStoreIndexedDbWrites,
  type LocalStoreIndexedDbDatabasePort,
  type LocalStoreIndexedDbFactoryPort,
  type LocalStoreIndexedDbObjectStoreNameList,
  type LocalStoreIndexedDbObjectStorePort,
  type LocalStoreIndexedDbOpenRequest,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbSchemaDatabasePort,
  type LocalStoreIndexedDbTransactionHandle,
  type LocalStoreIndexedDbTransactionLifecycle,
  type LocalStoreIndexedDbTransactionPort,
  type LocalStoreIndexedDbWriteOperation,
} from '../store/indexeddb'
import {
  planLocalStoreAckCompletionTransaction,
  planLocalStoreSuccessCompletionTransaction,
  type LocalStoreOutboxRecord,
} from '../store/store'

const yUpdateId = outboxId('indexeddb-y-update-1')
const materializeId = outboxId('indexeddb-materialize-1')
const blobPutId = outboxId('indexeddb-blob-put-1')
const vaultId = makeVaultId('indexeddb-vault-1')
const deviceId = makeDeviceId('indexeddb-device-1')
const messageId = makeMessageId('indexeddb-message-1')
const fileDocId = { kind: 'file', ydocId: makeYDocId('indexeddb-doc-1') } satisfies DocId

test('local store indexeddb adapter plans reads from outbox before leases', () => {
  assert.deepEqual(
    planLocalStoreIndexedDbReads({
      outboxItemIds: [materializeId, yUpdateId],
      leaseItemIds: [yUpdateId],
    }),
    [
      { kind: 'get', storeName: 'outbox', key: materializeId },
      { kind: 'get', storeName: 'outbox', key: yUpdateId },
      { kind: 'get', storeName: 'running-leases', key: yUpdateId },
    ],
  )
})

test('local store indexeddb adapter maps driver writes to object-store operations', () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'done')
  const nextLease = runningLease(materializeId, 'materialize', 'worker-1', 31_000)
  const expectedLease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)

  assert.deepEqual(
    planLocalStoreIndexedDbWrites([
      { kind: 'put-outbox-record', record },
      { kind: 'put-lease-row', lease: nextLease },
      { kind: 'delete-lease-row', itemId: yUpdateId, expectedLease },
    ]),
    [
      { kind: 'put', storeName: 'outbox', key: yUpdateId, value: record },
      { kind: 'put', storeName: 'running-leases', key: materializeId, value: nextLease },
      { kind: 'delete', storeName: 'running-leases', key: yUpdateId, expectedLease },
    ],
  )
})

test('local store indexeddb adapter applies open effects and creates requested stores', async () => {
  const factory = new FakeIndexedDbFactory([])

  const plan = await applyLocalStoreIndexedDbOpenEffect({
    indexedDb: factory,
    effect: {
      kind: 'open-database',
      mode: 'create',
      dbName: 'kuroflare:indexeddb-vault-1',
      version: 3,
      createStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
    },
  })

  assert.equal(plan.ok, true)
  if (!plan.ok || plan.kind !== 'open-database') {
    throw new Error(`unexpected indexeddb open plan: ${JSON.stringify(plan)}`)
  }
  assert.equal(plan.kind, 'open-database')
  assert.deepEqual(plan.createdStores, DEFAULT_LOCAL_STORE_OBJECT_STORES)
  assert.deepEqual(factory.operations, [
    { kind: 'open', name: 'kuroflare:indexeddb-vault-1', version: 3 },
  ])
  assert.deepEqual(factory.database.storeNames(), DEFAULT_LOCAL_STORE_OBJECT_STORES)
})

test('local store indexeddb adapter skips existing stores during upgrades', async () => {
  const factory = new FakeIndexedDbFactory(['outbox'])

  const plan = await applyLocalStoreIndexedDbOpenEffect({
    indexedDb: factory,
    effect: {
      kind: 'open-database',
      mode: 'upgrade',
      dbName: 'kuroflare:indexeddb-vault-1',
      version: 3,
      createStores: ['outbox', 'running-leases'],
    },
  })

  assert.equal(plan.ok, true)
  if (!plan.ok || plan.kind !== 'open-database') {
    throw new Error(`unexpected indexeddb open plan: ${JSON.stringify(plan)}`)
  }
  assert.equal(plan.kind, 'open-database')
  assert.deepEqual(plan.createdStores, ['running-leases'])
  assert.deepEqual(factory.database.createdStores, ['running-leases'])
  assert.deepEqual(factory.database.storeNames(), ['outbox', 'running-leases'])
})

test('local store indexeddb adapter applies delete effects before rebuild open', async () => {
  const factory = new FakeIndexedDbFactory(['outbox'])

  assert.deepEqual(
    await applyLocalStoreIndexedDbOpenEffect({
      indexedDb: factory,
      effect: {
        kind: 'delete-database',
        dbName: 'kuroflare:indexeddb-vault-1',
        reason: 'store-version-too-old',
      },
    }),
    {
      ok: true,
      kind: 'delete-database',
      dbName: 'kuroflare:indexeddb-vault-1',
      reason: 'store-version-too-old',
    },
  )
  assert.deepEqual(factory.operations, [
    { kind: 'deleteDatabase', name: 'kuroflare:indexeddb-vault-1' },
  ])
  assert.deepEqual(factory.database.storeNames(), [])
})

test('local store indexeddb adapter commits operations through a transaction port', async () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const port = new MemoryIndexedDbTransactionPort({
    outboxRecords: [record],
    leaseRows: [lease],
  })
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 21,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = await commitLocalStoreIndexedDbTransaction({
      operations: planLocalStoreAckCompletionTransaction(completion),
      port,
    })

    assert.equal(plan.ok, true)
    if (plan.ok) {
      assert.deepEqual(plan.reads, [
        { kind: 'get', storeName: 'outbox', key: yUpdateId },
        { kind: 'get', storeName: 'running-leases', key: yUpdateId },
      ])
      assert.deepEqual(plan.writes, [
        {
          kind: 'put',
          storeName: 'outbox',
          key: yUpdateId,
          value: {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
            durableSeq: 21,
          },
        },
        { kind: 'delete', storeName: 'running-leases', key: yUpdateId, expectedLease: lease },
      ])
    }
    assert.deepEqual(port.outboxRows(), [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 21,
      },
    ])
    assert.deepEqual(port.leaseRows(), [])
  }
})

test('local store indexeddb adapter commits non-ack success completion through a transaction port', async () => {
  const record = outboxRecord(blobPutId, 'blob-put', 'retrying')
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const port = new MemoryIndexedDbTransactionPort({
    outboxRecords: [record],
    leaseRows: [lease],
  })
  const completion = planOutboundQueueSuccessCompletion({
    itemId: blobPutId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = await commitLocalStoreIndexedDbTransaction({
      operations: planLocalStoreSuccessCompletionTransaction(completion),
      port,
    })

    assert.equal(plan.ok, true)
    if (plan.ok) {
      assert.deepEqual(plan.reads, [
        { kind: 'get', storeName: 'outbox', key: blobPutId },
        { kind: 'get', storeName: 'running-leases', key: blobPutId },
      ])
      assert.deepEqual(plan.writes, [
        {
          kind: 'put',
          storeName: 'outbox',
          key: blobPutId,
          value: {
            ...record,
            status: 'done',
            nextAttemptAt: undefined,
          },
        },
        { kind: 'delete', storeName: 'running-leases', key: blobPutId, expectedLease: lease },
      ])
    }
    assert.deepEqual(port.outboxRows(), [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
      },
    ])
    assert.deepEqual(port.leaseRows(), [])
  }
})

test('local store indexeddb adapter does not write when commit validation fails', async () => {
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const port = new MemoryIndexedDbTransactionPort({
    outboxRecords: [],
    leaseRows: [lease],
  })
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 22,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = await commitLocalStoreIndexedDbTransaction({
      operations: planLocalStoreAckCompletionTransaction(completion),
      port,
    })

    assert.deepEqual(plan, {
      ok: false,
      phase: 'commit',
      reason: 'missing-outbox-item',
      itemId: yUpdateId,
      readSet: { outboxItemIds: [yUpdateId], leaseItemIds: [yUpdateId] },
      reads: [
        { kind: 'get', storeName: 'outbox', key: yUpdateId },
        { kind: 'get', storeName: 'running-leases', key: yUpdateId },
      ],
      snapshot: { outboxRecords: [], leaseRows: [lease] },
      commit: {
        ok: false,
        reason: 'missing-outbox-item',
        itemId: yUpdateId,
        apply: {
          ok: false,
          reason: 'missing-outbox-item',
          itemId: yUpdateId,
          commit: { ok: false, reason: 'missing-outbox-item', itemId: yUpdateId },
        },
      },
    })
    assert.deepEqual(port.writeLog, [])
    assert.deepEqual(port.leaseRows(), [lease])
  }
})

test('local store indexeddb adapter creates a transaction port from object stores', async () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'pending')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const outboxStore = new FakeIndexedDbObjectStore<LocalStoreOutboxRecord>([record])
  const leaseStore = new FakeIndexedDbObjectStore<OutboxRunningLease>([lease])
  const port = createLocalStoreIndexedDbTransactionPort({
    outbox: outboxStore,
    runningLeases: leaseStore,
  })

  assert.deepEqual(await port.getOutboxRecord(yUpdateId), record)
  assert.deepEqual(await port.getRunningLease(yUpdateId), lease)

  const doneRecord = { ...record, status: 'done' } satisfies LocalStoreOutboxRecord
  await port.putOutboxRecord(doneRecord)
  await port.deleteRunningLease(yUpdateId, lease)

  assert.deepEqual(outboxStore.values(), [doneRecord])
  assert.deepEqual(leaseStore.values(), [])
  assert.deepEqual(outboxStore.operations, [
    { kind: 'get', key: yUpdateId },
    { kind: 'put', key: yUpdateId, value: doneRecord },
  ])
  assert.deepEqual(leaseStore.operations, [
    { kind: 'get', key: yUpdateId },
    { kind: 'delete', key: yUpdateId },
  ])
})

test('local store indexeddb database transaction waits for transaction completion', async () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const database = new FakeIndexedDbDatabasePort({
    outboxRecords: [record],
    leaseRows: [lease],
    completion: 'complete',
  })
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 23,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = await commitLocalStoreIndexedDbDatabaseTransaction({
      operations: planLocalStoreAckCompletionTransaction(completion),
      database,
    })

    assert.equal(plan.ok, true)
    assert.equal(database.openCount, 1)
    assert.equal(database.lifecycle.completed, true)
    assert.deepEqual(database.outboxRows(), [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 23,
      },
    ])
    assert.deepEqual(database.leaseRows(), [])
  }
})

test('local store indexeddb database transaction persists non-ack success completion', async () => {
  const record = outboxRecord(blobPutId, 'blob-put', 'retrying')
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const database = new FakeIndexedDbDatabasePort({
    outboxRecords: [record],
    leaseRows: [lease],
    completion: 'complete',
  })
  const completion = planOutboundQueueSuccessCompletion({
    itemId: blobPutId,
    kind: 'blob-put',
    status: 'retrying',
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const plan = await commitLocalStoreIndexedDbDatabaseTransaction({
      operations: planLocalStoreSuccessCompletionTransaction(completion),
      database,
    })

    assert.equal(plan.ok, true)
    assert.equal(database.openCount, 1)
    assert.equal(database.lifecycle.completed, true)
    assert.deepEqual(database.outboxRows(), [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
      },
    ])
    assert.deepEqual(database.leaseRows(), [])
  }
})

test('local store indexeddb concrete write transaction queues all writes before awaiting requests', async () => {
  const record = outboxRecord(blobPutId, 'blob-put', 'retrying')
  const doneRecord = {
    ...record,
    status: 'done',
    nextAttemptAt: undefined,
  } satisfies LocalStoreOutboxRecord
  const lease = runningLease(blobPutId, 'blob-put', 'worker-1', 30_000)
  const database = new DeferredIndexedDbDatabasePort({
    outboxRecords: [record],
    leaseRows: [lease],
  })
  const writes: LocalStoreIndexedDbWriteOperation[] = [
    { kind: 'put', storeName: 'outbox', key: blobPutId, value: doneRecord },
    { kind: 'delete', storeName: 'running-leases', key: blobPutId, expectedLease: lease },
  ]
  const committed = commitLocalStoreIndexedDbConcreteWriteTransaction({ database, writes })
  let completed = false
  void committed.then(() => {
    completed = true
  })

  assert.deepEqual(database.outboxOperations, [{ kind: 'put', key: blobPutId, value: doneRecord }])
  assert.deepEqual(database.leaseOperations, [{ kind: 'delete', key: blobPutId }])

  database.succeedRequests()
  await Promise.resolve()
  assert.equal(completed, false)

  database.completeTransaction()
  await committed
  assert.equal(completed, true)
  assert.deepEqual(database.outboxRows(), [doneRecord])
  assert.deepEqual(database.leaseRows(), [])
})

test('local store indexeddb database transaction queues writes from the final read callback', async () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const database = new DeferredIndexedDbDatabasePort({
    outboxRecords: [record],
    leaseRows: [lease],
  })
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 25,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    const committed = commitLocalStoreIndexedDbDatabaseTransaction({
      operations: planLocalStoreAckCompletionTransaction(completion),
      database,
    })
    let completed = false
    void committed.then(() => {
      completed = true
    })

    assert.deepEqual(database.outboxOperations, [{ kind: 'get', key: yUpdateId }])
    assert.deepEqual(database.leaseOperations, [{ kind: 'get', key: yUpdateId }])

    database.succeedPendingRequests()
    await Promise.resolve()

    assert.deepEqual(database.outboxOperations, [
      { kind: 'get', key: yUpdateId },
      {
        kind: 'put',
        key: yUpdateId,
        value: {
          ...record,
          status: 'done',
          nextAttemptAt: undefined,
          durableSeq: 25,
        },
      },
    ])
    assert.deepEqual(database.leaseOperations, [
      { kind: 'get', key: yUpdateId },
      { kind: 'delete', key: yUpdateId },
    ])
    assert.equal(completed, false)

    database.succeedPendingRequests()
    database.completeTransaction()
    const plan = await committed

    assert.equal(plan.ok, true)
    assert.equal(completed, true)
    assert.deepEqual(database.outboxRows(), [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 25,
      },
    ])
    assert.deepEqual(database.leaseRows(), [])
  }
})

test('local store indexeddb database transaction rejects aborted commits', async () => {
  const record = outboxRecord(yUpdateId, 'y-update', 'retrying')
  const lease = runningLease(yUpdateId, 'y-update', 'worker-1', 30_000)
  const database = new FakeIndexedDbDatabasePort({
    outboxRecords: [record],
    leaseRows: [lease],
    completion: 'abort',
  })
  const completion = planOutboundQueueAckCompletion({
    itemId: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    vaultId,
    deviceId,
    docId: fileDocId,
    messageId,
    message: {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      docId: fileDocId,
      messageId,
      durableSeq: 24,
    },
    ownerId: 'worker-1',
    now: 1_000,
    existingLease: lease,
  })
  assert.equal(completion.ok, true)

  if (completion.ok) {
    await expect(
      async () =>
        await commitLocalStoreIndexedDbDatabaseTransaction({
          operations: planLocalStoreAckCompletionTransaction(completion),
          database,
        }),
    ).rejects.toThrow(/fake transaction aborted/)
    assert.equal(database.lifecycle.aborted, true)
  }
})

function outboxId(value: string): OutboxPlanItemId {
  const itemId = makeOutboxPlanItemId(value)
  assert(itemId !== null)
  return itemId
}

function outboxRecord(
  id: OutboxPlanItemId,
  kind: LocalStoreOutboxRecord['kind'],
  status: LocalStoreOutboxRecord['status'],
): LocalStoreOutboxRecord {
  return {
    id,
    kind,
    status,
    dependsOn: [],
    nextAttemptAt: undefined,
  }
}

function runningLease(
  itemId: OutboxPlanItemId,
  kind: OutboxRunningLease['kind'],
  ownerId: string,
  leaseExpiresAt: number,
): OutboxRunningLease {
  return { itemId, kind, ownerId, leaseExpiresAt }
}

class MemoryIndexedDbTransactionPort implements LocalStoreIndexedDbTransactionPort {
  readonly #outboxRecords = new Map<OutboxPlanItemId, LocalStoreOutboxRecord>()
  readonly #leaseRows = new Map<OutboxPlanItemId, OutboxRunningLease>()
  readonly writeLog: LocalStoreIndexedDbWriteOperation[] = []

  constructor(snapshot: {
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  }) {
    for (const record of snapshot.outboxRecords) {
      this.#outboxRecords.set(record.id, record)
    }
    for (const lease of snapshot.leaseRows) {
      this.#leaseRows.set(lease.itemId, lease)
    }
  }

  async getOutboxRecord(key: OutboxPlanItemId): Promise<LocalStoreOutboxRecord | undefined> {
    return this.#outboxRecords.get(key)
  }

  async getRunningLease(key: OutboxPlanItemId): Promise<OutboxRunningLease | undefined> {
    return this.#leaseRows.get(key)
  }

  async putOutboxRecord(record: LocalStoreOutboxRecord): Promise<void> {
    this.#outboxRecords.set(record.id, record)
    this.writeLog.push({ kind: 'put', storeName: 'outbox', key: record.id, value: record })
  }

  async putRunningLease(lease: OutboxRunningLease): Promise<void> {
    this.#leaseRows.set(lease.itemId, lease)
    this.writeLog.push({
      kind: 'put',
      storeName: 'running-leases',
      key: lease.itemId,
      value: lease,
    })
  }

  async deleteRunningLease(
    key: OutboxPlanItemId,
    expectedLease: OutboxRunningLease,
  ): Promise<void> {
    this.#leaseRows.delete(key)
    this.writeLog.push({ kind: 'delete', storeName: 'running-leases', key, expectedLease })
  }

  outboxRows(): readonly LocalStoreOutboxRecord[] {
    return [...this.#outboxRecords.values()]
  }

  leaseRows(): readonly OutboxRunningLease[] {
    return [...this.#leaseRows.values()]
  }
}

type FakeIndexedDbObjectStoreOperation<Value> =
  | { readonly kind: 'get'; readonly key: IDBValidKey }
  | { readonly kind: 'put'; readonly key: IDBValidKey | undefined; readonly value: Value }
  | { readonly kind: 'delete'; readonly key: IDBValidKey }

class FakeIndexedDbObjectStore<
  Value extends { readonly id?: OutboxPlanItemId; readonly itemId?: OutboxPlanItemId },
> implements LocalStoreIndexedDbObjectStorePort<Value> {
  readonly #values = new Map<IDBValidKey, Value>()
  readonly operations: FakeIndexedDbObjectStoreOperation<Value>[] = []

  constructor(values: readonly Value[]) {
    for (const value of values) {
      const key = value.id ?? value.itemId
      assert(key !== undefined)
      this.#values.set(key, value)
    }
  }

  get(key: IDBValidKey): LocalStoreIndexedDbRequest<Value | undefined> {
    this.operations.push({ kind: 'get', key })
    return new SuccessfulIndexedDbRequest(this.#values.get(key))
  }

  put(value: Value, key: IDBValidKey | undefined): LocalStoreIndexedDbRequest<IDBValidKey> {
    this.operations.push({ kind: 'put', key, value })
    const storedKey = key ?? value.id ?? value.itemId
    assert(storedKey !== undefined)
    this.#values.set(storedKey, value)
    return new SuccessfulIndexedDbRequest(storedKey)
  }

  delete(key: IDBValidKey): LocalStoreIndexedDbRequest<undefined> {
    this.operations.push({ kind: 'delete', key })
    this.#values.delete(key)
    return new SuccessfulIndexedDbRequest(undefined)
  }

  values(): readonly Value[] {
    return [...this.#values.values()]
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

type FakeIndexedDbFactoryOperation =
  | { readonly kind: 'open'; readonly name: string; readonly version: number }
  | { readonly kind: 'deleteDatabase'; readonly name: string }

class FakeIndexedDbFactory implements LocalStoreIndexedDbFactoryPort<FakeIndexedDbSchemaDatabase> {
  readonly database: FakeIndexedDbSchemaDatabase
  readonly operations: FakeIndexedDbFactoryOperation[] = []

  constructor(storeNames: readonly LocalStoreObjectStore[]) {
    this.database = new FakeIndexedDbSchemaDatabase(storeNames)
  }

  open(name: string, version: number): LocalStoreIndexedDbOpenRequest<FakeIndexedDbSchemaDatabase> {
    this.operations.push({ kind: 'open', name, version })
    return new SuccessfulIndexedDbOpenRequest(this.database)
  }

  deleteDatabase(name: string): LocalStoreIndexedDbRequest<undefined> {
    this.operations.push({ kind: 'deleteDatabase', name })
    this.database.clearStores()
    return new SuccessfulIndexedDbRequest(undefined)
  }
}

class FakeIndexedDbSchemaDatabase implements LocalStoreIndexedDbSchemaDatabasePort {
  readonly objectStoreNames: LocalStoreIndexedDbObjectStoreNameList
  readonly createdStores: LocalStoreObjectStore[] = []
  readonly #storeNames = new Set<LocalStoreObjectStore>()

  constructor(storeNames: readonly LocalStoreObjectStore[]) {
    for (const storeName of storeNames) {
      this.#storeNames.add(storeName)
    }
    this.objectStoreNames = {
      contains: (name) => this.#storeNames.has(localStoreObjectStoreName(name)),
    }
  }

  createObjectStore(name: LocalStoreObjectStore): unknown {
    this.#storeNames.add(name)
    this.createdStores.push(name)
    return {}
  }

  clearStores(): void {
    this.#storeNames.clear()
    this.createdStores.length = 0
  }

  storeNames(): readonly LocalStoreObjectStore[] {
    return DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((storeName) => this.#storeNames.has(storeName))
  }
}

class SuccessfulIndexedDbOpenRequest implements LocalStoreIndexedDbOpenRequest<FakeIndexedDbSchemaDatabase> {
  readonly error = null
  onerror: ((event: Event) => void) | null = null
  onsuccess: ((event: Event) => void) | null = null
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null

  constructor(readonly result: FakeIndexedDbSchemaDatabase) {
    queueMicrotask(() => {
      if (this.onupgradeneeded !== null) {
        this.onupgradeneeded(idbVersionChangeEvent())
      }
      if (this.onsuccess !== null) {
        this.onsuccess(new Event('success'))
      }
    })
  }
}

function idbVersionChangeEvent(): IDBVersionChangeEvent {
  return new FakeIDBVersionChangeEvent()
}

class FakeIDBVersionChangeEvent extends Event implements IDBVersionChangeEvent {
  readonly newVersion = null
  readonly oldVersion = 0

  constructor() {
    super('upgradeneeded')
  }
}

function localStoreObjectStoreName(name: string): LocalStoreObjectStore {
  for (const storeName of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
    if (storeName === name) {
      return storeName
    }
  }
  assert.fail(`unexpected local store object store name: ${name}`)
}

class FakeIndexedDbDatabasePort implements LocalStoreIndexedDbDatabasePort {
  readonly #outboxStore: FakeIndexedDbObjectStore<LocalStoreOutboxRecord>
  readonly #leaseStore: FakeIndexedDbObjectStore<OutboxRunningLease>
  readonly lifecycle: FakeIndexedDbTransactionLifecycle
  openCount = 0

  constructor(input: {
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
    readonly completion: 'complete' | 'abort'
  }) {
    this.#outboxStore = new FakeIndexedDbObjectStore(input.outboxRecords)
    this.#leaseStore = new FakeIndexedDbObjectStore(input.leaseRows)
    this.lifecycle = new FakeIndexedDbTransactionLifecycle(input.completion)
  }

  openOutboxTransaction(): LocalStoreIndexedDbTransactionHandle {
    this.openCount += 1
    this.lifecycle.schedule()
    return {
      stores: {
        outbox: this.#outboxStore,
        runningLeases: this.#leaseStore,
      },
      lifecycle: this.lifecycle,
    }
  }

  outboxRows(): readonly LocalStoreOutboxRecord[] {
    return this.#outboxStore.values()
  }

  leaseRows(): readonly OutboxRunningLease[] {
    return this.#leaseStore.values()
  }
}

class DeferredIndexedDbDatabasePort implements LocalStoreIndexedDbDatabasePort {
  readonly #outboxStore: DeferredIndexedDbObjectStore<LocalStoreOutboxRecord>
  readonly #leaseStore: DeferredIndexedDbObjectStore<OutboxRunningLease>
  readonly lifecycle = new ManualIndexedDbTransactionLifecycle()

  constructor(input: {
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  }) {
    this.#outboxStore = new DeferredIndexedDbObjectStore(input.outboxRecords)
    this.#leaseStore = new DeferredIndexedDbObjectStore(input.leaseRows)
  }

  openOutboxTransaction(): LocalStoreIndexedDbTransactionHandle {
    return {
      stores: {
        outbox: this.#outboxStore,
        runningLeases: this.#leaseStore,
      },
      lifecycle: this.lifecycle,
    }
  }

  get outboxOperations(): readonly FakeIndexedDbObjectStoreOperation<LocalStoreOutboxRecord>[] {
    return this.#outboxStore.operations
  }

  get leaseOperations(): readonly FakeIndexedDbObjectStoreOperation<OutboxRunningLease>[] {
    return this.#leaseStore.operations
  }

  succeedRequests(): void {
    this.#outboxStore.succeedRequests()
    this.#leaseStore.succeedRequests()
  }

  succeedPendingRequests(): void {
    this.#outboxStore.succeedPendingRequests()
    this.#leaseStore.succeedPendingRequests()
  }

  completeTransaction(): void {
    this.lifecycle.complete()
  }

  outboxRows(): readonly LocalStoreOutboxRecord[] {
    return this.#outboxStore.values()
  }

  leaseRows(): readonly OutboxRunningLease[] {
    return this.#leaseStore.values()
  }
}

class DeferredIndexedDbObjectStore<
  Value extends { readonly id?: OutboxPlanItemId; readonly itemId?: OutboxPlanItemId },
> implements LocalStoreIndexedDbObjectStorePort<Value> {
  readonly #values = new Map<IDBValidKey, Value>()
  readonly #requests: DeferredIndexedDbRequest<unknown>[] = []
  #nextRequestToSucceed = 0
  readonly operations: FakeIndexedDbObjectStoreOperation<Value>[] = []

  constructor(values: readonly Value[]) {
    for (const value of values) {
      const key = value.id ?? value.itemId
      assert(key !== undefined)
      this.#values.set(key, value)
    }
  }

  get(key: IDBValidKey): LocalStoreIndexedDbRequest<Value | undefined> {
    this.operations.push({ kind: 'get', key })
    const request = new DeferredIndexedDbRequest<Value | undefined>(this.#values.get(key))
    this.#requests.push(request)
    return request
  }

  put(value: Value, key: IDBValidKey | undefined): LocalStoreIndexedDbRequest<IDBValidKey> {
    this.operations.push({ kind: 'put', key, value })
    const storedKey = key ?? value.id ?? value.itemId
    assert(storedKey !== undefined)
    this.#values.set(storedKey, value)
    const request = new DeferredIndexedDbRequest<IDBValidKey>(storedKey)
    this.#requests.push(request)
    return request
  }

  delete(key: IDBValidKey): LocalStoreIndexedDbRequest<undefined> {
    this.operations.push({ kind: 'delete', key })
    this.#values.delete(key)
    const request = new DeferredIndexedDbRequest<undefined>(undefined)
    this.#requests.push(request)
    return request
  }

  succeedRequests(): void {
    while (this.#nextRequestToSucceed < this.#requests.length) {
      const request = this.#requests[this.#nextRequestToSucceed]
      this.#nextRequestToSucceed += 1
      request?.succeed()
    }
  }

  succeedPendingRequests(): void {
    const requestCount = this.#requests.length
    while (this.#nextRequestToSucceed < requestCount) {
      const request = this.#requests[this.#nextRequestToSucceed]
      this.#nextRequestToSucceed += 1
      assert(request !== undefined)
      request.succeed()
    }
  }

  values(): readonly Value[] {
    return [...this.#values.values()]
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

class ManualIndexedDbTransactionLifecycle implements LocalStoreIndexedDbTransactionLifecycle {
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

class FakeIndexedDbTransactionLifecycle implements LocalStoreIndexedDbTransactionLifecycle {
  readonly error: DOMException | null
  onabort: ((event: Event) => void) | null = null
  oncomplete: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  aborted = false
  completed = false

  constructor(readonly completion: 'complete' | 'abort') {
    this.error =
      completion === 'abort' ? new DOMException('fake transaction aborted', 'AbortError') : null
  }

  schedule(): void {
    setTimeout(() => {
      if (this.completion === 'complete') {
        this.completed = true
        if (this.oncomplete !== null) {
          this.oncomplete(new Event('complete'))
        }
        return
      }

      this.aborted = true
      if (this.onabort !== null) {
        this.onabort(new Event('abort'))
      }
    }, 0)
  }
}
