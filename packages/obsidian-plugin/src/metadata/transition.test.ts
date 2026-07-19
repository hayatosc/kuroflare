// @vitest-environment jsdom

import { makeDeviceId, makeFileId, makeSha256Hex, makeVaultId, makeYDocId } from '@kuroflare/core'
import { TFile } from 'obsidian'
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

import { setOwnedPathMarker } from '../host/guards'
import { insertMetaFile, metaMap } from '../host/meta'
import KuroflareSpikePlugin from '../host/plugin'
import type { KuroflareSettings, LoadedTextDoc } from '../types'
import type { MetadataReconcilePort } from './evidence'
import type { MetadataMaterializationPort } from './materialize'
import { reconcileAndMaterializeMeta } from './reconcile'

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

test('metadata repair settings write is rejected when its vault context changes', async () => {
  const metaDoc = new Y.Doc()
  const invalidFileId = makeFileId('repair-settings-vault-transition')
  metaDoc.getMap<unknown>('meta').set(invalidFileId, { invalid: true })
  let writeStartedResolve!: () => void
  let releaseWriteResolve!: () => void
  const writeStarted = new Promise<void>((resolve) => {
    writeStartedResolve = resolve
  })
  const releaseWrite = new Promise<void>((resolve) => {
    releaseWriteResolve = resolve
  })
  const appliedRepairLogs: unknown[] = []
  let materializeLookupCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataAccess: 'read-write',
    metadataVaultGeneration: 6,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('repair-settings-vault-a'),
      deviceId: makeDeviceId('repair-settings-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { repairLog: [] },
    updateSettingsForReconcile: async (
      update: Parameters<MetadataReconcilePort['updateSettings']>[0],
      context: Parameters<MetadataReconcilePort['updateSettings']>[1],
    ) => {
      writeStartedResolve()
      await releaseWrite
      if (
        plugin.pendingSetupResponse !== null ||
        plugin.metaDoc !== context.metaDoc ||
        plugin.metadataVaultGeneration !== context.generation ||
        plugin.trustedSetupMetadata?.vaultId !== context.vaultId
      ) {
        return false
      }
      appliedRepairLogs.push(update(plugin.kuroflareSettings).repairLog)
      return true
    },
  })

  const pending = reconcileAndMaterializeMeta(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      vault: {
        getAbstractFileByPath: () => {
          materializeLookupCount += 1
          return null
        },
        adapter: { readBinary: async () => new ArrayBuffer(0) },
      },
    }),
  )
  await writeStarted
  plugin.pendingSetupResponse = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('repair-settings-vault-b'),
    deviceId: makeDeviceId('repair-settings-device-b'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  }
  plugin.metadataVaultGeneration += 1
  releaseWriteResolve()
  await pending

  assert.deepEqual(appliedRepairLogs, [])
  assert.equal(materializeLookupCount, 0)
  metaDoc.destroy()
})

test('metadata rename does not compensate into the next vault after setup starts', async () => {
  const vaultAMetaDoc = new Y.Doc()
  const vaultBMetaDoc = new Y.Doc()
  const fileId = makeFileId('rename-setup-transition')
  const vaultAId = makeVaultId('rename-setup-transition-vault-a')
  const vaultBId = makeVaultId('rename-setup-transition-vault-b')
  insertMetaFile(metaMap({ metaDoc: vaultAMetaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Vault A/Target.md',
    canonicalPath: 'vault a/target.md',
    type: 'text',
    ydocId: makeYDocId('rename-setup-transition-doc-a'),
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('rename-setup-transition-creator-a'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('rename-setup-transition-creator-a'),
    updatedAt: 2,
    updatedBy: makeDeviceId('rename-setup-transition-creator-a'),
    mtime: 2,
  })
  insertMetaFile(metaMap({ metaDoc: vaultBMetaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Vault B/Must Not Be Touched.md',
    canonicalPath: 'vault b/must not be touched.md',
    type: 'text',
    ydocId: makeYDocId('rename-setup-transition-doc-b'),
    deleted: true,
    deletedAt: 4,
    deletedBy: makeDeviceId('rename-setup-transition-deleter-b'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64: btoa(String.fromCharCode(...Y.encodeStateVector(vaultBMetaDoc))),
      contentSha256: makeSha256Hex('d'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('rename-setup-transition-creator-b'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('rename-setup-transition-creator-b'),
    updatedAt: 3,
    updatedBy: makeDeviceId('rename-setup-transition-creator-b'),
    mtime: 3,
  })
  const plugin = createTestPlugin()
  const sourceFile = new TFile() as TFile & { path: string }
  const sourcePath = 'Vault A/Source.md'
  sourceFile.path = sourcePath
  const renameCalls: string[] = []
  const statusTexts: string[] = []
  const notices: string[] = []
  Object.assign(plugin, {
    metaDoc: vaultAMetaDoc,
    metadataVaultGeneration: 4,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: vaultAId,
      deviceId: makeDeviceId('rename-setup-transition-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    metadataAccess: 'read-only',
    kuroflareSettings: { repairLog: [] },
    materializedPaths: new Map([[fileId, sourceFile.path]]),
    pendingFsRenames: new Set<string>(),
    lastMaterialized: new Map(),
    pendingRemoteTextFiles: new Map(),
    activeRemoteDeletedFileIds: new Set(),
  })

  await reconcileAndMaterializeMeta(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      vault: {
        getAbstractFileByPath: (path) => (path === sourceFile.path ? sourceFile : null),
        adapter: { readBinary: async () => new ArrayBuffer(0) },
      },
      fileManager: {
        renameFile: async (file, path) => {
          renameCalls.push(path)
          ;(file as TFile & { path: string }).path = path
          plugin.metaDoc = vaultBMetaDoc
          plugin.trustedSetupMetadata = {
            endpoint: 'https://worker.example.test',
            vaultId: vaultBId,
            deviceId: makeDeviceId('rename-setup-transition-device-b'),
            protocolVersion: 1,
            bootstrapMode: 'new-vault',
            tokenVersion: 1,
          }
          plugin.pendingSetupResponse = {
            endpoint: 'https://worker.example.test',
            vaultId: vaultBId,
            deviceId: makeDeviceId('rename-setup-transition-device-b'),
            accessToken: 'access-token-b',
            refreshToken: 'refresh-token-b',
            tokenVersion: 1,
            protocolVersion: 1,
            bootstrapMode: 'new-vault',
          }
          plugin.metadataVaultGeneration += 1
          setOwnedPathMarker(
            plugin.materializedPaths,
            plugin.materializedPathOwners,
            fileId,
            sourcePath,
            plugin.metadataVaultGeneration,
          )
        },
      },
      getActiveFile: () => ({ path: 'Vault B/Must Not Be Touched.md' }),
      setSyncStatusText: (text) => statusTexts.push(text),
      notify: (message) => notices.push(message),
    }),
  )
  assert.deepEqual(renameCalls, ['Vault A/Target.md'])
  assert.equal(plugin.materializedPaths.get(fileId), sourcePath)
  assert.deepEqual([...plugin.pendingFsRenames], [])
  assert.deepEqual(statusTexts, [])
  assert.deepEqual(notices, [])
  vaultBMetaDoc.destroy()
  vaultAMetaDoc.destroy()
})

test('setup staging rolls back a repair log whose save crossed the vault generation', async () => {
  const metaDoc = new Y.Doc()
  const vaultAId = makeVaultId('repair-commit-vault-a')
  const repairLog: NonNullable<KuroflareSettings['repairLog']> = [
    {
      id: 'invalid-meta:repair-commit-file',
      kind: 'invalid-meta',
      fileId: makeFileId('repair-commit-file'),
      reason: 'meta-schema-invalid',
      createdAt: 1,
    },
  ]
  let firstSaveStartedResolve!: () => void
  let releaseFirstSaveResolve!: () => void
  const firstSaveStarted = new Promise<void>((resolve) => {
    firstSaveStartedResolve = resolve
  })
  const releaseFirstSave = new Promise<void>((resolve) => {
    releaseFirstSaveResolve = resolve
  })
  const savedRepairLogs: (KuroflareSettings['repairLog'] | undefined)[] = []
  const savedDeviceNames: (string | undefined)[] = []
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 9,
    settingsWritePromise: null,
    metadataSetupStagingCount: 0,
    metadataReconcileRetryTimeout: null,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: vaultAId,
      deviceId: makeDeviceId('repair-commit-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    metadataMigrationPending: false,
    metadataMigrationPromise: null,
    documentReplacementInProgress: new Set<string>(),
    startupSideEffectGate: {
      replayingPersistence: false,
      canSendNetwork: () => true,
      setPermission: vi.fn(),
    },
    kuroflareSettings: { repairLog: [], requestedDeviceName: 'before-ui' },
    saveData: async (settings: KuroflareSettings) => {
      savedRepairLogs.push(settings.repairLog?.map((entry) => ({ ...entry })))
      savedDeviceNames.push(settings.requestedDeviceName)
      if (savedRepairLogs.length === 1) {
        firstSaveStartedResolve()
        await releaseFirstSave
      }
    },
  })
  const write = plugin.updateMetadataReconcileSettings(() => ({ repairLog }), {
    metaDoc,
    generation: 9,
    vaultId: vaultAId,
  })
  await firstSaveStarted
  const uiWrite = plugin.updateSettings({ requestedDeviceName: 'from-ui' })
  const setup = plugin.stagePendingSetupResponse({
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('repair-commit-vault-b'),
    deviceId: makeDeviceId('repair-commit-device-b'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  })
  const queuedCapture = await Promise.resolve().then(() =>
    plugin.metadataReconcileTransitionPending() ? undefined : plugin.metadataVaultGeneration,
  )
  assert.equal(queuedCapture, undefined)
  releaseFirstSaveResolve()
  assert.equal(await write, false)
  await uiWrite
  await setup
  assert.deepEqual(plugin.kuroflareSettings.repairLog, [])
  assert.deepEqual(savedRepairLogs, [repairLog, [], []])
  assert.deepEqual(savedDeviceNames, ['before-ui', 'before-ui', 'from-ui'])
  assert.equal(plugin.pendingSetupResponse?.vaultId, makeVaultId('repair-commit-vault-b'))
  assert.equal(plugin.metadataSetupStagingCount, 0)
  metaDoc.destroy()
})
