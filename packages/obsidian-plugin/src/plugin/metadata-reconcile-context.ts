import {
  type BinaryMetaFile,
  type BlobManifest,
  type MetaFile,
  type MetadataAccess,
} from '@kuroflare/core'
import * as Y from 'yjs'

import type {
  KuroflareBinaryRestoreCheckDetail,
  KuroflareSettings,
  LoadedTextDoc,
} from '../main-types'
import { readMetaFile } from '../main/meta'
import type { LocalSetupMetadata } from '../sync/engine/setup'

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
