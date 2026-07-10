import {
  type BrowserLocalStoreIndexedDbFactoryPort,
  type LocalStoreIndexedDbDatabasePort,
  type LocalStoreIndexedDbMetadataDatabasePort,
  type LocalStoreIndexedDbObjectStorePorts,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionPort,
} from '../../store/ports'

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

export function createLocalStoreIndexedDbTransactionPortFromIdbTransaction(
  transaction: IDBTransaction,
): LocalStoreIndexedDbTransactionPort {
  return createLocalStoreIndexedDbTransactionPort({
    outbox: transaction.objectStore('outbox'),
    runningLeases: transaction.objectStore('running-leases'),
  })
}

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

export function createBrowserLocalStoreIndexedDbFactoryPort(
  indexedDb: IDBFactory,
): BrowserLocalStoreIndexedDbFactoryPort {
  return indexedDb
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
