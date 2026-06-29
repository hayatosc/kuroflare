import assert from 'node:assert/strict'

import { DEFAULT_LOCAL_STORE_OBJECT_STORES, type LocalStoreObjectStore } from '@kuroflare/core'
import { makeVaultId } from '@kuroflare/core'
import { test } from 'vitest'

import {
  readLocalStoreIndexedDbSchemaEvidence,
  type LocalStoreIndexedDbDatabaseInfo,
  type LocalStoreIndexedDbObjectStoreNameList,
  type LocalStoreIndexedDbOpenRequest,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbSchemaProbeDatabasePort,
  type LocalStoreIndexedDbSchemaProbeFactoryPort,
  type LocalStoreIndexedDbSchemaProbeTransactionPort,
} from './local-store-indexeddb'
import {
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  localStoreIndexedDbName,
  planLocalStoreIndexedDbOpen,
} from './local-store-schema'

const vaultId = makeVaultId('schema-evidence-vault-1')
const dbName = localStoreIndexedDbName(vaultId)

test('local store indexeddb schema evidence probe returns missing database evidence without opening', async () => {
  const factory = new FakeSchemaProbeFactory([])

  assert.deepEqual(
    await readLocalStoreIndexedDbSchemaEvidence({
      dbName,
      indexedDb: factory,
    }),
    {
      ok: true,
      evidence: {
        dbExists: false,
        currentVersion: undefined,
        presentStores: [],
        pendingOutboxCount: 0,
      },
    },
  )
  assert.deepEqual(factory.openedNames, [])
})

test('local store indexeddb schema evidence probe reads version stores and pending outbox count', async () => {
  const factory = new FakeSchemaProbeFactory([
    {
      name: dbName,
      database: new FakeSchemaProbeDatabase({
        version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        stores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
        outboxCount: 2,
      }),
    },
  ])

  const plan = await readLocalStoreIndexedDbSchemaEvidence({ dbName, indexedDb: factory })

  assert.deepEqual(plan, {
    ok: true,
    evidence: {
      dbExists: true,
      currentVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      presentStores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
      pendingOutboxCount: 2,
    },
  })
  assert.deepEqual(factory.openedNames, [dbName])
})

test('local store indexeddb schema evidence probe treats missing outbox as not proven empty', async () => {
  const stores = DEFAULT_LOCAL_STORE_OBJECT_STORES.filter((store) => store !== 'outbox')
  const factory = new FakeSchemaProbeFactory([
    {
      name: dbName,
      database: new FakeSchemaProbeDatabase({
        version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
        stores,
        outboxCount: 0,
      }),
    },
  ])

  const evidence = await readLocalStoreIndexedDbSchemaEvidence({ dbName, indexedDb: factory })
  assert.equal(evidence.ok, true)
  if (evidence.ok) {
    assert.equal(evidence.evidence.pendingOutboxCount, 1)
    assert.deepEqual(planLocalStoreIndexedDbOpen({ vaultId, ...evidence.evidence }), {
      ok: false,
      startupGate: 'degraded',
      dbName,
      decision: { action: 'degraded', reason: 'missing-required-store-with-pending-outbox' },
      effects: [
        { kind: 'hold-degraded', dbName, reason: 'missing-required-store-with-pending-outbox' },
      ],
    })
  }
})

test('local store indexeddb schema evidence probe rejects unavailable or inconsistent directory evidence', async () => {
  assert.deepEqual(
    await readLocalStoreIndexedDbSchemaEvidence({
      dbName,
      indexedDb: new FakeSchemaProbeFactory([], { databasesAvailable: false }),
    }),
    { ok: false, reason: 'database-directory-unavailable' },
  )

  const duplicateDatabase = new FakeSchemaProbeDatabase({
    version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
    stores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
    outboxCount: 0,
  })
  assert.deepEqual(
    await readLocalStoreIndexedDbSchemaEvidence({
      dbName,
      indexedDb: new FakeSchemaProbeFactory([
        { name: dbName, database: duplicateDatabase },
        { name: dbName, database: duplicateDatabase },
      ]),
    }),
    { ok: false, reason: 'duplicate-database-name' },
  )
})

test('local store indexeddb schema evidence probe rejects invalid version and count evidence', async () => {
  assert.deepEqual(
    await readLocalStoreIndexedDbSchemaEvidence({
      dbName,
      indexedDb: new FakeSchemaProbeFactory([
        {
          name: dbName,
          database: new FakeSchemaProbeDatabase({
            version: 0,
            stores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
            outboxCount: 0,
          }),
        },
      ]),
    }),
    { ok: false, reason: 'invalid-database-version' },
  )

  assert.deepEqual(
    await readLocalStoreIndexedDbSchemaEvidence({
      dbName,
      indexedDb: new FakeSchemaProbeFactory([
        {
          name: dbName,
          database: new FakeSchemaProbeDatabase({
            version: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
            stores: DEFAULT_LOCAL_STORE_OBJECT_STORES,
            outboxCount: -1,
          }),
        },
      ]),
    }),
    { ok: false, reason: 'invalid-outbox-count' },
  )
})

class FakeSchemaProbeFactory implements LocalStoreIndexedDbSchemaProbeFactoryPort<FakeSchemaProbeDatabase> {
  readonly #entries: readonly {
    readonly name: string
    readonly database: FakeSchemaProbeDatabase
  }[]
  readonly openedNames: string[] = []
  readonly databases: (() => Promise<readonly LocalStoreIndexedDbDatabaseInfo[]>) | undefined

  constructor(
    entries: readonly { readonly name: string; readonly database: FakeSchemaProbeDatabase }[],
    options: { readonly databasesAvailable?: boolean } = {},
  ) {
    this.#entries = entries
    this.databases =
      options.databasesAvailable === false
        ? undefined
        : async () =>
            this.#entries.map((entry) => ({
              name: entry.name,
              version: entry.database.version,
            }))
  }

  open(name: string): LocalStoreIndexedDbOpenRequest<FakeSchemaProbeDatabase> {
    this.openedNames.push(name)
    const entry = this.#entries.find((candidate) => candidate.name === name)
    assert(entry !== undefined)
    return new SuccessfulIndexedDbOpenRequest(entry.database)
  }
}

class FakeSchemaProbeDatabase implements LocalStoreIndexedDbSchemaProbeDatabasePort {
  readonly objectStoreNames: LocalStoreIndexedDbObjectStoreNameList
  readonly #stores: ReadonlySet<LocalStoreObjectStore>
  readonly #outboxCount: number
  closed = false

  constructor(input: {
    readonly version: number
    readonly stores: readonly LocalStoreObjectStore[]
    readonly outboxCount: number
  }) {
    this.version = input.version
    this.#stores = new Set(input.stores)
    this.#outboxCount = input.outboxCount
    this.objectStoreNames = {
      contains: (name) => this.#stores.has(localStoreObjectStoreName(name)),
    }
  }

  readonly version: number

  transaction(
    storeNames: 'outbox',
    mode: 'readonly',
  ): LocalStoreIndexedDbSchemaProbeTransactionPort {
    assert.equal(storeNames, 'outbox')
    assert.equal(mode, 'readonly')
    return {
      objectStore: () => ({
        count: () => new SuccessfulIndexedDbRequest(this.#outboxCount),
      }),
    }
  }

  close(): void {
    this.closed = true
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

class SuccessfulIndexedDbOpenRequest
  extends SuccessfulIndexedDbRequest<FakeSchemaProbeDatabase>
  implements LocalStoreIndexedDbOpenRequest<FakeSchemaProbeDatabase>
{
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null
}

function localStoreObjectStoreName(name: string): LocalStoreObjectStore {
  for (const storeName of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
    if (storeName === name) {
      return storeName
    }
  }
  assert.fail(`unexpected local store object store name: ${name}`)
}
