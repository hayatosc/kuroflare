import {
  hashBytesSha256,
  canonicalizeVaultPath,
  isMetaFile,
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
} from '@kuroflare/core'
import { TFile } from 'obsidian'
import * as v from 'valibot'
import * as Y from 'yjs'

import type { FileDocId } from '../main-types'
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
import { encodeBase64, binaryBlobCacheKey, requireOutboxPlanItemId } from './helpers'
import { loadTextDoc, metaMap } from './meta'
import { runOutboxWorkerTick } from './outbox'
import { writeBlobCacheBytes } from './outbox'
import type KuroflareSpikePlugin from './plugin'
import { consumePendingFsRename } from './runtime-guards'
import { openLocalStoreDatabase, putOutboxRecords } from './store'
import { sendMetaDocToWorker, requestDocFromWorker } from './sync-websocket'

export function fileTreeDeviceId(plugin: SetupMetadataSource): DeviceId {
  return makeDeviceId(currentSetupMetadata(plugin)?.deviceId ?? 'local-device')
}

/** Minimal plugin surface needed to register a newly created text file. */
export interface VaultCreatePlugin extends SetupMetadataSource {
  readonly startupSideEffectGate: {
    readonly canRun: () => boolean
  }
  readonly metaDoc: Y.Doc
  readonly materializedPaths: Map<FileId, string>
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
      if (!plugin.startupSideEffectGate.canRun()) return
      if (file instanceof TFile) {
        handleVaultDelete(plugin, file)
      }
    }),
  )
}

export async function handleVaultCreate(
  plugin: VaultCreatePlugin,
  file: Pick<TFile, 'path'>,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canRun()) return
  if (findActiveFileId(plugin, file.path) !== undefined) return
  const fileId = makeFileId(crypto.randomUUID())
  const activeYDocId = await startupYDocId(plugin, file, fileId)
  if (!plugin.startupSideEffectGate.canRun()) return
  if (findActiveFileId(plugin, file.path) !== undefined) return
  applyFileCreate(metaMap(plugin), {
    fileId,
    path: file.path,
    ydocId: activeYDocId,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  plugin.materializedPaths.set(fileId, file.path)
}

function handleVaultRename(plugin: KuroflareSpikePlugin, file: TFile, oldPath: string): void {
  if (!plugin.startupSideEffectGate.canRun()) return
  if (consumePendingFsRename(plugin.pendingFsRenames, file.path)) return
  const result = applyFileRename(metaMap(plugin), {
    fromPath: oldPath,
    toPath: file.path,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'renamed') {
    plugin.materializedPaths.set(result.fileId, file.path)
  }
}

function handleVaultDelete(plugin: KuroflareSpikePlugin, file: TFile): void {
  if (!plugin.startupSideEffectGate.canRun()) return
  const result = applyFileDelete(metaMap(plugin), {
    path: file.path,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'deleted') {
    plugin.materializedPaths.delete(result.fileId)
  }
}

async function handleBinaryVaultRename(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  oldPath: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  const oldFileId = findActiveFileId(plugin, oldPath)
  if (oldFileId === undefined) {
    await enqueueBinaryUploadFromVaultFile(plugin, file, 'binary-rename')
    return
  }
  const oldEntry = metaMap(plugin).get(oldFileId)
  if (!isMetaFile(oldEntry, oldFileId) || oldEntry.type !== 'binary') return
  if (consumePendingFsRename(plugin.pendingFsRenames, file.path)) return
  const result = applyFileRename(metaMap(plugin), {
    fromPath: oldPath,
    toPath: file.path,
    deviceId: fileTreeDeviceId(plugin),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'renamed') {
    plugin.materializedPaths.set(result.fileId, file.path)
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
    const before = Y.encodeStateVector(tempDoc)
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
    tempDoc.getMap<unknown>('meta').set(input.fileId, entry)
    return Y.encodeStateAsUpdate(tempDoc, before)
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
    plugin.materializedPaths.set(fileId, file.path)
    await importFileTextIntoDoc(plugin, file, docId, text)
    created += 1
  }
  console.info('[kuroflare] created local meta YDoc from startup scan', { created, reason })
}

export async function adoptLocalFilesAfterRemoteMeta(plugin: KuroflareSpikePlugin): Promise<void> {
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
    plugin.materializedPaths.set(fileId, file.path)
    await importFileTextIntoDocAndSend(
      plugin,
      file,
      docId,
      `startup:adopt-local-files-after-remote-meta`,
    )
    adopted += 1
  }
  if (adopted > 0) {
    await sendMetaDocToWorker(plugin, 'startup:adopt-local-files-after-remote-meta')
  }
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
  const value = metaMap(plugin).get(fileId)
  if (!isMetaFile(value, fileId) || value.deleted || value.type !== 'text') return
  plugin.materializedPaths.set(fileId, file.path)
  const docId: FileDocId = { kind: 'file', ydocId: value.ydocId }
  await loadTextDoc(plugin, docId)
  plugin.pendingRemoteTextFiles.set(docId.ydocId, file.path)
}

export async function enqueueBinaryUploadFromVaultFile(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  reason: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  if (file.path.startsWith(BLOB_CACHE_PATH_PREFIX)) return
  if (!v.is(VaultRelativePathSchema, file.path)) {
    console.warn('[kuroflare] skipped binary upload for invalid vault path', { path: file.path })
    return
  }
  const existingFileId = findActiveFileId(plugin, file.path)
  const existing = existingFileId === undefined ? undefined : metaMap(plugin).get(existingFileId)
  if (existingFileId !== undefined && !isMetaFile(existing, existingFileId)) return
  if (
    existingFileId !== undefined &&
    existing !== undefined &&
    isMetaFile(existing, existingFileId) &&
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
  if (bytes.byteLength === 0) {
    console.warn('[kuroflare] skipped empty binary file upload', { path: file.path })
    return
  }

  const built = await buildBlobManifest(fileId, bytes, fileTreeDeviceId(plugin), now)
  if (
    existing !== undefined &&
    isMetaFile(existing, fileId) &&
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
    previous:
      existing && isMetaFile(existing, fileId) && existing.type === 'binary' ? existing : undefined,
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
  value: { readonly type: unknown; readonly path: string; readonly ydocId?: unknown },
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  if (value.type !== 'text' || typeof value.ydocId !== 'string') return
  if (!v.is(VaultRelativePathSchema, value.path)) return
  if (plugin.app.vault.getAbstractFileByPath(value.path) instanceof TFile) return
  const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(value.ydocId) }
  const loaded = await loadTextDoc(plugin, docId)
  plugin.pendingRemoteTextFiles.set(docId.ydocId, value.path)
  await requestDocFromWorker(
    plugin,
    docId,
    Y.encodeStateVector(loaded.doc),
    'meta-missing-text-file',
  )
}
