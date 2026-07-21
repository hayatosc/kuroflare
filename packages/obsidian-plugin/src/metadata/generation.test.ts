// @vitest-environment jsdom

import { makeDeviceId, makeFileId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { TFile } from 'obsidian'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import type * as MetaModule from '../host/meta'

const metaMocks = vi.hoisted(() => ({
  loadTextDoc: vi.fn(),
}))

vi.mock('obsidian', () => {
  class FakePlugin {}
  class FakePluginSettingTab {
    readonly containerEl = document.createElement('div')
    constructor(..._args: unknown[]) {}
  }
  class FakeSetting {
    constructor(..._args: unknown[]) {}
    setName(): this {
      return this
    }
    setDesc(): this {
      return this
    }
    addTextArea(): this {
      return this
    }
    addText(): this {
      return this
    }
    addButton(): this {
      return this
    }
  }
  class FakeNotice {
    constructor(..._args: unknown[]) {}
  }
  class FakeTFile {}
  class FakeTFolder {}
  class FakeMarkdownView {}
  class FakeModal {}
  return {
    MarkdownView: FakeMarkdownView,
    Modal: FakeModal,
    Notice: FakeNotice,
    Plugin: FakePlugin,
    PluginSettingTab: FakePluginSettingTab,
    Setting: FakeSetting,
    TFile: FakeTFile,
    TFolder: FakeTFolder,
  }
})

vi.mock('../host/meta', async (importOriginal) => ({
  ...(await importOriginal<typeof MetaModule>()),
  loadTextDoc: metaMocks.loadTextDoc,
}))

import { adoptLocalFilesAfterRemoteMeta } from '../host/files'
import { setOwnedPathMarker } from '../host/guards'
import { insertMetaFile, metaMap, readMetaFile } from '../host/meta'
import KuroflareSpikePlugin from '../host/plugin'
import type { KuroflareRepairLogEntry, KuroflareSettings, LoadedTextDoc } from '../types'

function createTestPlugin(): KuroflareSpikePlugin {
  const plugin: unknown = Object.create(KuroflareSpikePlugin.prototype)
  if (!(plugin instanceof KuroflareSpikePlugin)) {
    throw new Error('failed to create test plugin')
  }
  const ydoc = new Y.Doc()
  Object.assign(plugin, {
    materializedPathOwners: new Map(),
    pendingRemoteTextFileOwners: new Map(),
    remoteTextMaterializationOperations: new Set(),
    loadedTextDocs: new Map(),
    loadingTextDocs: new Map(),
    documentRecoveryRequired: new Set(),
    documentRecoveryHydrating: new Set(),
    needFullSnapshotRecoveryInProgress: new Set(),
    needFullSnapshotRecoveryOwners: new Map(),
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    outboxWorkerCompletionPromise: null,
    activeTextDoc: null,
    ydoc,
    ytext: ydoc.getText('content'),
    bindGeneration: 0,
    metadataSetupStagingCount: 0,
  })
  return plugin
}

test('pending setup prevents path repair mutation and keeps its repair log', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('repair-generation-file')
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Conflicts/Original.md',
    canonicalPath: 'conflicts/original.md',
    type: 'text',
    ydocId: makeYDocId('repair-generation-doc'),
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('repair-generation-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('repair-generation-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('repair-generation-creator'),
    mtime: 1,
  })
  const retryEntry: KuroflareRepairLogEntry = {
    id: `path-conflict:${fileId}:retry`,
    kind: 'path-conflict',
    fileId,
    reason: 'path-conflict-renamed',
    createdAt: 1,
  }
  const resolveEntry: KuroflareRepairLogEntry = {
    ...retryEntry,
    id: `path-conflict:${fileId}:resolve`,
  }
  const remoteEntry: KuroflareRepairLogEntry = {
    id: `remote-materialize-blocked:${fileId}:resolve`,
    kind: 'remote-materialize-blocked',
    fileId,
    path: 'Conflicts/Original.md',
    reason: 'path-collision',
    createdAt: 1,
  }
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataAccess: 'read-write',
    metadataVaultGeneration: 3,
    pendingSetupResponse: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('repair-generation-vault-b'),
      deviceId: makeDeviceId('repair-generation-device-b'),
      accessToken: 'access-token-b',
      refreshToken: 'refresh-token-b',
      tokenVersion: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    },
    materializedPaths: new Map([[fileId, 'Conflicts/Original.md']]),
    pendingRemoteTextFiles: new Map(),
    pendingFsRenames: new Set(),
    activeRemoteDeletedFileIds: new Set(),
    lastMaterialized: new Map(),
    kuroflareSettings: { repairLog: [retryEntry, resolveEntry, remoteEntry] },
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        adapter: { readBinary: async () => new ArrayBuffer(0) },
      },
      fileManager: { renameFile: async () => undefined },
    },
  })

  await plugin.retryPathConflictRepairEntry(retryEntry)
  await plugin.resolvePathConflictRepairEntry(resolveEntry)
  await plugin.resolveRemoteMaterializeBlockedRepairEntry(remoteEntry)

  assert.deepEqual(
    plugin.kuroflareSettings.repairLog?.map((entry) => entry.id),
    [retryEntry.id, resolveEntry.id, remoteEntry.id],
  )
  assert.equal(readMetaFile(metaMap(plugin), fileId)?.path, 'Conflicts/Original.md')
  metaDoc.destroy()
})

test('path repair keeps its log when setup changes during the materialization rename', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('repair-rename-generation-file')
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Conflicts/Remote.md',
    canonicalPath: 'conflicts/remote.md',
    type: 'text',
    ydocId: makeYDocId('repair-rename-generation-doc'),
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('repair-rename-generation-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('repair-rename-generation-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('repair-rename-generation-creator'),
    mtime: 1,
  })
  const entry: KuroflareRepairLogEntry = {
    id: `path-conflict:${fileId}:generation`,
    kind: 'path-conflict',
    fileId,
    reason: 'path-conflict-renamed',
    createdAt: 1,
  }
  const sourcePath = 'Conflicts/Local.md'
  const sourceFile = Object.assign(new TFile(), { path: sourcePath })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataAccess: 'read-write',
    metadataVaultGeneration: 5,
    metadataSetupStagingCount: 0,
    pendingSetupResponse: null,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set(),
    materializedPaths: new Map([[fileId, sourcePath]]),
    pendingRemoteTextFiles: new Map(),
    pendingFsRenames: new Set(),
    activeRemoteDeletedFileIds: new Set(),
    lastMaterialized: new Map(),
    startupSideEffectGate: {
      canSendNetwork: () => true,
      replayingPersistence: false,
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('repair-rename-generation-vault-a'),
      deviceId: makeDeviceId('repair-rename-generation-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    kuroflareSettings: { repairLog: [entry] },
    updateSettings: async (patch: Partial<KuroflareSettings>) => {
      plugin.kuroflareSettings = { ...plugin.kuroflareSettings, ...patch }
    },
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => (path === sourcePath ? sourceFile : null),
        adapter: { readBinary: async () => new ArrayBuffer(0) },
      },
      fileManager: {
        renameFile: async () => {
          plugin.metadataVaultGeneration += 1
          plugin.pendingSetupResponse = {
            endpoint: 'https://worker.example.test',
            vaultId: makeVaultId('repair-rename-generation-vault-b'),
            deviceId: makeDeviceId('repair-rename-generation-device-b'),
            accessToken: 'access-token-b',
            refreshToken: 'refresh-token-b',
            tokenVersion: 1,
            protocolVersion: 1,
            bootstrapMode: 'new-vault',
          }
        },
      },
    },
  })

  await plugin.resolvePathConflictRepairEntry(entry)

  assert.equal(plugin.kuroflareSettings.repairLog?.[0]?.id, entry.id)
  assert(plugin.pendingSetupResponse !== null)
  metaDoc.destroy()
})

test('join adoption does not register an A marker after loading crosses into vault B', async () => {
  const vaultAMetaDoc = new Y.Doc()
  const vaultBMetaDoc = new Y.Doc()
  const fileId = makeFileId('join-load-generation-file')
  const ydocId = makeYDocId('join-load-generation-doc')
  const path = 'Join/Local.md'
  insertMetaFile(metaMap({ metaDoc: vaultAMetaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'join/local.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('join-load-generation-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('join-load-generation-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('join-load-generation-creator'),
    mtime: 1,
  })
  const loadedDoc = new Y.Doc()
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc: loadedDoc,
    text: loadedDoc.getText('content'),
    persistence: null,
  }
  let loadStartedResolve!: () => void
  let releaseLoadResolve!: () => void
  const loadStarted = new Promise<void>((resolve) => {
    loadStartedResolve = resolve
  })
  const releaseLoad = new Promise<void>((resolve) => {
    releaseLoadResolve = resolve
  })
  let plugin!: KuroflareSpikePlugin
  metaMocks.loadTextDoc.mockImplementationOnce(async () => {
    loadStartedResolve()
    await releaseLoad
    plugin.loadedTextDocs.set(ydocId, loaded)
    return loaded
  })
  plugin = createTestPlugin()
  const file = Object.assign(new TFile(), { path })
  Object.assign(plugin, {
    metaDoc: vaultAMetaDoc,
    metadataAccess: 'read-write',
    metadataVaultGeneration: 7,
    pendingSetupResponse: null,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set(),
    materializedPaths: new Map(),
    pendingRemoteTextFiles: new Map(),
    loadedTextDocs: new Map(),
    startupScannedMarkdownFiles: [],
    startupSideEffectGate: {
      canSendNetwork: () => true,
      replayingPersistence: false,
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('join-load-generation-vault-a'),
      deviceId: makeDeviceId('join-load-generation-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    app: {
      vault: {
        getMarkdownFiles: () => [file],
        getAbstractFileByPath: () => file,
      },
    },
  })

  const pending = adoptLocalFilesAfterRemoteMeta(plugin)
  await loadStarted
  plugin.metaDoc = vaultBMetaDoc
  plugin.metadataVaultGeneration += 1
  plugin.pendingSetupResponse = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('join-load-generation-vault-b'),
    deviceId: makeDeviceId('join-load-generation-device-b'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  }
  const owner = setOwnedPathMarker(
    plugin.pendingRemoteTextFiles,
    plugin.pendingRemoteTextFileOwners,
    ydocId,
    path,
    plugin.metadataVaultGeneration,
  )
  releaseLoadResolve()
  await pending

  assert.equal(plugin.pendingRemoteTextFiles.get(ydocId), path)
  assert.equal(plugin.pendingRemoteTextFileOwners.get(ydocId), owner)
  assert.equal(plugin.materializedPaths.has(fileId), false)
  loadedDoc.destroy()
  vaultBMetaDoc.destroy()
  vaultAMetaDoc.destroy()
})

test('worker update from A cannot materialize after setup staging advances the generation', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('worker-update-staging-file')
  const ydocId = makeYDocId('worker-update-staging-doc')
  const path = 'Staging/Blocked.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'staging/blocked.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('worker-update-staging-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('worker-update-staging-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('worker-update-staging-creator'),
    mtime: 1,
  })
  const doc = new Y.Doc()
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc,
    text: doc.getText('content'),
    persistence: null,
  }
  let createCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 12,
    metadataSetupStagingCount: 1,
    pendingSetupResponse: null,
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    lastMaterialized: new Map(),
    startupSideEffectGate: {
      canSendNetwork: () => true,
      replayingPersistence: false,
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('worker-update-staging-vault-a'),
      deviceId: makeDeviceId('worker-update-staging-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => undefined,
        create: async () => {
          createCount += 1
        },
      },
    },
  })

  await plugin.resolvePendingRemoteTextFile(loaded)

  assert.equal(createCount, 0)
  assert.equal(plugin.pendingRemoteTextFiles.get(ydocId), path)
  doc.destroy()
  metaDoc.destroy()
})

test('queued metadata repair additions merge against the latest persisted settings', async () => {
  const plugin = createTestPlugin()
  const metaDoc = new Y.Doc()
  const vaultId = makeVaultId('queued-repair-merge-vault')
  const entryOne: KuroflareRepairLogEntry = {
    id: 'invalid-meta:queued-entry-one',
    kind: 'invalid-meta',
    fileId: makeFileId('queued-entry-one'),
    reason: 'invalid-meta-entry',
    createdAt: 1,
  }
  const entryTwo: KuroflareRepairLogEntry = {
    ...entryOne,
    id: 'invalid-meta:queued-entry-two',
    fileId: makeFileId('queued-entry-two'),
  }
  let firstSaveStartedResolve!: () => void
  let releaseFirstSaveResolve!: () => void
  const firstSaveStarted = new Promise<void>((resolve) => {
    firstSaveStartedResolve = resolve
  })
  const releaseFirstSave = new Promise<void>((resolve) => {
    releaseFirstSaveResolve = resolve
  })
  let saveCount = 0
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 4,
    pendingSetupResponse: null,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set<string>(),
    settingsWritePromise: null,
    kuroflareSettings: { repairLog: [] },
    startupSideEffectGate: {
      canSendNetwork: () => true,
      replayingPersistence: false,
      setPermission: vi.fn(),
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId,
      deviceId: makeDeviceId('queued-repair-merge-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    saveData: async () => {
      saveCount += 1
      if (saveCount === 1) {
        firstSaveStartedResolve()
        await releaseFirstSave
      }
    },
  })
  const context = { metaDoc, generation: 4, vaultId }

  const first = plugin.updateMetadataReconcileSettings(
    (current) => ({ repairLog: [...(current.repairLog ?? []), entryOne] }),
    context,
  )
  await firstSaveStarted
  const second = plugin.updateMetadataReconcileSettings(
    (current) => ({ repairLog: [...(current.repairLog ?? []), entryTwo] }),
    context,
  )
  releaseFirstSaveResolve()

  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.deepEqual(plugin.kuroflareSettings.repairLog, [entryOne, entryTwo])
  metaDoc.destroy()
})

test('stale A repair removal queued across setup B preserves B entry with the same id', async () => {
  const plugin = createTestPlugin()
  const metaDoc = new Y.Doc()
  const vaultA = makeVaultId('repair-removal-vault-a')
  const entryA: KuroflareRepairLogEntry = {
    id: 'invalid-meta:reused-repair-id',
    kind: 'invalid-meta',
    fileId: makeFileId('repair-removal-file'),
    reason: 'invalid-meta-entry',
    createdAt: 1,
  }
  const entryB: KuroflareRepairLogEntry = { ...entryA, createdAt: 2 }
  let blockingSaveStartedResolve!: () => void
  let releaseBlockingSaveResolve!: () => void
  const blockingSaveStarted = new Promise<void>((resolve) => {
    blockingSaveStartedResolve = resolve
  })
  const releaseBlockingSave = new Promise<void>((resolve) => {
    releaseBlockingSaveResolve = resolve
  })
  let saveCount = 0
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 8,
    pendingSetupResponse: null,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set<string>(),
    settingsWritePromise: null,
    kuroflareSettings: { repairLog: [entryA], requestedDeviceName: 'before' },
    startupSideEffectGate: {
      canSendNetwork: () => true,
      replayingPersistence: false,
      setPermission: vi.fn(),
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: vaultA,
      deviceId: makeDeviceId('repair-removal-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    saveData: async () => {
      saveCount += 1
      if (saveCount === 1) {
        blockingSaveStartedResolve()
        await releaseBlockingSave
      }
    },
  })

  const blocker = plugin.updateSettings({ requestedDeviceName: 'blocking' })
  await blockingSaveStarted
  const staleRemoval = plugin.clearRepairLogEntry(entryA)
  const setup = plugin.stagePendingSetupResponse({
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('repair-removal-vault-b'),
    deviceId: makeDeviceId('repair-removal-device-b'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  })
  await Promise.resolve()
  const addEntryForB = plugin.updateSettings({ repairLog: [entryB] })
  releaseBlockingSaveResolve()

  await Promise.all([blocker, staleRemoval, setup, addEntryForB])
  assert.deepEqual(plugin.kuroflareSettings.repairLog, [entryB])
  metaDoc.destroy()
})
