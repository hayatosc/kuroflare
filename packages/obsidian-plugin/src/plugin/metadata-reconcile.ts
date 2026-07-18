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
import { setOwnedPathMarker } from '../main/runtime-guards'
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

/** Vault-scoped identity required for a metadata reconciliation settings write. */
export interface MetadataReconcileWriteContext {
  readonly metaDoc: Y.Doc
  readonly vaultId: string | undefined
  readonly generation: number
}

/** Runtime state and network capabilities needed for metadata reconciliation. */
export interface MetadataReconcilePort {
  readonly canSendNetwork: () => boolean
  readonly scheduleReconcileRetry?: () => void
  readonly getVaultGeneration?: () => number
  readonly isVaultTransitionPending?: () => boolean
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
  readonly updateSettings: (
    update: (current: KuroflareSettings) => Partial<KuroflareSettings>,
    context: MetadataReconcileWriteContext,
  ) => Promise<boolean>
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
  if (!(await reconcileMetaWithEvidence(reconcile, 0))) return
  if (!(await materializeMetaRenames(materialize))) return
  if (!materializeMetaDeletes(materialize)) return
  await enqueueMissingRemoteBinaryDownloads(reconcile, materialize, 'meta-reconcile')
}

async function reconcileMetaWithEvidence(
  reconcile: MetadataReconcilePort,
  attempt: number,
): Promise<boolean> {
  const context = captureReconcileContext(reconcile)
  if (context === undefined) return false
  if (
    metadataWritesEnabled({
      metadataAccess: reconcile.getMetadataAccess(),
      metaDoc: reconcile.getMetaDoc(),
    })
  ) {
    const textResult = await collectTextDeletionEvidenceForReconcile(reconcile, context)
    if (
      textResult.unstable ||
      !textDeletionEvidenceStillStable(reconcile, textResult) ||
      !reconcileContextStillStable(reconcile, context)
    ) {
      return await retryReconcileAfterEvidenceInstability(reconcile, attempt, context)
    }
    const restorableBinaryFileIds = await findRestorableBinaryFileIdsForReconcile(reconcile)
    const currentMetaDoc = reconcile.getMetaDoc()
    if (
      textResult.unstable ||
      !textDeletionEvidenceStillStable(reconcile, textResult) ||
      !reconcileContextStillStable(reconcile, context)
    ) {
      return await retryReconcileAfterEvidenceInstability(reconcile, attempt, context)
    } else if (
      metadataWritesEnabled({
        metadataAccess: reconcile.getMetadataAccess(),
        metaDoc: currentMetaDoc,
      })
    ) {
      const reconciled = reconcileMetaDoc(currentMetaDoc.getMap<unknown>('meta'), {
        updatedAt: Date.now(),
        updatedBy: REPAIR_DEVICE,
        restorableBinaryFileIds,
        textDeletionEvidence: textResult.evidence,
        origin: REPAIR_ORIGIN,
      })
      if (
        !(await recordMetaRepairLog(
          reconcile,
          reconciled.repairs,
          reconciled.invalidFileIds,
          context,
        )) ||
        !(await clearResolvedDeleteDeferrals(reconcile, reconciled.repairs, context))
      ) {
        return false
      }
      return reconcileContextIdentityStillStable(reconcile, context)
    }
  } else if (reconcile.getMetadataAccess() === 'read-write') {
    const invalidFileIds: string[] = []
    for (const [fileId, value] of reconcile.getMetaDoc().getMap<unknown>('meta').entries()) {
      if (decodeMetaValue(value, fileId).disposition === 'invalid') invalidFileIds.push(fileId)
    }
    if (!(await recordMetaRepairLog(reconcile, [], invalidFileIds, context))) return false
    return reconcileContextStillStable(reconcile, context)
  }
  return reconcileContextIdentityStillStable(reconcile, context)
}

interface ReconcileContext extends MetadataReconcileWriteContext {
  readonly stateVector: Uint8Array
}

interface TextDeletionEvidenceCollectionResult {
  readonly evidence: ReadonlyMap<FileId, TextDeletionEvidence>
  readonly observations: ReadonlyMap<FileId, TextDeletionEvidenceObservation>
  readonly unstable: boolean
}

interface TextDeletionEvidenceObservation {
  readonly entry: Extract<MetaFile, { type: 'text'; deleted: true }>
  readonly loaded: LoadedTextDoc
  readonly stateVector: Uint8Array
}

function captureReconcileContext(reconcile: MetadataReconcilePort): ReconcileContext | undefined {
  if (reconcile.isVaultTransitionPending?.()) return undefined
  const setup = reconcile.currentSetup()
  return {
    metaDoc: reconcile.getMetaDoc(),
    stateVector: Y.encodeStateVector(reconcile.getMetaDoc()),
    vaultId: setup?.vaultId,
    generation: reconcile.getVaultGeneration?.() ?? 0,
  }
}

function reconcileContextStillStable(
  reconcile: MetadataReconcilePort,
  context: ReconcileContext,
): boolean {
  return (
    reconcileContextIdentityStillStable(reconcile, context) &&
    stateVectorsEqual(Y.encodeStateVector(context.metaDoc), context.stateVector)
  )
}

function reconcileContextIdentityStillStable(
  reconcile: MetadataReconcilePort,
  context: ReconcileContext,
): boolean {
  if (reconcile.isVaultTransitionPending?.()) return false
  return (
    reconcile.getMetaDoc() === context.metaDoc &&
    reconcile.currentSetup()?.vaultId === context.vaultId &&
    (reconcile.getVaultGeneration?.() ?? 0) === context.generation &&
    reconcile.canSendNetwork()
  )
}

async function retryReconcileAfterEvidenceInstability(
  reconcile: MetadataReconcilePort,
  attempt: number,
  context: ReconcileContext,
): Promise<boolean> {
  if (!reconcileContextIdentityStillStable(reconcile, context)) {
    reconcile.scheduleReconcileRetry?.()
    return false
  }
  if (attempt === 0) {
    return await reconcileMetaWithEvidence(reconcile, 1)
  }
  reconcile.scheduleReconcileRetry?.()
  return false
}

/** Collects deletion evidence while revalidating metadata at every async boundary. */
export async function findTextDeletionEvidenceForReconcile(
  reconcile: MetadataReconcilePort,
): Promise<ReadonlyMap<FileId, TextDeletionEvidence>> {
  const context = captureReconcileContext(reconcile)
  if (context === undefined) return new Map()
  return (await collectTextDeletionEvidenceForReconcile(reconcile, context)).evidence
}

async function collectTextDeletionEvidenceForReconcile(
  reconcile: MetadataReconcilePort,
  context: ReconcileContext,
): Promise<TextDeletionEvidenceCollectionResult> {
  const evidence = new Map<FileId, TextDeletionEvidence>()
  const inspectedEntries = new Map<FileId, Extract<MetaFile, { type: 'text'; deleted: true }>>()
  const inspectedLoadedDocs = new Map<FileId, LoadedTextDoc>()
  const inspectedStateVectors = new Map<FileId, Uint8Array>()
  let unstable = false
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
    if (!reconcileContextIdentityStillStable(reconcile, context)) {
      unstable = true
      continue
    }
    if (!textDeletionEvidenceEntryMatches(reconcile, fileId, value)) continue
    if (!wasLoaded) {
      await requestTextDeletionEvidence(reconcile, loaded, context)
      continue
    }
    const hashStateVector = Y.encodeStateVector(loaded.doc)
    const stateVectorBase64 = encodeBase64(hashStateVector)
    const contentSha256 = await hashCanonicalText(loaded.text.toJSON())
    if (
      !textDeletionEvidenceEntryMatches(reconcile, fileId, value) ||
      reconcile.loadedTextDocs.get(value.ydocId) !== loaded ||
      !stateVectorsEqual(Y.encodeStateVector(loaded.doc), hashStateVector)
    ) {
      if (
        textDeletionEvidenceEntryMatches(reconcile, fileId, value) &&
        reconcile.loadedTextDocs.get(value.ydocId) === loaded
      ) {
        await requestTextDeletionEvidence(reconcile, loaded, context)
      }
      unstable = true
      continue
    }
    evidence.set(value.fileId, { stateVectorBase64, contentSha256 })
    inspectedEntries.set(fileId, value)
    inspectedLoadedDocs.set(fileId, loaded)
    inspectedStateVectors.set(fileId, hashStateVector)
    if (!stateVectorDominates(loaded.doc, value.deletedContentVersion.stateVectorBase64)) {
      await requestTextDeletionEvidence(reconcile, loaded, context)
    }
  }
  const validatedEvidence = new Map<FileId, TextDeletionEvidence>()
  const validatedObservations = new Map<FileId, TextDeletionEvidenceObservation>()
  for (const [fileId, currentEvidence] of evidence) {
    const inspected = inspectedEntries.get(fileId)
    const loaded = inspectedLoadedDocs.get(fileId)
    const inspectedStateVector = inspectedStateVectors.get(fileId)
    if (
      inspected !== undefined &&
      loaded !== undefined &&
      reconcile.loadedTextDocs.get(inspected.ydocId) === loaded &&
      textDeletionEvidenceEntryMatches(reconcile, fileId, inspected) &&
      inspectedStateVector !== undefined &&
      stateVectorsEqual(Y.encodeStateVector(loaded.doc), inspectedStateVector)
    ) {
      validatedEvidence.set(fileId, currentEvidence)
      validatedObservations.set(fileId, {
        entry: inspected,
        loaded,
        stateVector: inspectedStateVector,
      })
    } else {
      unstable = true
    }
  }
  return { evidence: validatedEvidence, observations: validatedObservations, unstable }
}

function textDeletionEvidenceStillStable(
  reconcile: MetadataReconcilePort,
  result: TextDeletionEvidenceCollectionResult,
): boolean {
  if (result.evidence.size !== result.observations.size) return false
  for (const [fileId, observation] of result.observations) {
    if (
      !result.evidence.has(fileId) ||
      reconcile.loadedTextDocs.get(observation.entry.ydocId) !== observation.loaded ||
      !textDeletionEvidenceEntryMatches(reconcile, fileId, observation.entry) ||
      !stateVectorsEqual(Y.encodeStateVector(observation.loaded.doc), observation.stateVector)
    ) {
      return false
    }
  }
  return true
}

/** Collects binary deletion evidence only after manifest and every chunk are verified remotely. */
export async function findRestorableBinaryFileIdsForReconcile(
  reconcile: MetadataReconcilePort,
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

/** Schedules one bounded retry for an unanswered text deletion evidence request. */
export function scheduleTextDeletionEvidenceRetry(
  reconcile: MetadataReconcilePort,
  loaded: LoadedTextDoc,
): void {
  scheduleTextDeletionEvidenceRetryForContext(reconcile, loaded, captureReconcileContext(reconcile))
}

function scheduleTextDeletionEvidenceRetryForContext(
  reconcile: MetadataReconcilePort,
  loaded: LoadedTextDoc,
  context: ReconcileContext | undefined,
): void {
  const docId = loaded.docId.ydocId
  if (
    context === undefined ||
    !reconcileContextIdentityStillStable(reconcile, context) ||
    reconcile.loadedTextDocs.get(docId) !== loaded
  ) {
    clearTextDeletionEvidenceRequest(reconcile, docId)
    return
  }
  if (!reconcile.pendingTextDeletionEvidenceRequests.has(docId)) return
  const existingTimer = reconcile.pendingTextDeletionEvidenceRetryTimers.get(docId)
  if (existingTimer !== undefined) window.clearTimeout(existingTimer)
  const timer = window.setTimeout(() => {
    reconcile.pendingTextDeletionEvidenceRetryTimers.delete(docId)
    if (!reconcile.pendingTextDeletionEvidenceRequests.delete(docId)) return
    if (
      !reconcileContextIdentityStillStable(reconcile, context) ||
      reconcile.loadedTextDocs.get(docId) !== loaded
    ) {
      return
    }
    void requestTextDeletionEvidence(reconcile, loaded, context)
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

async function requestTextDeletionEvidence(
  reconcile: MetadataReconcilePort,
  loaded: LoadedTextDoc,
  context: ReconcileContext,
): Promise<void> {
  if (
    !reconcileContextIdentityStillStable(reconcile, context) ||
    reconcile.loadedTextDocs.get(loaded.docId.ydocId) !== loaded
  ) {
    return
  }
  const now = Date.now()
  const expiresAt = reconcile.pendingTextDeletionEvidenceRequests.get(loaded.docId.ydocId)
  if (expiresAt !== undefined && expiresAt > now) return
  if (expiresAt !== undefined) clearTextDeletionEvidenceRequest(reconcile, loaded.docId.ydocId)
  reconcile.pendingTextDeletionEvidenceRequests.set(loaded.docId.ydocId, now + 10_000)
  try {
    if (
      !reconcileContextIdentityStillStable(reconcile, context) ||
      reconcile.loadedTextDocs.get(loaded.docId.ydocId) !== loaded
    ) {
      clearTextDeletionEvidenceRequest(reconcile, loaded.docId.ydocId)
      return
    }
    const sent = await reconcile.requestDocFromWorker(
      loaded,
      Y.encodeStateVector(loaded.doc),
      'delete-reconcile-text-evidence',
    )
    if (!sent || !reconcileContextIdentityStillStable(reconcile, context)) {
      clearTextDeletionEvidenceRequest(reconcile, loaded.docId.ydocId)
    } else {
      scheduleTextDeletionEvidenceRetryForContext(reconcile, loaded, context)
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
  context: ReconcileContext,
): Promise<boolean> {
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
  if (next.length === current.length) return reconcileContextIdentityStillStable(reconcile, context)
  if (!reconcileContextIdentityStillStable(reconcile, context)) return false
  const written = await reconcile.updateSettings(
    (latest) => ({
      repairLog: (latest.repairLog ?? []).filter(
        (entry) =>
          !(
            entry.kind === 'delete-vs-edit' &&
            deferredReasons.has(entry.reason) &&
            !pending.has(entry.fileId)
          ),
      ),
    }),
    context,
  )
  return written && reconcileContextIdentityStillStable(reconcile, context)
}

async function recordMetaRepairLog(
  reconcile: MetadataReconcilePort,
  repairs: readonly MetaRepair[],
  invalidFileIds: readonly string[],
  context: ReconcileContext,
): Promise<boolean> {
  if (repairs.length === 0 && invalidFileIds.length === 0) {
    return reconcileContextIdentityStillStable(reconcile, context)
  }
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
  if (!reconcileContextIdentityStillStable(reconcile, context)) return false
  const written = await reconcile.updateSettings(
    (latest) => ({
      repairLog: mergeRepairLogEntries(latest.repairLog ?? [], entries),
    }),
    context,
  )
  return written && reconcileContextIdentityStillStable(reconcile, context)
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

function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
