import type { FileId, LastMaterializedRecord, MetaFile } from '@kuroflare/core'
import { TFile } from 'obsidian'
import type * as Y from 'yjs'

import { safeLogError } from '../main/helpers'
import { readMetaFile } from '../main/meta'
import { clearPendingFsRename, markPendingFsRename } from '../main/runtime-guards'
import type { LocalStoreOutboxRecord } from '../sync/store/store'

/** Vault, materialization, and outbox capabilities used after metadata is reconciled. */
export interface MetadataMaterializationPort {
  readonly getMetaDoc: () => Y.Doc
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
  readonly pendingRemoteTextFiles: Map<string, string>
  readonly pendingFsRenames: Set<string>
  readonly activeRemoteDeletedFileIds: Set<FileId>
  readonly getActiveFile: () => { readonly path: string } | null
  readonly setSyncStatusText: (text: string) => void
  readonly notify: (message: string) => void
  readonly clearTextDeletionEvidenceRequest: (docId: string) => void
  readonly requestMissingRemoteTextFile: (value: MetaFile) => Promise<void>
  readonly openLocalStoreDatabase: (vaultId: string) => Promise<IDBDatabase>
  readonly readOutboxWorkerSnapshot: (db: IDBDatabase) => Promise<{
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  }>
  readonly putOutboxRecords: (
    db: IDBDatabase,
    records: readonly LocalStoreOutboxRecord[],
  ) => Promise<void>
  readonly runOutboxWorkerTick: (reason: string) => Promise<void>
}

/** Materializes remote metadata renames while preserving filesystem rename guards. */
export async function materializeMetaRenames(
  materialize: MetadataMaterializationPort,
): Promise<void> {
  const fileIds = [...materialize.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    const value = currentMetaFile(materialize, fileId)
    if (value === undefined || value.deleted) continue
    materialize.activeRemoteDeletedFileIds.delete(value.fileId)
    const known = materialize.materializedPaths.get(value.fileId)
    if (known === value.path) continue
    if (known === undefined) {
      materialize.materializedPaths.set(value.fileId, value.path)
      if (value.type === 'text') await materialize.requestMissingRemoteTextFile(value)
      continue
    }
    const file = materialize.vault.getAbstractFileByPath(known)
    if (!(file instanceof TFile)) {
      materialize.materializedPaths.set(value.fileId, value.path)
      if (value.type === 'text') await materialize.requestMissingRemoteTextFile(value)
      continue
    }
    const target = markPendingFsRename(materialize.pendingFsRenames, value.path)
    try {
      await materialize.fileManager.renameFile(file, value.path)
      const current = currentMetaFile(materialize, fileId)
      if (
        current === undefined ||
        current.deleted ||
        current.path !== value.path ||
        current.type !== value.type
      ) {
        clearPendingFsRename(materialize.pendingFsRenames, target)
        continue
      }
      materialize.materializedPaths.set(current.fileId, current.path)
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
}

/** Applies remote tombstones to local materialization state without closing the active editor. */
export function materializeMetaDeletes(materialize: MetadataMaterializationPort): void {
  const fileIds = [...materialize.getMetaDoc().getMap<unknown>('meta').keys()]
  for (const fileId of fileIds) {
    const value = currentMetaFile(materialize, fileId)
    if (value === undefined || !value.deleted) continue
    if (value.type === 'text') {
      materialize.pendingRemoteTextFiles.delete(value.ydocId)
      materialize.clearTextDeletionEvidenceRequest(value.ydocId)
    }
    if (materialize.getActiveFile()?.path !== value.path) continue
    if (materialize.activeRemoteDeletedFileIds.has(value.fileId)) continue
    materialize.activeRemoteDeletedFileIds.add(value.fileId)
    materialize.setSyncStatusText(`Kuroflare sync: remote tombstone ${value.path}`)
    materialize.notify('Kuroflare sync: active file was deleted remotely; local editor kept open')
  }
}

function currentMetaFile(
  materialize: MetadataMaterializationPort,
  fileId: string,
): MetaFile | undefined {
  const meta = materialize.getMetaDoc().getMap<unknown>('meta')
  return readMetaFile(meta, fileId)
}
