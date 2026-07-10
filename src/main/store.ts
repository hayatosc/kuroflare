import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION, localStoreIndexedDbName } from '../sync/store/schema'
import type KuroflareSpikePlugin from './plugin'

export async function openLocalStoreDatabase(
  plugin: KuroflareSpikePlugin,
  vaultId: LocalSetupMetadata['vaultId'],
): Promise<IDBDatabase> {
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
  plugin.localStoreDb = db
  plugin.localStoreDbName = dbName
  return db
}

export async function rebuildLocalStoreDatabase(
  plugin: KuroflareSpikePlugin,
  vaultId: LocalSetupMetadata['vaultId'],
): Promise<void> {
  const dbName = localStoreIndexedDbName(vaultId)
  if (plugin.localStoreDbName === dbName) {
    plugin.localStoreDb?.close()
    plugin.localStoreDb = null
    plugin.localStoreDbName = null
  }
  await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(dbName))
  await plugin.openLocalStoreDatabase(vaultId)
}
