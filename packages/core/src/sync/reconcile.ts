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
  | {
      readonly action: 'defer-deletion'
      readonly fileId: FileId
      readonly type: 'text' | 'binary'
      readonly reason:
        | 'legacy-deletion-tombstone'
        | 'deletion-evidence-unavailable'
        | 'deletion-base-not-dominated'
        | 'invalid-deletion-evidence'
      readonly updatedAt: number
      readonly updatedBy: DeviceId
    }

export type MetaRepair = PathConflictRepair | DeleteVsEditRepair

/** Current text YDoc evidence used to evaluate one deletion-base witness. */
export interface TextDeletionEvidence {
  readonly stateVectorBase64: string
  readonly contentSha256: string
}

/**
 * Plans renames for active files that share the same folder path, resolving conflicts deterministically.
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
 * Plans how to resolve situations where a file is edited on one device after being deleted on another.
 */
export function planDeleteVsEditRepairs(
  entries: readonly MetaFile[],
  restorableBinaryFileIds: ReadonlySet<FileId>,
  updatedAt: number,
  updatedBy: DeviceId,
  textDeletionEvidence: ReadonlyMap<FileId, TextDeletionEvidence> = new Map(),
): readonly DeleteVsEditRepair[] {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error(`Invalid repair timestamp: ${updatedAt}`)
  }

  const repairs: DeleteVsEditRepair[] = []
  for (const entry of entries) {
    if (!entry.deleted) {
      continue
    }

    if (entry.type === 'text') {
      const decision = decideTextDeletion(entry, textDeletionEvidence.get(entry.fileId))
      if (decision === 'keep-deleted') continue
      if (decision !== 'restore') {
        repairs.push({
          action: 'defer-deletion',
          fileId: entry.fileId,
          type: 'text',
          reason: decision,
          updatedAt,
          updatedBy,
        })
        continue
      }
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

    const decision = decideBinaryDeletion(entry, restorableBinaryFileIds)
    if (decision === 'keep-deleted') continue
    if (decision === 'missing-binary-content') {
      repairs.push({
        action: 'keep-deleted',
        fileId: entry.fileId,
        type: 'binary',
        reason: 'missing-binary-content',
        updatedAt,
        updatedBy,
      })
      continue
    }
    if (decision !== 'restore') {
      repairs.push({
        action: 'defer-deletion',
        fileId: entry.fileId,
        type: 'binary',
        reason: decision,
        updatedAt,
        updatedBy,
      })
      continue
    }

    repairs.push({
      action: 'restore',
      fileId: entry.fileId,
      type: 'binary',
      reason: 'concurrent-edit-after-delete',
      updatedAt,
      updatedBy,
    })
  }

  return repairs
}

/**
 * Applies a repair plan to a metadata entry, returning a new updated entry.
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

  if (repair.action === 'keep-deleted' || repair.action === 'defer-deletion') {
    return entry
  }

  if (!entry.deleted) {
    return {
      ...entry,
      updatedAt: repair.updatedAt,
      updatedBy: repair.updatedBy,
    }
  }

  const {
    deletedAt: _deletedAt,
    deletedBy: _deletedBy,
    deletedContentVersion: _deletedContentVersion,
    ...restored
  } = entry
  return {
    ...restored,
    deleted: false,
    updatedAt: repair.updatedAt,
    updatedBy: repair.updatedBy,
  }
}

function decideTextDeletion(
  entry: Extract<MetaFile, { type: 'text'; deleted: true }>,
  evidence: TextDeletionEvidence | undefined,
):
  | 'keep-deleted'
  | 'restore'
  | 'legacy-deletion-tombstone'
  | 'deletion-evidence-unavailable'
  | 'deletion-base-not-dominated'
  | 'invalid-deletion-evidence' {
  const deletedContentVersion = entry.deletedContentVersion
  if (deletedContentVersion === undefined) return 'legacy-deletion-tombstone'
  if (deletedContentVersion.kind !== 'text') return 'invalid-deletion-evidence'
  if (evidence === undefined) return 'deletion-evidence-unavailable'
  if (!isTextEvidence(evidence)) return 'invalid-deletion-evidence'

  const baseStateVector = decodeStateVectorBase64(deletedContentVersion.stateVectorBase64)
  const currentStateVector = decodeStateVectorBase64(evidence.stateVectorBase64)
  if (baseStateVector === undefined || currentStateVector === undefined) {
    return 'invalid-deletion-evidence'
  }
  if (!stateVectorDominates(currentStateVector, baseStateVector)) {
    return 'deletion-base-not-dominated'
  }
  return evidence.contentSha256 === deletedContentVersion.contentSha256 ? 'keep-deleted' : 'restore'
}

function decideBinaryDeletion(
  entry: Extract<MetaFile, { type: 'binary'; deleted: true }>,
  restorableBinaryFileIds: ReadonlySet<FileId>,
):
  | 'keep-deleted'
  | 'restore'
  | 'legacy-deletion-tombstone'
  | 'invalid-deletion-evidence'
  | 'missing-binary-content' {
  const deletedContentVersion = entry.deletedContentVersion
  if (deletedContentVersion === undefined) return 'legacy-deletion-tombstone'
  if (deletedContentVersion.kind !== 'binary') return 'invalid-deletion-evidence'
  if (entry.blobManifestHash === deletedContentVersion.blobManifestHash) return 'keep-deleted'
  return restorableBinaryFileIds.has(entry.fileId) ? 'restore' : 'missing-binary-content'
}

function isTextEvidence(value: TextDeletionEvidence): boolean {
  return (
    typeof value.stateVectorBase64 === 'string' &&
    typeof value.contentSha256 === 'string' &&
    vIsSha256(value.contentSha256)
  )
}

function vIsSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function decodeStateVectorBase64(value: string): ReadonlyMap<number, number> | undefined {
  const bytes = decodeBase64(value)
  if (bytes === undefined) return undefined
  let offset = 0
  const count = readVarUint(bytes, () => offset++)
  if (count === undefined || count > 1_000_000) return undefined
  const result = new Map<number, number>()
  for (let index = 0; index < count; index += 1) {
    const clientId = readVarUint(bytes, () => offset++)
    const clock = readVarUint(bytes, () => offset++)
    if (clientId === undefined || clock === undefined || result.has(clientId)) return undefined
    result.set(clientId, clock)
  }
  return offset === bytes.length ? result : undefined
}

function stateVectorDominates(
  current: ReadonlyMap<number, number>,
  base: ReadonlyMap<number, number>,
): boolean {
  for (const [clientId, clock] of base) {
    if ((current.get(clientId) ?? 0) < clock) return false
  }
  return true
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const output = new Uint8Array((value.length / 4) * 3 - padding)
  let outputOffset = 0
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Char(value[index])
    const b = base64Char(value[index + 1])
    const c = value[index + 2] === '=' ? 0 : base64Char(value[index + 2])
    const d = value[index + 3] === '=' ? 0 : base64Char(value[index + 3])
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      return undefined
    }
    if (
      index === value.length - 4 &&
      ((padding === 2 && (b & 0x0f) !== 0) || (padding === 1 && (c & 0x03) !== 0))
    ) {
      return undefined
    }
    const bits = (a << 18) | (b << 12) | (c << 6) | d
    if (outputOffset < output.length) output[outputOffset++] = (bits >>> 16) & 0xff
    if (outputOffset < output.length) output[outputOffset++] = (bits >>> 8) & 0xff
    if (outputOffset < output.length) output[outputOffset++] = bits & 0xff
  }
  return output
}

function base64Char(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const index = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(value)
  return index === -1 ? undefined : index
}

function readVarUint(bytes: Uint8Array, advance: () => number): number | undefined {
  let value = 0
  let shift = 0
  for (let index = 0; index < 10; index += 1) {
    const byteIndex = advance()
    const byte = bytes[byteIndex]
    if (byte === undefined) return undefined
    value += (byte & 0x7f) * 2 ** shift
    if (value > Number.MAX_SAFE_INTEGER) return undefined
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
  return undefined
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
