import {
  hashCanonicalText,
  type BinaryMetaFile,
  type BlobManifest,
  type FileId,
  type MetaFile,
  type MetadataAccess,
  type TextDeletionEvidence,
} from '@kuroflare/core'
import * as Y from 'yjs'

import { safeLogError } from '../host/helpers'
import { readMetaFile } from '../host/meta'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import type { KuroflareBinaryRestoreCheckDetail, KuroflareSettings, LoadedTextDoc } from '../types'

type TextYDocId = LoadedTextDoc['docId']['ydocId']

/** Vault-scoped identity required for a metadata reconciliation settings write. */
export interface MetadataReconcileWriteContext {
  readonly metaDoc: Y.Doc
  readonly vaultId: string | undefined
  readonly generation: number
}

/** Shared identity and settings capabilities used by reconciliation evidence workers. */
export interface MetadataReconcileContextPort {
  readonly canSendNetwork: () => boolean
  readonly scheduleReconcileRetry?: () => void
  readonly getVaultGeneration?: () => number
  readonly isVaultTransitionPending?: () => boolean
  readonly getMetaDoc: () => Y.Doc
  readonly getMetadataAccess: () => MetadataAccess
  readonly getSettings: () => KuroflareSettings
  readonly updateSettings: (
    update: (current: KuroflareSettings) => Partial<KuroflareSettings>,
    context: MetadataReconcileWriteContext,
  ) => Promise<boolean>
  readonly currentSetup: () => LocalSetupMetadata | undefined
}

/** Text evidence capabilities kept separate from binary restore capabilities. */
export interface MetadataReconcileTextPort {
  readonly loadedTextDocs: ReadonlyMap<string, LoadedTextDoc>
  readonly pendingTextDeletionEvidenceRequests: Map<string, number>
  readonly pendingTextDeletionEvidenceRetryTimers: Map<string, number>
  readonly loadTextDoc: (ydocId: TextYDocId) => Promise<LoadedTextDoc>
  readonly requestDocFromWorker: (
    loaded: LoadedTextDoc,
    stateVector: Uint8Array,
    reason: string,
  ) => Promise<boolean>
}

/** Binary restore capabilities kept separate from text evidence capabilities. */
export interface MetadataReconcileBinaryPort {
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

/** Complete port retained as an intersection so existing fixtures stay structurally compatible. */
export type MetadataReconcilePort = MetadataReconcileContextPort &
  MetadataReconcileTextPort &
  MetadataReconcileBinaryPort

export type MetadataReconcileTextRuntimePort = MetadataReconcileContextPort &
  MetadataReconcileTextPort
export type MetadataReconcileBinaryRuntimePort = MetadataReconcileContextPort &
  MetadataReconcileBinaryPort

export interface ReconcileContext extends MetadataReconcileWriteContext {
  readonly stateVector: Uint8Array
}

export function captureReconcileContext(
  reconcile: MetadataReconcileContextPort,
): ReconcileContext | undefined {
  if (reconcile.isVaultTransitionPending?.()) return undefined
  const setup = reconcile.currentSetup()
  const metaDoc = reconcile.getMetaDoc()
  return {
    metaDoc,
    stateVector: Y.encodeStateVector(metaDoc),
    vaultId: setup?.vaultId,
    generation: reconcile.getVaultGeneration?.() ?? 0,
  }
}

export function reconcileContextStillStable(
  reconcile: MetadataReconcileContextPort,
  context: ReconcileContext,
): boolean {
  return (
    reconcileContextIdentityStillStable(reconcile, context) &&
    stateVectorsEqual(Y.encodeStateVector(context.metaDoc), context.stateVector)
  )
}

export function reconcileContextIdentityStillStable(
  reconcile: MetadataReconcileContextPort,
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

export function currentMetaFile(
  reconcile: MetadataReconcileContextPort,
  fileId: string,
): MetaFile | undefined {
  return readMetaFile(reconcile.getMetaDoc().getMap<unknown>('meta'), fileId)
}

export function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export type { TextYDocId }

export interface TextDeletionEvidenceCollectionResult {
  readonly evidence: ReadonlyMap<FileId, TextDeletionEvidence>
  readonly observations: ReadonlyMap<FileId, TextDeletionEvidenceObservation>
  readonly unstable: boolean
}

interface TextDeletionEvidenceObservation {
  readonly entry: Extract<MetaFile, { type: 'text'; deleted: true }>
  readonly loaded: LoadedTextDoc
  readonly stateVector: Uint8Array
}

/** Collects deletion evidence while revalidating metadata at every async boundary. */
export async function findTextDeletionEvidenceForReconcile(
  reconcile: MetadataReconcileTextRuntimePort,
): Promise<ReadonlyMap<FileId, TextDeletionEvidence>> {
  const context = captureReconcileContext(reconcile)
  if (context === undefined) return new Map()
  return (await collectTextDeletionEvidenceForReconcile(reconcile, context)).evidence
}

export async function collectTextDeletionEvidenceForReconcile(
  reconcile: MetadataReconcileTextRuntimePort,
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

export function textDeletionEvidenceStillStable(
  reconcile: MetadataReconcileTextRuntimePort,
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

/** Schedules one bounded retry for an unanswered text deletion evidence request. */
export function scheduleTextDeletionEvidenceRetry(
  reconcile: MetadataReconcileTextRuntimePort,
  loaded: LoadedTextDoc,
): void {
  scheduleTextDeletionEvidenceRetryForContext(reconcile, loaded, captureReconcileContext(reconcile))
}

function scheduleTextDeletionEvidenceRetryForContext(
  reconcile: MetadataReconcileTextRuntimePort,
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
  reconcile: MetadataReconcileTextRuntimePort,
  docId: TextYDocId,
): void {
  reconcile.pendingTextDeletionEvidenceRequests.delete(docId)
  const timer = reconcile.pendingTextDeletionEvidenceRetryTimers.get(docId)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    reconcile.pendingTextDeletionEvidenceRetryTimers.delete(docId)
  }
}

async function requestTextDeletionEvidence(
  reconcile: MetadataReconcileTextRuntimePort,
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
  reconcile: MetadataReconcileTextRuntimePort,
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
