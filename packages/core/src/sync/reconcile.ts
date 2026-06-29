import { canonicalizeVaultPath, type MetaFile } from '../sync/meta'
import { type DeviceId, type FileId } from '../utils/ids'

export interface PathConflictRepair {
  readonly fileId: FileId
  readonly fromPath: string
  readonly toPath: string
  readonly toCanonicalPath: string
  readonly updatedAt: number
  readonly updatedBy: DeviceId
}

export type DeleteVsEditRepair =
  | {
      readonly action: 'restore'
      readonly fileId: FileId
      readonly type: 'text' | 'binary'
      readonly reason: 'concurrent-edit-after-delete'
      readonly updatedAt: number
      readonly updatedBy: DeviceId
    }
  | {
      readonly action: 'keep-deleted'
      readonly fileId: FileId
      readonly type: 'binary'
      readonly reason: 'missing-binary-content'
      readonly updatedAt: number
      readonly updatedBy: DeviceId
    }

export type MetaRepair = PathConflictRepair | DeleteVsEditRepair

/**
 * Plans deterministic renames for active meta entries that share one canonical path.
 *
 * @param entries - Valid meta entries from the meta YDoc.
 * @param updatedAt - Logical repair timestamp to write into repaired entries.
 * @param updatedBy - Device or synthetic repair actor ID to write into repaired entries.
 * @returns Rename operations for losing entries. The winner keeps its path.
 */
export function planPathConflictRepairs(
  entries: readonly MetaFile[],
  updatedAt: number,
  updatedBy: DeviceId,
): readonly PathConflictRepair[] {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error(`Invalid repair timestamp: ${updatedAt}`)
  }

  const activeEntries = entries.filter((entry) => !entry.deleted)
  const reservedCanonicalPaths = new Set(activeEntries.map((entry) => entry.canonicalPath))
  const groups = groupByCanonicalPath(activeEntries)
  const repairs: PathConflictRepair[] = []

  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue
    }

    const sorted = [...group].sort(compareConflictPriority)
    const winner = sorted[0]
    if (winner === undefined) {
      continue
    }

    for (const loser of sorted.slice(1).sort(compareByFileId)) {
      const toPath = allocateConflictPath(winner.path, loser.fileId, reservedCanonicalPaths)
      const toCanonicalPath = canonicalizeVaultPath(toPath)
      reservedCanonicalPaths.add(toCanonicalPath)
      repairs.push({
        fileId: loser.fileId,
        fromPath: loser.path,
        toPath,
        toCanonicalPath,
        updatedAt,
        updatedBy,
      })
    }
  }

  return repairs
}

/**
 * Plans tombstone repairs when a file was edited after it was deleted.
 *
 * @param entries - Valid meta entries from the meta YDoc.
 * @param restorableBinaryFileIds - Binary file IDs whose manifest and chunks are verified.
 * @param updatedAt - Logical repair timestamp to write into repaired entries.
 * @param updatedBy - Device or synthetic repair actor ID to write into repaired entries.
 * @returns Restore plans for text/complete binary files and keep-deleted plans for incomplete binaries.
 */
export function planDeleteVsEditRepairs(
  entries: readonly MetaFile[],
  restorableBinaryFileIds: ReadonlySet<FileId>,
  updatedAt: number,
  updatedBy: DeviceId,
): readonly DeleteVsEditRepair[] {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error(`Invalid repair timestamp: ${updatedAt}`)
  }

  const repairs: DeleteVsEditRepair[] = []
  for (const entry of entries) {
    if (!hasEditAfterDelete(entry)) {
      continue
    }

    if (entry.type === 'text') {
      repairs.push({
        action: 'restore',
        fileId: entry.fileId,
        type: 'text',
        reason: 'concurrent-edit-after-delete',
        updatedAt,
        updatedBy,
      })
      continue
    }

    if (restorableBinaryFileIds.has(entry.fileId)) {
      repairs.push({
        action: 'restore',
        fileId: entry.fileId,
        type: 'binary',
        reason: 'concurrent-edit-after-delete',
        updatedAt,
        updatedBy,
      })
    } else {
      repairs.push({
        action: 'keep-deleted',
        fileId: entry.fileId,
        type: 'binary',
        reason: 'missing-binary-content',
        updatedAt,
        updatedBy,
      })
    }
  }

  return repairs
}

/**
 * Applies one repair plan to a metadata entry without mutating the input.
 *
 * @param entry - Metadata entry to update.
 * @param repair - Repair plan for the same file ID.
 * @returns Updated metadata entry, or the original entry when the repair does not apply.
 */
export function applyMetaRepair(entry: MetaFile, repair: MetaRepair): MetaFile {
  if (entry.fileId !== repair.fileId) {
    return entry
  }

  if (isPathConflictRepair(repair)) {
    return {
      ...entry,
      path: repair.toPath,
      canonicalPath: repair.toCanonicalPath,
      updatedAt: repair.updatedAt,
      updatedBy: repair.updatedBy,
    }
  }

  if (repair.action === 'keep-deleted') {
    return entry
  }

  if (!entry.deleted) {
    return {
      ...entry,
      updatedAt: repair.updatedAt,
      updatedBy: repair.updatedBy,
    }
  }

  const { deletedAt: _deletedAt, deletedBy: _deletedBy, ...restored } = entry
  return {
    ...restored,
    deleted: false,
    updatedAt: repair.updatedAt,
    updatedBy: repair.updatedBy,
  }
}

function hasEditAfterDelete(entry: MetaFile): boolean {
  return (
    entry.deleted &&
    entry.deletedAt !== undefined &&
    entry.contentUpdatedAt > entry.deletedAt &&
    entry.contentUpdatedBy !== entry.deletedBy
  )
}

function isPathConflictRepair(repair: MetaRepair): repair is PathConflictRepair {
  return 'toPath' in repair
}

function groupByCanonicalPath(entries: readonly MetaFile[]): Map<string, MetaFile[]> {
  const groups = new Map<string, MetaFile[]>()
  for (const entry of entries) {
    const group = groups.get(entry.canonicalPath)
    if (group) {
      group.push(entry)
    } else {
      groups.set(entry.canonicalPath, [entry])
    }
  }
  return groups
}

function compareConflictPriority(left: MetaFile, right: MetaFile): number {
  const createdAtDelta = left.createdAt - right.createdAt
  return createdAtDelta === 0 ? compareFileId(left.fileId, right.fileId) : createdAtDelta
}

function compareByFileId(left: MetaFile, right: MetaFile): number {
  return compareFileId(left.fileId, right.fileId)
}

function compareFileId(left: FileId, right: FileId): number {
  return compareCodeUnitString(left, right)
}

function compareCodeUnitString(left: string, right: string): number {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

function allocateConflictPath(
  winnerPath: string,
  loserFileId: FileId,
  reservedCanonicalPaths: ReadonlySet<string>,
): string {
  const { dirname, basename, extension } = splitPath(winnerPath)
  const shortFileId = loserFileId.slice(0, 8)
  let attempt = 1

  while (true) {
    const suffix =
      attempt === 1 ? ` (conflict ${shortFileId})` : ` (conflict ${shortFileId}-${attempt})`
    const candidate = joinPath(dirname, `${basename}${suffix}${extension}`)
    if (!reservedCanonicalPaths.has(canonicalizeVaultPath(candidate))) {
      return candidate
    }
    attempt += 1
  }
}

function splitPath(path: string): {
  readonly dirname: string
  readonly basename: string
  readonly extension: string
} {
  const slashIndex = path.lastIndexOf('/')
  const dirname = slashIndex === -1 ? '' : path.slice(0, slashIndex)
  const filename = slashIndex === -1 ? path : path.slice(slashIndex + 1)
  const dotIndex = filename.lastIndexOf('.')

  if (dotIndex <= 0) {
    return { dirname, basename: filename, extension: '' }
  }

  return {
    dirname,
    basename: filename.slice(0, dotIndex),
    extension: filename.slice(dotIndex),
  }
}

function joinPath(dirname: string, filename: string): string {
  return dirname.length === 0 ? filename : `${dirname}/${filename}`
}
