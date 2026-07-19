// @vitest-environment jsdom

import {
  hashCanonicalText,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { TFile, TFolder } from 'obsidian'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

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

import type { KuroflareSettings, LoadedTextDoc } from '../main-types'
import {
  materializeMetaRenames,
  type MetadataMaterializationPort,
} from '../plugin/metadata-materialization'
import { reconcileAndMaterializeMeta } from '../plugin/metadata-reconcile'
import type { MetadataReconcilePort } from '../plugin/metadata-reconcile-context'
import { applyFileDelete } from '../sync/meta/tree'
import { requestMissingRemoteTextFile } from './file-tree'
import { insertMetaFile, metaMap, updateMetaFile } from './meta'
import KuroflareSpikePlugin from './plugin'
import { setOwnedPathMarker } from './runtime-guards'

function createTestPlugin(): KuroflareSpikePlugin {
  const value: unknown = Object.create(KuroflareSpikePlugin.prototype)
  if (!(value instanceof KuroflareSpikePlugin)) {
    throw new Error('failed to create test plugin')
  }
  const ydoc = new Y.Doc()
  Object.assign(value, {
    materializedPathOwners: new Map(),
    pendingRemoteTextFileOwners: new Map(),
    remoteTextMaterializationOperations: new Set(),
    loadedTextDocs: new Map(),
    loadingTextDocs: new Map(),
    documentRecoveryRequired: new Set(),
    documentRecoveryHydrating: new Set(),
    needFullSnapshotRecoveryInProgress: new Set(),
    activeTextDoc: null,
    ydoc,
    ytext: ydoc.getText('content'),
    bindGeneration: 0,
    metadataSetupStagingCount: 0,
    settingsWritePromise: null,
    saveData: async () => undefined,
    metadataVaultGeneration: 0,
    pendingSetupResponse: null,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set(),
    startupSideEffectGate: {
      canSendNetwork: () => true,
      replayingPersistence: false,
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('remote-materialize-test-vault'),
      deviceId: makeDeviceId('remote-materialize-test-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
  })
  return value
}

function createReconcilePort(plugin: KuroflareSpikePlugin): MetadataReconcilePort {
  const value = plugin as KuroflareSpikePlugin & {
    requestTextDeletionEvidence?: (loaded: LoadedTextDoc) => Promise<void>
    scheduleReconcileRetry?: () => void
    metadataVaultGeneration?: number
    pendingSetupResponse?: unknown
    canSendNetworkForReconcile?: () => boolean
    readAccessTokenForReconcile?: MetadataReconcilePort['readAccessToken']
    loadTextDocForReconcile?: MetadataReconcilePort['loadTextDoc']
    requestDocFromWorkerForReconcile?: MetadataReconcilePort['requestDocFromWorker']
    updateSettingsForReconcile?: MetadataReconcilePort['updateSettings']
    fetchBlobManifestForMeta?: MetadataReconcilePort['fetchBlobManifestForMeta']
    remoteBlobChunksExist?: MetadataReconcilePort['remoteBlobChunksExist']
  }
  const settings =
    plugin.kuroflareSettings ??
    ({
      endpoint: '',
      setupVaultId: '',
      setupToken: '',
      requestedDeviceName: '',
      repairLog: [],
    } satisfies KuroflareSettings)
  const port: MetadataReconcilePort = {
    canSendNetwork: () => value.canSendNetworkForReconcile?.() ?? true,
    scheduleReconcileRetry: () => value.scheduleReconcileRetry?.(),
    getVaultGeneration: () => value.metadataVaultGeneration ?? 0,
    isVaultTransitionPending: () =>
      value.pendingSetupResponse !== null && value.pendingSetupResponse !== undefined,
    getMetaDoc: () => plugin.metaDoc,
    getMetadataAccess: () => plugin.metadataAccess ?? 'read-write',
    loadedTextDocs: plugin.loadedTextDocs ?? new Map(),
    pendingTextDeletionEvidenceRequests: plugin.pendingTextDeletionEvidenceRequests ?? new Map(),
    pendingTextDeletionEvidenceRetryTimers:
      plugin.pendingTextDeletionEvidenceRetryTimers ?? new Map(),
    loadTextDoc:
      value.loadTextDocForReconcile ??
      (async () => {
        throw new Error('test fixture expected the text document to be loaded')
      }),
    requestDocFromWorker: async (loaded, stateVector, reason) => {
      if (value.requestDocFromWorkerForReconcile !== undefined) {
        return value.requestDocFromWorkerForReconcile(loaded, stateVector, reason)
      }
      if (value.requestTextDeletionEvidence !== undefined) {
        await value.requestTextDeletionEvidence(loaded)
        return false
      }
      return false
    },
    getSettings: () => plugin.kuroflareSettings ?? settings,
    updateSettings: async (update, context) => {
      if (value.updateSettingsForReconcile !== undefined) {
        return value.updateSettingsForReconcile(update, context)
      }
      const patch = update(plugin.kuroflareSettings ?? settings)
      plugin.kuroflareSettings = { ...settings, ...plugin.kuroflareSettings, ...patch }
      return true
    },
    currentSetup: () => plugin.trustedSetupMetadata ?? undefined,
    readAccessToken: value.readAccessTokenForReconcile ?? (async () => 'access-token'),
    setBinaryRestoreCheckDetail: () => undefined,
  }
  if (value.fetchBlobManifestForMeta !== undefined && value.remoteBlobChunksExist !== undefined) {
    return {
      ...port,
      fetchBlobManifestForMeta: value.fetchBlobManifestForMeta,
      remoteBlobChunksExist: value.remoteBlobChunksExist,
    }
  }
  if (value.fetchBlobManifestForMeta !== undefined) {
    return { ...port, fetchBlobManifestForMeta: value.fetchBlobManifestForMeta }
  }
  if (value.remoteBlobChunksExist !== undefined) {
    return { ...port, remoteBlobChunksExist: value.remoteBlobChunksExist }
  }
  return port
}

function createMaterializationPort(
  plugin: KuroflareSpikePlugin,
  overrides: Partial<MetadataMaterializationPort> = {},
): MetadataMaterializationPort {
  const port: MetadataMaterializationPort = {
    getMetaDoc: () => plugin.metaDoc,
    getVaultGeneration: () => plugin.metadataVaultGeneration ?? 0,
    isVaultTransitionPending: () =>
      plugin.pendingSetupResponse !== null && plugin.pendingSetupResponse !== undefined,
    getVaultId: () => plugin.trustedSetupMetadata?.vaultId,
    vault: {
      getAbstractFileByPath: () => null,
      adapter: { readBinary: async () => new ArrayBuffer(0) },
    },
    fileManager: { renameFile: async () => undefined },
    lastMaterialized: plugin.lastMaterialized ?? new Map(),
    materializedPaths: plugin.materializedPaths ?? new Map(),
    materializedPathOwners: plugin.materializedPathOwners ?? new Map(),
    pendingRemoteTextFiles: plugin.pendingRemoteTextFiles ?? new Map(),
    pendingRemoteTextFileOwners: plugin.pendingRemoteTextFileOwners ?? new Map(),
    pendingFsRenames: plugin.pendingFsRenames ?? new Set(),
    activeRemoteDeletedFileIds: plugin.activeRemoteDeletedFileIds ?? new Set(),
    getActiveFile: () => plugin.activeFile ?? null,
    setSyncStatusText: (text) => plugin.syncStatusEl?.setText(text),
    notify: () => undefined,
    clearTextDeletionEvidenceRequest: () => undefined,
    requestMissingRemoteTextFile: async () => false,
    openLocalStoreDatabase: async () => {
      throw new Error('test fixture does not open IndexedDB')
    },
    readOutboxWorkerSnapshot: async () => ({ outboxRecords: [] }),
    putOutboxRecords: async () => undefined,
    runOutboxWorkerTick: async () => undefined,
  }
  return { ...port, ...overrides }
}

test('delayed text materialization does not create a file after a metadata tombstone', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('delayed-materialize')
  const ydocId = makeYDocId('delayed-materialize-doc')
  const path = 'Folder/Delayed.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'folder/delayed.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('creator'),
    mtime: 1,
  })

  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'remote')
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('remote-materialize-test-vault'),
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }

  let folderStartedResolve!: () => void
  let releaseFolderResolve!: () => void
  const folderStarted = new Promise<void>((resolve) => {
    folderStartedResolve = resolve
  })
  const releaseFolder = new Promise<void>((resolve) => {
    releaseFolderResolve = resolve
  })
  const createdPaths: string[] = []
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    lastMaterialized: new Map(),
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => {
          folderStartedResolve()
          await releaseFolder
        },
        create: async (createdPath: string) => {
          createdPaths.push(createdPath)
        },
      },
    },
  })

  const pending = plugin.resolvePendingRemoteTextFile(loaded)
  await folderStarted

  const baseStateVector = btoa(String.fromCharCode(...Y.encodeStateVector(doc)))
  const contentSha256 = await hashCanonicalText(text.toJSON())
  assert.deepEqual(
    applyFileDelete(metaMap(plugin), {
      path,
      deviceId: makeDeviceId('deleter'),
      now: 2,
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64: baseStateVector,
        contentSha256,
      },
    }),
    { action: 'deleted', fileId },
  )

  releaseFolderResolve()
  await pending
  assert.deepEqual(createdPaths, [])
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  doc.destroy()
  metaDoc.destroy()
})

test('remote text materialization records a repair when parent creation collides', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('parent-create-rejection')
  const ydocId = makeYDocId('parent-create-rejection-doc')
  const path = 'Folder/Rejected.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'folder/rejected.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('creator'),
    mtime: 1,
  })
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'remote')
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('remote-materialize-test-vault'),
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    lastMaterialized: new Map(),
    kuroflareSettings: {
      endpoint: '',
      setupVaultId: '',
      setupToken: '',
      requestedDeviceName: '',
      repairLog: [],
    },
    updateSettings: async (patch: Partial<KuroflareSettings>) => {
      plugin.kuroflareSettings = {
        ...plugin.kuroflareSettings,
        repairLog: patch.repairLog,
      }
    },
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => {
          throw new Error('path already exists')
        },
      },
    },
  })
  await plugin.resolvePendingRemoteTextFile(loaded)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  assert.equal(plugin.kuroflareSettings.repairLog?.[0]?.reason, 'parent-collision')
  doc.destroy()
  metaDoc.destroy()
})

test('remote tombstone uses the active file observed after reconciliation awaits', async () => {
  const metaDoc = new Y.Doc()
  const activeFileId = makeFileId('active-file-race')
  const activeYDocId = makeYDocId('active-file-race-doc')
  const deletedFileId = makeFileId('deleted-file-race')
  const deletedYDocId = makeYDocId('deleted-file-race-doc')
  const deletedPath = 'Folder/Deleted.md'
  const deletedDoc = new Y.Doc()
  const deletedStateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(deletedDoc)))
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: activeFileId,
    path: 'Folder/Remote.md',
    canonicalPath: 'folder/remote.md',
    type: 'text',
    ydocId: activeYDocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('active-file-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('active-file-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('active-file-race-creator'),
    mtime: 1,
  })
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: deletedFileId,
    path: deletedPath,
    canonicalPath: 'folder/deleted.md',
    type: 'text',
    ydocId: deletedYDocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('deleted-file-race-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64: deletedStateVectorBase64,
      contentSha256: makeSha256Hex('0'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('deleted-file-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('deleted-file-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('deleted-file-race-creator'),
    mtime: 1,
  })
  const plugin = createTestPlugin()
  let activePath = 'Folder/Before.md'
  let releaseRequest!: () => void
  let requestStartedResolve!: () => void
  const requestStarted = new Promise<void>((resolve) => {
    requestStartedResolve = resolve
  })
  const requestRelease = new Promise<void>((resolve) => {
    releaseRequest = resolve
  })
  const statusTexts: string[] = []
  const notices: string[] = []
  Object.assign(plugin, {
    metaDoc,
    metadataAccess: 'read-only',
    pendingRemoteTextFiles: new Map(),
    materializedPaths: new Map(),
    pendingFsRenames: new Set(),
    activeRemoteDeletedFileIds: new Set(),
    lastMaterialized: new Map(),
    readAccessTokenForReconcile: async () => undefined,
  })
  const materialize = createMaterializationPort(plugin, {
    getActiveFile: () => ({ path: activePath }),
    setSyncStatusText: (text) => statusTexts.push(text),
    notify: (message) => notices.push(message),
    requestMissingRemoteTextFile: async () => {
      requestStartedResolve()
      await requestRelease
      return true
    },
  })
  const pending = reconcileAndMaterializeMeta(createReconcilePort(plugin), materialize)
  await requestStarted
  activePath = deletedPath
  releaseRequest()
  await pending
  assert.deepEqual(statusTexts, [`Kuroflare sync: remote tombstone ${deletedPath}`])
  assert.deepEqual(notices, [
    'Kuroflare sync: active file was deleted remotely; local editor kept open',
  ])
  deletedDoc.destroy()
  metaDoc.destroy()
})

test('remote text create is compensated when a tombstone arrives during vault.create', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('create-race-materialize')
  const ydocId = makeYDocId('create-race-materialize-doc')
  const path = 'Folder/CreateRace.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'folder/createrace.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('creator'),
    mtime: 1,
  })
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'remote')
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('remote-materialize-test-vault'),
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }
  const folders = new Map<string, TFolder>()
  const files = new Map<string, TFile & { bytes?: string }>()
  let createStartedResolve!: () => void
  let releaseCreateResolve!: () => void
  const createStarted = new Promise<void>((resolve) => {
    createStartedResolve = resolve
  })
  const releaseCreate = new Promise<void>((resolve) => {
    releaseCreateResolve = resolve
  })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    pendingFsDeletes: new Set<string>(),
    lastMaterialized: new Map(),
    kuroflareSettings: { repairLog: [] },
    app: {
      vault: {
        getAbstractFileByPath: (target: string) => files.get(target) ?? folders.get(target) ?? null,
        createFolder: async (target: string) => {
          const folder = Object.assign(new TFolder(), { path: target, children: [] })
          folders.set(target, folder)
        },
        create: async (target: string) => {
          createStartedResolve()
          await releaseCreate
          const created = Object.assign(new TFile(), { path: target })
          files.set(target, created)
          return created
        },
        read: async () => text.toJSON(),
        delete: async (target: TFile | TFolder) => {
          if (target instanceof TFile) files.delete(target.path)
          if (target instanceof TFolder) folders.delete(target.path)
        },
      },
    },
  })

  const pending = plugin.resolvePendingRemoteTextFile(loaded)
  await createStarted
  const contentSha256 = await hashCanonicalText(text.toJSON())
  assert.deepEqual(
    applyFileDelete(metaMap(plugin), {
      path,
      deviceId: makeDeviceId('deleter'),
      now: 2,
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64: btoa(String.fromCharCode(...Y.encodeStateVector(doc))),
        contentSha256,
      },
    }),
    { action: 'deleted', fileId },
  )
  releaseCreateResolve()
  await pending
  assert.equal(files.has(path), false)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  assert.equal(plugin.pendingFsDeletes.size, 0)
  doc.destroy()
  metaDoc.destroy()
})

test('remote text create is compensated when its vault generation changes during vault.create', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('create-vault-transition-materialize')
  const ydocId = makeYDocId('create-vault-transition-materialize-doc')
  const path = 'VaultTransition.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'vaulttransition.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('creator'),
    mtime: 1,
  })
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'remote')
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('remote-materialize-test-vault'),
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }
  const files = new Map<string, TFile>()
  let createStartedResolve!: () => void
  let releaseCreateResolve!: () => void
  const createStarted = new Promise<void>((resolve) => {
    createStartedResolve = resolve
  })
  const releaseCreate = new Promise<void>((resolve) => {
    releaseCreateResolve = resolve
  })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    pendingFsDeletes: new Set<string>(),
    lastMaterialized: new Map(),
    kuroflareSettings: { repairLog: [] },
    app: {
      vault: {
        getAbstractFileByPath: (target: string) => files.get(target) ?? null,
        create: async (target: string) => {
          createStartedResolve()
          await releaseCreate
          const created = Object.assign(new TFile(), { path: target })
          files.set(target, created)
          return created
        },
        read: async () => text.toJSON(),
        delete: async (target: TFile) => {
          files.delete(target.path)
        },
      },
    },
  })

  const pending = plugin.resolvePendingRemoteTextFile(loaded)
  await createStarted
  plugin.metadataVaultGeneration += 1
  releaseCreateResolve()
  await pending

  assert.equal(files.has(path), false)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  assert.equal(plugin.pendingFsDeletes.size, 0)
  doc.destroy()
  metaDoc.destroy()
})

test('remote text create rejection preserves a competing file and newer pending marker', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('create-collision-materialize')
  const ydocId = makeYDocId('create-collision-materialize-doc')
  const path = 'Folder/CreateCollision.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'folder/createcollision.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('creator'),
    mtime: 1,
  })
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'remote')
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('remote-materialize-test-vault'),
    vaultGeneration: 1,
    doc,
    text,
    persistence: null,
  }
  const folders = new Map<string, TFolder>()
  const files = new Map<string, TFile & { bytes?: string }>()
  let createStartedResolve!: () => void
  let releaseCreateResolve!: () => void
  const createStarted = new Promise<void>((resolve) => {
    createStartedResolve = resolve
  })
  const releaseCreate = new Promise<void>((resolve) => {
    releaseCreateResolve = resolve
  })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 1,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    lastMaterialized: new Map(),
    kuroflareSettings: {
      endpoint: '',
      setupVaultId: '',
      setupToken: '',
      requestedDeviceName: '',
      repairLog: [],
    },
    updateSettings: async (patch: Partial<KuroflareSettings>) => {
      plugin.kuroflareSettings = {
        ...plugin.kuroflareSettings,
        repairLog: patch.repairLog,
      }
    },
    app: {
      vault: {
        getAbstractFileByPath: (target: string) => files.get(target) ?? folders.get(target) ?? null,
        createFolder: async (target: string) => {
          folders.set(target, Object.assign(new TFolder(), { path: target, children: [] }))
        },
        create: async (target: string) => {
          createStartedResolve()
          await releaseCreate
          const competing = Object.assign(new TFile(), { path: target, bytes: 'local' })
          files.set(target, competing)
          const folder = folders.get('Folder')
          folder?.children.push(competing)
          plugin.metadataVaultGeneration += 1
          plugin.pendingSetupResponse = {
            endpoint: 'https://worker.example.test',
            vaultId: makeVaultId('create-collision-materialize-vault-b'),
            deviceId: makeDeviceId('create-collision-materialize-device-b'),
            accessToken: 'access-token-b',
            refreshToken: 'refresh-token-b',
            tokenVersion: 1,
            protocolVersion: 1,
            bootstrapMode: 'new-vault',
          }
          setOwnedPathMarker(
            plugin.pendingRemoteTextFiles,
            plugin.pendingRemoteTextFileOwners,
            ydocId,
            path,
            plugin.metadataVaultGeneration,
          )
          throw new Error('path already exists')
        },
        delete: async (target: TFolder) => {
          folders.delete(target.path)
        },
      },
    },
  })
  const pending = plugin.resolvePendingRemoteTextFile(loaded)
  await createStarted
  releaseCreateResolve()
  await pending
  assert.equal(files.get(path)?.bytes, 'local')
  assert.equal(plugin.pendingRemoteTextFiles.get(ydocId), path)
  assert.equal(folders.has('Folder'), true)
  assert.deepEqual(plugin.kuroflareSettings.repairLog, [])
  doc.destroy()
  metaDoc.destroy()
})

test('join adoption does not mutate or send a YDoc after a tombstone during import', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('join-race-materialize')
  const ydocId = makeYDocId('join-race-materialize-doc')
  const path = 'Join/Race.md'
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: 'join/race.md',
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('creator'),
    mtime: 1,
  })
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'remote')
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('remote-materialize-test-vault'),
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }
  const file = Object.assign(new TFile(), {
    path,
    stat: { mtime: 1, size: 5 },
  })
  let readCount = 0
  let importReadStartedResolve!: () => void
  let releaseImportReadResolve!: () => void
  const importReadStarted = new Promise<void>((resolve) => {
    importReadStartedResolve = resolve
  })
  const releaseImportRead = new Promise<void>((resolve) => {
    releaseImportReadResolve = resolve
  })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map([[ydocId, path]]),
    lastMaterialized: new Map(),
    app: {
      vault: {
        getAbstractFileByPath: () => file,
        read: async () => {
          readCount += 1
          if (readCount === 2) {
            importReadStartedResolve()
            await releaseImportRead
          }
          return 'local'
        },
      },
    },
  })

  const pending = plugin.resolveJoinAdoptionHashCheck(file, loaded)
  await importReadStarted
  const contentSha256 = await hashCanonicalText(text.toJSON())
  assert.deepEqual(
    applyFileDelete(metaMap(plugin), {
      path,
      deviceId: makeDeviceId('deleter'),
      now: 2,
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64: btoa(String.fromCharCode(...Y.encodeStateVector(doc))),
        contentSha256,
      },
    }),
    { action: 'deleted', fileId },
  )
  releaseImportReadResolve()
  await pending
  assert.equal(text.toJSON(), 'remote')
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  doc.destroy()
  metaDoc.destroy()
})

test('stale remote text requests roll back materialized markers for both missing-file paths', async () => {
  const metaDoc = new Y.Doc()
  const firstFileId = makeFileId('text-request-race-first')
  const secondFileId = makeFileId('text-request-race-second')
  const firstYDocId = makeYDocId('text-request-race-first-doc')
  const secondYDocId = makeYDocId('text-request-race-second-doc')
  const first = {
    schemaVersion: 1 as const,
    fileId: firstFileId,
    path: 'Requests/First.md',
    canonicalPath: 'requests/first.md',
    type: 'text' as const,
    ydocId: firstYDocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('text-request-race-first-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-request-race-first-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-request-race-first-creator'),
    mtime: 1,
  }
  const second = {
    schemaVersion: 1 as const,
    fileId: secondFileId,
    path: 'Requests/Second.md',
    canonicalPath: 'requests/second.md',
    type: 'text' as const,
    ydocId: secondYDocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('text-request-race-second-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-request-race-second-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-request-race-second-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), first)
  insertMetaFile(metaMap({ metaDoc }), second)
  const firstNext = {
    ...first,
    path: 'Requests/First-next.md',
    canonicalPath: 'requests/first-next.md',
  }
  const secondNext = {
    ...second,
    path: 'Requests/Second-next.md',
    canonicalPath: 'requests/second-next.md',
  }
  const plugin = createTestPlugin()
  const materializedPaths = new Map([[secondFileId, 'Requests/Second-old.md']])
  const pendingRemoteTextFiles = new Map<string, string>()
  Object.assign(plugin, {
    metaDoc,
    materializedPaths,
    pendingRemoteTextFiles,
    pendingFsRenames: new Set(),
    lastMaterialized: new Map(),
    activeRemoteDeletedFileIds: new Set(),
  })
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondRelease = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  let firstStartedResolve!: (path: string) => void
  let secondStartedResolve!: (path: string) => void
  const firstStarted = new Promise<string>((resolve) => {
    firstStartedResolve = resolve
  })
  const secondStarted = new Promise<string>((resolve) => {
    secondStartedResolve = resolve
  })
  let requestCount = 0
  const requestedPaths: string[] = []
  const materialize = createMaterializationPort(plugin, {
    vault: {
      getAbstractFileByPath: () => null,
      adapter: { readBinary: async () => new ArrayBuffer(0) },
    },
    requestMissingRemoteTextFile: async (value) => {
      requestedPaths.push(value.path)
      assert(typeof value.ydocId === 'string')
      pendingRemoteTextFiles.set(value.ydocId, value.path)
      requestCount += 1
      if (requestCount === 1) firstStartedResolve(value.path)
      if (requestCount === 2) secondStartedResolve(value.path)
      if (value.path === first.path) await firstRelease
      if (value.path === second.path) await secondRelease
      return true
    },
  })
  const pending = materializeMetaRenames(materialize)
  const firstRequestPath = await firstStarted
  if (firstRequestPath === first.path) {
    assert.equal(updateMetaFile(metaMap(plugin), firstNext), true)
    releaseFirst()
  } else {
    assert.equal(firstRequestPath, second.path)
    assert.equal(updateMetaFile(metaMap(plugin), secondNext), true)
    releaseSecond()
  }
  const secondRequestPath = await secondStarted
  if (secondRequestPath === first.path) {
    assert.equal(updateMetaFile(metaMap(plugin), firstNext), true)
    releaseFirst()
  } else {
    assert.equal(secondRequestPath, second.path)
    assert.equal(updateMetaFile(metaMap(plugin), secondNext), true)
    releaseSecond()
  }
  await pending
  assert.equal(materializedPaths.has(firstFileId), false)
  assert.equal(materializedPaths.has(secondFileId), false)
  assert.equal(pendingRemoteTextFiles.get(firstYDocId), first.path)
  assert.equal(pendingRemoteTextFiles.get(secondYDocId), second.path)
  await materializeMetaRenames(materialize)
  assert.deepEqual(requestedPaths, [first.path, second.path, firstNext.path, secondNext.path])
  assert.equal(materializedPaths.get(firstFileId), firstNext.path)
  assert.equal(materializedPaths.get(secondFileId), secondNext.path)
  metaDoc.destroy()
})

test('overlapping remote text requests preserve a newer same-identity marker', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('text-request-overlap')
  const ydocId = makeYDocId('text-request-overlap-doc')
  const initial = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Requests/Overlap.md',
    canonicalPath: 'requests/overlap.md',
    type: 'text' as const,
    ydocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('text-request-overlap-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-request-overlap-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-request-overlap-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), initial)
  const plugin = createTestPlugin()
  const materializedPaths = new Map<string, string>()
  const pendingRemoteTextFiles = new Map<string, string>()
  Object.assign(plugin, {
    metaDoc,
    materializedPaths,
    pendingRemoteTextFiles,
    pendingFsRenames: new Set(),
    lastMaterialized: new Map(),
    activeRemoteDeletedFileIds: new Set(),
  })
  let firstStartedResolve!: () => void
  let releaseFirst!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve
  })
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let requestCount = 0
  const materialize = createMaterializationPort(plugin, {
    vault: {
      getAbstractFileByPath: () => null,
      adapter: { readBinary: async () => new ArrayBuffer(0) },
    },
    requestMissingRemoteTextFile: async (value) => {
      assert(typeof value.ydocId === 'string')
      requestCount += 1
      if (requestCount === 1) {
        firstStartedResolve()
        await firstRelease
      } else {
        pendingRemoteTextFiles.set(value.ydocId, value.path)
      }
      return true
    },
  })
  const firstPass = materializeMetaRenames(materialize)
  await firstStarted
  const changed = {
    ...initial,
    updatedAt: 2,
    updatedBy: makeDeviceId('text-request-overlap-updater'),
    mtime: 2,
  }
  assert.equal(updateMetaFile(metaMap(plugin), changed), true)
  materializedPaths.delete(fileId)
  await materializeMetaRenames(materialize)
  assert.equal(requestCount, 2)
  assert.equal(pendingRemoteTextFiles.get(ydocId), initial.path)
  releaseFirst()
  await firstPass
  assert.equal(pendingRemoteTextFiles.get(ydocId), initial.path)
  assert.equal(materializedPaths.get(fileId), initial.path)
  metaDoc.destroy()
})

test('rename race leaves an obsolete target explicitly unmaterialized', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('rename-target-race')
  const ydocId = makeYDocId('rename-target-race-doc')
  const initial = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Rename/B.md',
    canonicalPath: 'rename/b.md',
    type: 'text' as const,
    ydocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('rename-target-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('rename-target-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('rename-target-race-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), initial)
  const plugin = createTestPlugin()
  const materializedPaths = new Map([[fileId, 'Rename/A.md']])
  const pendingFsRenames = new Set<string>()
  const file = Object.assign(new TFile(), { path: 'Rename/A.md' })
  const renameCalls: string[] = []
  const next = {
    ...initial,
    path: 'Rename/C.md',
    canonicalPath: 'rename/c.md',
  }
  Object.assign(plugin, {
    metaDoc,
    materializedPaths,
    pendingFsRenames,
    pendingRemoteTextFiles: new Map(),
    lastMaterialized: new Map(),
    activeRemoteDeletedFileIds: new Set(),
  })
  const materialize = createMaterializationPort(plugin, {
    vault: {
      getAbstractFileByPath: (path) => (path === 'Rename/A.md' ? file : null),
      adapter: { readBinary: async () => new ArrayBuffer(0) },
    },
    fileManager: {
      renameFile: async (current, path) => {
        renameCalls.push(`${current.path}->${path}`)
        current.path = path
        if (path === initial.path) {
          assert.equal(updateMetaFile(metaMap(plugin), next), true)
        }
      },
    },
  })
  await materializeMetaRenames(materialize)
  assert.deepEqual(renameCalls, ['Rename/A.md->Rename/B.md', 'Rename/B.md->Rename/C.md'])
  assert.equal(file.path, 'Rename/C.md')
  assert.equal(materializedPaths.get(fileId), next.path)
  assert.equal(pendingFsRenames.size, 0)
  metaDoc.destroy()
})

test('missing remote text request tolerates updatedAt and mtime changes after loading', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('text-request-stable-identity')
  const ydocId = makeYDocId('text-request-stable-identity-doc')
  const initial = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Requests/Stable.md',
    canonicalPath: 'requests/stable.md',
    type: 'text' as const,
    ydocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('text-request-stable-identity-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-request-stable-identity-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-request-stable-identity-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), initial)
  const doc = new Y.Doc()
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('text-request-stable-identity-vault'),
    vaultGeneration: 0,
    doc,
    text: doc.getText('content'),
    persistence: null,
  }
  const sent: string[] = []
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 0,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set(),
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map(),
    pendingSyncRequestMessageIds: new Set(),
    workerMessageCounter: 0,
    workerHelloAccepted: true,
    workerWebSocketSession: {
      attach: () => undefined,
      send: (frame: string | ArrayBuffer) => {
        if (typeof frame !== 'string') throw new Error('expected a text WebSocket frame')
        sent.push(frame)
      },
      close: () => undefined,
      snapshot: () => ({ hasConnection: true, readyState: WebSocket.OPEN }),
    },
    startupSideEffectGate: { canSendNetwork: () => true, replayingPersistence: false },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('text-request-stable-identity-vault'),
      deviceId: makeDeviceId('text-request-stable-identity-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    app: { vault: { getAbstractFileByPath: () => null } },
  })

  const pending = requestMissingRemoteTextFile(plugin, initial)
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...initial,
      updatedAt: 2,
      updatedBy: makeDeviceId('text-request-stable-identity-updater'),
      mtime: 2,
    }),
    true,
  )

  assert.equal(await pending, true)
  assert.equal(sent.length, 1)
  assert.equal(plugin.pendingRemoteTextFiles.get(ydocId), initial.path)
  doc.destroy()
  metaDoc.destroy()
})

test('same-path TFile still requests adoption and a pending setup cancels the next request', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('text-request-existing-file')
  const ydocId = makeYDocId('text-request-existing-file-doc')
  const value = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Requests/Existing.md',
    canonicalPath: 'requests/existing.md',
    type: 'text' as const,
    ydocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('text-request-existing-file-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-request-existing-file-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-request-existing-file-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), value)
  const doc = new Y.Doc()
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('text-request-existing-file-vault-a'),
    vaultGeneration: 0,
    doc,
    text: doc.getText('content'),
    persistence: null,
  }
  const existing = Object.assign(new TFile(), {
    path: value.path,
    stat: { mtime: 1, ctime: 1, size: 1 },
  })
  let sentCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 0,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set(),
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingRemoteTextFiles: new Map(),
    pendingSyncRequestMessageIds: new Set(),
    workerMessageCounter: 0,
    workerHelloAccepted: true,
    workerWebSocketSession: {
      attach: () => undefined,
      send: () => {
        sentCount += 1
      },
      close: () => undefined,
      snapshot: () => ({ hasConnection: true, readyState: WebSocket.OPEN }),
    },
    startupSideEffectGate: { canSendNetwork: () => true, replayingPersistence: false },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('text-request-existing-file-vault-a'),
      deviceId: makeDeviceId('text-request-existing-file-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    app: { vault: { getAbstractFileByPath: () => existing } },
  })

  assert.equal(await requestMissingRemoteTextFile(plugin, value), true)
  assert.equal(sentCount, 1)
  assert.equal(plugin.pendingRemoteTextFiles.get(ydocId), value.path)

  plugin.pendingRemoteTextFiles.clear()
  const competingFileId = makeFileId('text-request-existing-file-competitor')
  const competingValue = {
    ...value,
    fileId: competingFileId,
    ydocId: makeYDocId('text-request-existing-file-competitor-doc'),
    createdBy: makeDeviceId('text-request-existing-file-competitor'),
    contentUpdatedBy: makeDeviceId('text-request-existing-file-competitor'),
    updatedBy: makeDeviceId('text-request-existing-file-competitor'),
  }
  insertMetaFile(metaMap(plugin), competingValue)
  assert.equal(await requestMissingRemoteTextFile(plugin, value), false)
  assert.equal(sentCount, 1)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  metaMap(plugin).delete(competingFileId)

  const competedWhileLoading = requestMissingRemoteTextFile(plugin, value)
  insertMetaFile(metaMap(plugin), competingValue)
  assert.equal(await competedWhileLoading, false)
  assert.equal(sentCount, 1)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  metaMap(plugin).delete(competingFileId)

  const replacementDoc = new Y.Doc()
  const replacement: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('text-request-existing-file-vault-a'),
    vaultGeneration: 0,
    doc: replacementDoc,
    text: replacementDoc.getText('content'),
    persistence: null,
  }
  const replacedWhileLoading = requestMissingRemoteTextFile(plugin, value)
  plugin.loadedTextDocs.set(ydocId, replacement)
  assert.equal(await replacedWhileLoading, false)
  assert.equal(sentCount, 1)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  plugin.loadedTextDocs.set(ydocId, loaded)

  const pending = requestMissingRemoteTextFile(plugin, value)
  plugin.pendingSetupResponse = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('text-request-existing-file-vault-b'),
    deviceId: makeDeviceId('text-request-existing-file-device-b'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  }
  plugin.metadataVaultGeneration += 1

  assert.equal(await pending, false)
  assert.equal(sentCount, 1)
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  replacementDoc.destroy()
  doc.destroy()
  metaDoc.destroy()
})
