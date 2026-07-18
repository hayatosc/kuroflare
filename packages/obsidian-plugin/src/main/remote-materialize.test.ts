// @vitest-environment jsdom

import {
  type BinaryMetaFile,
  type BlobManifest,
  hashCanonicalText,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
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
import { type MetadataMaterializationPort } from '../plugin/metadata-materialization'
import {
  findRestorableBinaryFileIdsForReconcile,
  findTextDeletionEvidenceForReconcile,
  enqueueMissingRemoteBinaryDownloads,
  reconcileAndMaterializeMeta,
  scheduleTextDeletionEvidenceRetry,
  type MetadataReconcilePort,
} from '../plugin/metadata-reconcile'
import { applyFileDelete } from '../sync/meta/tree'
import { insertMetaFile, metaMap, readMetaFile, updateMetaFile } from './meta'
import KuroflareSpikePlugin from './plugin'

function createTestPlugin(): KuroflareSpikePlugin {
  const value: unknown = Object.create(KuroflareSpikePlugin.prototype)
  if (!(value instanceof KuroflareSpikePlugin)) {
    throw new Error('failed to create test plugin')
  }
  return value
}

function createReconcilePort(plugin: KuroflareSpikePlugin): MetadataReconcilePort {
  const value = plugin as KuroflareSpikePlugin & {
    requestTextDeletionEvidence?: (loaded: LoadedTextDoc) => Promise<void>
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
    canSendNetwork: () => true,
    getMetaDoc: () => plugin.metaDoc,
    getMetadataAccess: () => plugin.metadataAccess ?? 'read-write',
    loadedTextDocs: plugin.loadedTextDocs ?? new Map(),
    pendingTextDeletionEvidenceRequests: plugin.pendingTextDeletionEvidenceRequests ?? new Map(),
    pendingTextDeletionEvidenceRetryTimers:
      plugin.pendingTextDeletionEvidenceRetryTimers ?? new Map(),
    loadTextDoc: async () => {
      throw new Error('test fixture expected the text document to be loaded')
    },
    requestDocFromWorker: async (loaded) => {
      if (value.requestTextDeletionEvidence !== undefined) {
        await value.requestTextDeletionEvidence(loaded)
        return false
      }
      return false
    },
    getSettings: () => plugin.kuroflareSettings ?? settings,
    updateSettings: async (patch) => {
      plugin.kuroflareSettings = { ...settings, ...plugin.kuroflareSettings, ...patch }
    },
    currentSetup: () => plugin.trustedSetupMetadata ?? undefined,
    readAccessToken: async () => 'access-token',
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
    vault: {
      getAbstractFileByPath: () => null,
      adapter: { readBinary: async () => new ArrayBuffer(0) },
    },
    fileManager: { renameFile: async () => undefined },
    lastMaterialized: plugin.lastMaterialized ?? new Map(),
    materializedPaths: plugin.materializedPaths ?? new Map(),
    pendingRemoteTextFiles: plugin.pendingRemoteTextFiles ?? new Map(),
    pendingFsRenames: plugin.pendingFsRenames ?? new Set(),
    activeRemoteDeletedFileIds: plugin.activeRemoteDeletedFileIds ?? new Set(),
    getActiveFile: () => plugin.activeFile ?? null,
    setSyncStatusText: (text) => plugin.syncStatusEl?.setText(text),
    notify: () => undefined,
    clearTextDeletionEvidenceRequest: () => undefined,
    requestMissingRemoteTextFile: async () => undefined,
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
    doc,
    text,
    persistence: null,
  }
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
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

test('text deletion evidence schedules one bounded retry after no response', async () => {
  vi.useFakeTimers()
  try {
    const doc = new Y.Doc()
    const loaded: LoadedTextDoc = {
      docId: { kind: 'file', ydocId: makeYDocId('evidence-retry-doc') },
      doc,
      text: doc.getText('content'),
      persistence: null,
    }
    const plugin = createTestPlugin()
    let retries = 0
    Object.assign(plugin, {
      pendingTextDeletionEvidenceRequests: new Map([[loaded.docId.ydocId, Date.now() + 10_000]]),
      pendingTextDeletionEvidenceRetryTimers: new Map(),
      loadedTextDocs: new Map([[loaded.docId.ydocId, loaded]]),
      requestTextDeletionEvidence: async () => {
        retries += 1
      },
    })

    scheduleTextDeletionEvidenceRetry(createReconcilePort(plugin), loaded)
    await vi.advanceTimersByTimeAsync(9_999)
    assert.equal(retries, 0)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(retries, 1)
    await vi.advanceTimersByTimeAsync(10_000)
    assert.equal(retries, 1)
    doc.destroy()
  } finally {
    vi.useRealTimers()
  }
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
  })
  const materialize = createMaterializationPort(plugin, {
    getActiveFile: () => ({ path: activePath }),
    setSyncStatusText: (text) => statusTexts.push(text),
    notify: (message) => notices.push(message),
    requestMissingRemoteTextFile: async () => {
      requestStartedResolve()
      await requestRelease
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

test('text deletion evidence is discarded when metadata changes during hashing', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('text-evidence-toctou')
  const ydocId = makeYDocId('text-evidence-toctou-doc')
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'current')
  const stateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(doc)))
  const initial = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Evidence/Text.md',
    canonicalPath: 'evidence/text.md',
    type: 'text' as const,
    ydocId,
    deleted: true as const,
    deletedAt: 2,
    deletedBy: makeDeviceId('text-evidence-deleter'),
    deletedContentVersion: {
      kind: 'text' as const,
      stateVectorBase64,
      contentSha256: makeSha256Hex('0'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('text-evidence-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-evidence-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-evidence-creator'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), initial)
  let digestStartedResolve!: () => void
  let releaseDigestResolve!: () => void
  const digestStarted = new Promise<void>((resolve) => {
    digestStartedResolve = resolve
  })
  const releaseDigest = new Promise<void>((resolve) => {
    releaseDigestResolve = resolve
  })
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
  const digestSpy = vi
    .spyOn(globalThis.crypto.subtle, 'digest')
    .mockImplementation(async (...args: Parameters<SubtleCrypto['digest']>) => {
      digestStartedResolve()
      await releaseDigest
      return originalDigest(...args)
    })
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    doc,
    text,
    persistence: null,
  }
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    kuroflareSettings: { repairLog: [] },
  })
  const pending = findTextDeletionEvidenceForReconcile(createReconcilePort(plugin))
  await digestStarted
  const current = readMetaFile(metaMap(plugin), fileId)
  assert(
    current &&
      current.type === 'text' &&
      current.deleted &&
      current.deletedContentVersion?.kind === 'text',
  )
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...current,
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64: current.deletedContentVersion.stateVectorBase64,
        contentSha256: makeSha256Hex('1'.repeat(64)),
      },
    }),
    true,
  )
  releaseDigestResolve()
  const evidence = await pending
  assert.equal(evidence.has(fileId), false)
  digestSpy.mockRestore()
  doc.destroy()
  metaDoc.destroy()
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
          files.set(target, Object.assign(new TFile(), { path: target }))
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

test('remote text create rejection preserves a competing local file and repair state', async () => {
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
  assert.equal(plugin.pendingRemoteTextFiles.has(ydocId), false)
  assert.equal(folders.has('Folder'), true)
  assert.equal(plugin.kuroflareSettings.repairLog?.[0]?.reason, 'path-collision')
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

test('text evidence final validation drops an earlier item changed while a later item hashes', async () => {
  const metaDoc = new Y.Doc()
  const docs = new Map<string, LoadedTextDoc>()
  const fileIds = [makeFileId('text-final-a'), makeFileId('text-final-b')]
  for (const [index, fileId] of fileIds.entries()) {
    const ydocId = makeYDocId(`text-final-${index}`)
    const doc = new Y.Doc()
    const text = doc.getText('content')
    text.insert(0, `item-${index}`)
    const stateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(doc)))
    insertMetaFile(metaMap({ metaDoc }), {
      schemaVersion: 1,
      fileId,
      path: `Final/Text-${index}.md`,
      canonicalPath: `final/text-${index}.md`,
      type: 'text',
      ydocId,
      deleted: true,
      deletedAt: 2,
      deletedBy: makeDeviceId(`text-final-deleter-${index}`),
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64,
        contentSha256: makeSha256Hex(`${index}`.repeat(64)),
      },
      createdAt: 1,
      createdBy: makeDeviceId(`text-final-creator-${index}`),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId(`text-final-creator-${index}`),
      updatedAt: 1,
      updatedBy: makeDeviceId(`text-final-creator-${index}`),
      mtime: 1,
    })
    docs.set(ydocId, { docId: { kind: 'file', ydocId }, doc, text, persistence: null })
  }
  let hashCount = 0
  let secondHashStartedResolve!: () => void
  let releaseSecondHashResolve!: () => void
  const secondHashStarted = new Promise<void>((resolve) => {
    secondHashStartedResolve = resolve
  })
  const releaseSecondHash = new Promise<void>((resolve) => {
    releaseSecondHashResolve = resolve
  })
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
  const digestSpy = vi
    .spyOn(globalThis.crypto.subtle, 'digest')
    .mockImplementation(async (...args: Parameters<SubtleCrypto['digest']>) => {
      hashCount += 1
      if (hashCount === 2) {
        secondHashStartedResolve()
        await releaseSecondHash
      }
      return originalDigest(...args)
    })
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: docs,
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    kuroflareSettings: { repairLog: [] },
  })
  const pending = findTextDeletionEvidenceForReconcile(createReconcilePort(plugin))
  await secondHashStarted
  const firstFileId = fileIds.at(0)
  const secondFileId = fileIds.at(1)
  assert(firstFileId !== undefined)
  assert(secondFileId !== undefined)
  const currentA = readMetaFile(metaMap(plugin), firstFileId)
  assert(
    currentA &&
      currentA.type === 'text' &&
      currentA.deleted &&
      currentA.deletedContentVersion?.kind === 'text',
  )
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...currentA,
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64: currentA.deletedContentVersion.stateVectorBase64,
        contentSha256: makeSha256Hex('f'.repeat(64)),
      },
    }),
    true,
  )
  releaseSecondHashResolve()
  const evidence = await pending
  assert.equal(evidence.has(firstFileId), false)
  assert.equal(evidence.has(secondFileId), true)
  digestSpy.mockRestore()
  for (const loaded of docs.values()) loaded.doc.destroy()
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
