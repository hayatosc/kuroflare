import { DEFAULT_LOCAL_STORE_OBJECT_STORES, type LocalStoreObjectStore } from '@kuroflare/core'

import {
  type LocalStoreIndexedDbObjectStoreNameList,
  type LocalStoreIndexedDbOpenEffectInput,
  type LocalStoreIndexedDbOpenEffectPlan,
  type LocalStoreIndexedDbSchemaDatabasePort,
  type LocalStoreIndexedDbSchemaEvidenceInput,
  type LocalStoreIndexedDbSchemaEvidencePlan,
  type LocalStoreIndexedDbSchemaProbeDatabasePort,
} from '../../store/ports'
import { waitForIndexedDbRequest } from './utils'

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
