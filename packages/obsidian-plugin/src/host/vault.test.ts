// @vitest-environment jsdom

import { makeDeviceId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { indexedDB as fakeIndexedDB, IDBKeyRange } from 'fake-indexeddb'
import * as v from 'valibot'
import { assert, test, vi } from 'vitest'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

vi.mock('obsidian', () => {
  class FakePlugin {}
  class FakePluginSettingTab {}
  class FakeSetting {}
  class FakeNotice {}
  class FakeTFile {}
  class FakeTFolder {}
  class FakeMarkdownView {}
  return {
    MarkdownView: FakeMarkdownView,
    Notice: FakeNotice,
    Plugin: FakePlugin,
    PluginSettingTab: FakePluginSettingTab,
    Setting: FakeSetting,
    TFile: FakeTFile,
    TFolder: FakeTFolder,
  }
})

import { filePersistenceDatabaseName, legacyFilePersistenceDatabaseName } from './guards'
import { waitForIndexedDbDeleteDatabase } from './helpers'
import { loadTextDoc } from './meta'
import KuroflareSpikePlugin from './plugin'

function createPlugin(vaultId: ReturnType<typeof makeVaultId>): KuroflareSpikePlugin {
  const plugin = v.parse(
    v.instance(KuroflareSpikePlugin),
    Object.create(KuroflareSpikePlugin.prototype),
  )
  const ydoc = new Y.Doc()
  Object.assign(plugin, {
    activeTextDoc: null,
    bindGeneration: 0,
    documentRecoveryHydrating: new Set<string>(),
    documentRecoveryRequired: new Set<string>(),
    documentReplacementInProgress: new Set<string>(),
    needFullSnapshotRecoveryInProgress: new Set<string>(),
    needFullSnapshotRecoveryOwners: new Map<string, object>(),
    pendingTextDeletionEvidenceRequests: new Map<string, number>(),
    pendingTextDeletionEvidenceRetryTimers: new Map<string, number>(),
    remoteTextMaterializationOperations: new Set<Promise<void>>(),
    outboxWorkerCompletionPromise: null,
    kuroflareSettings: { setupVaultId: '' },
    loadedTextDocs: new Map(),
    loadingTextDocs: new Map(),
    localStoreDb: null,
    metadataSetupStagingCount: 0,
    metadataVaultGeneration: 0,
    pendingSetupResponse: null,
    settingsWritePromise: null,
    startupSideEffectGate: {
      canSendNetwork: () => false,
      replayingPersistence: false,
      setPermission: vi.fn(),
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId,
      deviceId: makeDeviceId(`${vaultId}-device`),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    ydoc,
    ytext: ydoc.getText('content'),
  })
  return plugin
}

test('vault switch destroys A text state and isolates B with the same ydocId', async () => {
  vi.stubGlobal('indexedDB', fakeIndexedDB)
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const vaultA = makeVaultId('text-provider-vault-a')
  const vaultB = makeVaultId('text-provider-vault-b')
  const ydocId = makeYDocId('shared-text-doc-id')
  const plugin = createPlugin(vaultA)
  const loadedA = await loadTextDoc(plugin, { kind: 'file', ydocId })
  loadedA.text.insert(0, 'vault-a-only')
  plugin.activeTextDoc = loadedA
  plugin.ydoc = loadedA.doc
  plugin.ytext = loadedA.text
  const destroyed = vi.fn()
  loadedA.doc.on('destroy', destroyed)

  await plugin.stagePendingSetupResponse({
    endpoint: 'https://worker.example.test',
    vaultId: vaultB,
    deviceId: makeDeviceId('text-provider-vault-b-device'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  })

  assert.equal(plugin.loadedTextDocs.size, 0)
  assert.equal(plugin.loadingTextDocs.size, 0)
  assert.equal(plugin.activeTextDoc, null)
  assert.equal(destroyed.mock.calls.length, 1)
  assert.equal(
    plugin.loadedTextDocStillCurrent(loadedA, {
      vaultId: vaultA,
      generation: loadedA.vaultGeneration,
    }),
    false,
  )

  plugin.pendingSetupResponse = null
  plugin.trustedSetupMetadata = {
    endpoint: 'https://worker.example.test',
    vaultId: vaultB,
    deviceId: makeDeviceId('text-provider-vault-b-device'),
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  }
  const loadedB = await loadTextDoc(plugin, { kind: 'file', ydocId })

  assert.notEqual(loadedB.doc, loadedA.doc)
  assert.equal(loadedB.vaultId, vaultB)
  assert.equal(loadedB.text.toJSON(), '')
  assert.equal(plugin.loadedTextDocs.get(ydocId), loadedB)

  await loadedB.persistence?.destroy()
  loadedB.doc.destroy()
  await waitForIndexedDbDeleteDatabase(
    fakeIndexedDB.deleteDatabase(filePersistenceDatabaseName(vaultA, ydocId)),
  )
  await waitForIndexedDbDeleteDatabase(
    fakeIndexedDB.deleteDatabase(filePersistenceDatabaseName(vaultB, ydocId)),
  )
  vi.unstubAllGlobals()
})

test('unowned legacy file persistence is not adopted into the current vault', async () => {
  vi.stubGlobal('indexedDB', fakeIndexedDB)
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const vaultId = makeVaultId('legacy-isolation-vault')
  const ydocId = makeYDocId('legacy-isolation-doc')
  const legacyName = legacyFilePersistenceDatabaseName(ydocId)
  const legacyDoc = new Y.Doc()
  const legacyPersistence = new IndexeddbPersistence(legacyName, legacyDoc)
  await legacyPersistence.whenSynced
  legacyDoc.getText('content').insert(0, 'unowned-legacy-text')
  await legacyPersistence.set('test-flush', 'flushed')
  await legacyPersistence.destroy()
  legacyDoc.destroy()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const plugin = createPlugin(vaultId)

  const loaded = await loadTextDoc(plugin, { kind: 'file', ydocId })

  assert.equal(loaded.text.toJSON(), '')
  assert.equal(
    warn.mock.calls.some(
      ([message]) => message === '[kuroflare] ignored unowned legacy file persistence',
    ),
    true,
  )

  warn.mockRestore()
  await loaded.persistence?.destroy()
  loaded.doc.destroy()
  await waitForIndexedDbDeleteDatabase(fakeIndexedDB.deleteDatabase(legacyName))
  await waitForIndexedDbDeleteDatabase(
    fakeIndexedDB.deleteDatabase(filePersistenceDatabaseName(vaultId, ydocId)),
  )
  vi.unstubAllGlobals()
})
