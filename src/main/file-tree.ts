import { v } from 'valibot'
import { Y } from 'yjs'

import { applyFileCreate, applyFileDelete, applyFileRename } from '@packages/obsidian-plugin/sync/meta/tree'
import type { LocalStoreOutboxRecord } from '@packages/obsidian-plugin/sync/store/store'
import type KuroflareSpikePlugin from './plugin'

export function registerFileTreeWatcher(plugin: KuroflareSpikePlugin): void {
  plugin.registerEvent(
    plugin.app.vault.on('create', (file) => {
      if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
        plugin.handleVaultCreate(file)
        return
      }
      if (file instanceof TFile) {
        void plugin.enqueueBinaryUploadFromVaultFile(file, 'binary-create')
      }
    }),
  )
  plugin.registerEvent(
    plugin.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension !== MARKDOWN_EXTENSION) {
        void plugin.enqueueBinaryUploadFromVaultFile(file, 'binary-modify')
      }
    }),
  )
  plugin.registerEvent(
    plugin.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
        plugin.handleVaultRename(file, oldPath)
        return
      }
      if (file instanceof TFile) {
        void plugin.handleBinaryVaultRename(file, oldPath)
      }
    }),
  )
  plugin.registerEvent(
    plugin.app.vault.on('delete', (file) => {
      if (file instanceof TFile) {
        plugin.handleVaultDelete(file)
      }
    }),
  )
}

export function handleVaultCreate(plugin: KuroflareSpikePlugin, file: TFile): void {
  if (plugin.findActiveFileId(file.path) !== undefined) {
    return
  }
  const fileId = makeFileId(crypto.randomUUID())
  const activeYDocId =
    plugin.activeFile?.path === file.path ? plugin.activeTextDoc?.docId.ydocId : undefined
  applyFileCreate(plugin.metaMap, {
    fileId,
    path: file.path,
    ydocId: activeYDocId ?? makeYDocId(`file-${fileId}`),
    deviceId: plugin.fileTreeDeviceId(),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  plugin.materializedPaths.set(fileId, file.path)
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
    if (!v.is(VaultRelativePathSchema, file.path)) {
      console.warn('[kuroflare] skipped startup file with invalid vault path', {
        path: file.path,
      })
      continue
    }
    if (!(plugin.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) {
      continue
    }
    if (plugin.findActiveFileId(file.path) !== undefined) {
      continue
    }
    const text = await plugin.app.vault.read(file)
    const fileId = makeFileId(crypto.randomUUID())
    const ydocId =
      plugin.activeFile?.path === file.path && plugin.activeTextDoc !== null
        ? plugin.activeTextDoc.docId.ydocId
        : makeYDocId(`file-${fileId}`)
    const docId: FileDocId = { kind: 'file', ydocId }
    const now = Date.now()
    applyFileCreate(plugin.metaMap, {
      fileId,
      path: file.path,
      ydocId,
      deviceId: plugin.fileTreeDeviceId(),
      now,
      origin: FILE_TREE_ORIGIN,
    })
    plugin.materializedPaths.set(fileId, file.path)
    await plugin.importFileTextIntoDoc(file, docId, text)
    created += 1
  }
  console.info('[kuroflare] created local meta YDoc from startup scan', { created, reason })
}

export async function adoptLocalFilesAfterRemoteMeta(plugin: KuroflareSpikePlugin): Promise<void> {
  let adopted = 0
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const remoteFileId = plugin.findActiveFileId(file.path)
    if (remoteFileId !== undefined) {
      // A path that already exists in remote meta must adopt the remote
      // fileId and never mint a second one for the same path. Whether the
      // content matches is unknown here because the
      // remote YText hasn't been fetched yet (the WebSocket opens later in
      // the join sequence), so the hash comparison is deferred until that
      // content arrives; see resolvePendingRemoteTextFile.
      await plugin.queueJoinAdoptionHashCheck(file, remoteFileId)
      continue
    }
    const fileId = makeFileId(crypto.randomUUID())
    const ydocId =
      plugin.activeFile?.path === file.path && plugin.activeTextDoc !== null
        ? plugin.activeTextDoc.docId.ydocId
        : makeYDocId(`file-${fileId}`)
    const docId: FileDocId = { kind: 'file', ydocId }
    const now = Date.now()
    applyFileCreate(plugin.metaMap, {
      fileId,
      path: file.path,
      ydocId,
      deviceId: plugin.fileTreeDeviceId(),
      now,
      origin: FILE_TREE_ORIGIN,
    })
    plugin.materializedPaths.set(fileId, file.path)
    await plugin.importFileTextIntoDocAndSend(
      file,
      docId,
      `startup:adopt-local-files-after-remote-meta`,
    )
    adopted += 1
  }
  if (adopted > 0) {
    await plugin.sendMetaDocToWorker('startup:adopt-local-files-after-remote-meta')
  }
  console.info('[kuroflare] adopted local files after remote meta', { adopted })
}

export async function queueJoinAdoptionHashCheck(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  fileId: FileId,
): Promise<void> {
  const value = plugin.metaMap.get(fileId)
  if (!isMetaFile(value, fileId) || value.deleted || value.type !== 'text') {
    return
  }
  plugin.materializedPaths.set(fileId, file.path)
  const docId: FileDocId = { kind: 'file', ydocId: value.ydocId }
  await plugin.loadTextDoc(docId)
  plugin.pendingRemoteTextFiles.set(docId.ydocId, file.path)
}

export async function enqueueBinaryUploadFromVaultFile(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  reason: string,
): Promise<void> {
  if (file.path.startsWith(BLOB_CACHE_PATH_PREFIX)) {
    // Our own blob-cache writes (upload staging and download materialize) land inside the
    // vault and surface as vault 'create'/'modify' events like any other file. Treating them
    // as user uploads would re-chunk the cache entry, write it back into the cache, and
    // re-trigger this same event forever.
    return
  }
  if (!v.is(VaultRelativePathSchema, file.path)) {
    console.warn('[kuroflare] skipped binary upload for invalid vault path', { path: file.path })
    return
  }
  const existingFileId = plugin.findActiveFileId(file.path)
  const existing = existingFileId === undefined ? undefined : plugin.metaMap.get(existingFileId)
  if (existingFileId !== undefined && !isMetaFile(existing, existingFileId)) {
    return
  }
  if (
    existingFileId !== undefined &&
    existing !== undefined &&
    isMetaFile(existing, existingFileId) &&
    existing.type === 'text'
  ) {
    console.warn('[kuroflare] skipped binary upload over text meta entry', { path: file.path })
    return
  }

  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    return
  }
  const fileId = existingFileId ?? makeFileId(crypto.randomUUID())
  const now = Date.now()
  const bytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(file.path))
  if (bytes.byteLength === 0) {
    console.warn('[kuroflare] skipped empty binary file upload', { path: file.path })
    return
  }

  const built = await buildBlobManifest(fileId, bytes, plugin.fileTreeDeviceId(), now)
  if (
    existing !== undefined &&
    isMetaFile(existing, fileId) &&
    existing.type === 'binary' &&
    existing.path === file.path &&
    blobManifestMatchesMetaFile(built.manifest, existing)
  ) {
    // Content is byte-identical to what's already referenced by meta (e.g. the watcher firing
    // on a no-op save, or an echo of our own materialize write). The manifest hash itself is not
    // a stable content address -- it embeds `now` -- so this chunk-hash comparison is the actual
    // settlement check; re-uploading here would only mint a new manifest for unchanged content
    // and never let the outbox drain. (Pure renames never reach this function in the first place
    // -- see `handleBinaryVaultRename` -- so `existing.path` is expected to already equal
    // `file.path` here; the check is a defensive no-op otherwise.)
    return
  }
  for (const chunk of built.chunks) {
    await plugin.writeBlobCacheBytes(binaryBlobCacheKey(chunk.sha256), chunk.bytes)
  }

  const metaUpdate = await plugin.planBinaryMetaUpdate({
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

  const messageId = plugin.nextWorkerMessageId()
  const updateBytesBase64 = encodeBase64(metaUpdate)
  const updateSha256 = makeSha256Hex(await plugin.sha256Hex(metaUpdate))
  const records: LocalStoreOutboxRecord[] = uploadPlan.plan.items.map((item) => {
    const base = {
      id: item.id,
      kind: item.kind,
      status: 'pending',
      dependsOn: item.dependsOn,
      nextAttemptAt: undefined,
      fileId: item.fileId,
      createdAt: now,
    } satisfies LocalStoreOutboxRecord
    switch (item.kind) {
      case 'blob-put':
        return {
          ...base,
          blobSha256: item.sha256,
          localCacheKey: item.localCacheKey,
          blobSize: item.size,
        } satisfies LocalStoreOutboxRecord
      case 'manifest-put':
        return {
          ...base,
          blobManifestHash: item.blobManifestHash,
          blobManifest: built.manifest,
        } satisfies LocalStoreOutboxRecord
      case 'meta-ref-update':
        return {
          ...base,
          blobManifestHash: item.blobManifestHash,
          blobManifest: built.manifest,
          docId: META_SYNC_DOC_ID,
          messageId,
          updateSha256,
          updateBytesBase64,
        } satisfies LocalStoreOutboxRecord
      case 'blob-get':
      case 'materialize':
        throw new Error(`unexpected-binary-upload-item:${item.kind}`)
    }
  })

  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  await plugin.putOutboxRecords(db, records)
  Y.applyUpdate(plugin.metaDoc, metaUpdate, BINARY_UPLOAD_ORIGIN)
  void plugin.runOutboxWorkerTick(reason)
}

export async function handleBinaryVaultRename(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  oldPath: string,
): Promise<void> {
  const oldFileId = plugin.findActiveFileId(oldPath)
  if (oldFileId === undefined) {
    await plugin.enqueueBinaryUploadFromVaultFile(file, 'binary-rename')
    return
  }
  const oldEntry = plugin.metaMap.get(oldFileId)
  if (!isMetaFile(oldEntry, oldFileId) || oldEntry.type !== 'binary') {
    return
  }
  // Ignore the watcher echo from a rename we materialized ourselves (see `handleVaultRename`).
  if (plugin.pendingFsRenames.delete(canonicalizeVaultPath(file.path))) {
    return
  }
  // A rename event means the bytes are unchanged -- only the path moved. Reuse the same
  // fileId-preserving, content-untouched path update `handleVaultRename` uses for text files
  // instead of routing through `enqueueBinaryUploadFromVaultFile`: that path always calls
  // `buildBlobManifest` with a fresh timestamp, which would mint a brand-new manifest hash (and
  // re-upload already-stored chunks) for content that never changed.
  const result = applyFileRename(plugin.metaMap, {
    fromPath: oldPath,
    toPath: file.path,
    deviceId: plugin.fileTreeDeviceId(),
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
      createdBy: input.previous?.createdBy ?? plugin.fileTreeDeviceId(),
      contentUpdatedAt: input.now,
      contentUpdatedBy: plugin.fileTreeDeviceId(),
      updatedAt: input.now,
      updatedBy: plugin.fileTreeDeviceId(),
      mtime: input.now,
    }
    tempDoc.getMap<unknown>('meta').set(input.fileId, entry)
    return Y.encodeStateAsUpdate(tempDoc, before)
  } finally {
    tempDoc.destroy()
  }
}

export function handleVaultRename(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  oldPath: string,
): void {
  // Ignore the watcher echo from a rename we materialized ourselves.
  if (plugin.pendingFsRenames.delete(canonicalizeVaultPath(file.path))) {
    return
  }
  const result = applyFileRename(plugin.metaMap, {
    fromPath: oldPath,
    toPath: file.path,
    deviceId: plugin.fileTreeDeviceId(),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'renamed') {
    plugin.materializedPaths.set(result.fileId, file.path)
  }
}

export function handleVaultDelete(plugin: KuroflareSpikePlugin, file: TFile): void {
  const result = applyFileDelete(plugin.metaMap, {
    path: file.path,
    deviceId: plugin.fileTreeDeviceId(),
    now: Date.now(),
    origin: FILE_TREE_ORIGIN,
  })
  if (result.action === 'deleted') {
    plugin.materializedPaths.delete(result.fileId)
  }
}

export async function requestMissingRemoteTextFile(
  plugin: KuroflareSpikePlugin,
  value: {
    readonly type: unknown
    readonly path: string
    readonly ydocId?: unknown
  },
): Promise<void> {
  if (value.type !== 'text' || typeof value.ydocId !== 'string') {
    return
  }
  if (!v.is(VaultRelativePathSchema, value.path)) {
    console.warn('[kuroflare] skipped remote text request for invalid path', { path: value.path })
    return
  }
  if (plugin.app.vault.getAbstractFileByPath(value.path) instanceof TFile) {
    return
  }
  const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(value.ydocId) }
  const loaded = await plugin.loadTextDoc(docId)
  plugin.pendingRemoteTextFiles.set(docId.ydocId, value.path)
  await plugin.requestDocFromWorker(
    docId,
    Y.encodeStateVector(loaded.doc),
    'meta-missing-text-file',
  )
}

export async function enqueueMissingDownloads(plugin: KuroflareSpikePlugin): Promise<void> {
  await plugin.reconcileAndMaterializeMeta()
  await plugin.requestPendingRemoteTextFilesFromWorker('startup:enqueue-missing-downloads')
  await plugin.enqueueMissingRemoteBinaryDownloads('startup:enqueue-missing-downloads')
  console.info('[kuroflare] enqueued missing remote text downloads', {
    pending: plugin.pendingRemoteTextFiles.size,
  })
}

export async function enqueueMissingRemoteBinaryDownloads(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    return
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    console.warn('[kuroflare] skipped remote binary downloads without access token', { reason })
    return
  }

  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const records: LocalStoreOutboxRecord[] = []
  const now = Date.now()
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (!isMetaFile(value, fileId) || value.deleted || value.type !== 'binary') {
      continue
    }
    if (!v.is(VaultRelativePathSchema, value.path)) {
      console.warn('[kuroflare] skipped remote binary download for invalid path', {
        path: value.path,
      })
      continue
    }
    if (
      snapshot.outboxRecords.some(
        (record) =>
          record.fileId === value.fileId &&
          record.kind === 'materialize' &&
          record.status !== 'done' &&
          record.status !== 'failed',
      )
    ) {
      continue
    }
    const manifest = await plugin.fetchBlobManifestForMeta(setup, accessToken, value)
    if (manifest === undefined) {
      continue
    }
    const existing = plugin.app.vault.getAbstractFileByPath(value.path)
    if (existing instanceof TFolder) {
      console.warn('[kuroflare] skipped remote binary download over folder path', {
        path: value.path,
      })
      continue
    }
    if (existing instanceof TFile) {
      const currentBytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(value.path))
      const currentHash = makeSha256Hex(await plugin.sha256Hex(currentBytes))
      if (currentHash === manifest.contentSha256) {
        plugin.lastMaterialized.set(value.path, {
          diskHash: manifest.contentSha256,
          ydocHash: manifest.contentSha256,
          path: value.path,
          writtenAt: now,
        })
        continue
      }
    }

    const outboxPrefix = `binary-download-${value.fileId}-${value.blobManifestHash}`
    const downloadPlan = buildBinaryDownloadOutboxPlan({
      fileId: value.fileId,
      expectedHash: manifest.contentSha256,
      chunks: manifest.chunks.map((chunk, index) => ({
        id: requireOutboxPlanItemId(`${outboxPrefix}-chunk-${index.toString(36)}`),
        sha256: chunk.sha256,
        localCacheKey: binaryBlobCacheKey(chunk.sha256),
        size: chunk.size,
      })),
      materializeId: requireOutboxPlanItemId(`${outboxPrefix}-materialize`),
    })
    if (!downloadPlan.ok) {
      console.warn('[kuroflare] skipped remote binary download outbox plan', {
        path: value.path,
        reason: downloadPlan.reason,
      })
      continue
    }
    for (const item of downloadPlan.plan.items) {
      const base = {
        id: item.id,
        kind: item.kind,
        status: 'pending',
        dependsOn: item.dependsOn,
        nextAttemptAt: undefined,
        fileId: item.fileId,
        createdAt: now,
      } satisfies LocalStoreOutboxRecord
      if (item.kind === 'blob-get') {
        records.push({
          ...base,
          blobSha256: item.sha256,
          localCacheKey: item.localCacheKey,
          blobSize: item.size,
        } satisfies LocalStoreOutboxRecord)
        continue
      }
      if (item.kind === 'materialize') {
        records.push({
          ...base,
          blobManifestHash: value.blobManifestHash,
          blobManifest: manifest,
          materializeChunks: manifest.chunks.map((chunk) => ({
            sha256: chunk.sha256,
            localCacheKey: binaryBlobCacheKey(chunk.sha256),
            size: chunk.size,
          })),
          expectedHash: item.expectedHash,
          targetPath: value.path,
          lastMaterialized:
            existing instanceof TFile ? plugin.lastMaterialized.get(value.path) : undefined,
        } satisfies LocalStoreOutboxRecord)
      }
    }
    plugin.materializedPaths.set(value.fileId, value.path)
  }
  if (records.length === 0) {
    return
  }
  await plugin.putOutboxRecords(db, records)
  void plugin.runOutboxWorkerTick(reason)
}

export async function fetchBlobManifestForMeta(
  plugin: KuroflareSpikePlugin,
  setup: LocalSetupMetadata,
  accessToken: string,
  value: BinaryMetaFile,
): Promise<BlobManifest | undefined> {
  const url = new URL(setup.endpoint)
  url.pathname = `/blob-manifests/${encodeURIComponent(value.blobManifestHash)}.json`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    })
  } catch (error: unknown) {
    console.warn('[kuroflare] blob manifest fetch failed before HTTP response', {
      path: value.path,
      error: safeLogError(error),
    })
    return undefined
  }
  if (!response.ok) {
    console.warn('[kuroflare] blob manifest fetch failed', {
      path: value.path,
      status: response.status,
      code: await responseErrorCode(response),
    })
    return undefined
  }
  const body = await response.json().catch(() => undefined)
  if (!v.is(BlobManifestSchema, body) || !blobManifestMatchesMetaFile(body, value)) {
    console.warn('[kuroflare] blob manifest rejected by guard', { path: value.path })
    return undefined
  }
  return body
}
