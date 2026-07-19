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
import { reconcileAndMaterializeMeta } from '../plugin/metadata-reconcile'
import type { MetadataReconcilePort } from '../plugin/metadata-reconcile-context'
import {
  findTextDeletionEvidenceForReconcile,
  scheduleTextDeletionEvidenceRetry,
} from '../plugin/metadata-text-evidence'
import { BINARY_UPLOAD_ORIGIN } from './constants'
import { insertMetaFile, metaMap, readMetaFile, updateMetaFile } from './meta'
import KuroflareSpikePlugin from './plugin'

function createTestPlugin(): KuroflareSpikePlugin {
  const value: unknown = Object.create(KuroflareSpikePlugin.prototype)
  if (!(value instanceof KuroflareSpikePlugin)) {
    throw new Error('failed to create test plugin')
  }
  Object.assign(value, {
    materializedPathOwners: new Map(),
    pendingRemoteTextFileOwners: new Map(),
    remoteTextMaterializationOperations: new Set(),
    loadingTextDocs: new Map(),
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

test('text deletion evidence schedules one bounded retry after no response', async () => {
  vi.useFakeTimers()
  try {
    const doc = new Y.Doc()
    const metaDoc = new Y.Doc()
    const loaded: LoadedTextDoc = {
      docId: { kind: 'file', ydocId: makeYDocId('evidence-retry-doc') },
      vaultId: 'test-vault',
      vaultGeneration: 0,
      doc,
      text: doc.getText('content'),
      persistence: null,
    }
    const plugin = createTestPlugin()
    let retries = 0
    Object.assign(plugin, {
      metaDoc,
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
    metaDoc.destroy()
  } finally {
    vi.useRealTimers()
  }
})

test('text deletion evidence retry timer cannot cross into a pending vault setup', async () => {
  vi.useFakeTimers()
  try {
    const metaDoc = new Y.Doc()
    const doc = new Y.Doc()
    const ydocId = makeYDocId('evidence-retry-vault-transition-doc')
    const loaded: LoadedTextDoc = {
      docId: { kind: 'file', ydocId },
      vaultId: 'test-vault',
      vaultGeneration: 0,
      doc,
      text: doc.getText('content'),
      persistence: null,
    }
    let requestCount = 0
    const plugin = createTestPlugin()
    Object.assign(plugin, {
      metaDoc,
      metadataVaultGeneration: 4,
      trustedSetupMetadata: {
        endpoint: 'https://worker.example.test',
        vaultId: makeVaultId('evidence-retry-vault-a'),
        deviceId: makeDeviceId('evidence-retry-device-a'),
        protocolVersion: 1,
        bootstrapMode: 'new-vault',
        tokenVersion: 1,
      },
      pendingSetupResponse: null,
      pendingTextDeletionEvidenceRequests: new Map([[ydocId, Date.now() + 10_000]]),
      pendingTextDeletionEvidenceRetryTimers: new Map(),
      loadedTextDocs: new Map([[ydocId, loaded]]),
      requestDocFromWorkerForReconcile: async () => {
        requestCount += 1
        return true
      },
    })

    const reconcile = createReconcilePort(plugin)
    scheduleTextDeletionEvidenceRetry(reconcile, loaded)
    plugin.pendingSetupResponse = {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('evidence-retry-vault-b'),
      deviceId: makeDeviceId('evidence-retry-device-b'),
      accessToken: 'access-token-b',
      refreshToken: 'refresh-token-b',
      tokenVersion: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
    }
    plugin.metadataVaultGeneration += 1
    await vi.advanceTimersByTimeAsync(10_000)

    assert.equal(requestCount, 0)
    assert.equal(plugin.pendingTextDeletionEvidenceRequests.has(ydocId), false)
    assert.equal(plugin.pendingTextDeletionEvidenceRetryTimers.has(ydocId), false)
    doc.destroy()
    metaDoc.destroy()
  } finally {
    vi.useRealTimers()
  }
})

test('unloaded text evidence does not request through a new setup after loading', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('unloaded-evidence-vault-transition')
  const ydocId = makeYDocId('unloaded-evidence-vault-transition-doc')
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'evidence')
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Evidence/Transition.md',
    canonicalPath: 'evidence/transition.md',
    type: 'text',
    ydocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('unloaded-evidence-vault-transition-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64: btoa(String.fromCharCode(...Y.encodeStateVector(doc))),
      contentSha256: await hashCanonicalText(text.toJSON()),
    },
    createdAt: 1,
    createdBy: makeDeviceId('unloaded-evidence-vault-transition-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('unloaded-evidence-vault-transition-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('unloaded-evidence-vault-transition-creator'),
    mtime: 1,
  })
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc,
    text,
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
  const loadedTextDocs = new Map<string, LoadedTextDoc>()
  let requestCount = 0
  let retryCount = 0
  let materializeLookupCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    metadataVaultGeneration: 2,
    loadedTextDocs,
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('unloaded-evidence-vault-a'),
      deviceId: makeDeviceId('unloaded-evidence-device-a'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { repairLog: [] },
    loadTextDocForReconcile: async () => {
      loadedTextDocs.set(ydocId, loaded)
      loadStartedResolve()
      await releaseLoad
      return loaded
    },
    requestDocFromWorkerForReconcile: async () => {
      requestCount += 1
      return true
    },
    scheduleReconcileRetry: () => {
      retryCount += 1
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
  await loadStarted
  plugin.pendingSetupResponse = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('unloaded-evidence-vault-b'),
    deviceId: makeDeviceId('unloaded-evidence-device-b'),
    accessToken: 'access-token-b',
    refreshToken: 'refresh-token-b',
    tokenVersion: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
  }
  plugin.metadataVaultGeneration += 1
  releaseLoadResolve()
  await pending

  assert.equal(requestCount, 0)
  assert.equal(retryCount, 1)
  assert.equal(materializeLookupCount, 0)
  doc.destroy()
  metaDoc.destroy()
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
    vaultId: 'test-vault',
    vaultGeneration: 0,
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

test('text deletion evidence is discarded when its loaded YDoc is replaced', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('loaded-doc-race')
  const ydocId = makeYDocId('loaded-doc-race-doc')
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'current')
  const stateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(doc)))
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Evidence/Loaded.md',
    canonicalPath: 'evidence/loaded.md',
    type: 'text',
    ydocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('loaded-doc-race-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64,
      contentSha256: makeSha256Hex('0'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('loaded-doc-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('loaded-doc-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('loaded-doc-race-creator'),
    mtime: 1,
  })
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
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }
  const replacementDoc = new Y.Doc()
  const replacementText = replacementDoc.getText('content')
  replacementText.insert(0, 'replacement')
  const replacement: LoadedTextDoc = {
    docId: { kind: 'file', ydocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc: replacementDoc,
    text: replacementText,
    persistence: null,
  }
  const plugin = createTestPlugin()
  const docs = new Map([[ydocId, loaded]])
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: docs,
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
  })
  const pending = findTextDeletionEvidenceForReconcile(createReconcilePort(plugin))
  await digestStarted
  docs.set(ydocId, replacement)
  releaseDigestResolve()
  const evidence = await pending
  assert.equal(evidence.has(fileId), false)
  digestSpy.mockRestore()
  doc.destroy()
  replacementDoc.destroy()
  metaDoc.destroy()
})

test('text deletion evidence is discarded when the loaded YDoc edits during hashing', async () => {
  const metaDoc = new Y.Doc()
  const fileId = makeFileId('loaded-edit-race')
  const ydocId = makeYDocId('loaded-edit-race-doc')
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'before')
  const stateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(doc)))
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId,
    path: 'Evidence/LoadedEdit.md',
    canonicalPath: 'evidence/loadededit.md',
    type: 'text',
    ydocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('loaded-edit-race-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64,
      contentSha256: makeSha256Hex('0'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('loaded-edit-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('loaded-edit-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('loaded-edit-race-creator'),
    mtime: 1,
  })
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
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc,
    text,
    persistence: null,
  }
  let requestCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[ydocId, loaded]]),
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    requestTextDeletionEvidence: async () => {
      requestCount += 1
    },
  })
  const pending = findTextDeletionEvidenceForReconcile(createReconcilePort(plugin))
  await digestStarted
  text.insert(text.length, '-during-hash')
  releaseDigestResolve()
  const evidence = await pending
  assert.equal(evidence.has(fileId), false)
  assert.equal(requestCount, 1)
  digestSpy.mockRestore()
  doc.destroy()
  metaDoc.destroy()
})

test('reconcile does not reuse binary evidence after text evidence awaits', async () => {
  const metaDoc = new Y.Doc()
  const binaryFileId = makeFileId('cross-phase-binary')
  const textFileId = makeFileId('cross-phase-text')
  const binaryManifestHash = makeSha256Hex('2'.repeat(64))
  const binaryChunkHash = makeSha256Hex('3'.repeat(64))
  const textYDocId = makeYDocId('cross-phase-text-doc')
  const textDoc = new Y.Doc()
  const text = textDoc.getText('content')
  text.insert(0, 'text')
  const textStateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(textDoc)))
  const textContentSha256 = await hashCanonicalText(text.toJSON())
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: binaryFileId,
    path: 'Cross/Binary.bin',
    canonicalPath: 'cross/binary.bin',
    type: 'binary',
    blobManifestHash: binaryManifestHash,
    blobChunks: [binaryChunkHash],
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('cross-phase-binary-deleter'),
    deletedContentVersion: { kind: 'binary', blobManifestHash: binaryManifestHash },
    createdAt: 1,
    createdBy: makeDeviceId('cross-phase-binary-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('cross-phase-binary-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('cross-phase-binary-creator'),
    mtime: 1,
  })
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: textFileId,
    path: 'Cross/Text.md',
    canonicalPath: 'cross/text.md',
    type: 'text',
    ydocId: textYDocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('cross-phase-text-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64: textStateVectorBase64,
      contentSha256: textContentSha256,
    },
    createdAt: 1,
    createdBy: makeDeviceId('cross-phase-text-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('cross-phase-text-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('cross-phase-text-creator'),
    mtime: 1,
  })
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
  const plugin = createTestPlugin()
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId: textYDocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc: textDoc,
    text,
    persistence: null,
  }
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[textYDocId, loaded]]),
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('cross-phase-vault'),
      deviceId: makeDeviceId('cross-phase-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    fetchBlobManifestForMeta: async (
      _setup: unknown,
      _accessToken: string,
      value: BinaryMetaFile,
    ): Promise<BlobManifest | undefined> => {
      if (value.blobManifestHash !== binaryManifestHash) return undefined
      return {
        version: 1,
        fileId: binaryFileId,
        contentSha256: makeSha256Hex('4'.repeat(64)),
        size: 1,
        chunks: [{ sha256: binaryChunkHash, offset: 0, size: 1 }],
        createdBy: makeDeviceId('cross-phase-manifest'),
        createdAt: 1,
      }
    },
    remoteBlobChunksExist: async () => true,
  })
  const pending = reconcileAndMaterializeMeta(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      openLocalStoreDatabase: async () => {
        const request = fakeIndexedDB.open('cross-phase-test')
        return await new Promise<IDBDatabase>((resolve, reject) => {
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
      },
    }),
  )
  await digestStarted
  const current = readMetaFile(metaMap(plugin), binaryFileId)
  assert(current && current.type === 'binary' && current.deleted)
  assert.equal(
    updateMetaFile(metaMap(plugin), {
      ...current,
      blobManifestHash: makeSha256Hex('5'.repeat(64)),
      blobChunks: [makeSha256Hex('6'.repeat(64))],
      deletedContentVersion: {
        kind: 'binary',
        blobManifestHash: makeSha256Hex('7'.repeat(64)),
      },
    }),
    true,
  )
  releaseDigestResolve()
  await pending
  const final = readMetaFile(metaMap(plugin), binaryFileId)
  assert(final && final.type === 'binary')
  assert.equal(final.deleted, true)
  digestSpy.mockRestore()
  textDoc.destroy()
  metaDoc.destroy()
})

test('reconcile drops text evidence when metadata changes during binary HEAD', async () => {
  const metaDoc = new Y.Doc()
  const textFileId = makeFileId('phase-reversal-text')
  const textYDocId = makeYDocId('phase-reversal-text-doc')
  const binaryFileId = makeFileId('phase-reversal-binary')
  const binaryManifestHash = makeSha256Hex('8'.repeat(64))
  const binaryChunkHash = makeSha256Hex('9'.repeat(64))
  const textDoc = new Y.Doc()
  const text = textDoc.getText('content')
  text.insert(0, 'edited')
  const textStateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(textDoc)))
  const textContentSha256 = await hashCanonicalText(text.toJSON())
  const textDeleted: Parameters<typeof insertMetaFile>[1] = {
    schemaVersion: 1,
    fileId: textFileId,
    path: 'Phase/Text.md',
    canonicalPath: 'phase/text.md',
    type: 'text',
    ydocId: textYDocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('phase-reversal-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64: textStateVectorBase64,
      contentSha256: makeSha256Hex('0'.repeat(64)),
    },
    createdAt: 1,
    createdBy: makeDeviceId('phase-reversal-creator'),
    contentUpdatedAt: 3,
    contentUpdatedBy: makeDeviceId('phase-reversal-editor'),
    updatedAt: 3,
    updatedBy: makeDeviceId('phase-reversal-editor'),
    mtime: 1,
  }
  insertMetaFile(metaMap({ metaDoc }), textDeleted)
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: binaryFileId,
    path: 'Phase/Binary.bin',
    canonicalPath: 'phase/binary.bin',
    type: 'binary',
    blobManifestHash: binaryManifestHash,
    blobChunks: [binaryChunkHash],
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('phase-reversal-binary-deleter'),
    deletedContentVersion: { kind: 'binary', blobManifestHash: binaryManifestHash },
    createdAt: 1,
    createdBy: makeDeviceId('phase-reversal-binary-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('phase-reversal-binary-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('phase-reversal-binary-creator'),
    mtime: 1,
  })
  let headStartedResolve!: () => void
  let releaseHeadResolve!: () => void
  let headCount = 0
  const headStarted = new Promise<void>((resolve) => {
    headStartedResolve = resolve
  })
  const releaseHead = new Promise<void>((resolve) => {
    releaseHeadResolve = resolve
  })
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId: textYDocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc: textDoc,
    text,
    persistence: null,
  }
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[textYDocId, loaded]]),
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('phase-reversal-vault'),
      deviceId: makeDeviceId('phase-reversal-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
      version: 1,
      fileId: binaryFileId,
      contentSha256: makeSha256Hex('a'.repeat(64)),
      size: 1,
      chunks: [{ sha256: binaryChunkHash, offset: 0, size: 1 }],
      createdBy: makeDeviceId('phase-reversal-manifest'),
      createdAt: 1,
    }),
    remoteBlobChunksExist: async () => {
      headCount += 1
      headStartedResolve()
      if (headCount === 1) await releaseHead
      return true
    },
  })
  const pending = reconcileAndMaterializeMeta(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      openLocalStoreDatabase: async () => {
        const request = fakeIndexedDB.open('phase-reversal-test')
        return await new Promise<IDBDatabase>((resolve, reject) => {
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
      },
    }),
  )
  await headStarted
  const current = readMetaFile(metaMap(plugin), textFileId)
  assert(
    current &&
      current.type === 'text' &&
      current.deleted &&
      current.deletedContentVersion?.kind === 'text',
  )
  const currentTextVersion = current.deletedContentVersion
  assert(currentTextVersion?.kind === 'text')
  let updated = false
  metaDoc.transact(() => {
    updated = updateMetaFile(metaMap(plugin), {
      ...current,
      updatedAt: 4,
      updatedBy: makeDeviceId('phase-reversal-later-editor'),
      mtime: 2,
      deletedContentVersion: {
        kind: 'text',
        stateVectorBase64: currentTextVersion.stateVectorBase64,
        contentSha256: textContentSha256,
      },
    })
  }, BINARY_UPLOAD_ORIGIN)
  assert.equal(updated, true)
  releaseHeadResolve()
  await pending
  const final = readMetaFile(metaMap(plugin), textFileId)
  assert(final && final.type === 'text')
  assert.equal(final.deleted, true)
  assert.equal(headCount, 2)
  textDoc.destroy()
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
    docs.set(ydocId, {
      docId: { kind: 'file', ydocId },
      vaultId: 'test-vault',
      vaultGeneration: 0,
      doc,
      text,
      persistence: null,
    })
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

test('reconcile retries when adopted text evidence changes during binary HEAD', async () => {
  const metaDoc = new Y.Doc()
  const textFileId = makeFileId('text-evidence-binary-head-race')
  const textYDocId = makeYDocId('text-evidence-binary-head-race-doc')
  const binaryFileId = makeFileId('text-evidence-binary-head-race-binary')
  const binaryManifestHash = makeSha256Hex('c'.repeat(64))
  const binaryChunkHash = makeSha256Hex('d'.repeat(64))
  const textDoc = new Y.Doc()
  const text = textDoc.getText('content')
  text.insert(0, 'before-head')
  const deletedStateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(textDoc)))
  const deletedContentSha256 = await hashCanonicalText(text.toJSON())
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: textFileId,
    path: 'Evidence/HeadRace.md',
    canonicalPath: 'evidence/headrace.md',
    type: 'text',
    ydocId: textYDocId,
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('text-evidence-binary-head-race-deleter'),
    deletedContentVersion: {
      kind: 'text',
      stateVectorBase64: deletedStateVectorBase64,
      contentSha256: deletedContentSha256,
    },
    createdAt: 1,
    createdBy: makeDeviceId('text-evidence-binary-head-race-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-evidence-binary-head-race-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-evidence-binary-head-race-creator'),
    mtime: 1,
  })
  insertMetaFile(metaMap({ metaDoc }), {
    schemaVersion: 1,
    fileId: binaryFileId,
    path: 'Evidence/HeadRace.bin',
    canonicalPath: 'evidence/headrace.bin',
    type: 'binary',
    blobManifestHash: binaryManifestHash,
    blobChunks: [binaryChunkHash],
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('text-evidence-binary-head-race-binary-deleter'),
    deletedContentVersion: { kind: 'binary', blobManifestHash: binaryManifestHash },
    createdAt: 1,
    createdBy: makeDeviceId('text-evidence-binary-head-race-binary-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('text-evidence-binary-head-race-binary-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('text-evidence-binary-head-race-binary-creator'),
    mtime: 1,
  })
  const loaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId: textYDocId },
    vaultId: 'test-vault',
    vaultGeneration: 0,
    doc: textDoc,
    text,
    persistence: null,
  }
  let firstHeadStartedResolve!: () => void
  let releaseFirstHeadResolve!: () => void
  const firstHeadStarted = new Promise<void>((resolve) => {
    firstHeadStartedResolve = resolve
  })
  const releaseFirstHead = new Promise<void>((resolve) => {
    releaseFirstHeadResolve = resolve
  })
  let headCount = 0
  const plugin = createTestPlugin()
  Object.assign(plugin, {
    metaDoc,
    loadedTextDocs: new Map([[textYDocId, loaded]]),
    pendingTextDeletionEvidenceRequests: new Map(),
    pendingTextDeletionEvidenceRetryTimers: new Map(),
    trustedSetupMetadata: {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId('text-evidence-binary-head-race-vault'),
      deviceId: makeDeviceId('text-evidence-binary-head-race-device'),
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    },
    pendingSetupResponse: null,
    kuroflareSettings: { setupVaultId: '' },
    fetchBlobManifestForMeta: async (): Promise<BlobManifest> => ({
      version: 1,
      fileId: binaryFileId,
      contentSha256: makeSha256Hex('e'.repeat(64)),
      size: 1,
      chunks: [{ sha256: binaryChunkHash, offset: 0, size: 1 }],
      createdBy: makeDeviceId('text-evidence-binary-head-race-manifest'),
      createdAt: 1,
    }),
    remoteBlobChunksExist: async () => {
      headCount += 1
      if (headCount === 1) {
        firstHeadStartedResolve()
        await releaseFirstHead
      }
      return true
    },
  })

  const pending = reconcileAndMaterializeMeta(
    createReconcilePort(plugin),
    createMaterializationPort(plugin, {
      openLocalStoreDatabase: async () => {
        const request = fakeIndexedDB.open('text-evidence-binary-head-race-test')
        return await new Promise<IDBDatabase>((resolve, reject) => {
          request.onerror = () => reject(request.error)
          request.onsuccess = () => resolve(request.result)
        })
      },
    }),
  )
  await firstHeadStarted
  text.insert(text.length, '-edited-during-head')
  releaseFirstHeadResolve()
  await pending

  const current = readMetaFile(metaMap(plugin), textFileId)
  assert(current && current.type === 'text')
  assert.equal(current.deleted, false)
  assert.equal(headCount, 2)
  textDoc.destroy()
  metaDoc.destroy()
})
