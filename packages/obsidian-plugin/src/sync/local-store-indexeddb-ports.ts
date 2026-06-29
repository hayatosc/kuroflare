import type {
  OutboxPlanItemId,
  OutboxRunningLease,
} from '@kuroflare/core'
import type {
  LocalStoreOutboxRecord,
  LocalStoreTransactionOperation,
} from './local-store'
import type {
  LocalStoreObjectStore,
} from '@kuroflare/core'
import type {
  LocalSetupMetadataPutOperation,
} from './setup-persist'
import type {
  LocalStoreIndexedDbOpenEffect,
} from './local-store-schema'
import type {
  LocalStoreDriverSnapshot,
  LocalStoreDriverReadSet,
  LocalStoreDriverWriteOperation,
  LocalStoreDriverCommitPlan,
} from './local-store-driver-types'

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
