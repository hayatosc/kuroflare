/** Hash record for the most recent successful YDoc-to-disk materialization. */
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
 * Decide whether a materializer may write the current YDoc state to disk.
 *
 * The write is allowed only when the disk hash still matches the last
 * materialized base. Missing base information is treated as unsafe because the
 * materializer cannot distinguish a fresh write from an unobserved disk edit.
 * A file currently bound to the active editor is never written directly because
 * doing so can race live editor updates and overwrite in-memory edits.
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
 * Decide whether a filesystem watcher event needs a full canonical-text hash
 * comparison, or can be skipped using mtime/size alone.
 *
 * Hashing requires reading the whole file, which is too costly to do for
 * every watcher event across a large vault (e.g. a `git pull` touching
 * thousands of files). `TFile.stat` mtime/size come for free with the event,
 * so a file whose mtime and size both still match the last observed
 * materialize/import baseline cannot have changed and is skipped without
 * hashing. Any mismatch, or a missing baseline (file never observed before),
 * falls through to the real hash gate.
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
