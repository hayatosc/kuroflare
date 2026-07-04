import type { FileId } from '../utils/ids'

/** Decision for reconciling one local file discovered during a vault join. */
export type JoinFileAdoptionDecision =
  | { readonly action: 'allocate-new' }
  | { readonly action: 'adopt-matching-content'; readonly fileId: FileId }
  | { readonly action: 'adopt-with-local-edit'; readonly fileId: FileId }

/** A remote meta entry matched by path, with its resolved canonical text content hash. */
export interface JoinRemoteTextEntry {
  readonly fileId: FileId
  readonly contentHash: string
}

/** Input for deciding how a local file should be reconciled against remote join meta. */
export interface JoinFileAdoptionInput {
  /** Remote meta entry at the same vault path, or `undefined` if remote has no such path. */
  readonly remoteEntry: JoinRemoteTextEntry | undefined
  readonly localContentHash: string
}

/**
 * Decide how a local markdown file should be reconciled with remote join meta.
 *
 * A local path with no remote counterpart is local-only and gets a freshly
 * allocated `fileId`. A path that also exists remotely must always adopt the
 * remote `fileId`, even when content differs, to avoid creating two file IDs
 * for the same path; content that differs is imported through the ordinary
 * external-edit path afterward instead of being discarded or silently
 * overwritten.
 */
export function decideJoinFileAdoption(input: JoinFileAdoptionInput): JoinFileAdoptionDecision {
  if (input.remoteEntry === undefined) {
    return { action: 'allocate-new' }
  }
  if (input.remoteEntry.contentHash === input.localContentHash) {
    return { action: 'adopt-matching-content', fileId: input.remoteEntry.fileId }
  }
  return { action: 'adopt-with-local-edit', fileId: input.remoteEntry.fileId }
}
