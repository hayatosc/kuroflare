import type { FileId, LastMaterializedRecord, MetaFile } from '@kuroflare/core'
import { TFile } from 'obsidian'
import type * as Y from 'yjs'

import type { GenerationMarkerOwner } from '../main-types'
import { safeLogError } from '../main/helpers'
import { readMetaFile } from '../main/meta'
import {
  claimOwnedPathMarker,
  clearOwnedPathMarker,
  clearPendingFsRename,
  deletePathMarker,
  markPendingFsRename,
  setOwnedPathMarker,
} from '../main/runtime-guards'
import type { LocalStoreOutboxRecord } from '../sync/store/store'

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
    const value = currentMetaFile(materialize, fileId)
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
      let current = currentMetaFile(materialize, fileId)
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
          current = currentMetaFile(materialize, fileId)
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
    const value = currentMetaFile(materialize, fileId)
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

function currentMetaFile(
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
  const current = currentMetaFile(materialize, value.fileId)
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
