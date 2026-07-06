/** Record of the most recent in-memory document state written to disk. */
export interface LastMaterializedRecord {
  readonly ydocHash: string
  readonly diskHash: string
  readonly path: string
  readonly writtenAt: number
  readonly writeId?: string
  /**
   * `TFile.stat.mtime` observed at the time this record was written. Used by
   * {@link decideWatcherStatPrefilter} to skip hash computation for watcher
   * events that carry no actual filesystem change.
   */
  readonly diskMtimeMs?: number
  /** `TFile.stat.size` observed at the time this record was written. */
  readonly diskSize?: number
}

/** Decision for a filesystem watcher event on a materialized file. */
export type WatcherHashGateDecision =
  | { readonly action: 'ignore-own-write' }
  | { readonly action: 'ignore-converged-write' }
  | { readonly action: 'import-external-edit' }

/** Input for deciding whether a watcher event should be imported into YText. */
export interface WatcherHashGateInput {
  readonly currentDiskHash: string
  readonly currentYDocHash: string
  readonly lastMaterialized: LastMaterializedRecord | undefined
}

/** Decision for an attempted YDoc-to-disk materialize write. */
export type MaterializeWriteDecision =
  | { readonly action: 'skip-active-editor' }
  | { readonly action: 'write' }
  | {
      readonly action: 'block-conflict'
      readonly reason: 'missing-last-materialized' | 'disk-hash-changed'
    }

/** Input for the final compare-and-swap gate before writing to disk. */
export interface MaterializeWriteInput {
  /** Vault-relative path of the file this materialize write targets. */
  readonly path: string
  /**
   * Vault-relative path of the file currently bound to the active editor, or
   * `undefined` if no file is bound. Callers must report their live binding
   * state here instead of pre-computing a boolean, so the active-editor guard
   * cannot be bypassed by passing a stale or hardcoded value.
   */
  readonly activeFilePath: string | undefined
  readonly currentDiskHash: string
  readonly lastMaterialized: LastMaterializedRecord | undefined
}

/** Build a last-materialized record without assigning absent optional fields. */
export function makeLastMaterializedRecord(input: LastMaterializedRecord): LastMaterializedRecord {
  return {
    ydocHash: input.ydocHash,
    diskHash: input.diskHash,
    path: input.path,
    writtenAt: input.writtenAt,
    ...(input.writeId === undefined ? {} : { writeId: input.writeId }),
    ...(input.diskMtimeMs === undefined ? {} : { diskMtimeMs: input.diskMtimeMs }),
    ...(input.diskSize === undefined ? {} : { diskSize: input.diskSize }),
  }
}

/**
 * Classify a watcher event using canonical content hashes.
 *
 * Own writes and already-converged disk states are ignored; anything else is an
 * external disk edit that must be imported into the YDoc instead of overwritten.
 */
export function decideWatcherHashGate(input: WatcherHashGateInput): WatcherHashGateDecision {
  if (input.lastMaterialized && input.currentDiskHash === input.lastMaterialized.diskHash) {
    return { action: 'ignore-own-write' }
  }

  if (input.currentDiskHash === input.currentYDocHash) {
    return { action: 'ignore-converged-write' }
  }

  return { action: 'import-external-edit' }
}

/**
 * Decides whether the in-memory document state can be written to disk.
 *
 * The write is permitted only if the current file content on disk matches the
 * last recorded write. This prevents overwriting unexpected local edits.
 * Additionally, files open in the active editor are skipped to avoid conflict
 * with in-progress edits.
 */
export function decideMaterializeWrite(input: MaterializeWriteInput): MaterializeWriteDecision {
  if (input.activeFilePath === input.path) {
    return { action: 'skip-active-editor' }
  }

  if (!input.lastMaterialized) {
    return { action: 'block-conflict', reason: 'missing-last-materialized' }
  }

  if (input.currentDiskHash !== input.lastMaterialized.diskHash) {
    return { action: 'block-conflict', reason: 'disk-hash-changed' }
  }

  return { action: 'write' }
}

/** Decision for whether a background watcher event needs a content-hash check. */
export type WatcherStatPrefilterDecision =
  | { readonly action: 'skip-unchanged-stat' }
  | { readonly action: 'check-hash' }

/** Input for deciding whether a watcher event's stat alone rules out a change. */
export interface WatcherStatPrefilterInput {
  readonly currentMtimeMs: number
  readonly currentSize: number
  readonly lastMaterialized: LastMaterializedRecord | undefined
}

/**
 * Decides whether a file change event requires a full content hash check,
 * or if it can be skipped using file size and modification time (mtime).
 *
 * Using metadata helps avoid reading and hashing the entire file unnecessarily.
 * If size and mtime match the last recorded baseline, the file content is
 * assumed unchanged. Any mismatch triggers a full hash validation.
 */
export function decideWatcherStatPrefilter(
  input: WatcherStatPrefilterInput,
): WatcherStatPrefilterDecision {
  const last = input.lastMaterialized
  if (
    last?.diskMtimeMs !== undefined &&
    last.diskSize !== undefined &&
    last.diskMtimeMs === input.currentMtimeMs &&
    last.diskSize === input.currentSize
  ) {
    return { action: 'skip-unchanged-stat' }
  }
  return { action: 'check-hash' }
}
