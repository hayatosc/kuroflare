import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  type LocalStoreObjectStore,
  type OutboxPlanItemId,
  type OutboxRunningLease,
} from '@kuroflare/core'

import {
  applyLocalStoreDriverCommit,
  planLocalStoreDriverReadSet,
  type LocalStoreDriverCommitPlan,
  type LocalStoreDriverReadSet,
  type LocalStoreDriverSnapshot,
  type LocalStoreDriverWriteOperation,
} from '../store/driver'
import { type LocalStoreIndexedDbOpenEffect } from '../store/schema'
import { type LocalStoreOutboxRecord, type LocalStoreTransactionOperation } from '../store/store'
import {
  LOCAL_AUTH_METADATA_KEY,
  LOCAL_SETUP_METADATA_KEY,
  planLocalSetupMetadataSnapshot,
  type LocalSetupMetadataPutOperation,
  type LocalSetupMetadataSnapshotDecision,
} from '../engine/setup'

import type {
  LocalStoreIndexedDbStoreName,
  LocalStoreIndexedDbReadOperation,
  LocalStoreIndexedDbWriteOperation,
  LocalStoreIndexedDbMetadataWriteOperation,
  LocalStoreIndexedDbTransactionPort,
  LocalStoreIndexedDbRequest,
  LocalStoreIndexedDbDatabaseInfo,
  LocalStoreIndexedDbOpenRequest,
  LocalStoreIndexedDbObjectStoreNameList,
  LocalStoreIndexedDbSchemaProbeFactoryPort,
  LocalStoreIndexedDbCountObjectStorePort,
  LocalStoreIndexedDbSchemaProbeTransactionPort,
  LocalStoreIndexedDbSchemaProbeDatabasePort,
  LocalStoreIndexedDbSchemaDatabasePort,
  LocalStoreIndexedDbFactoryPort,
  BrowserLocalStoreIndexedDbFactoryPort,
  LocalStoreIndexedDbObjectStorePort,
  LocalStoreIndexedDbMetadataObjectStorePort,
  LocalStoreIndexedDbObjectStorePorts,
  LocalStoreIndexedDbTransactionLifecycle,
  LocalStoreIndexedDbTransactionHandle,
  LocalStoreIndexedDbQueuedReadRequest,
  LocalStoreIndexedDbMetadataTransactionHandle,
  LocalStoreIndexedDbDatabasePort,
  LocalStoreIndexedDbMetadataDatabasePort,
  LocalStoreIndexedDbTransactionInput,
  LocalStoreIndexedDbDatabaseTransactionInput,
  LocalStoreIndexedDbQueuedTransactionInput,
  LocalStoreIndexedDbConcreteWriteTransactionInput,
  LocalStoreIndexedDbMetadataTransactionInput,
  LocalStoreIndexedDbMetadataSnapshotInput,
  LocalStoreIndexedDbExecutableOpenEffect,
  LocalStoreIndexedDbOpenEffectInput,
  LocalStoreIndexedDbOpenEffectPlan,
  LocalStoreIndexedDbSchemaEvidenceInput,
  LocalStoreIndexedDbSchemaEvidence,
  LocalStoreIndexedDbSchemaEvidencePlan,
  SuccessfulLocalStoreIndexedDbTransactionPlan,
  FailedLocalStoreIndexedDbTransactionPlan,
  LocalStoreIndexedDbTransactionPlan,
} from '../store/ports'

export type {
  LocalStoreIndexedDbStoreName,
  LocalStoreIndexedDbReadOperation,
  LocalStoreIndexedDbWriteOperation,
  LocalStoreIndexedDbMetadataWriteOperation,
  LocalStoreIndexedDbTransactionPort,
  LocalStoreIndexedDbRequest,
  LocalStoreIndexedDbDatabaseInfo,
  LocalStoreIndexedDbOpenRequest,
  LocalStoreIndexedDbObjectStoreNameList,
  LocalStoreIndexedDbSchemaProbeFactoryPort,
  LocalStoreIndexedDbCountObjectStorePort,
  LocalStoreIndexedDbSchemaProbeTransactionPort,
  LocalStoreIndexedDbSchemaProbeDatabasePort,
  LocalStoreIndexedDbSchemaDatabasePort,
  LocalStoreIndexedDbFactoryPort,
  BrowserLocalStoreIndexedDbFactoryPort,
  LocalStoreIndexedDbObjectStorePort,
  LocalStoreIndexedDbMetadataObjectStorePort,
  LocalStoreIndexedDbObjectStorePorts,
  LocalStoreIndexedDbTransactionLifecycle,
  LocalStoreIndexedDbTransactionHandle,
  LocalStoreIndexedDbQueuedReadRequest,
  LocalStoreIndexedDbMetadataTransactionHandle,
  LocalStoreIndexedDbDatabasePort,
  LocalStoreIndexedDbMetadataDatabasePort,
  LocalStoreIndexedDbTransactionInput,
  LocalStoreIndexedDbDatabaseTransactionInput,
  LocalStoreIndexedDbQueuedTransactionInput,
  LocalStoreIndexedDbConcreteWriteTransactionInput,
  LocalStoreIndexedDbMetadataTransactionInput,
  LocalStoreIndexedDbMetadataSnapshotInput,
  LocalStoreIndexedDbExecutableOpenEffect,
  LocalStoreIndexedDbOpenEffectInput,
  LocalStoreIndexedDbOpenEffectPlan,
  LocalStoreIndexedDbSchemaEvidenceInput,
  LocalStoreIndexedDbSchemaEvidence,
  LocalStoreIndexedDbSchemaEvidencePlan,
  SuccessfulLocalStoreIndexedDbTransactionPlan,
  FailedLocalStoreIndexedDbTransactionPlan,
  LocalStoreIndexedDbTransactionPlan,
}

/**
 * Converts a local-store driver read set into ordered IndexedDB get operations.
 */
export function planLocalStoreIndexedDbReads(
  readSet: LocalStoreDriverReadSet,
): readonly LocalStoreIndexedDbReadOperation[] {
  return [
    ...readSet.outboxItemIds.map(
      (key): LocalStoreIndexedDbReadOperation => ({ kind: 'get', storeName: 'outbox', key }),
    ),
    ...readSet.leaseItemIds.map(
      (key): LocalStoreIndexedDbReadOperation => ({
        kind: 'get',
        storeName: 'running-leases',
        key,
      }),
    ),
  ]
}

/**
 * Converts local-store driver writes into ordered IndexedDB write operations.
 */
export function planLocalStoreIndexedDbWrites(
  writes: readonly LocalStoreDriverWriteOperation[],
): readonly LocalStoreIndexedDbWriteOperation[] {
  return writes.map((write): LocalStoreIndexedDbWriteOperation => {
    if (write.kind === 'put-outbox-record') {
      return {
        kind: 'put',
        storeName: 'outbox',
        key: write.record.id,
        value: write.record,
      }
    }
    if (write.kind === 'put-lease-row') {
      return {
        kind: 'put',
        storeName: 'running-leases',
        key: write.lease.itemId,
        value: write.lease,
      }
    }
    return {
      kind: 'delete',
      storeName: 'running-leases',
      key: write.itemId,
      expectedLease: write.expectedLease,
    }
  })
}

/**
 * Converts setup metadata puts into ordered IndexedDB metadata store writes.
 */
export function planLocalStoreIndexedDbMetadataWrites(
  writes: readonly LocalSetupMetadataPutOperation[],
): readonly LocalStoreIndexedDbMetadataWriteOperation[] {
  return writes.map(
    (write): LocalStoreIndexedDbMetadataWriteOperation => ({
      kind: 'put',
      storeName: 'metadata',
      key: write.key,
      value: write.value,
    }),
  )
}

/**
 * Creates a local-store transaction port from already-open IndexedDB object stores.
 */
export function createLocalStoreIndexedDbTransactionPort(
  stores: LocalStoreIndexedDbObjectStorePorts,
): LocalStoreIndexedDbTransactionPort {
  return {
    async getOutboxRecord(key) {
      return await waitForIndexedDbRequest(stores.outbox.get(key))
    },
    async getRunningLease(key) {
      return await waitForIndexedDbRequest(stores.runningLeases.get(key))
    },
    async putOutboxRecord(record) {
      await waitForIndexedDbRequest(stores.outbox.put(record, record.id))
    },
    async putRunningLease(lease) {
      await waitForIndexedDbRequest(stores.runningLeases.put(lease, lease.itemId))
    },
    async deleteRunningLease(key) {
      await waitForIndexedDbRequest(stores.runningLeases.delete(key))
    },
  }
}

/**
 * Creates a local-store transaction port from a concrete IndexedDB transaction.
 */
export function createLocalStoreIndexedDbTransactionPortFromIdbTransaction(
  transaction: IDBTransaction,
): LocalStoreIndexedDbTransactionPort {
  return createLocalStoreIndexedDbTransactionPort({
    outbox: transaction.objectStore('outbox'),
    runningLeases: transaction.objectStore('running-leases'),
  })
}

/**
 * Creates a database port from a concrete IndexedDB database.
 */
export function createLocalStoreIndexedDbDatabasePort(
  database: IDBDatabase,
): LocalStoreIndexedDbDatabasePort {
  return {
    openOutboxTransaction() {
      const transaction = database.transaction(['outbox', 'running-leases'], 'readwrite')
      return {
        stores: {
          outbox: transaction.objectStore('outbox'),
          runningLeases: transaction.objectStore('running-leases'),
        },
        lifecycle: transaction,
      }
    },
  }
}

/**
 * Creates a setup metadata database port from a concrete IndexedDB database.
 */
export function createLocalStoreIndexedDbMetadataDatabasePort(
  database: IDBDatabase,
): LocalStoreIndexedDbMetadataDatabasePort {
  return {
    openMetadataTransaction(mode = 'readwrite') {
      const transaction = database.transaction(['metadata'], mode)
      return {
        store: transaction.objectStore('metadata'),
        lifecycle: transaction,
      }
    },
  }
}

/**
 * Adapts the browser IndexedDB factory into the local-store runtime factory port.
 */
export function createBrowserLocalStoreIndexedDbFactoryPort(
  indexedDb: IDBFactory,
): BrowserLocalStoreIndexedDbFactoryPort {
  return indexedDb
}

/**
 * Reads local-store schema evidence from IndexedDB without creating missing databases.
 */
export async function readLocalStoreIndexedDbSchemaEvidence<
  Database extends LocalStoreIndexedDbSchemaProbeDatabasePort,
>(
  input: LocalStoreIndexedDbSchemaEvidenceInput<Database>,
): Promise<LocalStoreIndexedDbSchemaEvidencePlan> {
  if (input.indexedDb.databases === undefined) {
    return { ok: false, reason: 'database-directory-unavailable' }
  }

  const databases = await input.indexedDb.databases()
  const matches = databases.filter((database) => database.name === input.dbName)
  if (matches.length > 1) {
    return { ok: false, reason: 'duplicate-database-name' }
  }
  if (matches.length === 0) {
    return {
      ok: true,
      evidence: {
        dbExists: false,
        currentVersion: undefined,
        presentStores: [],
        pendingOutboxCount: 0,
      },
    }
  }

  const listedVersion = matches[0]?.version
  if (listedVersion !== undefined && !isPositiveSafeInteger(listedVersion)) {
    return { ok: false, reason: 'invalid-database-version' }
  }

  const database = await waitForIndexedDbRequest(input.indexedDb.open(input.dbName))
  try {
    if (!isPositiveSafeInteger(database.version)) {
      return { ok: false, reason: 'invalid-database-version' }
    }
    const presentStores = localStoreObjectStoresFromNames(database.objectStoreNames)
    const pendingOutboxCount = await readPendingOutboxCount(database, presentStores)
    if (!Number.isSafeInteger(pendingOutboxCount) || pendingOutboxCount < 0) {
      return { ok: false, reason: 'invalid-outbox-count' }
    }

    return {
      ok: true,
      evidence: {
        dbExists: true,
        currentVersion: database.version,
        presentStores,
        pendingOutboxCount,
      },
    }
  } finally {
    database.close()
  }
}

/**
 * Executes one schema open/delete effect against an IndexedDB factory.
 */
export async function applyLocalStoreIndexedDbOpenEffect<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
>(
  input: LocalStoreIndexedDbOpenEffectInput<Database>,
): Promise<LocalStoreIndexedDbOpenEffectPlan<Database>> {
  const effect = input.effect
  if (effect.kind === 'delete-database') {
    await waitForIndexedDbRequest(input.indexedDb.deleteDatabase(effect.dbName))
    return {
      ok: true,
      kind: 'delete-database',
      dbName: effect.dbName,
      reason: effect.reason,
    }
  }

  const createdStores: LocalStoreObjectStore[] = []
  const request = input.indexedDb.open(effect.dbName, effect.version)
  request.onupgradeneeded = () => {
    for (const storeName of effect.createStores) {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
        createdStores.push(storeName)
      }
    }
  }
  const database = await waitForIndexedDbRequest(request)

  return {
    ok: true,
    kind: 'open-database',
    dbName: effect.dbName,
    mode: effect.mode,
    version: effect.version,
    database,
    createdStores,
  }
}

/**
 * Reads a local-store driver snapshot by executing concrete IndexedDB get operations.
 */
export async function readLocalStoreIndexedDbSnapshot(
  port: LocalStoreIndexedDbTransactionPort,
  reads: readonly LocalStoreIndexedDbReadOperation[],
): Promise<LocalStoreDriverSnapshot> {
  const outboxRecords: LocalStoreOutboxRecord[] = []
  const leaseRows: OutboxRunningLease[] = []

  for (const read of reads) {
    if (read.storeName === 'outbox') {
      const record = await port.getOutboxRecord(read.key)
      if (record !== undefined) {
        outboxRecords.push(record)
      }
      continue
    }

    const lease = await port.getRunningLease(read.key)
    if (lease !== undefined) {
      leaseRows.push(lease)
    }
  }

  return { outboxRecords, leaseRows }
}

/**
 * Applies concrete IndexedDB write operations to a transaction port in commit order.
 */
export async function applyLocalStoreIndexedDbWrites(
  port: LocalStoreIndexedDbTransactionPort,
  writes: readonly LocalStoreIndexedDbWriteOperation[],
): Promise<void> {
  for (const write of writes) {
    if (write.storeName === 'outbox') {
      await port.putOutboxRecord(write.value)
      continue
    }
    if (write.kind === 'put') {
      await port.putRunningLease(write.value)
      continue
    }
    await port.deleteRunningLease(write.key, write.expectedLease)
  }
}

/**
 * Queues concrete local-store writes directly on IndexedDB object stores before awaiting requests.
 */
export async function applyLocalStoreIndexedDbConcreteWrites(
  stores: LocalStoreIndexedDbObjectStorePorts,
  writes: readonly LocalStoreIndexedDbWriteOperation[],
): Promise<void> {
  const requests = queueLocalStoreIndexedDbConcreteWrites(stores, writes)
  await Promise.all(requests.map((request) => waitForIndexedDbRequest(request)))
}

/**
 * Queues concrete local-store read requests directly on IndexedDB object stores.
 */
export function queueLocalStoreIndexedDbConcreteReads(
  stores: LocalStoreIndexedDbObjectStorePorts,
  reads: readonly LocalStoreIndexedDbReadOperation[],
): readonly LocalStoreIndexedDbQueuedReadRequest[] {
  return reads.map((operation): LocalStoreIndexedDbQueuedReadRequest => {
    if (operation.storeName === 'outbox') {
      return { operation, request: stores.outbox.get(operation.key) }
    }
    return { operation, request: stores.runningLeases.get(operation.key) }
  })
}

/**
 * Builds a local-store snapshot from successful concrete IndexedDB read requests.
 */
export function localStoreIndexedDbSnapshotFromQueuedReads(
  queuedReads: readonly LocalStoreIndexedDbQueuedReadRequest[],
): LocalStoreDriverSnapshot {
  const outboxRecords: LocalStoreOutboxRecord[] = []
  const leaseRows: OutboxRunningLease[] = []

  for (const queuedRead of queuedReads) {
    if (isQueuedOutboxReadRequest(queuedRead)) {
      const row = queuedRead.request.result
      if (row !== undefined) {
        outboxRecords.push(row)
      }
      continue
    }
    const row = queuedRead.request.result
    if (row !== undefined) {
      leaseRows.push(row)
    }
  }

  return { outboxRecords, leaseRows }
}

function isQueuedOutboxReadRequest(
  queuedRead: LocalStoreIndexedDbQueuedReadRequest,
): queuedRead is Extract<
  LocalStoreIndexedDbQueuedReadRequest,
  { readonly operation: { readonly storeName: 'outbox' } }
> {
  return queuedRead.operation.storeName === 'outbox'
}

/**
 * Queues concrete local-store writes directly on IndexedDB object stores.
 */
export function queueLocalStoreIndexedDbConcreteWrites(
  stores: LocalStoreIndexedDbObjectStorePorts,
  writes: readonly LocalStoreIndexedDbWriteOperation[],
): readonly LocalStoreIndexedDbRequest<unknown>[] {
  return writes.map((write): LocalStoreIndexedDbRequest<unknown> => {
    if (write.storeName === 'outbox') {
      return stores.outbox.put(write.value, write.key)
    }
    if (write.kind === 'put') {
      return stores.runningLeases.put(write.value, write.key)
    }
    return stores.runningLeases.delete(write.key)
  })
}

/**
 * Applies setup metadata writes to the IndexedDB metadata object store.
 */
export async function applyLocalStoreIndexedDbMetadataWrites(
  store: LocalStoreIndexedDbMetadataObjectStorePort,
  writes: readonly LocalStoreIndexedDbMetadataWriteOperation[],
): Promise<void> {
  const requests = writes.map((write) => store.put(write.value, write.key))
  await Promise.all(requests.map((request) => waitForIndexedDbRequest(request)))
}

/**
 * Commits local-store operations through an IndexedDB transaction port.
 */
export async function commitLocalStoreIndexedDbTransaction(
  input: LocalStoreIndexedDbTransactionInput,
): Promise<LocalStoreIndexedDbTransactionPlan> {
  const readSet = planLocalStoreDriverReadSet(input.operations)
  const reads = planLocalStoreIndexedDbReads(readSet)
  const snapshot = await readLocalStoreIndexedDbSnapshot(input.port, reads)
  const commit = applyLocalStoreDriverCommit({
    operations: input.operations,
    snapshot,
  })

  if (!commit.ok) {
    return {
      ok: false,
      phase: 'commit',
      reason: commit.reason,
      itemId: commit.itemId,
      readSet,
      reads,
      snapshot,
      commit,
    }
  }

  const writes = planLocalStoreIndexedDbWrites(commit.writes)
  await applyLocalStoreIndexedDbWrites(input.port, writes)

  return {
    ok: true,
    readSet,
    reads,
    snapshot,
    commit,
    writes,
  }
}

/**
 * Commits local-store operations while preserving IndexedDB transaction activity.
 */
export async function commitLocalStoreIndexedDbQueuedTransaction(
  input: LocalStoreIndexedDbQueuedTransactionInput,
): Promise<LocalStoreIndexedDbTransactionPlan> {
  const readSet = planLocalStoreDriverReadSet(input.operations)
  const reads = planLocalStoreIndexedDbReads(readSet)
  const queuedReads = queueLocalStoreIndexedDbConcreteReads(input.transaction.stores, reads)

  return await new Promise<LocalStoreIndexedDbTransactionPlan>((resolve, reject) => {
    let readSuccessCount = 0
    let plan: LocalStoreIndexedDbTransactionPlan | undefined
    let settled = false

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    const requestFailed = (request: LocalStoreIndexedDbRequest<unknown>): void => {
      rejectOnce(request.error ?? new Error('IndexedDB request failed'))
    }

    const queueCommitWrites = (): void => {
      const snapshot = localStoreIndexedDbSnapshotFromQueuedReads(queuedReads)
      const commit = applyLocalStoreDriverCommit({
        operations: input.operations,
        snapshot,
      })

      if (!commit.ok) {
        plan = {
          ok: false,
          phase: 'commit',
          reason: commit.reason,
          itemId: commit.itemId,
          readSet,
          reads,
          snapshot,
          commit,
        }
        return
      }

      const writes = planLocalStoreIndexedDbWrites(commit.writes)
      const queuedWrites = queueLocalStoreIndexedDbConcreteWrites(input.transaction.stores, writes)
      for (const request of queuedWrites) {
        request.onerror = () => {
          requestFailed(request)
        }
      }
      plan = {
        ok: true,
        readSet,
        reads,
        snapshot,
        commit,
        writes,
      }
    }

    input.transaction.lifecycle.oncomplete = () => {
      if (settled) {
        return
      }
      if (plan === undefined) {
        rejectOnce(
          new Error('IndexedDB transaction completed before local-store commit was planned'),
        )
        return
      }
      settled = true
      resolve(plan)
    }
    input.transaction.lifecycle.onabort = () => {
      rejectOnce(input.transaction.lifecycle.error ?? new Error('IndexedDB transaction aborted'))
    }
    input.transaction.lifecycle.onerror = () => {
      rejectOnce(input.transaction.lifecycle.error ?? new Error('IndexedDB transaction failed'))
    }

    if (queuedReads.length === 0) {
      queueCommitWrites()
      return
    }

    for (const queuedRead of queuedReads) {
      queuedRead.request.onerror = () => {
        requestFailed(queuedRead.request)
      }
      queuedRead.request.onsuccess = () => {
        readSuccessCount += 1
        if (readSuccessCount === queuedReads.length) {
          queueCommitWrites()
        }
      }
    }
  })
}

/**
 * Opens a readwrite IndexedDB transaction, commits local-store operations, and waits for durability.
 */
export async function commitLocalStoreIndexedDbDatabaseTransaction(
  input: LocalStoreIndexedDbDatabaseTransactionInput,
): Promise<LocalStoreIndexedDbTransactionPlan> {
  const transaction = input.database.openOutboxTransaction()
  return await commitLocalStoreIndexedDbQueuedTransaction({
    operations: input.operations,
    transaction,
  })
}

/**
 * Opens a readwrite transaction, queues already-planned local-store writes, and waits for durability.
 */
export async function commitLocalStoreIndexedDbConcreteWriteTransaction(
  input: LocalStoreIndexedDbConcreteWriteTransactionInput,
): Promise<void> {
  const transaction = input.database.openOutboxTransaction()
  await applyLocalStoreIndexedDbConcreteWrites(transaction.stores, input.writes)
  await waitForIndexedDbTransaction(transaction.lifecycle)
}

/**
 * Opens a metadata IndexedDB transaction, queues setup/auth writes, and waits for durability.
 */
export async function commitLocalStoreIndexedDbMetadataTransaction(
  input: LocalStoreIndexedDbMetadataTransactionInput,
): Promise<void> {
  const transaction = input.database.openMetadataTransaction('readwrite')
  await applyLocalStoreIndexedDbMetadataWrites(transaction.store, input.writes)
  await waitForIndexedDbTransaction(transaction.lifecycle)
}

/**
 * Reads setup/auth metadata records and waits for the readonly IndexedDB transaction to complete.
 */
export async function readLocalStoreIndexedDbMetadataSnapshot(
  input: LocalStoreIndexedDbMetadataSnapshotInput,
): Promise<LocalSetupMetadataSnapshotDecision> {
  const transaction = input.database.openMetadataTransaction('readonly')
  const setupRequest = transaction.store.get(LOCAL_SETUP_METADATA_KEY)
  const authRequest = transaction.store.get(LOCAL_AUTH_METADATA_KEY)
  const [setup, auth] = await Promise.all([
    waitForIndexedDbRequest(setupRequest),
    waitForIndexedDbRequest(authRequest),
  ])
  await waitForIndexedDbTransaction(transaction.lifecycle)
  return planLocalSetupMetadataSnapshot({ setup, auth })
}

async function waitForIndexedDbRequest<Result>(
  request: LocalStoreIndexedDbRequest<Result>,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function waitForIndexedDbTransaction(
  transaction: LocalStoreIndexedDbTransactionLifecycle,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

function localStoreObjectStoresFromNames(
  names: LocalStoreIndexedDbObjectStoreNameList,
): readonly LocalStoreObjectStore[] {
  return DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((storeName) => names.contains(storeName))
}

async function readPendingOutboxCount(
  database: LocalStoreIndexedDbSchemaProbeDatabasePort,
  presentStores: readonly LocalStoreObjectStore[],
): Promise<number> {
  if (!presentStores.includes('outbox')) {
    return 1
  }
  const transaction = database.transaction('outbox', 'readonly')
  return await waitForIndexedDbRequest(transaction.objectStore('outbox').count())
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
