import {
  DocIdSchema,
  Sha256HexSchema,
  VaultIdSchema,
  type DocId,
  type VaultId,
  type YDocId,
} from '@kuroflare/core'
import * as v from 'valibot'

/** R2 prefix category for a document snapshot. */
export type SnapshotDocPrefix = 'meta' | `files/${YDocId}`

/** Per-document entry inside the vault-wide snapshot manifest. */
export const DocSnapshotManifestEntrySchema = v.object({
  docId: DocIdSchema,
  snapshotSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  snapshotKey: v.pipe(v.string(), v.minLength(1)),
  updateSha256: Sha256HexSchema,
  stateVectorSha256: Sha256HexSchema,
})
export type DocSnapshotManifestEntry = v.InferInput<typeof DocSnapshotManifestEntrySchema>

/** Vault-wide manifest that points at a consistent set of document snapshots. */
export const SnapshotManifestSchema = v.object({
  version: v.literal(1),
  vaultId: VaultIdSchema,
  manifestSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  createdAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  docs: v.array(DocSnapshotManifestEntrySchema),
})
export type SnapshotManifest = v.InferInput<typeof SnapshotManifestSchema>

/** Snapshot candidate discovered from a pointer object or R2 prefix listing. */
export interface SnapshotCandidate {
  readonly key: string
  readonly upperSeq: number
  readonly healthy: boolean
}

/** Snapshot choice to restore, including whether the pointer was trusted. */
export interface SnapshotRestoreChoice {
  readonly key: string
  readonly upperSeq: number
  readonly source: 'pointer' | 'fallback-list'
}

/** Returns the R2 object key for an immutable document snapshot. */
export function makeSnapshotObjectKey(vaultId: VaultId, docId: DocId, seq: number): string {
  assertPositiveSafeInteger(seq, 'seq')
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  return `${prefix}${seq}.yupdate`
}

/** Returns the R2 prefix that contains immutable document snapshots. */
export function makeSnapshotListPrefix(vaultId: VaultId, docId: DocId): string {
  const prefix = snapshotDocPrefix(docId)
  return `snapshots/${vaultId}/${prefix}/`
}

/** Returns the R2 object key for a per-document pointer. */
export function makeSnapshotPointerKey(vaultId: VaultId, docId: DocId): string {
  const prefix = snapshotDocPrefix(docId)
  return `snapshots/${vaultId}/pointers/${prefix}.json`
}

/** Returns the R2 object key for an immutable vault-wide manifest. */
export function makeManifestKey(vaultId: VaultId, manifestSeq: number): string {
  assertPositiveSafeInteger(manifestSeq, 'manifestSeq')
  return `snapshots/${vaultId}/manifests/${manifestSeq}.json`
}

/** Returns the R2 object key for the mutable latest manifest pointer. */
export function makeLatestManifestKey(vaultId: VaultId): string {
  return `snapshots/${vaultId}/manifests/latest.json`
}

/**
 * Chooses a snapshot for cold-start restore.
 *
 * A healthy pointer is used only when it is at least as new as the newest
 * healthy prefix-listed snapshot. Missing, corrupt, or stale pointers fall back
 * to the newest healthy listed snapshot.
 *
 * @throws If no healthy snapshot candidate exists.
 */
export function chooseSnapshotForRestore(
  pointer: SnapshotCandidate | undefined,
  listedCandidates: readonly SnapshotCandidate[],
): SnapshotRestoreChoice {
  const healthyListed = listedCandidates.filter((candidate) => candidate.healthy)
  const newestListed = maxCandidateBySeq(healthyListed)

  if (pointer?.healthy && pointer.upperSeq >= newestListed.upperSeq) {
    return {
      key: pointer.key,
      upperSeq: pointer.upperSeq,
      source: 'pointer',
    }
  }

  return {
    key: newestListed.key,
    upperSeq: newestListed.upperSeq,
    source: 'fallback-list',
  }
}

function snapshotDocPrefix(docId: DocId): SnapshotDocPrefix {
  return docId.kind === 'meta' ? 'meta' : `files/${docId.ydocId}`
}

function maxCandidateBySeq(candidates: readonly SnapshotCandidate[]): SnapshotCandidate {
  const first = candidates[0]
  if (!first) {
    throw new Error('No healthy snapshot candidate available')
  }

  return candidates.reduce(
    (best, candidate) => (candidate.upperSeq > best.upperSeq ? candidate : best),
    first,
  )
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}
