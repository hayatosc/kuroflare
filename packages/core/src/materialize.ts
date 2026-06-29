/** Hash record for the most recent successful YDoc-to-disk materialization. */
export interface LastMaterializedRecord {
  readonly ydocHash: string
  readonly diskHash: string
  readonly path: string
  readonly writtenAt: number
  readonly writeId?: string
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
  readonly activeEditorBound: boolean
  readonly currentDiskHash: string
  readonly lastMaterialized: LastMaterializedRecord | undefined
}

/** Build a last-materialized record without assigning absent optional fields. */
export function makeLastMaterializedRecord(input: LastMaterializedRecord): LastMaterializedRecord {
  return input.writeId === undefined
    ? {
        ydocHash: input.ydocHash,
        diskHash: input.diskHash,
        path: input.path,
        writtenAt: input.writtenAt,
      }
    : { ...input }
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
 */
export function decideMaterializeWrite(input: MaterializeWriteInput): MaterializeWriteDecision {
  if (input.activeEditorBound) {
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
