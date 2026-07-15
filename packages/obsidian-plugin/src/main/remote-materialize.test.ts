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

    plugin.scheduleTextDeletionEvidenceRetry(loaded)
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
  const pending = plugin.findTextDeletionEvidenceForReconcile()
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
    kuroflareSettings: { setupMetadata: undefined, setupVaultId: '' },
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
  const pending = plugin.findRestorableBinaryFileIdsForReconcile()
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
  const pending = plugin.findTextDeletionEvidenceForReconcile()
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
    kuroflareSettings: { setupMetadata: undefined, setupVaultId: '' },
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
  const pending = plugin.findRestorableBinaryFileIdsForReconcile()
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
