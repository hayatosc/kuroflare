import {
  applyMetaRepair,
  planDeleteVsEditRepairs,
  planPathConflictRepairs,
  type MetaRepair,
} from '@kuroflare/core'
import { isMetaFile, type DeviceId, type FileId, type MetaFile } from '@kuroflare/core'
import type * as Y from 'yjs'

const NO_RESTORABLE_BINARIES: ReadonlySet<FileId> = new Set()

/** Options for one deterministic meta YDoc reconciliation pass. */
export interface MetaReconcileOptions {
  /** Logical repair timestamp written into repaired entries. */
  readonly updatedAt: number
  /** Synthetic repair actor (e.g. `makeDeviceId('repair')`) written into repaired entries. */
  readonly updatedBy: DeviceId
  /** Binary file IDs whose manifest + chunks are verified present, hence restorable. */
  readonly restorableBinaryFileIds?: ReadonlySet<FileId>
  /** Yjs transaction origin so observers can tag repair-originated updates. */
  readonly origin?: unknown
}

/** Outcome of one reconciliation pass over a meta YDoc map. */
export interface MetaReconcileResult {
  /** Every planned repair, including `keep-deleted` plans the caller surfaces as repair-log events. */
  readonly repairs: readonly MetaRepair[]
  /** YMap keys whose value failed the meta schema guard; quarantine candidates, left untouched. */
  readonly invalidFileIds: readonly string[]
}

/**
 * Applies the deterministic path-conflict and delete-vs-edit repairs to a live meta YDoc map.
 *
 * The decision (who wins, where losers move, what is restored) is the pure core planner; this is
 * the runtime bridge that reads the real `Y.Map`, runs the planners, and writes the results back in
 * a single Yjs transaction. Because the planners are deterministic, every client that runs this with
 * the same `updatedAt`/`updatedBy` converges to identical entry contents (see the convergence test).
 *
 * @param metaMap Live meta YDoc map keyed by file ID.
 * @param options Repair actor/timestamp, restorable binaries, and transaction origin.
 * @returns Planned repairs (for repair-log + rename materialization) and invalid keys.
 */
export function reconcileMetaDoc(
  metaMap: Y.Map<unknown>,
  options: MetaReconcileOptions,
): MetaReconcileResult {
  const entries: MetaFile[] = []
  const invalidFileIds: string[] = []
  for (const [fileId, value] of metaMap.entries()) {
    if (isMetaFile(value, fileId)) {
      entries.push(value)
    } else {
      invalidFileIds.push(fileId)
    }
  }

  const repairs: readonly MetaRepair[] = [
    ...planPathConflictRepairs(entries, options.updatedAt, options.updatedBy),
    ...planDeleteVsEditRepairs(
      entries,
      options.restorableBinaryFileIds ?? NO_RESTORABLE_BINARIES,
      options.updatedAt,
      options.updatedBy,
    ),
  ]

  // keep-deleted plans change no entry; they only drive repair-log/user notification.
  const mutations = repairs.filter((repair) => !isKeepDeleted(repair))
  if (mutations.length > 0) {
    const apply = (): void => {
      for (const repair of mutations) {
        const current = metaMap.get(repair.fileId)
        if (!isMetaFile(current, repair.fileId)) {
          continue
        }
        const repaired = applyMetaRepair(current, repair)
        if (repaired !== current) {
          metaMap.set(repair.fileId, repaired)
        }
      }
    }
    const doc = metaMap.doc
    if (doc) {
      doc.transact(apply, options.origin)
    } else {
      apply()
    }
  }

  return { repairs, invalidFileIds }
}

function isKeepDeleted(repair: MetaRepair): boolean {
  return 'action' in repair && repair.action === 'keep-deleted'
}
