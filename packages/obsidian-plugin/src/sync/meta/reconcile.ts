import {
  applyMetaRepair,
  decodeMetaValue,
  planDeleteVsEditRepairs,
  planPathConflictRepairs,
  planPortablePathRepairs,
  type DeviceId,
  type FileId,
  type MetaFile,
  type MetaRepair,
  type TextDeletionEvidence,
} from '@kuroflare/core'
import type * as Y from 'yjs'

import { insertMetaFile, readMetaFile, updateMetaFile } from '../../host/meta'

const NO_RESTORABLE_BINARIES: ReadonlySet<FileId> = new Set()

/** Options for one deterministic meta YDoc reconciliation pass. */
export interface MetaReconcileOptions {
  /** Logical repair timestamp written into repaired entries. */
  readonly updatedAt: number
  /** Synthetic repair actor (e.g. `makeDeviceId('repair')`) written into repaired entries. */
  readonly updatedBy: DeviceId
  /** Binary file IDs whose manifest + chunks are verified present, hence restorable. */
  readonly restorableBinaryFileIds?: ReadonlySet<FileId>
  /** Current loaded text YDoc evidence keyed by file ID. */
  readonly textDeletionEvidence?: ReadonlyMap<FileId, TextDeletionEvidence>
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
  for (const [fileId] of metaMap.entries()) {
    const decoded = decodeMetaValue(metaMap.get(fileId), fileId)
    if (decoded.metaFile !== undefined) entries.push(decoded.metaFile)
    else if (decoded.disposition === 'invalid') invalidFileIds.push(fileId)
  }

  // Sanitize portable-path violations first, then re-run path-conflict planning over the
  // sanitized paths so any collision it introduces converges through the existing mechanism.
  const portableRepairs = planPortablePathRepairs(entries, options.updatedAt, options.updatedBy)
  const sanitizedEntries = withPortablePathRepairs(entries, portableRepairs)

  const repairs: readonly MetaRepair[] = [
    ...portableRepairs,
    ...planPathConflictRepairs(sanitizedEntries, options.updatedAt, options.updatedBy),
    ...planDeleteVsEditRepairs(
      sanitizedEntries,
      options.restorableBinaryFileIds ?? NO_RESTORABLE_BINARIES,
      options.updatedAt,
      options.updatedBy,
      options.textDeletionEvidence,
    ),
  ]

  // keep-deleted plans change no entry; they only drive repair-log/user notification.
  const mutations = repairs.filter((repair) => !isNonMutatingRepair(repair))
  if (mutations.length > 0) {
    const apply = (): void => {
      for (const repair of mutations) {
        const current = readMetaFile(metaMap, repair.fileId)
        if (current === undefined) {
          continue
        }
        const repaired = applyMetaRepair(current, repair)
        if (repaired !== current) {
          if (!updateMetaFile(metaMap, repaired)) {
            insertMetaFile(metaMap, current)
            updateMetaFile(metaMap, repaired)
          }
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

function isNonMutatingRepair(repair: MetaRepair): boolean {
  return (
    'action' in repair && (repair.action === 'keep-deleted' || repair.action === 'defer-deletion')
  )
}

/** Applies planned portable-path repairs to a plain entry list for downstream planning. */
function withPortablePathRepairs(
  entries: readonly MetaFile[],
  repairs: readonly MetaRepair[],
): readonly MetaFile[] {
  if (repairs.length === 0) {
    return entries
  }
  const byFileId = new Map(repairs.map((repair) => [repair.fileId, repair]))
  return entries.map((entry) => {
    const repair = byFileId.get(entry.fileId)
    return repair === undefined ? entry : applyMetaRepair(entry, repair)
  })
}
