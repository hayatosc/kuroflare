// @vitest-environment jsdom

import {
  type BinaryMetaFile,
  type BlobManifest,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
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

import type { KuroflareSettings, LoadedTextDoc } from '../main-types'
import {
  findRestorableBinaryFileIdsForReconcile,
  enqueueMissingRemoteBinaryDownloads,
} from '../plugin/metadata-binary-restore'
import { type MetadataMaterializationPort } from '../plugin/metadata-materialization'
import { reconcileAndMaterializeMeta } from '../plugin/metadata-reconcile'
import type { MetadataReconcilePort } from '../plugin/metadata-reconcile-context'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import { requestMissingRemoteTextFile } from './file-tree'
import { insertMetaFile, metaMap, readMetaFile, updateMetaFile } from './meta'
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

function openFakeDatabase(name: string): Promise<IDBDatabase> {
  const request = fakeIndexedDB.open(name)
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
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

test('binary enqueue revalidates metadata after a manifest await', async () => {
  const oldMetaDoc = new Y.Doc()
  const fileId = makeFileId('manifest-meta-race')
  const manifestHash = makeSha256Hex('a'.repeat(64))
  const chunkHash = makeSha256Hex('b'.repeat(64))
  const value: BinaryMetaFile = {
    schemaVersion: 1,
    fileId,
    path: 'Folder/Race.bin',
    canonicalPath: 'folder/race.bin',
    type: 'binary',
    blobManifestHash: manifestHash,
    blobChunks: [chunkHash],
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('manifest-meta-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('manifest-meta-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('manifest-meta-race-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc: oldMetaDoc }), value)
  const plugin = createTestPlugin()
  let releaseManifest!: () => void
  let manifestStartedResolve!: () => void
  const manifestStarted = new Promise<void>((resolve) => {
    manifestStartedResolve = resolve
  })
  const manifestRelease = new Promise<void>((resolve) => {
    releaseManifest = resolve
  })
  const records: unknown[] = []
  Object.assign(plugin, {
    metaDoc: oldMetaDoc,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('manifest-meta-race-vault'),
      deviceId: makeDeviceId('manifest-meta-race-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    lastMaterialized: new Map(),
    materializedPaths: new Map(),
    pendingRemoteTextFiles: new Map(),
    pendingFsRenames: new Set(),
    activeRemoteDeletedFileIds: new Set(),
    fetchBlobManifestForMeta: async (): Promise<BlobManifest> => {
      manifestStartedResolve()
      await manifestRelease
      return {
        version: 1,
        fileId,
        contentSha256: makeSha256Hex('c'.repeat(64)),
        size: 1,
        chunks: [{ sha256: chunkHash, offset: 0, size: 1 }],
        createdBy: makeDeviceId('manifest-meta-race-manifest'),
        createdAt: 1,
      }
    },
  })
  const pending = enqueueMissingRemoteBinaryDownloads(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      openLocalStoreDatabase: async () => {
        const request = fakeIndexedDB.open('manifest-meta-race-test')
        return await new Promise<IDBDatabase>((resolve, reject) => {
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
      },
      putOutboxRecords: async (_db, nextRecords) => {
        records.push(...nextRecords)
      },
    }),
    'test:manifest-meta-race',
  )
  await manifestStarted
  const currentMetaDoc = new Y.Doc()
  plugin.metaDoc = currentMetaDoc
  releaseManifest()
  await pending
  assert.deepEqual(records, [])
  assert.equal(plugin.materializedPaths.has(fileId), false)
  currentMetaDoc.destroy()
  oldMetaDoc.destroy()
})

test('binary enqueue discards stale metadata after disk hashing', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('disk-meta-race')
  const oldManifestHash = makeSha256Hex('d'.repeat(64))
  const oldChunkHash = makeSha256Hex('e'.repeat(64))
  const nextManifestHash = makeSha256Hex('f'.repeat(64))
  const nextChunkHash = makeSha256Hex('0'.repeat(64))
  const oldValue: BinaryMetaFile = {
    schemaVersion: 1,
    fileId,
    path: 'Folder/DiskRace.bin',
    canonicalPath: 'folder/diskrace.bin',
    type: 'binary',
    blobManifestHash: oldManifestHash,
    blobChunks: [oldChunkHash],
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('disk-meta-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('disk-meta-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('disk-meta-race-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), oldValue)
  const plugin = createTestPlugin()
  let releaseRead!: () => void
  let readStartedResolve!: () => void
  const readStarted = new Promise<void>((resolve) => {
    readStartedResolve = resolve
  })
  const readRelease = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const records: unknown[] = []
  Object.assign(plugin, {
    metaDoc,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('disk-meta-race-vault'),
      deviceId: makeDeviceId('disk-meta-race-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    lastMaterialized: new Map(),
    materializedPaths: new Map(),
    pendingRemoteTextFiles: new Map(),
    pendingFsRenames: new Set(),
    activeRemoteDeletedFileIds: new Set(),
    fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
      version: 1,
      fileId,
      contentSha256: makeSha256Hex('1'.repeat(64)),
      size: 1,
      chunks: [{ sha256: oldChunkHash, offset: 0, size: 1 }],
      createdBy: makeDeviceId('disk-meta-race-manifest'),
      createdAt: 1,
    }),
  })
  const file = Object.assign(new TFile(), { path: oldValue.path })
  const pending = enqueueMissingRemoteBinaryDownloads(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      vault: {
        getAbstractFileByPath: (path) => (path === oldValue.path ? file : null),
        adapter: {
          readBinary: async () => {
            readStartedResolve()
            await readRelease
            return new TextEncoder().encode('disk bytes').buffer
          },
        },
      },
      openLocalStoreDatabase: async () => {
        const request = fakeIndexedDB.open('disk-meta-race-test')
        return await new Promise<IDBDatabase>((resolve, reject) => {
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
      },
      putOutboxRecords: async (_db, nextRecords) => {
        records.push(...nextRecords)
      },
    }),
    'test:disk-meta-race',
  )
  await readStarted
  const current = readMetaFile(metaMap(plugin), fileId)
  assert(current && current.type === 'binary' && !current.deleted)
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...current,
      path: 'Folder/DiskRaceNext.bin',
      canonicalPath: 'folder/diskracenext.bin',
      blobManifestHash: nextManifestHash,
      blobChunks: [nextChunkHash],
    }),
    true,
  )
  releaseRead()
  await pending
  assert.deepEqual(records, [])
  assert.equal(plugin.materializedPaths.has(fileId), false)
  metaDoc.destroy()
})

test('binary enqueue reports no completion when network or token gates block it', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('binary-enqueue-gate')
  const chunkHash = makeSha256Hex('2'.repeat(64))
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Binary/Gated.bin',
    canonicalPath: 'binary/gated.bin',
    type: 'binary',
    blobManifestHash: makeSha256Hex('1'.repeat(64)),
    blobChunks: [chunkHash],
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('binary-enqueue-gate-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('binary-enqueue-gate-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('binary-enqueue-gate-creator'),
    mtime: 1,
  })
  let networkEnabled = false
  let tokenAvailable = true
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('binary-enqueue-gate-vault'),
      deviceId: makeDeviceId('binary-enqueue-gate-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    canSendNetworkForReconcile: () => networkEnabled,
    readAccessTokenForReconcile: async () => (tokenAvailable ? 'access-token' : undefined),
  })
  const materialize = createMaterializationPort(plugin)

  const blocked = await enqueueMissingRemoteBinaryDownloads(
    createReconcilePort(plugin),
    materialize,
    'test:binary-network-gate',
  )
  assert.equal(blocked.has(fileId), false)

  networkEnabled = true
  tokenAvailable = false
  const missingToken = await enqueueMissingRemoteBinaryDownloads(
    createReconcilePort(plugin),
    materialize,
    'test:binary-token-gate',
  )
  assert.equal(missingToken.has(fileId), false)
  metaDoc.destroy()
})

test('binary enqueue reuses only pending and retrying materialize rows', async () => {
  const statuses = ['pending', 'retrying', 'paused', 'blocked', 'failed', 'done'] as const
  for (const status of statuses) {
    const metaDoc = new Y.Doc()
    const fileId = makeFileId(`binary-outbox-status-${status}`)
    const manifestHash = makeSha256Hex('3'.repeat(64))
    const chunkHash = makeSha256Hex('4'.repeat(64))
    const value: BinaryMetaFile = {
      schemaVersion: 1,
      fileId,
      path: `Binary/${status}.bin`,
      canonicalPath: `binary/${status}.bin`,
      type: 'binary',
      blobManifestHash: manifestHash,
      blobChunks: [chunkHash],
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId(`binary-outbox-status-${status}-creator`),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId(`binary-outbox-status-${status}-creator`),
      updatedAt: 1,
      updatedBy: makeDeviceId(`binary-outbox-status-${status}-creator`),
      mtime: 1,
    }
    insertMetaFile(metaMap({ metaDoc }), value)
    const plugin = createTestPlugin()
    Object.assign(plugin, {
      metaDoc,
      trustedSetupMetadata: {
        endpoint: 'https://worker.example.test',
        vaultId: makeVaultId(`binary-outbox-status-${status}-vault`),
        deviceId: makeDeviceId(`binary-outbox-status-${status}-device`),
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
        tokenVersion: 1,
      },
      pendingSetupResponse: null,
      kuroflareSettings: { setupVaultId: '' },
      lastMaterialized: new Map(),
      materializedPaths: new Map(),
      pendingRemoteTextFiles: new Map(),
      pendingFsRenames: new Set(),
      activeRemoteDeletedFileIds: new Set(),
      fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
        version: 1,
        fileId,
        contentSha256: makeSha256Hex('5'.repeat(64)),
        size: 1,
        chunks: [{ sha256: chunkHash, offset: 0, size: 1 }],
        createdBy: makeDeviceId(`binary-outbox-status-${status}-manifest`),
        createdAt: 1,
      }),
    })
    const persisted: LocalStoreOutboxRecord[] = []
    let tickCount = 0
    const result = await enqueueMissingRemoteBinaryDownloads(
      createReconcilePort(plugin),
      createMaterializationPort(plugin, {
        openLocalStoreDatabase: () => openFakeDatabase(`binary-outbox-status-${status}`),
        readOutboxWorkerSnapshot: async () => ({
          outboxRecords: [
            {
              id: `existing-${status}`,
              kind: 'materialize',
              status,
              dependsOn: [],
              nextAttemptAt: undefined,
              fileId,
              blobManifestHash: manifestHash,
              targetPath: value.path,
            },
          ],
        }),
        putOutboxRecords: async (_db, records) => {
          persisted.push(...records)
        },
        runOutboxWorkerTick: async () => {
          tickCount += 1
        },
      }),
      `test:binary-outbox-status-${status}`,
    )
    const isReusable = status === 'pending' || status === 'retrying'
    assert.equal(result.has(fileId), true, status)
    if (isReusable) {
      assert.deepEqual(persisted, [])
      assert.equal(tickCount, 0)
    } else {
      assert(persisted.length > 0)
      assert.equal(tickCount, 1)
    }
    metaDoc.destroy()
  }
})

test('binary enqueue retries same-vault outbox persistence failures and drops stale writes', async () => {
  const run = async (
    mode: 'failure' | 'transition',
  ): Promise<{
    readonly completed: boolean
    readonly retryCount: number
    readonly tickCount: number
    readonly marker: string | undefined
  }> => {
    const metaDoc = new Y.Doc()
    const fileId = makeFileId(`binary-outbox-put-${mode}`)
    const manifestHash = makeSha256Hex('6'.repeat(64))
    const chunkHash = makeSha256Hex('7'.repeat(64))
    const value: BinaryMetaFile = {
      schemaVersion: 1,
      fileId,
      path: `Binary/Put-${mode}.bin`,
      canonicalPath: `binary/put-${mode}.bin`,
      type: 'binary',
      blobManifestHash: manifestHash,
      blobChunks: [chunkHash],
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId(`binary-outbox-put-${mode}-creator`),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId(`binary-outbox-put-${mode}-creator`),
      updatedAt: 1,
      updatedBy: makeDeviceId(`binary-outbox-put-${mode}-creator`),
      mtime: 1,
    }
    insertMetaFile(metaMap({ metaDoc }), value)
    const plugin = createTestPlugin()
    let retryCount = 0
    let tickCount = 0
    Object.assign(plugin, {
      metaDoc,
      metadataVaultGeneration: 0,
      scheduleReconcileRetry: () => {
        retryCount += 1
      },
      trustedSetupMetadata: {
        endpoint: 'https://worker.example.test',
        vaultId: makeVaultId(`binary-outbox-put-${mode}-vault-a`),
        deviceId: makeDeviceId(`binary-outbox-put-${mode}-device-a`),
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
        tokenVersion: 1,
      },
      pendingSetupResponse: null,
      kuroflareSettings: { setupVaultId: '' },
      lastMaterialized: new Map(),
      materializedPaths: new Map(),
      pendingRemoteTextFiles: new Map(),
      pendingFsRenames: new Set(),
      activeRemoteDeletedFileIds: new Set(),
      fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
        version: 1,
        fileId,
        contentSha256: makeSha256Hex('8'.repeat(64)),
        size: 1,
        chunks: [{ sha256: chunkHash, offset: 0, size: 1 }],
        createdBy: makeDeviceId(`binary-outbox-put-${mode}-manifest`),
        createdAt: 1,
      }),
    })
    const result = await enqueueMissingRemoteBinaryDownloads(
      createReconcilePort(plugin),
      createMaterializationPort(plugin, {
        openLocalStoreDatabase: () => openFakeDatabase(`binary-outbox-put-${mode}`),
        putOutboxRecords: async () => {
          if (mode === 'transition') {
            plugin.pendingSetupResponse = {
              endpoint: 'https://worker.example.test',
              vaultId: makeVaultId('binary-outbox-put-transition-vault-b'),
              deviceId: makeDeviceId('binary-outbox-put-transition-device-b'),
              accessToken: 'access-token-b',
              refreshToken: 'refresh-token-b',
              tokenVersion: 1,
              protocolVersion: 1,
              bootstrapMode: 'new-vault',
            }
            plugin.metadataVaultGeneration += 1
            return
          }
          throw new Error('InvalidStateError: database is closed')
        },
        runOutboxWorkerTick: async () => {
          tickCount += 1
        },
      }),
      `test:binary-outbox-put-${mode}`,
    )
    const output = {
      completed: result.has(fileId),
      retryCount,
      tickCount,
      marker: plugin.materializedPaths.get(fileId),
    }
    metaDoc.destroy()
    return output
  }

  assert.deepEqual(await run('failure'), {
    completed: false,
    retryCount: 1,
    tickCount: 0,
    marker: undefined,
  })
  assert.deepEqual(await run('transition'), {
    completed: false,
    retryCount: 0,
    tickCount: 0,
    marker: undefined,
  })
})

test('binary deletion evidence is discarded when metadata changes during HEAD verification', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('binary-evidence-toctou')
  const manifestHash = makeSha256Hex('2'.repeat(64))
  const chunkHash = makeSha256Hex('3'.repeat(64))
  const initial = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Evidence/Binary.bin',
    canonicalPath: 'evidence/binary.bin',
    type: 'binary' as const,
    blobManifestHash: manifestHash,
    blobChunks: [chunkHash],
    deleted: true as const,
    deletedAt: 2,
    deletedBy: makeDeviceId('binary-evidence-deleter'),
    deletedContentVersion: {
      kind: 'binary' as const,
      blobManifestHash: manifestHash,
    },
    createdAt: 1,
    createdBy: makeDeviceId('binary-evidence-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('binary-evidence-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('binary-evidence-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), initial)
  let headStartedResolve!: () => void
  let releaseHeadResolve!: () => void
  const headStarted = new Promise<void>((resolve) => {
    headStartedResolve = resolve
  })
  const releaseHead = new Promise<void>((resolve) => {
    releaseHeadResolve = resolve
  })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('binary-evidence-vault'),
      deviceId: makeDeviceId('binary-evidence-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    app: { secretStorage: { getSecret: () => 'access-token' } },
    fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
      version: 1,
      fileId,
      contentSha256: makeSha256Hex('0'.repeat(64)),
      size: 1,
      chunks: [{ sha256: chunkHash, offset: 0, size: 1 }],
      createdBy: makeDeviceId('binary-evidence-manifest'),
      createdAt: 1,
    }),
    remoteBlobChunksExist: async () => {
      headStartedResolve()
      await releaseHead
      return true
    },
  })
  const pending = findRestorableBinaryFileIdsForReconcile(createReconcilePort(plugin))
  await headStarted
  const current = readMetaFile(metaMap(plugin), fileId)
  assert(current && current.type === 'binary' && current.deleted)
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...current,
      blobManifestHash: makeSha256Hex('4'.repeat(64)),
      deletedContentVersion: {
        kind: 'binary',
        blobManifestHash: makeSha256Hex('5'.repeat(64)),
      },
    }),
    true,
  )
  releaseHeadResolve()
  const restorable = await pending
  assert.equal(restorable.has(fileId), false)
  metaDoc.destroy()
})

test('binary evidence final validation drops an earlier item changed during later HEAD verification', async () => {
  const metaDoc = new Y.Doc()
  const fileIds = [makeFileId('binary-final-a'), makeFileId('binary-final-b')]
  const hashes = [makeSha256Hex('6'.repeat(64)), makeSha256Hex('7'.repeat(64))]
  for (const [index, fileId] of fileIds.entries()) {
    const manifestHash = hashes.at(index)
    assert(manifestHash !== undefined)
    insertMetaFile(metaMap({ metaDoc }), {
      schemaVersion: 1,
      fileId,
      path: `Final/Binary-${index}.bin`,
      canonicalPath: `final/binary-${index}.bin`,
      type: 'binary',
      blobManifestHash: manifestHash,
      blobChunks: [makeSha256Hex(`${index + 8}`.repeat(64))],
      deleted: true,
      deletedAt: 2,
      deletedBy: makeDeviceId(`binary-final-deleter-${index}`),
      deletedContentVersion: { kind: 'binary', blobManifestHash: manifestHash },
      createdAt: 1,
      createdBy: makeDeviceId(`binary-final-creator-${index}`),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId(`binary-final-creator-${index}`),
      updatedAt: 1,
      updatedBy: makeDeviceId(`binary-final-creator-${index}`),
      mtime: 1,
    })
  }
  let headCount = 0
  let secondHeadStartedResolve!: () => void
  let releaseSecondHeadResolve!: () => void
  const secondHeadStarted = new Promise<void>((resolve) => {
    secondHeadStartedResolve = resolve
  })
  const releaseSecondHead = new Promise<void>((resolve) => {
    releaseSecondHeadResolve = resolve
  })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('binary-final-vault'),
      deviceId: makeDeviceId('binary-final-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    app: { secretStorage: { getSecret: () => 'access-token' } },
    fetchBlobManifestForMeta: async (
      _setup: unknown,
      _accessToken: string,
      value: BinaryMetaFile,
    ): Promise<BlobManifest> => ({
      version: 1,
      fileId: value.fileId,
      contentSha256: makeSha256Hex('0'.repeat(64)),
      size: value.blobChunks.length,
      chunks: value.blobChunks.map((sha256, index) => ({ sha256, offset: index, size: 1 })),
      createdBy: makeDeviceId('binary-final-manifest'),
      createdAt: 1,
    }),
    remoteBlobChunksExist: async () => {
      headCount += 1
      if (headCount === 2) {
        secondHeadStartedResolve()
        await releaseSecondHead
      }
      return true
    },
  })
  const pending = findRestorableBinaryFileIdsForReconcile(createReconcilePort(plugin))
  await secondHeadStarted
  const firstFileId = fileIds.at(0)
  const secondFileId = fileIds.at(1)
  assert(firstFileId !== undefined)
  assert(secondFileId !== undefined)
  const currentA = readMetaFile(metaMap(plugin), firstFileId)
  assert(currentA && currentA.type === 'binary' && currentA.deleted)
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...currentA,
      blobManifestHash: makeSha256Hex('a'.repeat(64)),
      deletedContentVersion: { kind: 'binary', blobManifestHash: makeSha256Hex('b'.repeat(64)) },
    }),
    true,
  )
  releaseSecondHeadResolve()
  const restorable = await pending
  assert.equal(restorable.has(firstFileId), false)
  assert.equal(restorable.has(secondFileId), true)
  metaDoc.destroy()
})

test('stale remote text request preserves a next-generation same-path marker', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('text-request-send-race')
  const ydocId = makeYDocId('text-request-send-race-doc')
  const initial = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Requests/Before.md',
    canonicalPath: 'requests/before.md',
    type: 'text' as const,
    ydocId,
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('text-request-send-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-request-send-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-request-send-race-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), initial)
  const doc = new Y.Doc()
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: makeVaultId('text-request-send-race-vault'),
    vaultGeneration: 0,
    doc,
    text: doc.getText('content'),
    persistence: null,
  }
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
        assert.equal(
          updateMetaFile(metaMap(plugin), {
            ...initial,
            path: 'Requests/After.md',
            canonicalPath: 'requests/after.md',
            updatedAt: 2,
          }),
          true,
        )
        plugin.metadataVaultGeneration += 1
        plugin.pendingSetupResponse = {
          endpoint: 'https://worker.example.test',
          vaultId: makeVaultId('text-request-send-race-vault-b'),
          deviceId: makeDeviceId('text-request-send-race-device-b'),
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
          initial.path,
          plugin.metadataVaultGeneration,
        )
      },
      close: () => undefined,
      snapshot: () => ({ hasConnection: true, readyState: WebSocket.OPEN }),
    },
    startupSideEffectGate: { canSendNetwork: () => true, replayingPersistence: false },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('text-request-send-race-vault'),
      deviceId: makeDeviceId('text-request-send-race-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    app: { vault: { getAbstractFileByPath: () => null } },
  })

  assert.equal(await requestMissingRemoteTextFile(plugin, initial), false)
  assert.equal(plugin.pendingRemoteTextFiles.get(ydocId), initial.path)
  doc.destroy()
  metaDoc.destroy()
})

test('metadata reconcile retry scheduled for vault A is discarded when setup B starts', async () => {
  vi.useFakeTimers()
  try {
    const plugin = createTestPlugin()
    const metaDoc = new Y.Doc()
    const fileId = makeFileId('retry-vault-a-file')
    const ydocId = makeYDocId('retry-vault-a-file-doc')
    insertMetaFile(metaMap({ metaDoc }), {
      schemaVersion: 1,
      fileId,
      path: 'Retry/VaultA.md',
      canonicalPath: 'retry/vaulta.md',
      type: 'text',
      ydocId,
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('retry-vault-a-file-creator'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('retry-vault-a-file-creator'),
      updatedAt: 1,
      updatedBy: makeDeviceId('retry-vault-a-file-creator'),
      mtime: 1,
    })
    let vaultLookupCount = 0
    Object.assign(plugin, {
      metaDoc,
      metadataAccess: 'read-write',
      metadataReconcileRetryTimeout: null,
      metadataVaultGeneration: 7,
      metadataMigrationPending: false,
      metadataMigrationPromise: null,
      documentReplacementInProgress: new Set(),
      loadedTextDocs: new Map(),
      pendingTextDeletionEvidenceRequests: new Map(),
      pendingTextDeletionEvidenceRetryTimers: new Map(),
      materializedPaths: new Map(),
      pendingRemoteTextFiles: new Map(),
      pendingFsRenames: new Set(),
      activeRemoteDeletedFileIds: new Set(),
      lastMaterialized: new Map(),
      pendingSetupResponse: null,
      trustedSetupMetadata: {
        endpoint: 'https://worker.example.test',
        vaultId: makeVaultId('retry-vault-a'),
        deviceId: makeDeviceId('retry-device-a'),
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
        tokenVersion: 1,
      },
      startupSideEffectGate: {
        canSendNetwork: () => true,
        replayingPersistence: false,
      },
      app: {
        vault: {
          getAbstractFileByPath: () => {
            vaultLookupCount += 1
            return null
          },
        },
      },
    })

    plugin.scheduleMetadataReconcileRetry()
    assert.notEqual(plugin.metadataReconcileRetryTimeout, null)
    plugin.pendingSetupResponse = {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('retry-vault-b'),
      deviceId: makeDeviceId('retry-device-b'),
      accessToken: 'access-token-b',
      refreshToken: 'refresh-token-b',
      tokenVersion: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    }
    await vi.runAllTimersAsync()

    assert.equal(plugin.metadataReconcileRetryTimeout, null)
    assert.equal(vaultLookupCount, 0)
    plugin.scheduleMetadataReconcileRetry()
    assert.equal(plugin.metadataReconcileRetryTimeout, null)
    metaDoc.destroy()
  } finally {
    vi.useRealTimers()
  }
})

test('metadata reconcile does not immediately retry after setup transition starts', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('reconcile-setup-transition')
  const manifestHash = makeSha256Hex('a'.repeat(64))
  const chunkHash = makeSha256Hex('b'.repeat(64))
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Retry/Transition.bin',
    canonicalPath: 'retry/transition.bin',
    type: 'binary',
    blobManifestHash: manifestHash,
    blobChunks: [chunkHash],
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('reconcile-setup-transition-deleter'),
    deletedContentVersion: { kind: 'binary', blobManifestHash: manifestHash },
    createdAt: 1,
    createdBy: makeDeviceId('reconcile-setup-transition-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('reconcile-setup-transition-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('reconcile-setup-transition-creator'),
    mtime: 1,
  })
  let headCount = 0
  let scheduledRetryCount = 0
  let materializeLookupCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 3,
    scheduleReconcileRetry: () => {
      scheduledRetryCount += 1
    },
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('reconcile-setup-transition-vault-a'),
      deviceId: makeDeviceId('reconcile-setup-transition-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
      version: 1,
      fileId,
      contentSha256: makeSha256Hex('c'.repeat(64)),
      size: 1,
      chunks: [{ sha256: chunkHash, offset: 0, size: 1 }],
      createdBy: makeDeviceId('reconcile-setup-transition-manifest'),
      createdAt: 1,
    }),
    remoteBlobChunksExist: async () => {
      headCount += 1
      plugin.pendingSetupResponse = {
        endpoint: 'https://worker.example.test',
        vaultId: makeVaultId('reconcile-setup-transition-vault-b'),
        deviceId: makeDeviceId('reconcile-setup-transition-device-b'),
        accessToken: 'access-token-b',
        refreshToken: 'refresh-token-b',
        tokenVersion: 1,
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
      }
      plugin.metadataVaultGeneration += 1
      return true
    },
  })

  await reconcileAndMaterializeMeta(
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

  assert.equal(headCount, 1)
  assert.equal(scheduledRetryCount, 1)
  assert.equal(materializeLookupCount, 0)
  metaDoc.destroy()
})
