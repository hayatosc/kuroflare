import {
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  hashBytesSha256,
  makeDeviceId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import { indexedDB as fakeIndexedDB, IDBKeyRange } from 'fake-indexeddb'
import { assert, test, vi } from 'vitest'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type { LocalStoreOutboxRecord } from '../sync/store/store'
import {
  createReadyDocumentEpoch,
  createRecoveringDocumentEpoch,
  documentEpochMetadataKey,
  probeIndexedDbProvider,
} from './epoch-recovery'
import {
  encodeBase64,
  waitForIndexedDbDeleteDatabase,
  waitForIndexedDbRequest,
  waitForIndexedDbTransaction,
} from './helpers'
import KuroflareSpikePlugin, { recoverDocumentEpochsAtStartup } from './plugin'
import { createStartupSideEffectGate } from './startup-gate'

vi.mock('obsidian', () => {
  class FakePlugin {}
  class FakeNotice {}
  class FakeTFile {}
  class FakeTFolder {}
  class FakeMarkdownView {}
  class FakePluginSettingTab {}
  class FakeSetting {}
  class FakeButtonComponent {}
  return {
    ButtonComponent: FakeButtonComponent,
    MarkdownView: FakeMarkdownView,
    Notice: FakeNotice,
    Plugin: FakePlugin,
    PluginSettingTab: FakePluginSettingTab,
    Setting: FakeSetting,
    TFile: FakeTFile,
    TFolder: FakeTFolder,
  }
})

const docId = { kind: 'file', ydocId: makeYDocId('epoch-recovery-integration') } as const
type IntegrationDocId = typeof docId

function castForIntegration<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T
}

function updateForText(value: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('fixed-file').insert(0, value)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

async function openDatabase(name: string): Promise<IDBDatabase> {
  const request = fakeIndexedDB.open(name, 1)
  request.onupgradeneeded = () => {
    for (const storeName of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
      }
    }
  }
  return await waitForIndexedDbRequest(request)
}

async function deleteDatabase(name: string): Promise<void> {
  await waitForIndexedDbDeleteDatabase(fakeIndexedDB.deleteDatabase(name))
}

async function closeProvider(provider: IndexeddbPersistence | null | undefined): Promise<void> {
  if (provider != null) await provider.destroy()
}

function destroyDoc(doc: Y.Doc | undefined): void {
  if (doc !== undefined) doc.destroy()
}

async function putLocalValue(
  db: IDBDatabase,
  storeName: string,
  key: string,
  value: unknown,
): Promise<void> {
  const transaction = db.transaction([storeName], 'readwrite')
  await waitForIndexedDbRequest(transaction.objectStore(storeName).put(value, key))
  await waitForIndexedDbTransaction(transaction)
}

async function readLocalValues(
  db: IDBDatabase,
  docId: IntegrationDocId,
): Promise<{
  readonly epoch: ReturnType<typeof createReadyDocumentEpoch>
  readonly ydoc: { readonly updateBytes: Uint8Array; readonly snapshotSeq?: number }
  readonly cursor: { readonly snapshotSeq: number; readonly remoteCursorSeq: number }
  readonly outbox: LocalStoreOutboxRecord
  readonly lease: OutboxRunningLease | undefined
}> {
  const transaction = db.transaction(
    ['metadata', 'file-ydocs', 'remote-cursors', 'outbox', 'running-leases'],
    'readonly',
  )
  const epochRequest = transaction.objectStore('metadata').get(documentEpochMetadataKey(docId))
  const ydocRequest = transaction.objectStore('file-ydocs').get(docId.ydocId)
  const cursorRequest = transaction.objectStore('remote-cursors').get(`file:${docId.ydocId}`)
  const outboxRequest = transaction.objectStore('outbox').get('outbox-recovery')
  const leaseRequest = transaction.objectStore('running-leases').get('outbox-recovery')
  const [epoch, ydoc, cursor, outbox, lease] = await Promise.all([
    waitForIndexedDbRequest(epochRequest),
    waitForIndexedDbRequest(ydocRequest),
    waitForIndexedDbRequest(cursorRequest),
    waitForIndexedDbRequest(outboxRequest),
    waitForIndexedDbRequest(leaseRequest),
  ])
  await waitForIndexedDbTransaction(transaction)
  return {
    epoch: castForIntegration<ReturnType<typeof createReadyDocumentEpoch>>(epoch),
    ydoc: castForIntegration<{ readonly updateBytes: Uint8Array; readonly snapshotSeq?: number }>(
      ydoc,
    ),
    cursor: castForIntegration<{ readonly snapshotSeq: number; readonly remoteCursorSeq: number }>(
      cursor,
    ),
    outbox: castForIntegration<LocalStoreOutboxRecord>(outbox),
    lease: castForIntegration<OutboxRunningLease | undefined>(lease),
  }
}

function createTestPlugin(db: IDBDatabase, setup: Record<string, unknown>): KuroflareSpikePlugin {
  const plugin = castForIntegration<KuroflareSpikePlugin>(
    Object.create(KuroflareSpikePlugin.prototype),
  )
  const ydoc = new Y.Doc()
  Object.assign(plugin, {
    app: { secretStorage: { getSecret: () => 'integration-token' } },
    activeTextDoc: null,
    documentRecoveryHydrating: new Set<string>(),
    documentRecoveryRequired: new Set<string>(),
    documentReplacementInProgress: new Set<string>(),
    kuroflareSettings: { setupMetadata: setup, setupToken: '', setupVaultId: '' },
    loadedTextDocs: new Map(),
    localStoreDb: db,
    localStoreDbName: 'integration-local-store',
    metaDoc: new Y.Doc(),
    metaPersistence: null,
    metaPersistenceName: null,
    pendingSetupResponse: null,
    startupSideEffectGate: createStartupSideEffectGate(),
    syncStoppedByAuth: null,
    trustedSetupMetadata: setup,
    ydoc,
    ytext: ydoc.getText('content'),
  })
  return plugin
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function latestSnapshotBody(
  setup: { readonly vaultId: string },
  fileDocId: { readonly kind: 'file'; readonly ydocId: string },
  updateBytes: Uint8Array,
  snapshotSeq: number,
): Promise<Record<string, unknown>> {
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, updateBytes)
  const stateVector = Y.encodeStateVector(snapshotDoc)
  const updateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  const stateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVector))
  snapshotDoc.destroy()
  return {
    docId: fileDocId,
    manifestSeq: snapshotSeq,
    snapshotKey: `snapshots/${setup.vaultId}/${fileDocId.ydocId}/${snapshotSeq}.yupdate`,
    snapshotSeq,
    stateVector: encodeBase64(stateVector),
    stateVectorSha256,
    updateBytesBase64: encodeBase64(updateBytes),
    updateSha256,
  }
}

function isPutBody(value: unknown): value is { readonly updateBytesBase64: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'updateBytesBase64' in value &&
    typeof value.updateBytesBase64 === 'string'
  )
}

function getPersistenceSet(): IndexeddbPersistence['set'] {
  const descriptor = Object.getOwnPropertyDescriptor(IndexeddbPersistence.prototype, 'set')
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error('IndexeddbPersistence.set is unavailable')
  }
  return descriptor.value
}

test('real fake-indexeddb + y-indexeddb recovery lifecycle survives provider crash and restart', async () => {
  vi.stubGlobal('indexedDB', fakeIndexedDB)
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const suffix = `epoch-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const providerName = `kuroflare-file:${docId.ydocId}`
  const localStoreName = `kuroflare-local:${suffix}`
  const setup = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId(`epoch-recovery-vault-${suffix}`),
    deviceId: makeDeviceId(`epoch-recovery-device-${suffix}`),
    protocolVersion: 1,
    bootstrapMode: 'new-vault' as const,
    tokenVersion: 1,
  }
  let localStoreDb: IDBDatabase | undefined
  let restartedLocalStoreDb: IDBDatabase | undefined
  let provider: IndexeddbPersistence | undefined
  let providerDoc: Y.Doc | undefined
  let firstPlugin: KuroflareSpikePlugin | undefined
  let restartedPlugin: KuroflareSpikePlugin | undefined
  const originalFetch = globalThis.fetch
  const originalPersistenceSet = getPersistenceSet()
  let remoteUpdate: Uint8Array | undefined
  let remoteSeq = 0
  let importCount = 0
  const importedUpdateHashes: string[] = []
  let crashProviderBarrier = true
  let providerDeleteCount = 0
  const originalDeleteDatabase = fakeIndexedDB.deleteDatabase.bind(fakeIndexedDB)
  const deleteSpy = vi.spyOn(fakeIndexedDB, 'deleteDatabase').mockImplementation((name) => {
    if (name === providerName) providerDeleteCount += 1
    return originalDeleteDatabase(name)
  })
  try {
    localStoreDb = await openDatabase(localStoreName)
    providerDoc = new Y.Doc()
    const initialActor = providerDoc.clientID
    provider = new IndexeddbPersistence(providerName, providerDoc)
    await provider.whenSynced
    providerDoc.getText('fixed-file').insert(0, 'initial')
    await provider.set('__integration_barrier', 'initial')
    await provider.destroy()
    provider = undefined
    providerDoc.destroy()
    providerDoc = undefined

    providerDoc = new Y.Doc()
    const intactActor = providerDoc.clientID
    assert.notEqual(intactActor, initialActor)
    provider = new IndexeddbPersistence(providerName, providerDoc)
    await provider.whenSynced
    assert.equal(providerDoc.getText('fixed-file').toJSON(), 'initial')
    await provider.destroy()
    provider = undefined
    providerDoc.destroy()
    providerDoc = undefined

    const initialEpoch = createReadyDocumentEpoch({
      docId,
      providerDbName: providerName,
      now: 1,
      epochId: 'initial-epoch',
    })
    await putLocalValue(localStoreDb, 'metadata', documentEpochMetadataKey(docId), initialEpoch)
    const localBaseUpdateBytes = updateForText('local-base')
    const pendingUpdateBytes = updateForText('pending')
    const fileRecord = {
      docId,
      updateBytes: localBaseUpdateBytes,
    }
    await putLocalValue(localStoreDb, 'file-ydocs', docId.ydocId, fileRecord)
    const outboxRecord: LocalStoreOutboxRecord = {
      id: 'outbox-recovery',
      kind: 'y-update',
      status: 'pending',
      dependsOn: [],
      nextAttemptAt: undefined,
      docId,
      updateBytesBase64: encodeBase64(pendingUpdateBytes),
    }
    const lease: OutboxRunningLease = {
      itemId: outboxRecord.id,
      kind: 'y-update',
      ownerId: 'integration-device',
      leaseExpiresAt: Date.now() + 60_000,
    }
    await putLocalValue(localStoreDb, 'outbox', outboxRecord.id, outboxRecord)
    await putLocalValue(localStoreDb, 'running-leases', lease.itemId, lease)

    const recoveringBeforeCrash = createRecoveringDocumentEpoch({
      docId,
      providerDbName: providerName,
      now: 2,
      previous: initialEpoch,
      reason: 'provider-loss',
    })
    await putLocalValue(
      localStoreDb,
      'metadata',
      documentEpochMetadataKey(docId),
      recoveringBeforeCrash,
    )
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'PUT') {
        const bodyText = typeof init.body === 'string' ? init.body : ''
        const body: unknown = JSON.parse(bodyText)
        if (!isPutBody(body)) throw new Error('invalid import request body')
        remoteUpdate = decodeBase64(body.updateBytesBase64)
        importedUpdateHashes.push(makeSha256Hex(await hashBytesSha256(remoteUpdate)))
        remoteSeq += 1
        importCount += 1
        return new Response(
          JSON.stringify({
            docId,
            ok: true,
            snapshotKey: `snapshots/${setup.vaultId}/${docId.ydocId}/${remoteSeq}.yupdate`,
            snapshotSeq: remoteSeq,
            vaultId: setup.vaultId,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (remoteUpdate === undefined) return new Response(null, { status: 404 })
      const body = await latestSnapshotBody(setup, docId, remoteUpdate, remoteSeq)
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const providerOpenEvents: string[] = []
    const observedIndexedDb = new Proxy(fakeIndexedDB, {
      get(target, property, receiver) {
        if (property === 'open') {
          return (...args: Parameters<IDBFactory['open']>) => {
            if (args[0] === providerName) providerOpenEvents.push('open')
            const open = Reflect.get(target, property, target)
            if (typeof open !== 'function') throw new Error('indexedDB.open is unavailable')
            return Reflect.apply(open, target, args)
          }
        }
        if (property === 'deleteDatabase') {
          return (...args: Parameters<IDBFactory['deleteDatabase']>) => {
            if (args[0] === providerName) providerOpenEvents.push('delete')
            const deleteDatabaseMethod = Reflect.get(target, property, target)
            if (typeof deleteDatabaseMethod !== 'function') {
              throw new Error('indexedDB.deleteDatabase is unavailable')
            }
            return Reflect.apply(deleteDatabaseMethod, target, args)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    vi.stubGlobal('indexedDB', observedIndexedDb)
    const originalSet = getPersistenceSet()
    IndexeddbPersistence.prototype.set = async function (key, value) {
      const result = await originalSet.call(this, key, value)
      if (crashProviderBarrier && key === '__kuroflare_epoch_barrier') {
        crashProviderBarrier = false
        throw new Error('crash:provider-synced')
      }
      return result
    }
    if (localStoreDb === undefined) throw new Error('local store database is unavailable')
    const activeLocalStoreDb = localStoreDb
    firstPlugin = createTestPlugin(activeLocalStoreDb, setup)
    const activeFirstPlugin = firstPlugin
    await expectCrash(
      () =>
        recoverDocumentEpochsAtStartup(activeFirstPlugin, activeLocalStoreDb, undefined, [
          fileRecord,
        ]),
      'crash:provider-synced',
    )
    IndexeddbPersistence.prototype.set = originalSet
    assert.equal(importCount, 1)
    assert.equal(providerDeleteCount, 1)
    assert.equal((await probeIndexedDbProvider(observedIndexedDb, providerName)).status, 'present')
    assert.equal(firstPlugin.loadedTextDocs.size, 1)
    const crashedLoaded = firstPlugin.loadedTextDocs.get(docId.ydocId)
    const crashedActor = crashedLoaded?.doc.clientID
    await crashedLoaded?.persistence?.destroy()
    crashedLoaded?.doc.destroy()
    firstPlugin.loadedTextDocs.clear()
    localStoreDb.close()
    restartedLocalStoreDb = await openDatabase(localStoreName)
    restartedPlugin = createTestPlugin(restartedLocalStoreDb, setup)
    await recoverDocumentEpochsAtStartup(restartedPlugin, restartedLocalStoreDb, undefined, [
      fileRecord,
    ])
    const recoveredLoaded = restartedPlugin.loadedTextDocs.get(docId.ydocId)
    assert.notEqual(recoveredLoaded, undefined)
    const recoveredActor = recoveredLoaded?.doc.clientID
    assert.notEqual(recoveredActor, crashedActor)
    assert.equal(importCount, 2)
    assert.equal(importedUpdateHashes.length, 2)
    assert.equal(importedUpdateHashes[0], importedUpdateHashes[1])
    assert.equal(providerDeleteCount, 2)
    assert.deepEqual(providerOpenEvents.slice(0, 2), ['delete', 'open'])

    const finalDoc = recoveredLoaded?.doc
    if (finalDoc === undefined) throw new Error('recovered document is unavailable')
    assert.equal(finalDoc?.getText('fixed-file').toJSON().includes('local-base'), true)
    assert.equal(finalDoc?.getText('fixed-file').toJSON().includes('pending'), true)
    const finalValues = await readLocalValues(restartedLocalStoreDb, docId)
    assert.equal(finalValues.epoch.status, 'ready')
    assert.equal(
      finalValues.epoch.baseUpdateSha256,
      makeSha256Hex(await hashBytesSha256(finalValues.ydoc.updateBytes)),
    )
    assert.equal(finalValues.cursor.snapshotSeq, 2)
    assert.equal(finalValues.cursor.remoteCursorSeq, 2)
    assert.equal(finalValues.outbox.status, 'done')
    assert.equal(finalValues.lease, undefined)
    const persistedDoc = new Y.Doc()
    Y.applyUpdate(persistedDoc, finalValues.ydoc.updateBytes)
    assert.deepEqual(
      Array.from(Y.encodeStateVector(finalDoc)),
      Array.from(Y.encodeStateVector(persistedDoc)),
    )
    persistedDoc.destroy()
    assert.equal(recoveredLoaded?.persistence !== null, true)
    assert.notEqual(recoveredActor, initialActor)
  } finally {
    IndexeddbPersistence.prototype.set = originalPersistenceSet
    globalThis.fetch = originalFetch
    await closeProvider(provider)
    destroyDoc(providerDoc)
    await closeProvider(firstPlugin?.loadedTextDocs.get(docId.ydocId)?.persistence)
    destroyDoc(firstPlugin?.loadedTextDocs.get(docId.ydocId)?.doc)
    await closeProvider(restartedPlugin?.loadedTextDocs.get(docId.ydocId)?.persistence)
    destroyDoc(restartedPlugin?.loadedTextDocs.get(docId.ydocId)?.doc)
    localStoreDb?.close()
    restartedLocalStoreDb?.close()
    await deleteDatabase(providerName)
    await deleteDatabase(localStoreName)
    deleteSpy.mockRestore()
    vi.unstubAllGlobals()
  }
})

async function expectCrash(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation()
  } catch (error: unknown) {
    assert.equal(error instanceof Error ? error.message : String(error), message)
    return
  }
  throw new Error(`expected crash: ${message}`)
}
