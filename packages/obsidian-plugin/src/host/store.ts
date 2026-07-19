import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  type DocId,
  type OutboxRunningLease,
} from '@kuroflare/core'

import { type OutboxWorkerIndexedDbWriteTransaction } from '../sync/engine/worker'
import {
  commitLocalStoreIndexedDbConcreteWriteTransaction,
  createLocalStoreIndexedDbDatabasePort,
} from '../sync/store/indexeddb'
import { localStoreIndexedDbName, LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from '../sync/store/schema'
import { type LocalStoreOutboxRecord } from '../sync/store/store'
import { isLocalStoreOutboxRecord, isOutboxRunningLease } from './guards'
import {
  waitForIndexedDbRequest,
  waitForIndexedDbDeleteDatabase,
  waitForIndexedDbTransaction,
} from './helpers'
import type KuroflareSpikePlugin from './plugin'

export async function openLocalStoreDatabase(
  plugin: KuroflareSpikePlugin,
  vaultId: string,
  isCurrent: () => boolean = () => true,
): Promise<IDBDatabase> {
  if (!isCurrent()) throw new Error('local-store-vault-context-stale')
  const dbName = localStoreIndexedDbName(vaultId)
  if (plugin.localStoreDb !== null && plugin.localStoreDbName === dbName) {
    return plugin.localStoreDb
  }
  plugin.localStoreDb?.close()
  plugin.localStoreDb = null
  plugin.localStoreDbName = null

  const request = indexedDB.open(dbName, LOCAL_STORE_INDEXEDDB_TARGET_VERSION)
  request.onupgradeneeded = () => {
    for (const storeName of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
      }
    }
  }
  const db = await waitForIndexedDbRequest(request)
  if (!isCurrent()) {
    db.close()
    throw new Error('local-store-vault-context-stale')
  }
  plugin.localStoreDb = db
  plugin.localStoreDbName = dbName
  return db
}

export async function rebuildLocalStoreDatabase(
  plugin: KuroflareSpikePlugin,
  vaultId: string,
): Promise<void> {
  const dbName = localStoreIndexedDbName(vaultId)
  if (plugin.localStoreDbName === dbName) {
    plugin.localStoreDb?.close()
    plugin.localStoreDb = null
    plugin.localStoreDbName = null
  }
  await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(dbName))
  await openLocalStoreDatabase(plugin, vaultId)
}

export async function readOutboxWorkerSnapshot(db: IDBDatabase): Promise<{
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}> {
  const transaction = db.transaction(['outbox', 'running-leases'], 'readonly')
  const outboxRequest = transaction.objectStore('outbox').getAll()
  const leasesRequest = transaction.objectStore('running-leases').getAll()
  const [outboxValues, leaseValues] = await Promise.all([
    waitForIndexedDbRequest(outboxRequest),
    waitForIndexedDbRequest(leasesRequest),
  ])
  await waitForIndexedDbTransaction(transaction)
  return {
    outboxRecords: outboxValues.filter(isLocalStoreOutboxRecord),
    leaseRows: leaseValues.filter(isOutboxRunningLease),
  }
}

export async function readRemoteCursorSeq(
  db: IDBDatabase,
  docId: DocId,
): Promise<number | undefined> {
  const transaction = db.transaction(['remote-cursors'], 'readonly')
  const key = docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
  const value: unknown = await waitForIndexedDbRequest(
    transaction.objectStore('remote-cursors').get(key),
  )
  await waitForIndexedDbTransaction(transaction)
  if (typeof value !== 'object' || value === null || !('remoteCursorSeq' in value)) {
    return undefined
  }
  const remoteCursorSeq = value.remoteCursorSeq
  return Number.isSafeInteger(remoteCursorSeq) && Number(remoteCursorSeq) >= 0
    ? Number(remoteCursorSeq)
    : undefined
}

export async function commitOutboxWorkerIndexedDbWriteTransaction(
  db: IDBDatabase,
  transaction: OutboxWorkerIndexedDbWriteTransaction,
): Promise<void> {
  await commitLocalStoreIndexedDbConcreteWriteTransaction({
    database: createLocalStoreIndexedDbDatabasePort(db),
    writes: transaction.writes,
  })
}

export async function putOutboxRecord(
  db: IDBDatabase,
  record: LocalStoreOutboxRecord,
): Promise<void> {
  const transaction = db.transaction(['outbox'], 'readwrite')
  const request = transaction.objectStore('outbox').put(record, record.id)
  await waitForIndexedDbRequest(request)
  await waitForIndexedDbTransaction(transaction)
}

export async function deleteOutboxRecordIfMessageMatches(
  db: IDBDatabase,
  record: Pick<LocalStoreOutboxRecord, 'id' | 'messageId'>,
): Promise<void> {
  const transaction = db.transaction(['outbox'], 'readwrite')
  const store = transaction.objectStore('outbox')
  const current: unknown = await waitForIndexedDbRequest(store.get(record.id))
  if (
    isLocalStoreOutboxRecord(current) &&
    current.messageId === record.messageId &&
    current.id === record.id
  ) {
    await waitForIndexedDbRequest(store.delete(record.id))
  }
  await waitForIndexedDbTransaction(transaction)
}

export async function putOutboxRecords(
  db: IDBDatabase,
  records: readonly LocalStoreOutboxRecord[],
): Promise<void> {
  const transaction = db.transaction(['outbox'], 'readwrite')
  const store = transaction.objectStore('outbox')
  await Promise.all(records.map((record) => waitForIndexedDbRequest(store.put(record, record.id))))
  await waitForIndexedDbTransaction(transaction)
}
