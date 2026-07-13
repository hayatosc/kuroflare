import { canonicalizeVaultPath } from '@kuroflare/core'

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

/** Builds the vault-scoped IndexedDB name used for the persisted meta Y.Doc. */
export function metaPersistenceDatabaseName(vaultId: string): string {
  return `${META_DOC_NAME}:${vaultId}`
}

/** Marks one target path as being renamed by remote meta materialization. */
export function markPendingFsRename(pending: Set<string>, path: string): string {
  const target = canonicalizeVaultPath(path)
  pending.add(target)
  return target
}

/** Clears one remote materialization rename guard after the operation settles. */
export function clearPendingFsRename(pending: Set<string>, path: string): void {
  pending.delete(canonicalizeVaultPath(path))
}

/** Consumes one rename guard from a vault watcher event. */
export function consumePendingFsRename(pending: Set<string>, path: string): boolean {
  const target = canonicalizeVaultPath(path)
  return pending.delete(target)
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
