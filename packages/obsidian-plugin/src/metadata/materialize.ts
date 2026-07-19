import {
  BlobHeadResponseSchema,
  BlobManifestSchema,
  blobManifestMatchesMetaFile,
  buildBinaryDownloadOutboxPlan,
  hashBytesSha256,
  makeSha256Hex,
  VaultRelativePathSchema,
  type BinaryMetaFile,
  type BlobManifest,
  type FileId,
  type LastMaterializedRecord,
  type MetaFile,
} from '@kuroflare/core'
import { TFile, TFolder } from 'obsidian'
import * as v from 'valibot'
import type * as Y from 'yjs'

import {
  claimOwnedPathMarker,
  clearOwnedPathMarker,
  clearPendingFsRename,
  deletePathMarker,
  markPendingFsRename,
  blobHeadEntryMatchesChunk,
  blobHeadHashBatches,
  MAX_BLOB_HEAD_HASHES_PER_REQUEST,
  setOwnedPathMarker,
} from '../host/guards'
import { binaryBlobCacheKey, requireOutboxPlanItemId, safeLogError } from '../host/helpers'
import { readMetaFile } from '../host/meta'
import { createWorkerClient } from '../sync/api-client'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import type { GenerationMarkerOwner } from '../types'
import {
  captureReconcileContext,
  currentMetaFile,
  reconcileContextIdentityStillStable,
  type MetadataReconcileBinaryRuntimePort,
} from './evidence'

/** Vault, materialization, and outbox capabilities used after metadata is reconciled. */
export interface MetadataMaterializationPort {
  readonly getMetaDoc: () => Y.Doc
  readonly getVaultGeneration: () => number
  readonly isVaultTransitionPending: () => boolean
  readonly getVaultId: () => string | undefined
  readonly vault: {
    readonly getAbstractFileByPath: (path: string) => unknown | null
    readonly adapter: {
      readonly readBinary: (path: string) => Promise<ArrayBuffer>
    }
  }
  readonly fileManager: {
    readonly renameFile: (file: TFile, path: string) => Promise<void>
  }
  readonly lastMaterialized: Map<string, LastMaterializedRecord>
  readonly materializedPaths: Map<FileId, string>
  readonly materializedPathOwners: Map<FileId, GenerationMarkerOwner>
  readonly pendingRemoteTextFiles: Map<string, string>
  readonly pendingRemoteTextFileOwners: Map<string, GenerationMarkerOwner>
  readonly pendingFsRenames: Set<string>
  readonly activeRemoteDeletedFileIds: Set<FileId>
  readonly getActiveFile: () => { readonly path: string } | null
  readonly setSyncStatusText: (text: string) => void
  readonly notify: (message: string) => void
  readonly clearTextDeletionEvidenceRequest: (docId: string) => void
  readonly requestMissingRemoteTextFile: (
    value: Extract<MetaFile, { type: 'text'; deleted: false }>,
  ) => Promise<boolean>
  readonly openLocalStoreDatabase: (
    vaultId: string,
    isCurrent?: () => boolean,
  ) => Promise<IDBDatabase>
  readonly readOutboxWorkerSnapshot: (db: IDBDatabase) => Promise<{
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  }>
  readonly putOutboxRecords: (
    db: IDBDatabase,
    records: readonly LocalStoreOutboxRecord[],
  ) => Promise<void>
  readonly runOutboxWorkerTick: (reason: string) => Promise<void>
}

const renameOperationQueues = new WeakMap<Set<string>, Map<string, Promise<void>>>()

/** Materializes remote metadata renames while preserving filesystem rename guards. */
export async function materializeMetaRenames(
  materialize: MetadataMaterializationPort,
): Promise<boolean> {
  const context = captureMaterializationContext(materialize)
  if (context === undefined) return false
  const fileIds = [...context.metaDoc.getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    if (!materializationContextStillStable(materialize, context)) return false
    const value = currentMaterializedMetaFile(materialize, fileId)
    if (value === undefined || value.deleted) continue
    materialize.activeRemoteDeletedFileIds.delete(value.fileId)
    const known = materialize.materializedPaths.get(value.fileId)
    if (known === value.path) continue
    if (known === undefined) {
      const markerOwner = setOwnedPathMarker(
        materialize.materializedPaths,
        materialize.materializedPathOwners,
        value.fileId,
        value.path,
        context.generation,
      )
      if (value.type === 'text') await requestMissingRemoteTextFile(materialize, value)
      if (!materializationContextStillStable(materialize, context)) {
        clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
        return false
      }
      continue
    }
    const file = materialize.vault.getAbstractFileByPath(known)
    if (!(file instanceof TFile)) {
      const markerOwner = setOwnedPathMarker(
        materialize.materializedPaths,
        materialize.materializedPathOwners,
        value.fileId,
        value.path,
        context.generation,
      )
      if (value.type === 'text') await requestMissingRemoteTextFile(materialize, value)
      if (!materializationContextStillStable(materialize, context)) {
        clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
        return false
      }
      continue
    }
    if (!materializationContextStillStable(materialize, context)) return false
    const markerOwner = claimOwnedPathMarker(
      materialize.materializedPaths,
      materialize.materializedPathOwners,
      value.fileId,
      known,
      context.generation,
    )
    if (markerOwner === undefined) continue
    const target = markPendingFsRename(materialize.pendingFsRenames, value.path)
    try {
      await runSerializedRename(materialize, value.fileId, () =>
        materialize.fileManager.renameFile(file, value.path),
      )
      if (!materializationContextStillStable(materialize, context)) {
        clearMaterializedPath(materialize, value.fileId, known, markerOwner)
        clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
        clearPendingFsRename(materialize.pendingFsRenames, target)
        return false
      }
      let current = currentMaterializedMetaFile(materialize, fileId)
      if (
        current !== undefined &&
        !current.deleted &&
        current.type === value.type &&
        current.path !== value.path
      ) {
        const compensationPath = current.path
        const compensationTarget = markPendingFsRename(
          materialize.pendingFsRenames,
          compensationPath,
        )
        try {
          if (!materializationContextStillStable(materialize, context)) {
            clearPendingFsRename(materialize.pendingFsRenames, target)
            clearPendingFsRename(materialize.pendingFsRenames, compensationTarget)
            return false
          }
          await runSerializedRename(materialize, value.fileId, () =>
            materialize.fileManager.renameFile(file, compensationPath),
          )
          if (!materializationContextStillStable(materialize, context)) {
            clearMaterializedPath(materialize, value.fileId, known, markerOwner)
            clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
            clearPendingFsRename(materialize.pendingFsRenames, target)
            clearPendingFsRename(materialize.pendingFsRenames, compensationTarget)
            return false
          }
          current = currentMaterializedMetaFile(materialize, fileId)
          if (
            current !== undefined &&
            !current.deleted &&
            current.type === value.type &&
            current.path === compensationPath
          ) {
            setOwnedPathMarker(
              materialize.materializedPaths,
              materialize.materializedPathOwners,
              current.fileId,
              current.path,
              context.generation,
            )
            clearPendingFsRename(materialize.pendingFsRenames, target)
            clearPendingFsRename(materialize.pendingFsRenames, compensationTarget)
            continue
          }
        } catch (error: unknown) {
          console.warn('[kuroflare] failed to compensate meta rename', {
            from: value.path,
            to: compensationPath,
            error: safeLogError(error),
          })
        }
        clearMaterializedPath(materialize, value.fileId, known, markerOwner)
        clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
        clearPendingFsRename(materialize.pendingFsRenames, target)
        clearPendingFsRename(materialize.pendingFsRenames, compensationTarget)
        continue
      }
      if (
        current === undefined ||
        current.deleted ||
        current.path !== value.path ||
        current.type !== value.type
      ) {
        clearMaterializedPath(materialize, value.fileId, known, markerOwner)
        clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
        clearPendingFsRename(materialize.pendingFsRenames, target)
        continue
      }
      setOwnedPathMarker(
        materialize.materializedPaths,
        materialize.materializedPathOwners,
        current.fileId,
        current.path,
        context.generation,
      )
      clearPendingFsRename(materialize.pendingFsRenames, target)
    } catch (error: unknown) {
      clearPendingFsRename(materialize.pendingFsRenames, target)
      console.warn('[kuroflare] failed to materialize meta rename', {
        from: known,
        to: value.path,
        error: safeLogError(error),
      })
    }
  }
  return materializationContextStillStable(materialize, context)
}

async function runSerializedRename(
  materialize: MetadataMaterializationPort,
  fileId: FileId,
  operation: () => Promise<void>,
): Promise<void> {
  let queues = renameOperationQueues.get(materialize.pendingFsRenames)
  if (queues === undefined) {
    queues = new Map()
    renameOperationQueues.set(materialize.pendingFsRenames, queues)
  }
  const previous = queues.get(fileId)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  queues.set(fileId, current)
  if (previous !== undefined) await previous
  try {
    await operation()
  } finally {
    release()
    if (queues.get(fileId) === current) queues.delete(fileId)
    if (queues.size === 0) renameOperationQueues.delete(materialize.pendingFsRenames)
  }
}

/** Applies remote tombstones to local materialization state without closing the active editor. */
export function materializeMetaDeletes(materialize: MetadataMaterializationPort): boolean {
  const context = captureMaterializationContext(materialize)
  if (context === undefined) return false
  const fileIds = [...context.metaDoc.getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    if (!materializationContextStillStable(materialize, context)) return false
    const value = currentMaterializedMetaFile(materialize, fileId)
    if (value === undefined || !value.deleted) continue
    if (value.type === 'text') {
      deletePathMarker(
        materialize.pendingRemoteTextFiles,
        materialize.pendingRemoteTextFileOwners,
        value.ydocId,
      )
      materialize.clearTextDeletionEvidenceRequest(value.ydocId)
    }
    if (materialize.getActiveFile()?.path !== value.path) continue
    if (materialize.activeRemoteDeletedFileIds.has(value.fileId)) continue
    materialize.activeRemoteDeletedFileIds.add(value.fileId)
    materialize.setSyncStatusText(`Kuroflare sync: remote tombstone ${value.path}`)
    materialize.notify('Kuroflare sync: active file was deleted remotely; local editor kept open')
  }
  return materializationContextStillStable(materialize, context)
}

function currentMaterializedMetaFile(
  materialize: MetadataMaterializationPort,
  fileId: string,
): MetaFile | undefined {
  const meta = materialize.getMetaDoc().getMap<unknown>('meta')
  return readMetaFile(meta, fileId)
}

interface MaterializationContext {
  readonly metaDoc: Y.Doc
  readonly generation: number
  readonly vaultId: string | undefined
}

function captureMaterializationContext(
  materialize: MetadataMaterializationPort,
): MaterializationContext | undefined {
  if (materialize.isVaultTransitionPending()) return undefined
  return {
    metaDoc: materialize.getMetaDoc(),
    generation: materialize.getVaultGeneration(),
    vaultId: materialize.getVaultId(),
  }
}

function materializationContextStillStable(
  materialize: MetadataMaterializationPort,
  context: MaterializationContext,
): boolean {
  return (
    !materialize.isVaultTransitionPending() &&
    materialize.getMetaDoc() === context.metaDoc &&
    materialize.getVaultGeneration() === context.generation &&
    materialize.getVaultId() === context.vaultId
  )
}

function clearMaterializedPath(
  materialize: MetadataMaterializationPort,
  fileId: FileId,
  path: string,
  owner: GenerationMarkerOwner,
): void {
  clearOwnedPathMarker(
    materialize.materializedPaths,
    materialize.materializedPathOwners,
    fileId,
    path,
    owner,
  )
}

async function requestMissingRemoteTextFile(
  materialize: MetadataMaterializationPort,
  value: Extract<MetaFile, { type: 'text'; deleted: false }>,
): Promise<boolean> {
  const markerOwner = materialize.materializedPathOwners.get(value.fileId)
  const requested = await materialize.requestMissingRemoteTextFile(value)
  const current = currentMaterializedMetaFile(materialize, value.fileId)
  if (
    requested &&
    current !== undefined &&
    !current.deleted &&
    current.type === 'text' &&
    current.ydocId === value.ydocId &&
    current.path === value.path
  ) {
    return true
  }
  if (markerOwner !== undefined) {
    clearMaterializedPath(materialize, value.fileId, value.path, markerOwner)
  }
  if (!requested) return false
  return false
}

/** Collects binary deletion evidence only after manifest and every chunk are verified remotely. */
export async function findRestorableBinaryFileIdsForReconcile(
  reconcile: MetadataReconcileBinaryRuntimePort,
): Promise<ReadonlySet<FileId>> {
  const context = captureReconcileContext(reconcile)
  if (context === undefined) return new Set()
  const setup = reconcile.currentSetup()
  if (setup === undefined) return new Set()
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  const accessToken = await reconcile.readAccessToken(setup)
  if (accessToken === undefined || !reconcileContextIdentityStillStable(reconcile, context)) {
    return new Set()
  }

  const restorable = new Set<FileId>()
  const inspectedEntries = new Map<FileId, Extract<MetaFile, { type: 'binary'; deleted: true }>>()
  const fileIds = [...reconcile.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
    const value = currentMetaFile(reconcile, fileId)
    if (value === undefined || !value.deleted || value.type !== 'binary') continue
    if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
    const manifest = await fetchBlobManifestForMeta(reconcile, setup, accessToken, value)
    if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
    if (!binaryDeletionEvidenceEntryMatches(reconcile, fileId, value)) continue
    if (manifest !== undefined) {
      if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
      const chunksExist = await remoteBlobChunksExist(reconcile, setup, accessToken, manifest)
      if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
      if (!chunksExist) continue
      if (!binaryDeletionEvidenceEntryMatches(reconcile, fileId, value)) continue
      restorable.add(value.fileId)
      inspectedEntries.set(fileId, value)
    }
  }
  const validatedRestorable = new Set<FileId>()
  for (const fileId of restorable) {
    const inspected = inspectedEntries.get(fileId)
    if (
      inspected !== undefined &&
      binaryDeletionEvidenceEntryMatches(reconcile, fileId, inspected)
    ) {
      validatedRestorable.add(fileId)
    }
  }
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  return validatedRestorable
}

/** Enqueues idempotent blob-get/materialize records for active binary metadata entries. */
export async function enqueueMissingRemoteBinaryDownloads(
  reconcile: MetadataReconcileBinaryRuntimePort,
  materialize: MetadataMaterializationPort,
  reason: string,
): Promise<ReadonlySet<FileId>> {
  const completedFileIds = new Set<FileId>()
  if (!reconcile.canSendNetwork()) return completedFileIds
  const context = captureReconcileContext(reconcile)
  if (context === undefined) return completedFileIds
  const setup = reconcile.currentSetup()
  if (setup === undefined) return completedFileIds
  const accessToken = await reconcile.readAccessToken(setup)
  if (accessToken === undefined || !reconcileContextIdentityStillStable(reconcile, context)) {
    return new Set()
  }

  let db: IDBDatabase
  try {
    db = await materialize.openLocalStoreDatabase(setup.vaultId, () =>
      reconcileContextIdentityStillStable(reconcile, context),
    )
  } catch (error: unknown) {
    if (reconcileContextIdentityStillStable(reconcile, context)) {
      reconcile.scheduleReconcileRetry?.()
    }
    console.warn('[kuroflare] binary outbox database open failed', {
      reason,
      error: safeLogError(error),
    })
    return new Set()
  }
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  const snapshot = await materialize.readOutboxWorkerSnapshot(db)
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  const records: LocalStoreOutboxRecord[] = []
  const queuedEntries = new Map<FileId, Extract<MetaFile, { type: 'binary'; deleted: false }>>()
  const now = Date.now()
  const fileIds = [...reconcile.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    const value = currentMetaFile(reconcile, fileId)
    if (value === undefined || value.deleted || value.type !== 'binary') continue
    if (!v.is(VaultRelativePathSchema, value.path)) continue
    const alreadyQueued = snapshot.outboxRecords.some(
      (record) =>
        record.fileId === value.fileId &&
        record.kind === 'materialize' &&
        record.blobManifestHash === value.blobManifestHash &&
        record.targetPath === value.path &&
        (record.status === 'pending' || record.status === 'retrying'),
    )
    if (alreadyQueued) {
      completedFileIds.add(value.fileId)
      continue
    }

    const manifest = await fetchBlobManifestForMeta(reconcile, setup, accessToken, value)
    if (manifest === undefined) continue
    if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
    let inspected = currentMetaFile(reconcile, fileId)
    if (
      inspected === undefined ||
      inspected.deleted ||
      inspected.type !== 'binary' ||
      JSON.stringify(inspected) !== JSON.stringify(value)
    ) {
      continue
    }
    const existing = materialize.vault.getAbstractFileByPath(inspected.path)
    if (existing instanceof TFolder) continue
    if (existing instanceof TFile) {
      const currentBytes = new Uint8Array(
        await materialize.vault.adapter.readBinary(inspected.path),
      )
      if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
      const currentHash = makeSha256Hex(await hashBytesSha256(currentBytes))
      if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
      const latest = currentMetaFile(reconcile, fileId)
      if (
        latest === undefined ||
        latest.deleted ||
        latest.type !== 'binary' ||
        JSON.stringify(latest) !== JSON.stringify(inspected)
      ) {
        continue
      }
      inspected = latest
      if (currentHash === manifest.contentSha256) {
        materialize.lastMaterialized.set(latest.path, {
          diskHash: manifest.contentSha256,
          ydocHash: manifest.contentSha256,
          path: latest.path,
          writtenAt: now,
        })
        completedFileIds.add(latest.fileId)
        continue
      }
    }

    const prefix = `binary-download-${inspected.fileId}-${inspected.blobManifestHash}`
    const plan = buildBinaryDownloadOutboxPlan({
      fileId: inspected.fileId,
      expectedHash: manifest.contentSha256,
      chunks: manifest.chunks.map((chunk, index) => ({
        id: requireOutboxPlanItemId(`${prefix}-chunk-${index.toString(36)}`),
        sha256: chunk.sha256,
        localCacheKey: binaryBlobCacheKey(chunk.sha256),
        size: chunk.size,
      })),
      materializeId: requireOutboxPlanItemId(`${prefix}-materialize`),
    })
    if (!plan.ok) continue
    for (const item of plan.plan.items) {
      const base = {
        id: item.id,
        kind: item.kind,
        status: 'pending',
        dependsOn: item.dependsOn,
        nextAttemptAt: undefined,
        fileId: item.fileId,
        createdAt: now,
      } as const
      if (item.kind === 'blob-get') {
        records.push({
          ...base,
          blobSha256: item.sha256,
          localCacheKey: item.localCacheKey,
          blobSize: item.size,
        })
      } else if (item.kind === 'materialize') {
        records.push({
          ...base,
          blobManifestHash: inspected.blobManifestHash,
          blobManifest: manifest,
          materializeChunks: manifest.chunks.map((chunk) => ({
            sha256: chunk.sha256,
            localCacheKey: binaryBlobCacheKey(chunk.sha256),
            size: chunk.size,
          })),
          expectedHash: item.expectedHash,
          targetPath: inspected.path,
          lastMaterialized:
            existing instanceof TFile
              ? materialize.lastMaterialized.get(inspected.path)
              : undefined,
        })
      }
    }
    queuedEntries.set(inspected.fileId, inspected)
  }
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  for (const [fileId, inspected] of queuedEntries) {
    const current = currentMetaFile(reconcile, fileId)
    if (
      current === undefined ||
      current.deleted ||
      current.type !== 'binary' ||
      JSON.stringify(current) !== JSON.stringify(inspected)
    ) {
      return new Set()
    }
  }
  if (records.length === 0) return completedFileIds
  try {
    await materialize.putOutboxRecords(db, records)
  } catch (error: unknown) {
    if (reconcileContextIdentityStillStable(reconcile, context)) {
      reconcile.scheduleReconcileRetry?.()
    }
    console.warn('[kuroflare] binary outbox enqueue failed', {
      reason,
      error: safeLogError(error),
    })
    return new Set()
  }
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  for (const [fileId, inspected] of queuedEntries) {
    const current = currentMetaFile(reconcile, fileId)
    if (
      current === undefined ||
      current.deleted ||
      current.type !== 'binary' ||
      JSON.stringify(current) !== JSON.stringify(inspected)
    ) {
      return new Set()
    }
  }
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  for (const [fileId, inspected] of queuedEntries) {
    setOwnedPathMarker(
      materialize.materializedPaths,
      materialize.materializedPathOwners,
      fileId,
      inspected.path,
      context.generation,
    )
    completedFileIds.add(fileId)
  }
  if (!reconcileContextIdentityStillStable(reconcile, context)) return new Set()
  void materialize.runOutboxWorkerTick(reason)
  return completedFileIds
}

async function fetchBlobManifestForMeta(
  reconcile: MetadataReconcileBinaryRuntimePort,
  setup: LocalSetupMetadata,
  accessToken: string,
  value: BinaryMetaFile,
): Promise<BlobManifest | undefined> {
  if (reconcile.fetchBlobManifestForMeta !== undefined) {
    return reconcile.fetchBlobManifestForMeta(setup, accessToken, value)
  }
  // The /blob-manifests/* route uses a catch-all wildcard that hc client does not support.
  // Keep as raw fetch until hono/client adds wildcard RPC support.
  const url = new URL(setup.endpoint)
  url.pathname = `/blob-manifests/${encodeURIComponent(value.blobManifestHash)}.json`
  let response: Response
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
  } catch {
    setManifestUnavailable(reconcile, value)
    return undefined
  }
  if (!response.ok) {
    setManifestUnavailable(reconcile, value)
    return undefined
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!v.is(BlobManifestSchema, body) || !blobManifestMatchesMetaFile(body, value)) {
    setManifestUnavailable(reconcile, value)
    return undefined
  }
  return body
}

async function remoteBlobChunksExist(
  reconcile: MetadataReconcileBinaryRuntimePort,
  setup: LocalSetupMetadata,
  accessToken: string,
  manifest: BlobManifest,
): Promise<boolean> {
  if (reconcile.remoteBlobChunksExist !== undefined) {
    return reconcile.remoteBlobChunksExist(setup, accessToken, manifest)
  }
  const hashes = manifest.chunks.map((chunk) => chunk.sha256)
  const client = createWorkerClient(setup.endpoint, accessToken)
  for (const [batchIndex, batch] of blobHeadHashBatches(hashes).entries()) {
    const start = batchIndex * MAX_BLOB_HEAD_HASHES_PER_REQUEST
    let response: Response
    try {
      response = await client.blobs.head.$post({
        json: { hashes: [...batch] },
      })
    } catch {
      return false
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok || !v.is(BlobHeadResponseSchema, body)) return false
    for (const chunk of manifest.chunks.slice(start, start + batch.length)) {
      const entry = body.exists[chunk.sha256]
      if (!blobHeadEntryMatchesChunk(entry, chunk.size)) return false
    }
  }
  return true
}

function setManifestUnavailable(
  reconcile: MetadataReconcileBinaryRuntimePort,
  value: BinaryMetaFile,
): void {
  reconcile.setBinaryRestoreCheckDetail({
    fileId: value.fileId,
    path: value.path,
    checkedAt: Date.now(),
    reason: 'manifest-unavailable',
  })
}

function binaryDeletionEvidenceEntryMatches(
  reconcile: MetadataReconcileBinaryRuntimePort,
  fileId: FileId,
  inspected: Extract<MetaFile, { type: 'binary'; deleted: true }>,
): boolean {
  const current = currentMetaFile(reconcile, fileId)
  return (
    current !== undefined &&
    current.deleted &&
    current.type === 'binary' &&
    current.blobManifestHash === inspected.blobManifestHash &&
    JSON.stringify(current.blobChunks) === JSON.stringify(inspected.blobChunks) &&
    JSON.stringify(current.deletedContentVersion) ===
      JSON.stringify(inspected.deletedContentVersion)
  )
}
