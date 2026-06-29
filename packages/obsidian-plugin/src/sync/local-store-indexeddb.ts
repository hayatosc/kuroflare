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
} from './local-store-driver.js'
import { type LocalStoreIndexedDbOpenEffect } from './local-store-schema.js'
import { type LocalStoreOutboxRecord, type LocalStoreTransactionOperation } from './local-store.js'
import {
  LOCAL_AUTH_METADATA_KEY,
  LOCAL_SETUP_METADATA_KEY,
  planLocalSetupMetadataSnapshot,
  type LocalSetupMetadataPutOperation,
  type LocalSetupMetadataSnapshotDecision,
} from './setup-persist.js'

/** IndexedDB object stores owned by the outbox local-store driver. */
export type LocalStoreIndexedDbStoreName = 'outbox' | 'running-leases'

/** One concrete IndexedDB read operation needed before a local-store commit. */
export type LocalStoreIndexedDbReadOperation =
  | { readonly kind: 'get'; readonly storeName: 'outbox'; readonly key: OutboxPlanItemId }
  | { readonly kind: 'get'; readonly storeName: 'running-leases'; readonly key: OutboxPlanItemId }

/** One concrete IndexedDB write operation produced after a local-store commit succeeds. */
export type LocalStoreIndexedDbWriteOperation =
  | {
      readonly kind: 'put'
      readonly storeName: 'outbox'
      readonly key: OutboxPlanItemId
      readonly value: LocalStoreOutboxRecord
    }
  | {
      readonly kind: 'put'
      readonly storeName: 'running-leases'
      readonly key: OutboxPlanItemId
      readonly value: OutboxRunningLease
    }
  | {
      readonly kind: 'delete'
      readonly storeName: 'running-leases'
      readonly key: OutboxPlanItemId
      readonly expectedLease: OutboxRunningLease
    }

/** One concrete IndexedDB metadata write used by setup persistence. */
export type LocalStoreIndexedDbMetadataWriteOperation = {
  readonly kind: 'put'
  readonly storeName: 'metadata'
  readonly key: LocalSetupMetadataPutOperation['key']
  readonly value: LocalSetupMetadataPutOperation['value']
}

/** Minimal IndexedDB transaction port required by the local-store adapter. */
export interface LocalStoreIndexedDbTransactionPort {
  /** Reads one outbox record by primary key. */
  getOutboxRecord(key: OutboxPlanItemId): Promise<LocalStoreOutboxRecord | undefined>
  /** Reads one running lease row by primary key. */
  getRunningLease(key: OutboxPlanItemId): Promise<OutboxRunningLease | undefined>
  /** Stores one outbox record by its primary key. */
  putOutboxRecord(record: LocalStoreOutboxRecord): Promise<void>
  /** Stores one running lease row by its primary key. */
  putRunningLease(lease: OutboxRunningLease): Promise<void>
  /** Deletes one running lease row after the caller has validated its expected value. */
  deleteRunningLease(key: OutboxPlanItemId, expectedLease: OutboxRunningLease): Promise<void>
}

/** Minimal IndexedDB request surface used by the local-store adapter. */
export interface LocalStoreIndexedDbRequest<Result> {
  readonly error: DOMException | null
  onerror: ((event: Event) => void) | null
  onsuccess: ((event: Event) => void) | null
  readonly result: Result
}

/** Minimal database directory entry used before opening a local-store database. */
export interface LocalStoreIndexedDbDatabaseInfo {
  readonly name?: string | null | undefined
  readonly version?: number | undefined
}

/** Minimal IndexedDB open request surface used by the local-store schema adapter. */
export interface LocalStoreIndexedDbOpenRequest<
  Database,
> extends LocalStoreIndexedDbRequest<Database> {
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null
}

/** Object-store name collection exposed by an IndexedDB database during schema setup. */
export interface LocalStoreIndexedDbObjectStoreNameList {
  /** Checks whether an object store already exists. */
  contains(name: string): boolean
}

/** Minimal IndexedDB factory surface used to probe existing local-store schema evidence. */
export interface LocalStoreIndexedDbSchemaProbeFactoryPort<
  Database extends LocalStoreIndexedDbSchemaProbeDatabasePort,
> {
  /** Lists existing databases without creating missing ones. */
  databases?: (() => Promise<readonly LocalStoreIndexedDbDatabaseInfo[]>) | undefined
  /** Opens an existing database without changing its version. */
  open(name: string): LocalStoreIndexedDbOpenRequest<Database>
}

/** Minimal object-store surface needed to count pending outbox rows during schema probing. */
export interface LocalStoreIndexedDbCountObjectStorePort {
  /** Counts all rows in the object store. */
  count(): LocalStoreIndexedDbRequest<number>
}

/** Minimal readonly transaction surface used during schema probing. */
export interface LocalStoreIndexedDbSchemaProbeTransactionPort {
  /** Gets the requested object store from the active transaction. */
  objectStore(name: 'outbox'): LocalStoreIndexedDbCountObjectStorePort
}

/** Minimal opened database surface used to build local-store schema evidence. */
export interface LocalStoreIndexedDbSchemaProbeDatabasePort {
  readonly version: number
  readonly objectStoreNames: LocalStoreIndexedDbObjectStoreNameList
  /** Opens a readonly transaction for counting pending outbox rows. */
  transaction(storeNames: 'outbox', mode: 'readonly'): LocalStoreIndexedDbSchemaProbeTransactionPort
  /** Closes the opened database after evidence has been gathered. */
  close(): void
}

/** Minimal database schema surface available while handling an IndexedDB upgrade event. */
export interface LocalStoreIndexedDbSchemaDatabasePort {
  readonly objectStoreNames: LocalStoreIndexedDbObjectStoreNameList
  /** Creates one object store in the current versionchange transaction. */
  createObjectStore(name: LocalStoreObjectStore): unknown
}

/** Minimal IndexedDB factory surface needed by the local-store open effect runner. */
export interface LocalStoreIndexedDbFactoryPort<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
> {
  /** Opens or upgrades a database at the requested version. */
  open(name: string, version: number): LocalStoreIndexedDbOpenRequest<Database>
  /** Deletes a database before a rebuild. */
  deleteDatabase(name: string): LocalStoreIndexedDbRequest<unknown>
}

/** Browser IndexedDB factory surface used by local-store schema and evidence adapters. */
export type BrowserLocalStoreIndexedDbFactoryPort = LocalStoreIndexedDbFactoryPort<IDBDatabase> &
  LocalStoreIndexedDbSchemaProbeFactoryPort<IDBDatabase>

/** Minimal object-store surface needed to build a transaction port. */
export interface LocalStoreIndexedDbObjectStorePort<Value> {
  /** Reads one value by primary key. */
  get(key: IDBValidKey): LocalStoreIndexedDbRequest<Value | undefined>
  /** Stores one value by primary key. */
  put(value: Value, key?: IDBValidKey): LocalStoreIndexedDbRequest<IDBValidKey>
  /** Deletes one value by primary key. */
  delete(key: IDBValidKey): LocalStoreIndexedDbRequest<undefined>
}

/** Minimal metadata object-store surface needed by setup persistence. */
export interface LocalStoreIndexedDbMetadataObjectStorePort {
  /** Reads one setup/auth metadata record by its stable key. */
  get(
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<LocalSetupMetadataPutOperation['value'] | undefined>
  /** Stores one setup/auth metadata record by its stable key. */
  put(
    value: LocalSetupMetadataPutOperation['value'],
    key: LocalSetupMetadataPutOperation['key'],
  ): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object-store handles required by the local-store IndexedDB adapter. */
export interface LocalStoreIndexedDbObjectStorePorts {
  readonly outbox: LocalStoreIndexedDbObjectStorePort<LocalStoreOutboxRecord>
  readonly runningLeases: LocalStoreIndexedDbObjectStorePort<OutboxRunningLease>
}

/** Minimal IndexedDB transaction lifecycle surface used after request writes are queued. */
export interface LocalStoreIndexedDbTransactionLifecycle {
  readonly error: DOMException | null
  onabort: ((event: Event) => void) | null
  oncomplete: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
}

/** Open transaction handle containing both object stores and lifecycle callbacks. */
export interface LocalStoreIndexedDbTransactionHandle {
  readonly stores: LocalStoreIndexedDbObjectStorePorts
  readonly lifecycle: LocalStoreIndexedDbTransactionLifecycle
}

/** One queued IndexedDB read request with enough type information to rebuild a driver snapshot. */
export type LocalStoreIndexedDbQueuedReadRequest =
  | {
      readonly operation: Extract<
        LocalStoreIndexedDbReadOperation,
        { readonly storeName: 'outbox' }
      >
      readonly request: LocalStoreIndexedDbRequest<LocalStoreOutboxRecord | undefined>
    }
  | {
      readonly operation: Extract<
        LocalStoreIndexedDbReadOperation,
        { readonly storeName: 'running-leases' }
      >
      readonly request: LocalStoreIndexedDbRequest<OutboxRunningLease | undefined>
    }

/** Open metadata transaction handle containing the metadata store and lifecycle callbacks. */
export interface LocalStoreIndexedDbMetadataTransactionHandle {
  readonly store: LocalStoreIndexedDbMetadataObjectStorePort
  readonly lifecycle: LocalStoreIndexedDbTransactionLifecycle
}

/** Minimal database surface required to open a local-store outbox transaction. */
export interface LocalStoreIndexedDbDatabasePort {
  /** Opens one readwrite transaction containing outbox and running-lease stores. */
  openOutboxTransaction(): LocalStoreIndexedDbTransactionHandle
}

/** Minimal database surface required to open a setup metadata transaction. */
export interface LocalStoreIndexedDbMetadataDatabasePort {
  /** Opens one transaction containing the metadata store. */
  openMetadataTransaction(
    mode?: 'readonly' | 'readwrite',
  ): LocalStoreIndexedDbMetadataTransactionHandle
}

/** Input for committing local-store operations through an IndexedDB transaction port. */
export interface LocalStoreIndexedDbTransactionInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly port: LocalStoreIndexedDbTransactionPort
}

/** Input for committing local-store operations through a database-backed transaction. */
export interface LocalStoreIndexedDbDatabaseTransactionInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly database: LocalStoreIndexedDbDatabasePort
}

/** Input for committing local-store operations through an already-open IndexedDB transaction. */
export interface LocalStoreIndexedDbQueuedTransactionInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly transaction: LocalStoreIndexedDbTransactionHandle
}

/** Input for committing already-planned concrete local-store writes through a database transaction. */
export interface LocalStoreIndexedDbConcreteWriteTransactionInput {
  readonly writes: readonly LocalStoreIndexedDbWriteOperation[]
  readonly database: LocalStoreIndexedDbDatabasePort
}

/** Input for committing setup metadata writes through a database-backed transaction. */
export interface LocalStoreIndexedDbMetadataTransactionInput {
  readonly writes: readonly LocalStoreIndexedDbMetadataWriteOperation[]
  readonly database: LocalStoreIndexedDbMetadataDatabasePort
}

/** Input for reading setup/auth metadata through a database-backed transaction. */
export interface LocalStoreIndexedDbMetadataSnapshotInput {
  readonly database: LocalStoreIndexedDbMetadataDatabasePort
}

/** Executable IndexedDB schema effect that performs browser storage work. */
export type LocalStoreIndexedDbExecutableOpenEffect = Extract<
  LocalStoreIndexedDbOpenEffect,
  { readonly kind: 'open-database' | 'delete-database' }
>

/** Input for applying one executable local-store IndexedDB open effect. */
export interface LocalStoreIndexedDbOpenEffectInput<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
> {
  readonly effect: LocalStoreIndexedDbExecutableOpenEffect
  readonly indexedDb: LocalStoreIndexedDbFactoryPort<Database>
}

/** Input for reading local-store schema evidence without mutating the database. */
export interface LocalStoreIndexedDbSchemaEvidenceInput<
  Database extends LocalStoreIndexedDbSchemaProbeDatabasePort,
> {
  readonly dbName: string
  readonly indexedDb: LocalStoreIndexedDbSchemaProbeFactoryPort<Database>
}

/** Schema evidence accepted by `planLocalStoreIndexedDbOpen`. */
export interface LocalStoreIndexedDbSchemaEvidence {
  readonly dbExists: boolean
  readonly currentVersion?: number | undefined
  readonly presentStores: readonly LocalStoreObjectStore[]
  readonly pendingOutboxCount: number
}

/** Result of probing local-store schema evidence before planning startup. */
export type LocalStoreIndexedDbSchemaEvidencePlan =
  | {
      readonly ok: true
      readonly evidence: LocalStoreIndexedDbSchemaEvidence
    }
  | {
      readonly ok: false
      readonly reason:
        | 'database-directory-unavailable'
        | 'duplicate-database-name'
        | 'invalid-database-version'
        | 'invalid-outbox-count'
    }

/** Result of applying one executable local-store IndexedDB open effect. */
export type LocalStoreIndexedDbOpenEffectPlan<
  Database extends LocalStoreIndexedDbSchemaDatabasePort,
> =
  | {
      readonly ok: true
      readonly kind: 'open-database'
      readonly dbName: string
      readonly mode: 'create' | 'open' | 'upgrade'
      readonly version: number
      readonly database: Database
      readonly createdStores: readonly LocalStoreObjectStore[]
    }
  | {
      readonly ok: true
      readonly kind: 'delete-database'
      readonly dbName: string
      readonly reason: 'store-version-too-old' | 'missing-required-store'
    }

/** Successful IndexedDB adapter transaction plan after reads, commit planning, and writes. */
export interface SuccessfulLocalStoreIndexedDbTransactionPlan {
  readonly ok: true
  readonly readSet: LocalStoreDriverReadSet
  readonly reads: readonly LocalStoreIndexedDbReadOperation[]
  readonly snapshot: LocalStoreDriverSnapshot
  readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: true }>
  readonly writes: readonly LocalStoreIndexedDbWriteOperation[]
}

/** IndexedDB adapter transaction plan when local-store commit validation rejects the transaction. */
export interface FailedLocalStoreIndexedDbTransactionPlan {
  readonly ok: false
  readonly phase: 'commit'
  readonly reason: Extract<LocalStoreDriverCommitPlan, { readonly ok: false }>['reason']
  readonly itemId: OutboxPlanItemId
  readonly readSet: LocalStoreDriverReadSet
  readonly reads: readonly LocalStoreIndexedDbReadOperation[]
  readonly snapshot: LocalStoreDriverSnapshot
  readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: false }>
}

/** Result of committing local-store operations through the IndexedDB adapter boundary. */
export type LocalStoreIndexedDbTransactionPlan =
  | SuccessfulLocalStoreIndexedDbTransactionPlan
  | FailedLocalStoreIndexedDbTransactionPlan

/**
 * Converts a local-store driver read set into ordered IndexedDB get operations.
 *
 * @param readSet Outbox and lease keys selected for one local-store transaction.
 * @returns Concrete object-store get operations in outbox-then-lease order.
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
 *
 * @param writes Commit write operations returned by the local-store driver.
 * @returns Concrete object-store put/delete operations preserving commit order.
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
 *
 * @param writes Setup/auth metadata records produced after SecretStorage writes complete.
 * @returns Concrete metadata object-store put operations preserving input order.
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
 *
 * @param stores Object stores from one active readwrite transaction.
 * @returns Port used by the async commit helper.
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
 *
 * @param transaction Active readwrite transaction containing the outbox stores.
 * @returns Port used by the async commit helper.
 * @throws When either required object store is unavailable on the transaction.
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
 *
 * @param database Open IndexedDB database containing the local-store object stores.
 * @returns Database port that opens readwrite outbox transactions.
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
 *
 * @param database Open IndexedDB database containing the metadata object store.
 * @returns Database port that opens readwrite metadata transactions.
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
 *
 * @param indexedDb Browser global or injected Obsidian/Electron IndexedDB factory.
 * @returns The same factory typed as the schema open/delete and evidence probe port.
 */
export function createBrowserLocalStoreIndexedDbFactoryPort(
  indexedDb: IDBFactory,
): BrowserLocalStoreIndexedDbFactoryPort {
  return indexedDb
}

/**
 * Reads local-store schema evidence from IndexedDB without creating missing databases.
 *
 * @param input Database name and IndexedDB factory probe surface.
 * @returns Existing database version, known stores, and conservative pending outbox evidence.
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
 *
 * @param input Executable schema effect and the browser/fake IndexedDB factory.
 * @returns Opened database evidence or delete completion evidence.
 * @throws When IndexedDB rejects the open/delete request or schema creation fails.
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
 *
 * Missing rows are omitted so local-store commit validation can produce the canonical failure.
 *
 * @param port Transaction port backed by one concrete IndexedDB transaction.
 * @param reads Concrete object-store get operations.
 * @returns Rows read from IndexedDB in operation order.
 * @throws When the transaction port rejects a read.
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
 *
 * @param port Transaction port backed by one concrete IndexedDB transaction.
 * @param writes Concrete object-store put/delete operations.
 * @returns Resolves after all writes are accepted by the port.
 * @throws When the transaction port rejects a write.
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
 *
 * @param stores Object stores from one active readwrite transaction.
 * @param writes Concrete object-store put/delete operations.
 * @returns Resolves after all queued write requests succeed.
 * @throws When IndexedDB rejects any write request.
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
 *
 * @param stores Object stores from one active readwrite transaction.
 * @param reads Concrete object-store get operations.
 * @returns Queued read requests in input order.
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
 *
 * @param queuedReads Read requests whose success events have fired.
 * @returns Snapshot containing only rows currently present in IndexedDB.
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
 *
 * @param stores Object stores from one active readwrite transaction.
 * @param writes Concrete object-store put/delete operations.
 * @returns Queued write requests in input order.
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
 *
 * @param store Metadata object-store handle from the active setup persistence transaction.
 * @param writes Concrete metadata put operations.
 * @returns Resolves after all metadata writes are accepted by IndexedDB.
 * @throws When IndexedDB rejects a metadata write.
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
 *
 * @param input Ordered local-store operations and the concrete transaction port.
 * @returns Read evidence, commit plan, and concrete writes, or the local-store commit rejection.
 * @throws When the transaction port rejects a read or write.
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
 *
 * Read requests are queued synchronously. When the final read succeeds, commit validation and write
 * request queueing happen inside that IndexedDB success callback, before the transaction can
 * auto-commit.
 *
 * @param input Ordered operations and an already-open readwrite transaction handle.
 * @returns The local-store transaction plan after the IndexedDB transaction completes.
 * @throws When a request rejects, the transaction aborts/errors, or completion races the commit plan.
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
 *
 * @param input Ordered local-store operations and a database transaction opener.
 * @returns The local-store transaction plan after the IndexedDB transaction completes.
 * @throws When a request rejects or the IndexedDB transaction aborts/errors before completion.
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
 *
 * @param input Concrete IndexedDB writes and a database transaction opener.
 * @returns Resolves after all writes are accepted and the transaction completes durably.
 * @throws When a request rejects or the IndexedDB transaction aborts/errors before completion.
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
 *
 * @param input Ordered setup metadata writes and a database transaction opener.
 * @returns Resolves after the metadata transaction completes durably.
 * @throws When a request rejects or the IndexedDB transaction aborts/errors before completion.
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
 *
 * @param input Database transaction opener containing the metadata store.
 * @returns A trusted metadata snapshot, or the reason startup must ignore the local credentials.
 * @throws When a request rejects or the IndexedDB transaction aborts/errors before completion.
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
