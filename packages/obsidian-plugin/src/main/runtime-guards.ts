import { canonicalizeVaultPath } from '@kuroflare/core'

import type { GenerationMarkerOwner } from '../main-types'
import { META_DOC_NAME } from './constants'

/** Maximum number of blob hashes sent in one `/blobs/head` request. */
export const MAX_BLOB_HEAD_HASHES_PER_REQUEST = 512

/** Splits blob head hashes into bounded request batches. */
export function blobHeadHashBatches(hashes: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = []
  for (let start = 0; start < hashes.length; start += MAX_BLOB_HEAD_HASHES_PER_REQUEST) {
    batches.push(hashes.slice(start, start + MAX_BLOB_HEAD_HASHES_PER_REQUEST))
  }
  return batches
}

/** Requires both presence and an exact byte length for one remote blob chunk. */
export function blobHeadEntryMatchesChunk(
  entry: { readonly found?: boolean | undefined; readonly size?: number | undefined } | undefined,
  chunkSize: number,
): boolean {
  return entry?.found === true && entry.size === chunkSize
}

/** Builds the vault-scoped IndexedDB name used for the persisted meta Y.Doc. */
export function metaPersistenceDatabaseName(vaultId: string): string {
  return `${META_DOC_NAME}:${vaultId}`
}

/** Builds the vault-scoped IndexedDB name for one persisted file Y.Doc. */
export function filePersistenceDatabaseName(vaultId: string, ydocId: string): string {
  return `kuroflare-file:${vaultId}:${ydocId}`
}

/** Returns the legacy unscoped file-provider name used before vault isolation. */
export function legacyFilePersistenceDatabaseName(ydocId: string): string {
  return `kuroflare-file:${ydocId}`
}

export interface PendingFsRenameOwner {
  readonly path: string
  readonly token: object
}

const pendingFsRenameOwners = new WeakMap<Set<string>, Map<string, Set<object>>>()

/** Marks one target path as being renamed by remote meta materialization. */
export function markPendingFsRename(pending: Set<string>, path: string): PendingFsRenameOwner {
  const target = canonicalizeVaultPath(path)
  const owner = { path: target, token: {} }
  let ownersByPath = pendingFsRenameOwners.get(pending)
  if (ownersByPath === undefined) {
    ownersByPath = new Map()
    pendingFsRenameOwners.set(pending, ownersByPath)
  }
  const owners = ownersByPath.get(target) ?? new Set<object>()
  owners.add(owner.token)
  ownersByPath.set(target, owners)
  pending.add(target)
  return owner
}

/** Clears only the rename guard owned by the settled materialization operation. */
export function clearPendingFsRename(pending: Set<string>, owner: PendingFsRenameOwner): void {
  const ownersByPath = pendingFsRenameOwners.get(pending)
  const owners = ownersByPath?.get(owner.path)
  if (owners === undefined || !owners.delete(owner.token)) return
  if (owners.size > 0) return
  ownersByPath?.delete(owner.path)
  if (ownersByPath?.size === 0) pendingFsRenameOwners.delete(pending)
  pending.delete(owner.path)
}

/** Consumes one rename guard from a vault watcher event. */
export function consumePendingFsRename(pending: Set<string>, path: string): boolean {
  const target = canonicalizeVaultPath(path)
  if (!pending.has(target)) return false
  const ownersByPath = pendingFsRenameOwners.get(pending)
  const owners = ownersByPath?.get(target)
  const token = owners?.values().next().value
  if (token !== undefined) owners?.delete(token)
  if (owners !== undefined && owners.size > 0) return true
  ownersByPath?.delete(target)
  if (ownersByPath?.size === 0) pendingFsRenameOwners.delete(pending)
  pending.delete(target)
  return true
}

/** Sets a transient path marker and returns its generation-scoped owner identity. */
export function setOwnedPathMarker<Key>(
  paths: Map<Key, string>,
  owners: Map<Key, GenerationMarkerOwner>,
  key: Key,
  path: string,
  generation: number,
): GenerationMarkerOwner {
  const owner = { generation, token: {} }
  paths.set(key, path)
  owners.set(key, owner)
  return owner
}

/** Claims the current path marker for an async operation without changing its visible value. */
export function claimOwnedPathMarker<Key>(
  paths: Map<Key, string>,
  owners: Map<Key, GenerationMarkerOwner>,
  key: Key,
  path: string,
  generation: number,
): GenerationMarkerOwner | undefined {
  if (paths.get(key) !== path) return undefined
  const owner = { generation, token: {} }
  owners.set(key, owner)
  return owner
}

/** Deletes a path marker only when the same generation-scoped operation still owns it. */
export function clearOwnedPathMarker<Key>(
  paths: Map<Key, string>,
  owners: Map<Key, GenerationMarkerOwner>,
  key: Key,
  path: string,
  owner: GenerationMarkerOwner,
): boolean {
  if (owners.get(key) !== owner || paths.get(key) !== path) return false
  owners.delete(key)
  return paths.delete(key)
}

/** Deletes a path marker and any ownership identity associated with it. */
export function deletePathMarker<Key>(
  paths: Map<Key, string>,
  owners: Map<Key, GenerationMarkerOwner>,
  key: Key,
): boolean {
  owners.delete(key)
  return paths.delete(key)
}

/** Clears path markers and ownership identities at a lifecycle boundary. */
export function clearPathMarkers<Key>(
  paths: Map<Key, string>,
  owners: Map<Key, GenerationMarkerOwner>,
): void {
  paths.clear()
  owners.clear()
}

/** Returns whether the visible editor is already bound to the expected file Y.Doc. */
export function activeMarkdownBindingMatches(input: {
  readonly activePath: string | undefined
  readonly expectedPath: string
  readonly activeDocId: string | undefined
  readonly expectedDocId: string
  readonly sameView: boolean
}): boolean {
  return (
    input.sameView &&
    input.activePath === input.expectedPath &&
    input.activeDocId === input.expectedDocId
  )
}

/** Schedules a startup replan after the current lifecycle tick has yielded. */
export function deferStartupReplan(
  runStartupTick: () => void | Promise<unknown>,
  schedule: (callback: () => void) => unknown,
): void {
  schedule(() => {
    void runStartupTick()
  })
}
