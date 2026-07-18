import {
  hashBytesSha256,
  hashCanonicalText,
  canonicalizeVaultPath,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeYDocId,
  buildBinaryUploadOutboxPlan,
  buildBlobManifest,
  blobManifestMatchesMetaFile,
  VaultRelativePathSchema,
  type BinaryMetaFile,
  type DeviceId,
  type FileId,
  type MetaFile,
} from '@kuroflare/core'
import { Notice, TFile } from 'obsidian'
import * as v from 'valibot'
import * as Y from 'yjs'

import type { FileDocId, GenerationMarkerOwner, LoadedTextDoc } from '../main-types'
import { applyFileCreate, applyFileDelete, applyFileRename } from '../sync/meta/tree'
import { type LocalStoreOutboxRecord } from '../sync/store/store'
import {
  nextWorkerMessageId,
  findActiveFileId,
  currentSetupMetadata,
  fileDocIdForPath,
  type SetupMetadataSource,
} from './auth'
import {
  FILE_TREE_ORIGIN,
  BINARY_UPLOAD_ORIGIN,
  BLOB_CACHE_PATH_PREFIX,
  MARKDOWN_EXTENSION,
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
} from './constants'
import { importFileTextIntoDoc, importFileTextIntoDocAndSend } from './editor'
import { encodeBase64, binaryBlobCacheKey, requireOutboxPlanItemId, safeLogError } from './helpers'
import {
  insertMetaFile,
  loadTextDoc,
  metadataWritesEnabled,
  metaMap,
  readMetaFile,
  updateMetaFile,
} from './meta'
import { writeBlobCacheBytes } from './outbox/blob-cache'
import { runOutboxWorkerTick } from './outbox/tick'
import type KuroflareSpikePlugin from './plugin'
import {
  clearOwnedPathMarker,
  consumePendingFsRename,
  deletePathMarker,
  setOwnedPathMarker,
} from './runtime-guards'
import { openLocalStoreDatabase, putOutboxRecords } from './store'
import { requestDocFromWorker } from './sync-websocket'

export function fileTreeDeviceId(plugin: SetupMetadataSource): DeviceId {
  return makeDeviceId(currentSetupMetadata(plugin)?.deviceId ?? 'local-device')
}

function canWriteMetadata(plugin: {
  readonly metadataAccess?: 'read-only' | 'read-write'
  readonly metaDoc?: Y.Doc
}): boolean {
  if (plugin.metaDoc === undefined) return false
  if (plugin.metadataAccess === undefined) {
    return metadataWritesEnabled({ metaDoc: plugin.metaDoc })
  }
  return metadataWritesEnabled({ metadataAccess: plugin.metadataAccess, metaDoc: plugin.metaDoc })
}

/** Minimal plugin surface needed to register a newly created text file. */
export interface VaultCreatePlugin extends SetupMetadataSource {
  readonly startupSideEffectGate: {
    readonly canRun: () => boolean
  }
  readonly metaDoc: Y.Doc
  readonly metadataAccess?: 'read-only' | 'read-write'
  readonly materializedPaths: Map<FileId, string>
  readonly materializedPathOwners: Map<FileId, GenerationMarkerOwner>
  readonly metadataVaultGeneration: number
  readonly activeFile: { readonly path: string } | null
  readonly app: {
    readonly workspace: {
      readonly getActiveFile: () => { readonly path: string } | null
    }
  }
}

export function registerFileTreeWatcher(plugin: KuroflareSpikePlugin): void {
  plugin.registerEvent(
    plugin.app.vault.on('create', (file) => {
      if (!plugin.startupSideEffectGate.canRun()) return
      if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
        void handleVaultCreate(plugin, file)
        return
      }
      if (file instanceof TFile) {
        void enqueueBinaryUploadFromVaultFile(plugin, file, 'binary-create')
      }
    }),
  )
  plugin.registerEvent(
    plugin.app.vault.on('modify', (file) => {
      if (!plugin.startupSideEffectGate.canRun()) return
      if (file instanceof TFile && file.extension !== MARKDOWN_EXTENSION) {
        void enqueueBinaryUploadFromVaultFile(plugin, file, 'binary-modify')
      }
    }),
  )
  plugin.registerEvent(
    plugin.app.vault.on('rename', (file, oldPath) => {
      if (!plugin.startupSideEffectGate.canRun()) return
      if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
        handleVaultRename(plugin, file, oldPath)
        return
      }
      if (file instanceof TFile) {
        void handleBinaryVaultRename(plugin, file, oldPath)
      }
    }),
  )
  plugin.registerEvent(
    plugin.app.vault.on('delete', (file) => {
      if (file instanceof TFile && plugin.pendingFsDeletes.delete(file.path)) return
      if (!plugin.startupSideEffectGate.canRun()) return
      if (file instanceof TFile) {
        void handleVaultDelete(plugin, file).catch((error: unknown) => {
          console.error('[kuroflare] vault delete deferred because deletion evidence failed', {
            path: file.path,
            error: safeLogError(error),
          })
          new Notice(
            `Kuroflare sync: delete evidence unavailable for ${file.path}; deletion was not recorded. Restore it, wait for sync, then delete it again.`,
          )
        })
      }
    }),
  )
}

export async function handleVaultCreate(
  plugin: VaultCreatePlugin,
  file: Pick<TFile, 'path'>,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canRun() || !canWriteMetadata(plugin)) return
  if (findActiveFileId(plugin, file.path) !== undefined) return
  const fileId = makeFileId(crypto.randomUUID())
  const activeYDocId = await startupYDocId(plugin, file, fileId)
  if (!plugin.startupSideEffectGate.canRun() || !canWriteMetadata(plugin)) return
  if (findActiveFileId(plugin, file.path) !== undefined) return
  applyFileCreate(metaMap(plugin), {
    fileId,
    path: file.path,
    ydocId: activeYDocId,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  setMaterializedPath(plugin, fileId, file.path)
}

function handleVaultRename(plugin: KuroflareSpikePlugin, file: TFile, oldPath: string): void {
  if (!plugin.startupSideEffectGate.canRun() || !canWriteMetadata(plugin)) return
  if (consumePendingFsRename(plugin.pendingFsRenames, file.path)) return
  const result = applyFileRename(metaMap(plugin), {
    fromPath: oldPath,
    toPath: file.path,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'renamed') {
    setMaterializedPath(plugin, result.fileId, file.path)
  }
}

export async function handleVaultDelete(plugin: KuroflareSpikePlugin, file: TFile): Promise<void> {
  if (!plugin.startupSideEffectGate.canRun() || !canWriteMetadata(plugin)) return
  const fileId = findActiveFileId(plugin, file.path)
  if (fileId === undefined) return
  const current = readMetaFile(metaMap(plugin), fileId)
  if (current === undefined || current.deleted) return

  let textContext: RemoteTextRequestContext | undefined
  let deletedContentVersion:
    | { readonly kind: 'text'; readonly stateVectorBase64: string; readonly contentSha256: string }
    | { readonly kind: 'binary'; readonly blobManifestHash: string }
  if (current.type === 'text') {
    textContext = captureRemoteTextRequestContext(plugin)
    if (textContext === undefined) return
    const loaded = await loadTextDoc(plugin, { kind: 'file', ydocId: current.ydocId })
    if (!loadedRemoteTextRequestContextStillStable(plugin, textContext, loaded)) return
    const contentSha256 = makeSha256Hex(await hashCanonicalText(loaded.text.toJSON()))
    if (!loadedRemoteTextRequestContextStillStable(plugin, textContext, loaded)) return
    deletedContentVersion = {
      kind: 'text',
      stateVectorBase64: encodeBase64(Y.encodeStateVector(loaded.doc)),
      contentSha256,
    }
  } else {
    if (current.blobManifestHash === undefined) return
    deletedContentVersion = { kind: 'binary', blobManifestHash: current.blobManifestHash }
  }

  if (!plugin.startupSideEffectGate.canRun() || !canWriteMetadata(plugin)) return
  if (textContext !== undefined && !remoteTextRequestContextStillStable(plugin, textContext)) return
  if (plugin.app.vault.getAbstractFileByPath(file.path) !== null) return
  if (findActiveFileId(plugin, file.path) !== fileId) return
  const result = applyFileDelete(metaMap(plugin), {
    path: file.path,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    deletedContentVersion,
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'deleted') {
    deleteMaterializedPath(plugin, result.fileId)
  } else if (result.action === 'deferred') {
    console.warn('[kuroflare] deferred vault delete until deletion evidence is available', {
      fileId: result.fileId,
      path: file.path,
      reason: result.reason,
    })
  }
}

async function handleBinaryVaultRename(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  oldPath: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork() || !canWriteMetadata(plugin)) return
  const oldFileId = findActiveFileId(plugin, oldPath)
  if (oldFileId === undefined) {
    await enqueueBinaryUploadFromVaultFile(plugin, file, 'binary-rename')
    return
  }
  const oldEntry = readMetaFile(metaMap(plugin), oldFileId)
  if (oldEntry === undefined || oldEntry.type !== 'binary') return
  if (consumePendingFsRename(plugin.pendingFsRenames, file.path)) return
  const result = applyFileRename(metaMap(plugin), {
    fromPath: oldPath,
    toPath: file.path,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'renamed') {
    setMaterializedPath(plugin, result.fileId, file.path)
  }
}

export async function planBinaryMetaUpdate(
  plugin: KuroflareSpikePlugin,
  input: {
    readonly fileId: FileId
    readonly path: string
    readonly previous: BinaryMetaFile | undefined
    readonly manifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
    readonly chunkHashes: readonly NonNullable<LocalStoreOutboxRecord['blobSha256']>[]
    readonly now: number
  },
): Promise<Uint8Array> {
  const tempDoc = new Y.Doc()
  try {
    Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(plugin.metaDoc), WORKER_ORIGIN)
    const tempMeta = tempDoc.getMap<unknown>('meta')
    const entry: BinaryMetaFile = {
      schemaVersion: 1,
      fileId: input.fileId,
      path: input.path,
      canonicalPath: canonicalizeVaultPath(input.path),
      type: 'binary',
      blobManifestHash: input.manifestHash,
      blobChunks: [...input.chunkHashes],
      deleted: false,
      createdAt: input.previous?.createdAt ?? input.now,
      createdBy: input.previous?.createdBy ?? fileTreeDeviceId(plugin),
      contentUpdatedAt: input.now,
      contentUpdatedBy: fileTreeDeviceId(plugin),
      updatedAt: input.now,
      updatedBy: fileTreeDeviceId(plugin),
      mtime: input.now,
    }
    // Capture the mutation's own transaction update rather than diffing
    // against a captured state vector: `Y.encodeStateAsUpdate(doc, vector)`
    // always re-emits the delete-set for every struct the vector covers, so
    // diffing since a snapshot taken right after importing the whole live
    // doc would leak unrelated tombstones from other actors into this
    // update. Those tombstones can reference content the server hasn't
    // durably received yet (still queued in this device's own outbox),
    // which fails the server's causal-application check and quarantines the
    // update. The transaction's own update event only ever reports what
    // this transaction actually changed.
    let capturedUpdate: Uint8Array | undefined
    const captureUpdate = (update: Uint8Array): void => {
      capturedUpdate = update
    }
    tempDoc.on('update', captureUpdate)
    try {
      tempDoc.transact(() => {
        if (input.previous !== undefined && updateMetaFile(tempMeta, entry)) {
          // Updated content/location groups are emitted without replacing the root entry.
        } else {
          insertMetaFile(tempMeta, entry)
        }
      })
    } finally {
      tempDoc.off('update', captureUpdate)
    }
    if (capturedUpdate === undefined) {
      throw new Error(`binary meta update produced no change for ${input.fileId}`)
    }
    return capturedUpdate
  } finally {
    tempDoc.destroy()
  }
}

export function scanLocalVaultForStartup(plugin: KuroflareSpikePlugin): void {
  plugin.startupScannedMarkdownFiles = plugin.app.vault
    .getMarkdownFiles()
    .filter((file) => v.is(VaultRelativePathSchema, file.path))
  console.info('[kuroflare] scanned local vault for startup', {
    markdownFiles: plugin.startupScannedMarkdownFiles.length,
  })
}

export async function createLocalMetaYDocFromStartupScan(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  if (!canWriteMetadata(plugin)) return
  const files =
    plugin.startupScannedMarkdownFiles.length === 0
      ? plugin.app.vault.getMarkdownFiles()
      : plugin.startupScannedMarkdownFiles
  let created = 0
  for (const file of files) {
    if (!v.is(VaultRelativePathSchema, file.path)) continue
    if (!(plugin.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) continue
    if (findActiveFileId(plugin, file.path) !== undefined) continue

    const text = await plugin.app.vault.read(file)
    const fileId = makeFileId(crypto.randomUUID())
    const ydocId = await startupYDocId(plugin, file, fileId)
    const docId: FileDocId = { kind: 'file', ydocId }
    const now = Date.now()
    applyFileCreate(metaMap(plugin), {
      fileId,
      path: file.path,
      ydocId,
      deviceId: fileTreeDeviceId(plugin),
      now,
      origin: FILE_TREE_ORIGIN,
    })
    setMaterializedPath(plugin, fileId, file.path)
    await importFileTextIntoDoc(plugin, file, docId, text)
    created += 1
  }
  console.info('[kuroflare] created local meta YDoc from startup scan', { created, reason })
}

export async function adoptLocalFilesAfterRemoteMeta(plugin: KuroflareSpikePlugin): Promise<void> {
  if (!canWriteMetadata(plugin)) return
  let adopted = 0
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const remoteFileId = findActiveFileId(plugin, file.path)
    if (remoteFileId !== undefined) {
      await queueJoinAdoptionHashCheck(plugin, file, remoteFileId)
      continue
    }
    const fileId = makeFileId(crypto.randomUUID())
    const ydocId = await startupYDocId(plugin, file, fileId)
    const docId: FileDocId = { kind: 'file', ydocId }
    const now = Date.now()
    applyFileCreate(metaMap(plugin), {
      fileId,
      path: file.path,
      ydocId,
      deviceId: fileTreeDeviceId(plugin),
      now,
      origin: FILE_TREE_ORIGIN,
    })
    setMaterializedPath(plugin, fileId, file.path)
    await importFileTextIntoDocAndSend(
      plugin,
      file,
      docId,
      `startup:adopt-local-files-after-remote-meta`,
    )
    adopted += 1
  }
  // Each `applyFileCreate` above already synced incrementally through metaDoc's
  // own `update` listener; resending the full doc here duplicated that update
  // and could quarantine the sync-update on the server, because
  // `Y.encodeStateAsUpdate(doc)` re-emits every delete this device has ever
  // observed, not just what changed since the last send.
  console.info('[kuroflare] adopted local files after remote meta', { adopted })
}

async function startupYDocId(
  plugin: VaultCreatePlugin,
  file: Pick<TFile, 'path'>,
  fileId: FileId,
): Promise<string> {
  const activeFilePath = plugin.app.workspace.getActiveFile()?.path ?? plugin.activeFile?.path
  if (activeFilePath !== file.path) {
    return makeYDocId(`file-${fileId}`)
  }
  return (await fileDocIdForPath(plugin, file.path)).ydocId
}

async function queueJoinAdoptionHashCheck(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  fileId: FileId,
): Promise<void> {
  const filePath = file.path
  const value = readMetaFile(metaMap(plugin), fileId)
  if (value === undefined || value.deleted || value.type !== 'text') return
  const context = captureRemoteTextRequestContext(plugin)
  if (context === undefined) return
  const docId: FileDocId = { kind: 'file', ydocId: value.ydocId }
  const loaded = await loadTextDoc(plugin, docId)
  if (!loadedRemoteTextRequestContextStillStable(plugin, context, loaded)) return
  const current = readMetaFile(metaMap(plugin), fileId)
  if (
    !activeTextIdentityMatches(current, value) ||
    current.path !== filePath ||
    file.path !== filePath ||
    hasCompetingActiveMetaPath(plugin, current)
  ) {
    return
  }
  setMaterializedPath(plugin, fileId, filePath)
  setOwnedPathMarker(
    plugin.pendingRemoteTextFiles,
    plugin.pendingRemoteTextFileOwners,
    docId.ydocId,
    filePath,
    context.generation,
  )
}

export async function enqueueBinaryUploadFromVaultFile(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  reason: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork() || !canWriteMetadata(plugin)) return
  if (file.path.startsWith(BLOB_CACHE_PATH_PREFIX)) return
  if (!v.is(VaultRelativePathSchema, file.path)) {
    console.warn('[kuroflare] skipped binary upload for invalid vault path', { path: file.path })
    return
  }
  const existingFileId = findActiveFileId(plugin, file.path)
  const existing =
    existingFileId === undefined ? undefined : readMetaFile(metaMap(plugin), existingFileId)
  if (existingFileId !== undefined && existing === undefined) return
  if (
    existingFileId !== undefined &&
    existing !== undefined &&
    existing !== undefined &&
    existing.type === 'text'
  ) {
    console.warn('[kuroflare] skipped binary upload over text meta entry', { path: file.path })
    return
  }

  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) return
  const fileId = existingFileId ?? makeFileId(crypto.randomUUID())
  const now = Date.now()
  const bytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(file.path))
  const built = await buildBlobManifest(fileId, bytes, fileTreeDeviceId(plugin), now)
  if (
    existing !== undefined &&
    existing !== undefined &&
    existing.type === 'binary' &&
    existing.path === file.path &&
    blobManifestMatchesMetaFile(built.manifest, existing)
  ) {
    return
  }

  for (const chunk of built.chunks) {
    await writeBlobCacheBytes(plugin, binaryBlobCacheKey(chunk.sha256), chunk.bytes)
  }

  const metaUpdate = await planBinaryMetaUpdate(plugin, {
    fileId,
    path: file.path,
    previous: existing !== undefined && existing.type === 'binary' ? existing : undefined,
    manifestHash: built.manifestHash,
    chunkHashes: built.manifest.chunks.map((chunk) => chunk.sha256),
    now,
  })
  const outboxPrefix = `binary-${fileId}-${built.manifestHash}-${now.toString(36)}`
  const uploadPlan = buildBinaryUploadOutboxPlan({
    fileId,
    blobManifestHash: built.manifestHash,
    chunks: built.chunks.map((chunk, index) => ({
      id: requireOutboxPlanItemId(`${outboxPrefix}-chunk-${index.toString(36)}`),
      sha256: chunk.sha256,
      localCacheKey: binaryBlobCacheKey(chunk.sha256),
      size: chunk.bytes.byteLength,
    })),
    manifestPutId: requireOutboxPlanItemId(`${outboxPrefix}-manifest`),
    metaRefUpdateId: requireOutboxPlanItemId(`${outboxPrefix}-meta`),
  })
  if (!uploadPlan.ok) {
    console.warn('[kuroflare] skipped binary upload outbox plan', {
      path: file.path,
      reason: uploadPlan.reason,
    })
    return
  }

  const messageId = nextWorkerMessageId(plugin)
  const updateBytesBase64 = encodeBase64(metaUpdate)
  const updateSha256 = makeSha256Hex(await hashBytesSha256(metaUpdate))

  const records: LocalStoreOutboxRecord[] = []
  for (const item of uploadPlan.plan.items) {
    const base = {
      id: item.id,
      status: 'pending',
      dependsOn: item.dependsOn,
      nextAttemptAt: undefined,
      fileId: item.fileId,
      createdAt: now,
    } as const
    if (item.kind === 'blob-put') {
      records.push({
        ...base,
        kind: item.kind,
        blobSha256: item.sha256,
        localCacheKey: item.localCacheKey,
        blobSize: item.size,
      })
    } else if (item.kind === 'manifest-put') {
      records.push({
        ...base,
        kind: item.kind,
        blobManifestHash: item.blobManifestHash,
        blobManifest: built.manifest,
      })
    } else if (item.kind === 'meta-ref-update') {
      records.push({
        ...base,
        kind: item.kind,
        blobManifestHash: item.blobManifestHash,
        blobManifest: built.manifest,
        docId: META_SYNC_DOC_ID,
        messageId,
        updateSha256,
        updateBytesBase64,
        metadataSchemaVersion: 2,
      })
    }
  }

  const db = await openLocalStoreDatabase(plugin, setup.vaultId)
  await putOutboxRecords(db, records)
  Y.applyUpdate(plugin.metaDoc, metaUpdate, BINARY_UPLOAD_ORIGIN)
  void runOutboxWorkerTick(plugin, reason)
}

export async function requestMissingRemoteTextFile(
  plugin: KuroflareSpikePlugin,
  value: Extract<MetaFile, { type: 'text'; deleted: false }>,
): Promise<boolean> {
  const initial = readMetaFile(metaMap(plugin), value.fileId)
  if (!activeTextIdentityMatches(initial, value)) return false
  if (!v.is(VaultRelativePathSchema, initial.path)) return false
  if (hasCompetingActiveMetaPath(plugin, initial)) return false
  const context = captureRemoteTextRequestContext(plugin)
  if (context === undefined) return false
  const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(value.ydocId) }
  const loaded = await loadTextDoc(plugin, docId)
  if (!loadedRemoteTextRequestContextStillStable(plugin, context, loaded)) return false
  const current = readMetaFile(metaMap(plugin), value.fileId)
  if (!activeTextIdentityMatches(current, value) || hasCompetingActiveMetaPath(plugin, current)) {
    return false
  }
  const markerOwner = setOwnedPathMarker(
    plugin.pendingRemoteTextFiles,
    plugin.pendingRemoteTextFileOwners,
    docId.ydocId,
    current.path,
    context.generation,
  )
  if (!loadedRemoteTextRequestContextStillStable(plugin, context, loaded)) {
    clearOwnedPathMarker(
      plugin.pendingRemoteTextFiles,
      plugin.pendingRemoteTextFileOwners,
      docId.ydocId,
      current.path,
      markerOwner,
    )
    return false
  }
  const requested = await requestDocFromWorker(
    plugin,
    docId,
    Y.encodeStateVector(loaded.doc),
    'meta-missing-text-file',
    () => loadedRemoteTextRequestContextStillStable(plugin, context, loaded),
  )
  const latest = readMetaFile(metaMap(plugin), value.fileId)
  const stillCurrent =
    loadedRemoteTextRequestContextStillStable(plugin, context, loaded) &&
    activeTextIdentityMatches(latest, current) &&
    !hasCompetingActiveMetaPath(plugin, current)
  if (!requested || !stillCurrent) {
    clearOwnedPathMarker(
      plugin.pendingRemoteTextFiles,
      plugin.pendingRemoteTextFileOwners,
      docId.ydocId,
      current.path,
      markerOwner,
    )
  }
  return requested && stillCurrent
}

function hasCompetingActiveMetaPath(
  plugin: KuroflareSpikePlugin,
  expected: Extract<MetaFile, { type: 'text'; deleted: false }>,
): boolean {
  for (const [fileId] of metaMap(plugin).entries()) {
    if (fileId === expected.fileId) continue
    const current = readMetaFile(metaMap(plugin), fileId)
    if (
      current !== undefined &&
      !current.deleted &&
      (current.path === expected.path || current.canonicalPath === expected.canonicalPath)
    ) {
      return true
    }
  }
  return false
}

interface RemoteTextRequestContext {
  readonly metaDoc: Y.Doc
  readonly generation: number
  readonly vaultId: string
}

function captureRemoteTextRequestContext(
  plugin: KuroflareSpikePlugin,
): RemoteTextRequestContext | undefined {
  if (plugin.metadataReconcileTransitionPending()) return undefined
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined || !plugin.startupSideEffectGate.canSendNetwork()) return undefined
  return {
    metaDoc: plugin.metaDoc,
    generation: plugin.metadataVaultGeneration,
    vaultId: setup.vaultId,
  }
}

function remoteTextRequestContextStillStable(
  plugin: KuroflareSpikePlugin,
  context: RemoteTextRequestContext,
): boolean {
  return (
    !plugin.metadataReconcileTransitionPending() &&
    plugin.metaDoc === context.metaDoc &&
    plugin.metadataVaultGeneration === context.generation &&
    currentSetupMetadata(plugin)?.vaultId === context.vaultId &&
    plugin.startupSideEffectGate.canSendNetwork()
  )
}

function loadedRemoteTextRequestContextStillStable(
  plugin: KuroflareSpikePlugin,
  context: RemoteTextRequestContext,
  loaded: LoadedTextDoc,
): boolean {
  return (
    remoteTextRequestContextStillStable(plugin, context) &&
    plugin.loadedTextDocStillCurrent(loaded, {
      vaultId: context.vaultId,
      generation: context.generation,
    })
  )
}

function activeTextIdentityMatches(
  current: MetaFile | undefined,
  expected: Extract<MetaFile, { type: 'text'; deleted: false }>,
): current is Extract<MetaFile, { type: 'text'; deleted: false }> {
  return (
    current !== undefined &&
    !current.deleted &&
    current.type === 'text' &&
    current.fileId === expected.fileId &&
    current.ydocId === expected.ydocId &&
    current.path === expected.path
  )
}

function setMaterializedPath(
  plugin: Pick<
    VaultCreatePlugin,
    'materializedPaths' | 'materializedPathOwners' | 'metadataVaultGeneration'
  >,
  fileId: FileId,
  path: string,
): void {
  setOwnedPathMarker(
    plugin.materializedPaths,
    plugin.materializedPathOwners,
    fileId,
    path,
    plugin.metadataVaultGeneration,
  )
}

function deleteMaterializedPath(
  plugin: Pick<VaultCreatePlugin, 'materializedPaths' | 'materializedPathOwners'>,
  fileId: FileId,
): void {
  deletePathMarker(plugin.materializedPaths, plugin.materializedPathOwners, fileId)
}
