import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  makeDeviceId,
  makeMessageId,
  makeOutboxPlanItemId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type LocalStoreObjectStore,
  type OutboxPlanItemId,
} from '@kuroflare/core'
import { IDBFactory } from 'fake-indexeddb'
import { assert, expect, test, vi } from 'vitest'

import { buildLocalStoreRepairExport } from '../sync/store/repair'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import { createSyncRuntimeWebSocketSession } from '../sync/transport/socket'
import { createStartupSideEffectGate } from './boot'
import { LOCAL_STORE_DISCARD_CONFIRMATION, LOCAL_STORE_REBUILD_CONFIRMATION } from './constants'
import { runExclusiveLocalStoreRepair, runLocalStoreMutation } from './local-store-coordination'
import {
  exportLocalStoreRepair,
  rebuildDegradedLocalStore,
  resumeLocalStoreRepairImports,
  stageLocalStoreRepairImport,
} from './local-store-repair'
import { recoverLeasedOutboxAfterWebSocketFailure } from './outbox/completion'
import type KuroflareSpikePlugin from './plugin'
import { openLocalStoreDatabase, rebuildLocalStoreDatabase } from './store'

test('exports a degraded local outbox through the validated repair format', async () => {
  const harness = await createHarness(1)
  const record = yUpdateRecord('export')
  await putOutboxRecords(harness.factory, harness.dbName, [record])

  const path = await exportLocalStoreRepair(harness.plugin)

  assert.match(path, /^\.obsidian\/kuroflare\/repair-exports\/kuroflare-local-outbox-/)
  const payload = harness.files.get(path)
  assert(payload)
  assert.equal(payload.includes(record.messageId ?? ''), true)
  assert.equal(payload.includes('setupToken'), false)
  const exportedAt: unknown = JSON.parse(payload).exportedAt
  assert.equal(typeof exportedAt, 'number')
  assert.deepEqual(harness.updateSettings.mock.calls[0]?.[0], {
    localRepairExport: { path, exportedAt, pendingOutboxCount: 1 },
  })
})

test('stages only eligible y-update export rows as paused', async () => {
  const harness = await createHarness(3)
  const yUpdate = yUpdateRecord('stage-y')
  const blobId = outboxId('stage-blob')
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt: 200,
    vaultId: harness.vaultId,
    deviceId: harness.deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: 3,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    outboxRecords: [
      yUpdate,
      {
        id: blobId,
        kind: 'blob-put',
        status: 'pending',
        dependsOn: [],
        createdAt: 101,
        blobSha256: makeSha256Hex('b'.repeat(64)),
        localCacheKey: 'blob-cache/stage-blob',
      },
    ],
  })
  assert(exportPlan.ok)
  const path = '.obsidian/kuroflare/repair-exports/import.json'
  harness.files.set(path, JSON.stringify(exportPlan.exportFile))

  const staged = await stageLocalStoreRepairImport(harness.plugin, path)

  assert.equal(staged, 1)
  const records = await readOutboxRecords(harness.factory, harness.dbName)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.id, yUpdate.id)
  assert.equal(records[0]?.status, 'paused')
  assert.equal(records[0]?.reason, 'imported-repair-export')
  assert.equal(records[0]?.resumeOn, 'manual')
})

test('resumes only eligible staged repair-import rows after guarded planning', async () => {
  const setTimeout = vi.fn(() => 1)
  vi.stubGlobal('window', { setTimeout, clearTimeout: vi.fn() })
  const harness = await createHarness(3)
  const eligible = stagedYUpdateRecord('resume-eligible')
  const guarded = stagedYUpdateRecord('resume-guarded')
  const durable = stagedYUpdateRecord('resume-durable')
  const ordinaryPaused = yUpdateRecord('resume-ordinary', {
    status: 'paused',
    reason: 'manual-review',
  })
  await putOutboxRecords(harness.factory, harness.dbName, [
    eligible,
    guarded,
    durable,
    ordinaryPaused,
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        durableMessages: [{ docId: durable.docId, messageId: durable.messageId, durableSeq: 4 }],
        quarantinedMessages: [
          {
            docId: guarded.docId,
            messageId: guarded.messageId,
            updateSha256: guarded.updateSha256,
          },
        ],
      }),
    ),
  )

  const resumed = await resumeLocalStoreRepairImports(harness.plugin)

  assert.equal(resumed, 1)
  const records = await readOutboxRecords(harness.factory, harness.dbName)
  assert.equal(records.find((record) => record.id === eligible.id)?.status, 'pending')
  assert.equal(records.find((record) => record.id === eligible.id)?.reason, undefined)
  assert.equal(records.find((record) => record.id === guarded.id)?.status, 'paused')
  assert.equal(records.find((record) => record.id === guarded.id)?.reason, 'imported-repair-export')
  assert.equal(records.find((record) => record.id === durable.id)?.reason, 'imported-repair-export')
  assert.equal(records.find((record) => record.id === ordinaryPaused.id)?.reason, 'manual-review')
  assert.notEqual(harness.plugin.outboxWorkerRetryTimeout, null)
  assert.equal(setTimeout.mock.calls.length, 1)
})

test('resume keeps every staged row unchanged when server evidence fails', async () => {
  const harness = await createHarness(3)
  const staged = stagedYUpdateRecord('resume-network-failure')
  await putOutboxRecords(harness.factory, harness.dbName, [staged])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unavailable', { status: 503 })),
  )

  await expect(resumeLocalStoreRepairImports(harness.plugin)).rejects.toThrow(
    /repair-resume-evidence-http:503/,
  )
  assert.deepEqual(await readOutboxRecords(harness.factory, harness.dbName), [staged])
  assert.equal(harness.plugin.outboxWorkerRetryTimeout, null)
})

test('resume keeps staged rows unchanged when server evidence is malformed', async () => {
  const harness = await createHarness(3)
  const staged = stagedYUpdateRecord('resume-invalid-evidence')
  await putOutboxRecords(harness.factory, harness.dbName, [staged])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ durableMessages: [] })),
  )

  await expect(resumeLocalStoreRepairImports(harness.plugin)).rejects.toThrow(
    /repair-resume-evidence-response-invalid/,
  )
  assert.deepEqual(await readOutboxRecords(harness.factory, harness.dbName), [staged])
})

test('stage and resume reject an old store without upgrading or mutating it', async () => {
  const harness = await createHarness(1)
  const record = yUpdateRecord('old-store')
  await putOutboxRecords(harness.factory, harness.dbName, [record])
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt: 200,
    vaultId: harness.vaultId,
    deviceId: harness.deviceId,
    metadata: {
      localStoreVersion: 1,
      targetStoreVersion: 3,
      degradedReason: 'store-version-too-old-with-pending-outbox',
    },
    outboxRecords: [record],
  })
  assert(exportPlan.ok)
  const path = '.obsidian/kuroflare/repair-exports/old-store.json'
  harness.files.set(path, JSON.stringify(exportPlan.exportFile))

  await expect(stageLocalStoreRepairImport(harness.plugin, path)).rejects.toThrow(
    /local-store-repair-requires-healthy-store/,
  )
  await expect(resumeLocalStoreRepairImports(harness.plugin)).rejects.toThrow(
    /local-store-repair-requires-healthy-store/,
  )
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 1)
  assert.deepEqual(await readOutboxRecords(harness.factory, harness.dbName), [record])
})

test('rebuild after export rejects stale evidence and accepts an exact current outbox', async () => {
  const harness = await createHarness(1)
  const original = yUpdateRecord('rebuild-original')
  await putOutboxRecords(harness.factory, harness.dbName, [original])
  await exportLocalStoreRepair(harness.plugin)
  const replacement = yUpdateRecord('rebuild-replacement')
  await replaceOutboxRecords(harness.factory, harness.dbName, [replacement])

  await expect(
    rebuildDegradedLocalStore(
      harness.plugin,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_DISCARD_CONFIRMATION,
    ),
  ).rejects.toThrow(/repair-rebuild-rejected/)
  assert.equal(harness.plugin.startupSideEffectGate.permission, 'allowed')
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 1)
  await replaceOutboxRecords(harness.factory, harness.dbName, [original])

  await rebuildDegradedLocalStore(
    harness.plugin,
    LOCAL_STORE_REBUILD_CONFIRMATION,
    LOCAL_STORE_REBUILD_CONFIRMATION,
    LOCAL_STORE_DISCARD_CONFIRMATION,
  )

  assert.equal(await databaseVersion(harness.factory, harness.dbName), 3)
  assert.deepEqual(await readOutboxRecords(harness.factory, harness.dbName), [])
  assert.equal(harness.startupTick.mock.calls.length, 1)
})

test('discard confirmation rebuilds a degraded store without an export', async () => {
  const harness = await createHarness(1)
  await putOutboxRecords(harness.factory, harness.dbName, [yUpdateRecord('discard')])

  await rebuildDegradedLocalStore(
    harness.plugin,
    LOCAL_STORE_DISCARD_CONFIRMATION,
    LOCAL_STORE_REBUILD_CONFIRMATION,
    LOCAL_STORE_DISCARD_CONFIRMATION,
  )

  assert.equal(await databaseVersion(harness.factory, harness.dbName), 3)
  assert.deepEqual(await readOutboxRecords(harness.factory, harness.dbName), [])
})

test('export and rebuild fail closed for a non-degraded store', async () => {
  const harness = await createHarness(3)
  const record = yUpdateRecord('healthy')
  await putOutboxRecords(harness.factory, harness.dbName, [record])

  await expect(exportLocalStoreRepair(harness.plugin)).rejects.toThrow(/local-store-not-degraded/)
  await expect(
    rebuildDegradedLocalStore(
      harness.plugin,
      LOCAL_STORE_DISCARD_CONFIRMATION,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_DISCARD_CONFIRMATION,
    ),
  ).rejects.toThrow(/local-store-not-degraded/)
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 3)
  assert.deepEqual(
    (await readOutboxRecords(harness.factory, harness.dbName)).map((entry) => entry.id),
    [record.id],
  )
})

test('rebuild-after-export rejects corrupt outbox rows while explicit discard remains required', async () => {
  const harness = await createHarness(1)
  const valid = yUpdateRecord('corrupt-rebuild')
  await putOutboxRecords(harness.factory, harness.dbName, [valid])
  await exportLocalStoreRepair(harness.plugin)
  await putRawOutboxValue(harness.factory, harness.dbName, 'corrupt-row', { unexpected: true })

  await expect(
    rebuildDegradedLocalStore(
      harness.plugin,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_DISCARD_CONFIRMATION,
    ),
  ).rejects.toThrow(/repair-rebuild-rejected/)
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 1)
  assert.equal((await readRawOutboxValues(harness.factory, harness.dbName)).length, 2)

  await rebuildDegradedLocalStore(
    harness.plugin,
    LOCAL_STORE_DISCARD_CONFIRMATION,
    LOCAL_STORE_REBUILD_CONFIRMATION,
    LOCAL_STORE_DISCARD_CONFIRMATION,
  )
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 3)
  assert.deepEqual(await readRawOutboxValues(harness.factory, harness.dbName), [])
})

test('rebuild rejects a missing outbox store unless discard is explicit', async () => {
  const harness = await createHarness(1, 'outbox')

  await expect(
    rebuildDegradedLocalStore(
      harness.plugin,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_DISCARD_CONFIRMATION,
    ),
  ).rejects.toThrow(/repair-rebuild-rejected/)
  assert.equal(harness.plugin.startupSideEffectGate.permission, 'allowed')
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 1)
  assert.equal((await databaseStores(harness.factory, harness.dbName)).includes('outbox'), false)

  await rebuildDegradedLocalStore(
    harness.plugin,
    LOCAL_STORE_DISCARD_CONFIRMATION,
    LOCAL_STORE_REBUILD_CONFIRMATION,
    LOCAL_STORE_DISCARD_CONFIRMATION,
  )
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 3)
  assert.equal((await databaseStores(harness.factory, harness.dbName)).includes('outbox'), true)
})

test('repair rejects before database work while another local-store mutation is active', async () => {
  const harness = await createHarness(1)
  let releaseMutation = (): void => undefined
  const activeMutation = runLocalStoreMutation(
    harness.plugin,
    () =>
      new Promise<void>((resolve) => {
        releaseMutation = resolve
      }),
  )

  await expect(
    rebuildDegradedLocalStore(
      harness.plugin,
      LOCAL_STORE_DISCARD_CONFIRMATION,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_DISCARD_CONFIRMATION,
    ),
  ).rejects.toThrow(/local-store-repair-operation-in-progress/)
  assert.equal(harness.plugin.startupSideEffectGate.permission, 'allowed')
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 1)
  releaseMutation()
  await activeMutation
})

test('rebuild leaves sync enabled when an outbox run is still active', async () => {
  const harness = await createHarness(1)
  harness.plugin.outboxWorkerCompletionPromise = Promise.resolve()

  await expect(
    rebuildDegradedLocalStore(
      harness.plugin,
      LOCAL_STORE_DISCARD_CONFIRMATION,
      LOCAL_STORE_REBUILD_CONFIRMATION,
      LOCAL_STORE_DISCARD_CONFIRMATION,
    ),
  ).rejects.toThrow(/local-store-repair-operation-in-progress/)
  assert.equal(harness.plugin.startupSideEffectGate.permission, 'allowed')
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 1)
})

test('lease recovery opens IndexedDB only after an exclusive rebuild releases', async () => {
  const harness = await createHarness(3)
  const record = yUpdateRecord('stale-handle', { status: 'retrying' })
  await putOutboxRecords(harness.factory, harness.dbName, [record])
  await putRunningLease(harness.factory, harness.dbName, {
    itemId: record.id,
    kind: record.kind,
    ownerId: harness.plugin.outboxWorkerOwnerId,
    leaseExpiresAt: 1_000,
  })
  let enterExclusive = (): void => undefined
  let releaseExclusive = (): void => undefined
  const entered = new Promise<void>((resolve) => {
    enterExclusive = resolve
  })
  const release = new Promise<void>((resolve) => {
    releaseExclusive = resolve
  })
  const rebuilding = runExclusiveLocalStoreRepair(harness.plugin, async () => {
    enterExclusive()
    await release
    await rebuildLocalStoreDatabase(harness.plugin, harness.vaultId)
  })
  await entered

  const recovery = recoverLeasedOutboxAfterWebSocketFailure(harness.plugin)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.equal(harness.plugin.localStoreDb, null)
  releaseExclusive()
  await rebuilding
  await recovery
  assert.equal(await databaseVersion(harness.factory, harness.dbName), 3)
})

interface RepairHarness {
  readonly factory: IDBFactory
  readonly vaultId: ReturnType<typeof makeVaultId>
  readonly deviceId: ReturnType<typeof makeDeviceId>
  readonly dbName: string
  readonly files: Map<string, string>
  readonly updateSettings: ReturnType<typeof vi.fn>
  readonly startupTick: ReturnType<typeof vi.fn>
  readonly plugin: KuroflareSpikePlugin
}

async function createHarness(
  version: number,
  omittedStore?: LocalStoreObjectStore,
): Promise<RepairHarness> {
  const factory = new IDBFactory()
  vi.stubGlobal('indexedDB', factory)
  const vaultId = makeVaultId(`repair-vault-v${version}`)
  const deviceId = makeDeviceId('repair-device')
  const dbName = `kuroflare:${vaultId}`
  const initial = await openDatabase(factory, dbName, version, omittedStore)
  initial.close()
  const files = new Map<string, string>()
  const directories = new Set<string>()
  const setup = {
    endpoint: 'https://sync.example.test',
    vaultId,
    deviceId,
    protocolVersion: 1,
    bootstrapMode: 'join-existing' as const,
    tokenVersion: 1,
  }
  const settings: Record<string, unknown> = {
    endpoint: setup.endpoint,
    setupVaultId: vaultId,
    setupToken: '',
    requestedDeviceName: 'Obsidian',
  }
  const updateSettings = vi.fn(async (patch: object) => Object.assign(settings, patch))
  const startupTick = vi.fn(async () => undefined)
  const startupSideEffectGate = createStartupSideEffectGate()
  startupSideEffectGate.setPermission('allowed')
  let plugin!: KuroflareSpikePlugin
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The harness supplies the complete repair adapter surface exercised by these integration tests.
  plugin = {
    app: {
      vault: {
        adapter: {
          exists: async (path: string) => directories.has(path) || files.has(path),
          mkdir: async (path: string) => {
            directories.add(path)
          },
          read: async (path: string) => files.get(path) ?? Promise.reject(new Error('missing')),
          write: async (path: string, data: string) => {
            files.set(path, data)
          },
        },
      },
    },
    trustedSetupMetadata: setup,
    pendingSetupResponse: null,
    kuroflareSettings: settings,
    updateSettings,
    openLocalStoreDatabase: (requestedVaultId: string) =>
      openLocalStoreDatabase(plugin, requestedVaultId),
    localStoreDb: null,
    localStoreDbName: null,
    startupSideEffectGate,
    readAccessToken: vi.fn(async () => 'repair-access-token'),
    workerWebSocketSession: createSyncRuntimeWebSocketSession(),
    outboxWorkerRetryTimeout: null,
    outboxWorkerCompletionPromise: null,
    outboxWorkerOwnerId: 'repair-owner',
    syncRuntime: {
      lifecycle: {
        requestReplan: vi.fn(),
        runStartupTick: startupTick,
      },
    },
  } as unknown as KuroflareSpikePlugin
  return { factory, vaultId, deviceId, dbName, files, updateSettings, startupTick, plugin }
}

function yUpdateRecord(
  suffix: string,
  overrides: Partial<LocalStoreOutboxRecord> = {},
): LocalStoreOutboxRecord {
  return {
    id: outboxId(`item-${suffix}`),
    kind: 'y-update',
    status: 'pending',
    dependsOn: [],
    nextAttemptAt: undefined,
    retryCount: 0,
    createdAt: 100,
    docId: { kind: 'file', ydocId: makeYDocId(`doc-${suffix}`) },
    messageId: makeMessageId(`message-${suffix}`),
    updateSha256: makeSha256Hex(hashCharacter(suffix).repeat(64)),
    updateBytesBase64: 'AQID',
    ...overrides,
  }
}

function stagedYUpdateRecord(
  suffix: string,
  overrides: Partial<LocalStoreOutboxRecord> = {},
): LocalStoreOutboxRecord {
  return yUpdateRecord(suffix, {
    status: 'paused',
    reason: 'imported-repair-export',
    resumeOn: 'manual',
    ...overrides,
  })
}

function hashCharacter(value: string): string {
  return String.fromCharCode(97 + (value.length % 6))
}

function outboxId(value: string): OutboxPlanItemId {
  const id = makeOutboxPlanItemId(value)
  if (id === null) throw new Error(`invalid test outbox id: ${value}`)
  return id
}

function openDatabase(
  factory: IDBFactory,
  name: string,
  version?: number,
  omittedStore?: LocalStoreObjectStore,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version)
    request.onupgradeneeded = () => {
      for (const store of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
        if (store === omittedStore) continue
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store)
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function putOutboxRecords(
  factory: IDBFactory,
  dbName: string,
  records: readonly LocalStoreOutboxRecord[],
): Promise<void> {
  const db = await openDatabase(factory, dbName)
  const transaction = db.transaction('outbox', 'readwrite')
  for (const record of records) transaction.objectStore('outbox').put(record, record.id)
  await transactionDone(transaction)
  db.close()
}

async function putRawOutboxValue(
  factory: IDBFactory,
  dbName: string,
  key: string,
  value: unknown,
): Promise<void> {
  const db = await openDatabase(factory, dbName)
  const transaction = db.transaction('outbox', 'readwrite')
  transaction.objectStore('outbox').put(value, key)
  await transactionDone(transaction)
  db.close()
}

async function putRunningLease(
  factory: IDBFactory,
  dbName: string,
  lease: {
    readonly itemId: OutboxPlanItemId
    readonly kind: LocalStoreOutboxRecord['kind']
    readonly ownerId: string
    readonly leaseExpiresAt: number
  },
): Promise<void> {
  const db = await openDatabase(factory, dbName)
  const transaction = db.transaction('running-leases', 'readwrite')
  transaction.objectStore('running-leases').put(lease, lease.itemId)
  await transactionDone(transaction)
  db.close()
}

async function readRawOutboxValues(factory: IDBFactory, dbName: string): Promise<unknown[]> {
  const db = await openDatabase(factory, dbName)
  const transaction = db.transaction('outbox', 'readonly')
  const values = await requestResult<unknown[]>(transaction.objectStore('outbox').getAll())
  await transactionDone(transaction)
  db.close()
  return values
}

async function replaceOutboxRecords(
  factory: IDBFactory,
  dbName: string,
  records: readonly LocalStoreOutboxRecord[],
): Promise<void> {
  const db = await openDatabase(factory, dbName)
  const transaction = db.transaction('outbox', 'readwrite')
  transaction.objectStore('outbox').clear()
  for (const record of records) transaction.objectStore('outbox').put(record, record.id)
  await transactionDone(transaction)
  db.close()
}

async function readOutboxRecords(
  factory: IDBFactory,
  dbName: string,
): Promise<LocalStoreOutboxRecord[]> {
  const db = await openDatabase(factory, dbName)
  const transaction = db.transaction('outbox', 'readonly')
  const records = await requestResult<LocalStoreOutboxRecord[]>(
    transaction.objectStore('outbox').getAll(),
  )
  await transactionDone(transaction)
  db.close()
  return records
}

async function databaseVersion(factory: IDBFactory, dbName: string): Promise<number> {
  const db = await openDatabase(factory, dbName)
  const version = db.version
  db.close()
  return version
}

async function databaseStores(factory: IDBFactory, dbName: string): Promise<string[]> {
  const db = await openDatabase(factory, dbName)
  const stores = [...db.objectStoreNames]
  db.close()
  return stores
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
