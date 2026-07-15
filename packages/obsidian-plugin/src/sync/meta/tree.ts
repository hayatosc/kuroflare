import {
  canonicalizeVaultPath,
  type DeviceId,
  type FileId,
  type MetaFile,
  type YDocId,
} from '@kuroflare/core'
import * as Y from 'yjs'

import { insertMetaFile, readMetaEntries, updateMetaGroup } from '../../main/meta'

/** Input for registering a newly created text file in the meta YDoc. */
export interface FileCreateInput {
  /** Stable file identifier (e.g. a freshly minted UUID). Never the path. */
  readonly fileId: FileId
  /** Vault-relative path at creation time. */
  readonly path: string
  /** Body YDoc identifier for this text file. */
  readonly ydocId: YDocId
  /** Device that observed the create. */
  readonly deviceId: DeviceId
  /** Logical timestamp written into the entry. */
  readonly now: number
  /** Yjs transaction origin. */
  readonly origin?: unknown
}

/** Input addressing an existing active entry by its current path. */
export interface FilePathMutationInput {
  /** Current vault-relative path used to locate the entry. */
  readonly path: string
  /** Device that observed the change. */
  readonly deviceId: DeviceId
  /** Logical timestamp written into the entry. */
  readonly now: number
  /** Yjs transaction origin. */
  readonly origin?: unknown
}

/** Input for a rename: locate by `fromPath`, update the same entry to `toPath`. */
export interface FileRenameInput {
  readonly fromPath: string
  readonly toPath: string
  readonly deviceId: DeviceId
  readonly now: number
  readonly origin?: unknown
}

export type FileTreeResult =
  | { readonly action: 'renamed' | 'deleted'; readonly fileId: FileId }
  | { readonly action: 'not-found' }

/**
 * Registers a freshly created text file as an active meta entry keyed by its file ID.
 *
 * @param metaMap Live meta YDoc map keyed by file ID.
 * @param input File identity, path, and provenance.
 */
export function applyFileCreate(metaMap: Y.Map<unknown>, input: FileCreateInput): void {
  if (findActiveEntryByCanonicalPath(metaMap, canonicalizeVaultPath(input.path)) !== undefined) {
    return
  }
  const entry: MetaFile = {
    schemaVersion: 1,
    fileId: input.fileId,
    path: input.path,
    canonicalPath: canonicalizeVaultPath(input.path),
    type: 'text',
    ydocId: input.ydocId,
    deleted: false,
    createdAt: input.now,
    createdBy: input.deviceId,
    contentUpdatedAt: input.now,
    contentUpdatedBy: input.deviceId,
    updatedAt: input.now,
    updatedBy: input.deviceId,
    mtime: input.now,
  }
  transact(metaMap, input.origin, () => insertMetaFile(metaMap, entry))
}

/**
 * Renames a file by updating the `path` of its existing entry, preserving the file ID.
 *
 * This is the core stable-identifier design guarantee: a rename is a path-field update on a stable file ID, never a
 * delete + create. The losing-side path collision (two files at one canonical path) is resolved
 * separately and deterministically by `reconcileMetaDoc`.
 *
 * @param metaMap Live meta YDoc map keyed by file ID.
 * @param input Old and new paths plus provenance.
 * @returns The renamed file ID, or `not-found` when no active entry holds `fromPath`.
 */
export function applyFileRename(metaMap: Y.Map<unknown>, input: FileRenameInput): FileTreeResult {
  const found = findActiveEntryByCanonicalPath(metaMap, canonicalizeVaultPath(input.fromPath))
  if (found === undefined) {
    return { action: 'not-found' }
  }

  const nextLocation = {
    path: input.toPath,
    canonicalPath: canonicalizeVaultPath(input.toPath),
    updatedAt: input.now,
    updatedBy: input.deviceId,
    mtime: found.mtime,
  }
  transact(metaMap, input.origin, () => {
    ensureGroupedEntry(metaMap, found.fileId, found)
    updateMetaGroup(metaMap, found.fileId, 'location', nextLocation)
  })
  return { action: 'renamed', fileId: found.fileId }
}

/**
 * Tombstones the active entry at `path` without physically removing it.
 *
 * @param metaMap Live meta YDoc map keyed by file ID.
 * @param input Path plus provenance.
 * @returns The deleted file ID, or `not-found` when no active entry holds `path`.
 */
export function applyFileDelete(
  metaMap: Y.Map<unknown>,
  input: FilePathMutationInput,
): FileTreeResult {
  const found = findActiveEntryByCanonicalPath(metaMap, canonicalizeVaultPath(input.path))
  if (found === undefined) {
    return { action: 'not-found' }
  }

  const nextDeletion = { deleted: true as const, deletedAt: input.now, deletedBy: input.deviceId }
  transact(metaMap, input.origin, () => {
    ensureGroupedEntry(metaMap, found.fileId, found)
    updateMetaGroup(metaMap, found.fileId, 'deletion', nextDeletion)
  })
  return { action: 'deleted', fileId: found.fileId }
}

function findActiveEntryByCanonicalPath(
  metaMap: Y.Map<unknown>,
  canonicalPath: string,
): MetaFile | undefined {
  for (const value of readMetaEntries(metaMap)) {
    if (!value.deleted && value.canonicalPath === canonicalPath) return value
  }
  return undefined
}

function transact(metaMap: Y.Map<unknown>, origin: unknown, fn: () => void): void {
  const doc = metaMap.doc
  if (doc) {
    doc.transact(fn, origin)
  } else {
    fn()
  }
}

function ensureGroupedEntry(metaMap: Y.Map<unknown>, fileId: FileId, value: MetaFile): void {
  if (metaMap.get(fileId) instanceof Y.Map) return
  insertMetaFile(metaMap, value)
}
