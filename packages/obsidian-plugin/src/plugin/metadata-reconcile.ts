import {
  BlobHeadResponseSchema,
  BlobManifestSchema,
  blobManifestMatchesMetaFile,
  buildBinaryDownloadOutboxPlan,
  hashBytesSha256,
  hashCanonicalText,
  makeSha256Hex,
  type BinaryMetaFile,
  type BlobManifest,
  type FileId,
  type MetaFile,
  type MetaRepair,
  type MetadataAccess,
  type TextDeletionEvidence,
} from '@kuroflare/core'
import { VaultRelativePathSchema, decodeMetaValue } from '@kuroflare/core'
import { TFile, TFolder } from 'obsidian'
import * as v from 'valibot'
import * as Y from 'yjs'

import type {
  KuroflareBinaryRestoreCheckDetail,
  KuroflareRepairLogEntry,
  KuroflareSettings,
  LoadedTextDoc,
} from '../main-types'
import { REPAIR_DEVICE, REPAIR_ORIGIN } from '../main/constants'
import {
  binaryBlobCacheKey,
  mergeRepairLogEntries,
  requireOutboxPlanItemId,
  safeLogError,
} from '../main/helpers'
import { metadataWritesEnabled, readMetaFile } from '../main/meta'
import {
  blobHeadHashBatches,
  blobHeadEntryMatchesChunk,
  MAX_BLOB_HEAD_HASHES_PER_REQUEST,
} from '../main/runtime-guards'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import { reconcileMetaDoc } from '../sync/meta/reconcile'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import {
  materializeMetaDeletes,
  materializeMetaRenames,
  type MetadataMaterializationPort,
} from './metadata-materialization'

type TextYDocId = LoadedTextDoc['docId']['ydocId']

/** Runtime state and network capabilities needed for metadata reconciliation. */
export interface MetadataReconcilePort {
  readonly canSendNetwork: () => boolean
  readonly getMetaDoc: () => Y.Doc
  readonly getMetadataAccess: () => MetadataAccess
  readonly loadedTextDocs: ReadonlyMap<string, LoadedTextDoc>
  readonly pendingTextDeletionEvidenceRequests: Map<string, number>
  readonly pendingTextDeletionEvidenceRetryTimers: Map<string, number>
  readonly loadTextDoc: (ydocId: TextYDocId) => Promise<LoadedTextDoc>
  readonly requestDocFromWorker: (
    loaded: LoadedTextDoc,
    stateVector: Uint8Array,
    reason: string,
  ) => Promise<boolean>
  readonly getSettings: () => KuroflareSettings
  readonly updateSettings: (patch: Partial<KuroflareSettings>) => Promise<void>
  readonly currentSetup: () => LocalSetupMetadata | undefined
  readonly readAccessToken: (setup: LocalSetupMetadata) => Promise<string | undefined>
  readonly setBinaryRestoreCheckDetail: (detail: KuroflareBinaryRestoreCheckDetail) => void
  readonly fetchBlobManifestForMeta?: (
    setup: LocalSetupMetadata,
    accessToken: string,
    value: BinaryMetaFile,
  ) => Promise<BlobManifest | undefined>
  readonly remoteBlobChunksExist?: (
    setup: LocalSetupMetadata,
    accessToken: string,
    manifest: BlobManifest,
  ) => Promise<boolean>
}

/** Runs metadata repair followed by safe Vault reconciliation/materialization. */
export async function reconcileAndMaterializeMeta(
  reconcile: MetadataReconcilePort,
  materialize: MetadataMaterializationPort,
): Promise<void> {
  if (!reconcile.canSendNetwork()) return
  if (
    metadataWritesEnabled({
      metadataAccess: reconcile.getMetadataAccess(),
      metaDoc: reconcile.getMetaDoc(),
    })
  ) {
    const restorableBinaryFileIds = await findRestorableBinaryFileIdsForReconcile(reconcile)
    const textDeletionEvidence = await findTextDeletionEvidenceForReconcile(reconcile)
    const currentMetaDoc = reconcile.getMetaDoc()
    if (
      metadataWritesEnabled({
        metadataAccess: reconcile.getMetadataAccess(),
        metaDoc: currentMetaDoc,
      })
    ) {
      const reconciled = reconcileMetaDoc(currentMetaDoc.getMap<unknown>('meta'), {
        updatedAt: Date.now(),
        updatedBy: REPAIR_DEVICE,
        restorableBinaryFileIds,
        textDeletionEvidence,
        origin: REPAIR_ORIGIN,
      })
      await recordMetaRepairLog(reconcile, reconciled.repairs, reconciled.invalidFileIds)
      await clearResolvedDeleteDeferrals(reconcile, reconciled.repairs)
    }
  } else if (reconcile.getMetadataAccess() === 'read-write') {
    const invalidFileIds: string[] = []
    for (const [fileId, value] of reconcile.getMetaDoc().getMap<unknown>('meta').entries()) {
      if (decodeMetaValue(value, fileId).disposition === 'invalid') invalidFileIds.push(fileId)
    }
    await recordMetaRepairLog(reconcile, [], invalidFileIds)
  }
  await materializeMetaRenames(materialize)
  materializeMetaDeletes(materialize)
  await enqueueMissingRemoteBinaryDownloads(reconcile, materialize, 'meta-reconcile')
}

/** Collects deletion evidence while revalidating metadata at every async boundary. */
export async function findTextDeletionEvidenceForReconcile(
  reconcile: MetadataReconcilePort,
): Promise<ReadonlyMap<FileId, TextDeletionEvidence>> {
  const evidence = new Map<FileId, TextDeletionEvidence>()
  const inspectedEntries = new Map<FileId, Extract<MetaFile, { type: 'text'; deleted: true }>>()
  const fileIds = [...reconcile.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    const value = currentMetaFile(reconcile, fileId)
    if (
      value === undefined ||
      !value.deleted ||
      value.type !== 'text' ||
      value.deletedContentVersion?.kind !== 'text'
    ) {
      continue
    }
    const wasLoaded = reconcile.loadedTextDocs.has(value.ydocId)
    let loaded = reconcile.loadedTextDocs.get(value.ydocId)
    if (loaded === undefined) loaded = await reconcile.loadTextDoc(value.ydocId)
    if (!textDeletionEvidenceEntryMatches(reconcile, fileId, value)) continue
    if (!wasLoaded) {
      await requestTextDeletionEvidence(reconcile, loaded)
      continue
    }
    const stateVectorBase64 = encodeBase64(Y.encodeStateVector(loaded.doc))
    const contentSha256 = await hashCanonicalText(loaded.text.toJSON())
    if (!textDeletionEvidenceEntryMatches(reconcile, fileId, value)) continue
    evidence.set(value.fileId, { stateVectorBase64, contentSha256 })
    inspectedEntries.set(fileId, value)
    if (!stateVectorDominates(loaded.doc, value.deletedContentVersion.stateVectorBase64)) {
      await requestTextDeletionEvidence(reconcile, loaded)
    }
  }
  const validatedEvidence = new Map<FileId, TextDeletionEvidence>()
  for (const [fileId, currentEvidence] of evidence) {
    const inspected = inspectedEntries.get(fileId)
    if (inspected !== undefined && textDeletionEvidenceEntryMatches(reconcile, fileId, inspected)) {
      validatedEvidence.set(fileId, currentEvidence)
    }
  }
  return validatedEvidence
}

/** Collects binary deletion evidence only after manifest and every chunk are verified remotely. */
export async function findRestorableBinaryFileIdsForReconcile(
  reconcile: MetadataReconcilePort,
): Promise<ReadonlySet<FileId>> {
  const setup = reconcile.currentSetup()
  if (setup === undefined) return new Set()
  const accessToken = await reconcile.readAccessToken(setup)
  if (accessToken === undefined) return new Set()

  const restorable = new Set<FileId>()
  const inspectedEntries = new Map<FileId, Extract<MetaFile, { type: 'binary'; deleted: true }>>()
  const fileIds = [...reconcile.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    const value = currentMetaFile(reconcile, fileId)
    if (value === undefined || !value.deleted || value.type !== 'binary') continue
    const manifest = await fetchBlobManifestForMeta(reconcile, setup, accessToken, value)
    if (!binaryDeletionEvidenceEntryMatches(reconcile, fileId, value)) continue
    if (
      manifest !== undefined &&
      (await remoteBlobChunksExist(reconcile, setup, accessToken, manifest))
    ) {
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
  return validatedRestorable
}

/** Schedules one bounded retry for an unanswered text deletion evidence request. */
export function scheduleTextDeletionEvidenceRetry(
  reconcile: MetadataReconcilePort,
  loaded: LoadedTextDoc,
): void {
  const docId = loaded.docId.ydocId
  if (!reconcile.pendingTextDeletionEvidenceRequests.has(docId)) return
  const existingTimer = reconcile.pendingTextDeletionEvidenceRetryTimers.get(docId)
  if (existingTimer !== undefined) window.clearTimeout(existingTimer)
  const timer = window.setTimeout(() => {
    reconcile.pendingTextDeletionEvidenceRetryTimers.delete(docId)
    if (!reconcile.pendingTextDeletionEvidenceRequests.delete(docId)) return
    const current = reconcile.loadedTextDocs.get(docId)
    if (current !== undefined) void requestTextDeletionEvidence(reconcile, current)
  }, 10_000)
  reconcile.pendingTextDeletionEvidenceRetryTimers.set(docId, timer)
}

/** Clears a pending deletion-evidence request and its retry timer. */
export function clearTextDeletionEvidenceRequest(
  reconcile: MetadataReconcilePort,
  docId: TextYDocId,
): void {
  reconcile.pendingTextDeletionEvidenceRequests.delete(docId)
  const timer = reconcile.pendingTextDeletionEvidenceRetryTimers.get(docId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    reconcile.pendingTextDeletionEvidenceRetryTimers.delete(docId)
  }
}

/** Enqueues idempotent blob-get/materialize records for active binary metadata entries. */
export async function enqueueMissingRemoteBinaryDownloads(
  reconcile: MetadataReconcilePort,
  materialize: MetadataMaterializationPort,
  reason: string,
): Promise<void> {
  if (!reconcile.canSendNetwork()) return
  const setup = reconcile.currentSetup()
  if (setup === undefined) return
  const accessToken = await reconcile.readAccessToken(setup)
  if (accessToken === undefined) return

  const db = await materialize.openLocalStoreDatabase(setup.vaultId)
  const snapshot = await materialize.readOutboxWorkerSnapshot(db)
  const records: LocalStoreOutboxRecord[] = []
  const now = Date.now()
  const fileIds = [...reconcile.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    const value = currentMetaFile(reconcile, fileId)
    if (value === undefined || value.deleted || value.type !== 'binary') continue
    if (!v.is(VaultRelativePathSchema, value.path)) continue
    if (
      snapshot.outboxRecords.some(
        (record) =>
          record.fileId === value.fileId &&
          record.kind === 'materialize' &&
          record.status !== 'done' &&
          record.status !== 'failed',
      )
    )
      continue

    const manifest = await fetchBlobManifestForMeta(reconcile, setup, accessToken, value)
    if (manifest === undefined) continue
    const current = currentMetaFile(reconcile, fileId)
    if (
      current === undefined ||
      current.deleted ||
      current.type !== 'binary' ||
      JSON.stringify(current) !== JSON.stringify(value)
    ) {
      continue
    }
    const existing = materialize.vault.getAbstractFileByPath(current.path)
    if (existing instanceof TFolder) continue
    if (existing instanceof TFile) {
      const currentBytes = new Uint8Array(await materialize.vault.adapter.readBinary(current.path))
      const currentHash = makeSha256Hex(await hashBytesSha256(currentBytes))
      if (currentHash === manifest.contentSha256) {
        const latest = currentMetaFile(reconcile, fileId)
        if (
          latest === undefined ||
          latest.deleted ||
          latest.type !== 'binary' ||
          JSON.stringify(latest) !== JSON.stringify(value)
        ) {
          continue
        }
        materialize.lastMaterialized.set(latest.path, {
          diskHash: manifest.contentSha256,
          ydocHash: manifest.contentSha256,
          path: latest.path,
          writtenAt: now,
        })
        continue
      }
    }

    const prefix = `binary-download-${value.fileId}-${value.blobManifestHash}`
    const plan = buildBinaryDownloadOutboxPlan({
      fileId: value.fileId,
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
          blobManifestHash: value.blobManifestHash,
          blobManifest: manifest,
          materializeChunks: manifest.chunks.map((chunk) => ({
            sha256: chunk.sha256,
            localCacheKey: binaryBlobCacheKey(chunk.sha256),
            size: chunk.size,
          })),
          expectedHash: item.expectedHash,
          targetPath: current.path,
          lastMaterialized:
            existing instanceof TFile ? materialize.lastMaterialized.get(current.path) : undefined,
        })
      }
    }
    materialize.materializedPaths.set(current.fileId, current.path)
  }
  if (records.length === 0) return
  await materialize.putOutboxRecords(db, records)
  void materialize.runOutboxWorkerTick(reason)
}

async function requestTextDeletionEvidence(
  reconcile: MetadataReconcilePort,
  loaded: LoadedTextDoc,
): Promise<void> {
  const now = Date.now()
  const expiresAt = reconcile.pendingTextDeletionEvidenceRequests.get(loaded.docId.ydocId)
  if (expiresAt !== undefined && expiresAt > now) return
  if (expiresAt !== undefined) clearTextDeletionEvidenceRequest(reconcile, loaded.docId.ydocId)
  reconcile.pendingTextDeletionEvidenceRequests.set(loaded.docId.ydocId, now + 10_000)
  try {
    const sent = await reconcile.requestDocFromWorker(
      loaded,
      Y.encodeStateVector(loaded.doc),
      'delete-reconcile-text-evidence',
    )
    if (!sent) {
      clearTextDeletionEvidenceRequest(reconcile, loaded.docId.ydocId)
    } else {
      scheduleTextDeletionEvidenceRetry(reconcile, loaded)
    }
  } catch (error: unknown) {
    clearTextDeletionEvidenceRequest(reconcile, loaded.docId.ydocId)
    console.warn('[kuroflare] failed to request text deletion evidence', {
      docId: loaded.docId,
      error: safeLogError(error),
    })
  }
}

function textDeletionEvidenceEntryMatches(
  reconcile: MetadataReconcilePort,
  fileId: FileId,
  inspected: Extract<MetaFile, { type: 'text'; deleted: true }>,
): boolean {
  const current = currentMetaFile(reconcile, fileId)
  return (
    current !== undefined &&
    current.deleted &&
    current.type === 'text' &&
    current.ydocId === inspected.ydocId &&
    JSON.stringify(current.deletedContentVersion) ===
      JSON.stringify(inspected.deletedContentVersion)
  )
}

function binaryDeletionEvidenceEntryMatches(
  reconcile: MetadataReconcilePort,
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

async function clearResolvedDeleteDeferrals(
  reconcile: MetadataReconcilePort,
  repairs: readonly MetaRepair[],
): Promise<void> {
  const pending = new Set(
    repairs
      .filter(
        (repair): repair is Extract<MetaRepair, { action: 'defer-deletion' }> =>
          'action' in repair && repair.action === 'defer-deletion',
      )
      .map((repair) => repair.fileId),
  )
  const current = reconcile.getSettings().repairLog ?? []
  const deferredReasons = new Set([
    'legacy-deletion-tombstone',
    'deletion-evidence-unavailable',
    'deletion-base-not-dominated',
    'invalid-deletion-evidence',
  ])
  const next = current.filter(
    (entry) =>
      !(
        entry.kind === 'delete-vs-edit' &&
        deferredReasons.has(entry.reason) &&
        !pending.has(entry.fileId)
      ),
  )
  if (next.length !== current.length) await reconcile.updateSettings({ repairLog: next })
}

async function recordMetaRepairLog(
  reconcile: MetadataReconcilePort,
  repairs: readonly MetaRepair[],
  invalidFileIds: readonly string[],
): Promise<void> {
  if (repairs.length === 0 && invalidFileIds.length === 0) return
  const createdAt = Date.now()
  const entries: KuroflareRepairLogEntry[] = [
    ...repairs.map(
      (repair): KuroflareRepairLogEntry => ({
        id:
          'action' in repair
            ? `delete-vs-edit:${repair.fileId}:${repair.action}`
            : 'reason' in repair
              ? `portable-path:${repair.fileId}`
              : `path-conflict:${repair.fileId}`,
        kind:
          'action' in repair
            ? 'delete-vs-edit'
            : 'reason' in repair
              ? 'portable-path'
              : 'path-conflict',
        fileId: repair.fileId,
        path: 'toPath' in repair ? repair.toPath : undefined,
        reason:
          'action' in repair
            ? repair.action === 'keep-deleted'
              ? 'missing-binary-content'
              : repair.action === 'defer-deletion'
                ? repair.reason
                : 'concurrent-edit-after-delete'
            : 'reason' in repair
              ? repair.reason
              : 'path-conflict-renamed',
        createdAt,
      }),
    ),
    ...invalidFileIds.map(
      (fileId): KuroflareRepairLogEntry => ({
        id: `invalid-meta:${fileId}`,
        kind: 'invalid-meta',
        fileId,
        reason: 'meta-schema-invalid',
        createdAt,
      }),
    ),
  ]
  await reconcile.updateSettings({
    repairLog: mergeRepairLogEntries(reconcile.getSettings().repairLog ?? [], entries),
  })
}

async function fetchBlobManifestForMeta(
  reconcile: MetadataReconcilePort,
  setup: LocalSetupMetadata,
  accessToken: string,
  value: BinaryMetaFile,
): Promise<BlobManifest | undefined> {
  if (reconcile.fetchBlobManifestForMeta !== undefined) {
    return reconcile.fetchBlobManifestForMeta(setup, accessToken, value)
  }
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
  reconcile: MetadataReconcilePort,
  setup: LocalSetupMetadata,
  accessToken: string,
  manifest: BlobManifest,
): Promise<boolean> {
  if (reconcile.remoteBlobChunksExist !== undefined) {
    return reconcile.remoteBlobChunksExist(setup, accessToken, manifest)
  }
  const hashes = manifest.chunks.map((chunk) => chunk.sha256)
  for (const [batchIndex, batch] of blobHeadHashBatches(hashes).entries()) {
    const start = batchIndex * MAX_BLOB_HEAD_HASHES_PER_REQUEST
    const url = new URL(setup.endpoint)
    url.pathname = '/blobs/head'
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ hashes: batch }),
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

function setManifestUnavailable(reconcile: MetadataReconcilePort, value: BinaryMetaFile): void {
  reconcile.setBinaryRestoreCheckDetail({
    fileId: value.fileId,
    path: value.path,
    checkedAt: Date.now(),
    reason: 'manifest-unavailable',
  })
}

function currentMetaFile(reconcile: MetadataReconcilePort, fileId: string): MetaFile | undefined {
  const meta = reconcile.getMetaDoc().getMap<unknown>('meta')
  return readMetaFile(meta, fileId)
}

function stateVectorDominates(doc: Y.Doc, base64: string): boolean {
  try {
    const binary = atob(base64)
    const base = Y.decodeStateVector(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )
    const current = Y.decodeStateVector(Y.encodeStateVector(doc))
    for (const [clientId, clock] of base) {
      if ((current.get(clientId) ?? 0) < clock) return false
    }
    return true
  } catch {
    return false
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
