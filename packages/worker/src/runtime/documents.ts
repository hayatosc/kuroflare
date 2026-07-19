import type { DocId } from '@kuroflare/core'
import * as Y from 'yjs'

import {
  getAllLatestSnapshotHealthEvents,
  getLatestSnapshotHealthEvent,
  getSnapshotRetentionCheckpointRuns,
  insertSnapshotHealthEvent,
} from '../db/checkpointRepo'
import type { SnapshotHealthEventRow } from '../db/checkpointRepo'
import { getOpLogUpdatesBetween, getOpLogUpdatesSince } from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import {
  verifySnapshotObject,
  SNAPSHOT_HEALTH_SYSTEM_ACTORS,
  type SnapshotVerificationExpectedEvidence,
} from '../sync/snapshot-health'
import { makeSnapshotListPrefix, type SnapshotCandidate } from '../sync/snapshots'
import { MAX_HYDRATED_FILE_DOCS } from './constants'
import type { VaultRoom } from './room'
import { getDb, readSnapshotPointer, readSyncRequestDocState, withSqlTransaction } from './storage'
import type { R2BucketBinding, R2ObjectBinding } from './types'
import { docKey, logEvent, retentionErrorMessage, snapshotCandidateFromKey } from './utils'

/** Evidence needed to decide whether a hydrated document may leave memory. */
export interface DocEvictionInput {
  /** `true` for the meta doc, which stays resident at all times. */
  readonly isMeta: boolean
  /** `true` once the doc's op_log is fully covered by its latest snapshot. */
  readonly checkpointed: boolean
  /** Number of currently connected sockets that have touched this doc. */
  readonly activeSocketCount: number
  /** Timestamp (ms) the doc was last touched by a client or a checkpoint. */
  readonly lastAccessedAt: number
  /** Current time (ms). */
  readonly now: number
  /** Minimum idle time (ms) required before an eligible doc may evict. */
  readonly idleThresholdMs: number
}

/** Decision for whether a hydrated document may be evicted from memory. */
export type DocEvictionDecision =
  | { readonly action: 'evict' }
  | {
      readonly action: 'keep'
      readonly reason:
        | 'meta-doc'
        | 'not-checkpointed'
        | 'active-sockets'
        | 'recently-accessed'
        | 'invalid-clock'
    }

export function decideDocEviction(input: DocEvictionInput): DocEvictionDecision {
  if (input.isMeta) return { action: 'keep', reason: 'meta-doc' }
  if (!input.checkpointed) return { action: 'keep', reason: 'not-checkpointed' }
  if (input.activeSocketCount > 0) return { action: 'keep', reason: 'active-sockets' }
  if (
    !Number.isSafeInteger(input.lastAccessedAt) ||
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.idleThresholdMs) ||
    input.idleThresholdMs < 0
  ) {
    return { action: 'keep', reason: 'invalid-clock' }
  }
  if (input.now - input.lastAccessedAt < input.idleThresholdMs) {
    return { action: 'keep', reason: 'recently-accessed' }
  }
  return { action: 'evict' }
}

/** Evidence needed to decide whether a doc load may proceed or must wait out memory pressure. */
export interface DocLoadAdmissionInput {
  /** `true` for the meta doc, which is always admitted and never evicted. */
  readonly isMeta: boolean
  /** `true` when the doc is already resident; re-entrant access is never blocked. */
  readonly alreadyHydrated: boolean
  /** Number of non-meta docs currently resident, after the room's eviction pass has run. */
  readonly hydratedFileDocCount: number
  /** Maximum number of non-meta docs a room may keep resident at once. */
  readonly maxHydratedFileDocs: number
}

/** Decision for whether a doc load may proceed. */
export type DocLoadAdmissionDecision =
  | { readonly action: 'admit' }
  | { readonly action: 'degraded' }

export function decideDocLoadAdmission(input: DocLoadAdmissionInput): DocLoadAdmissionDecision {
  if (input.isMeta || input.alreadyHydrated) return { action: 'admit' }
  return input.hydratedFileDocCount < input.maxHydratedFileDocs
    ? { action: 'admit' }
    : { action: 'degraded' }
}

export async function rehydrateAfterApplyFailure(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  const current = room.docs.get(key)
  room.docs.delete(key)
  room.hydratedDocs.delete(key)
  current?.destroy()
  await ensureDocHydrated(room, docId)
}

/** Invalidates stale hydration state and reloads the document from its durable pointer. */
export async function rehydrateAfterDocPointer(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  const inFlight = room.hydrationInFlight.get(key)
  if (inFlight !== undefined) {
    try {
      await inFlight
    } catch (error) {
      logEvent('pointer-rehydrate-stale-hydration-failed', {
        docId,
        error: retentionErrorMessage(error),
      })
    }
  }
  const current = room.docs.get(key)
  room.docs.delete(key)
  room.hydratedDocs.delete(key)
  if (inFlight !== undefined && room.hydrationInFlight.get(key) === inFlight) {
    room.hydrationInFlight.delete(key)
  }
  current?.destroy()
  await ensureDocHydrated(room, docId)
}

/** Decides whether a doc load may proceed, given the room's current residency. */
export function admitDocLoad(room: VaultRoom, docId: DocId): DocLoadAdmissionDecision {
  const key = docKey(docId)
  return decideDocLoadAdmission({
    isMeta: docId.kind === 'meta',
    alreadyHydrated: room.hydratedDocs.has(key),
    hydratedFileDocCount: [...room.hydratedDocs].filter((hydratedKey) => hydratedKey !== 'meta')
      .length,
    maxHydratedFileDocs: MAX_HYDRATED_FILE_DOCS,
  })
}

export async function ensureDocHydrated(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  room.docLastAccessedAt.set(key, Date.now())
  if (room.hydratedDocs.has(key)) return

  const existing = room.hydrationInFlight.get(key)
  if (existing !== undefined) return existing

  const attempt = hydrateDoc(room, docId, key).finally(() => {
    room.hydrationInFlight.delete(key)
  })
  room.hydrationInFlight.set(key, attempt)
  return attempt
}

async function hydrateDoc(room: VaultRoom, docId: DocId, key: string): Promise<void> {
  const db = getDb(room)
  if (db === undefined) throw new Error('sql-unavailable')

  const persisted = await readSyncRequestDocState(room, docId)
  const pointer = await readSnapshotPointer(room, docId)
  const snapshot = await chooseSnapshot(room, docId, persisted, pointer)
  const doc = new Y.Doc()
  let installed = false
  try {
    if (snapshot !== undefined) {
      const snapshotKey = snapshot.latestSnapshotKey
      const bucket = room.env.SNAPSHOT_BUCKET
      if (bucket === undefined) throw new Error('snapshot-bucket-unavailable')
      const snapshotObject = await bucket.get(snapshotKey)
      if (snapshotObject === null) throw new Error('snapshot-missing')
      Y.applyUpdate(doc, new Uint8Array(await snapshotObject.arrayBuffer()))
    }

    const minSeq = snapshot?.latestSnapshotSeq ?? 0
    if (
      snapshot === undefined &&
      persisted !== undefined &&
      persisted.minRetainedSeq > 0 &&
      persisted.latestSeq > 0
    ) {
      throw new Error('snapshot-health:no-verified-generation')
    }
    const updates =
      persisted === undefined
        ? await getOpLogUpdatesSince(db, key, minSeq)
        : await getOpLogUpdatesBetween(db, key, minSeq, persisted.latestSeq)
    let expectedSeq = minSeq + 1
    for (const row of updates) {
      if (row.seq !== expectedSeq) {
        throw new Error('op_log sequence gap')
      }
      const updateBytes = readSqlUpdateBytes(row.updateBytes)
      if (updateBytes === undefined) {
        throw new Error('invalid op_log update_bytes')
      }
      Y.applyUpdate(doc, updateBytes)
      expectedSeq += 1
    }
    if (persisted !== undefined && expectedSeq !== persisted.latestSeq + 1) {
      throw new Error('op_log sequence gap')
    }
    if (persisted === undefined && expectedSeq !== 1) {
      throw new Error('snapshot-health:no-verified-generation')
    }
    room.docs.set(key, doc)
    room.hydratedDocs.add(key)
    installed = true
    logEvent('doc-restore-source', {
      vaultId: room.vaultId,
      docId,
      source:
        snapshot !== undefined
          ? 'r2-snapshot'
          : persisted !== undefined
            ? 'op-log-replay'
            : 'empty',
    })
  } finally {
    if (!installed) doc.destroy()
  }
}

async function chooseSnapshot(
  room: VaultRoom,
  docId: DocId,
  persisted: Awaited<ReturnType<typeof readSyncRequestDocState>>,
  pointer: Awaited<ReturnType<typeof readSnapshotPointer>>,
): Promise<{ readonly latestSnapshotKey: string; readonly latestSnapshotSeq: number } | undefined> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (db === undefined || bucket === undefined || vaultId === undefined) return undefined
  const listed = await listSnapshotCandidates(room, docId)
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  if (persisted === undefined && listed.length > 0) {
    throw new Error('snapshot-health:no-verified-generation')
  }
  const durableAuthorities = new Set<string>()
  if (persisted !== undefined) {
    for (const row of await getAllLatestSnapshotHealthEvents(db, docKey(docId))) {
      const candidate = snapshotCandidateFromKey(prefix, row.snapshotKey)
      if (
        candidate !== undefined &&
        candidate.upperSeq === row.upperSeq &&
        row.authorityStatus === 'authoritative' &&
        candidate.upperSeq >= persisted.minRetainedSeq &&
        candidate.upperSeq <= persisted.latestSeq
      ) {
        durableAuthorities.add(candidate.key)
      }
    }
  }
  const pointerCandidate =
    pointer === undefined ? undefined : snapshotCandidateFromKey(prefix, pointer.latestSnapshotKey)
  if (
    pointerCandidate !== undefined &&
    pointer !== undefined &&
    pointerCandidate.upperSeq === pointer.latestSnapshotSeq &&
    (persisted === undefined ||
      (pointerCandidate.upperSeq >= persisted.minRetainedSeq &&
        pointerCandidate.upperSeq <= persisted.latestSeq))
  ) {
    durableAuthorities.add(pointerCandidate.key)
  }
  if (persisted !== undefined) {
    for (const run of await getSnapshotRetentionCheckpointRuns(db, docKey(docId))) {
      if (
        run.status !== 'pointer-updated' &&
        run.status !== 'compacted' &&
        run.status !== 'completed'
      ) {
        continue
      }
      if (run.snapshotKey === null) continue
      const runCandidate = snapshotCandidateFromKey(prefix, run.snapshotKey)
      if (runCandidate === undefined || runCandidate.upperSeq !== run.upperSeq) continue
      if (
        runCandidate.upperSeq < persisted.minRetainedSeq ||
        runCandidate.upperSeq > persisted.latestSeq
      )
        continue
      durableAuthorities.add(runCandidate.key)
    }
  }
  const candidates = [...(pointerCandidate === undefined ? [] : [pointerCandidate]), ...listed]
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [candidate.key, candidate])).values(),
  ].sort((left, right) => right.upperSeq - left.upperSeq)

  for (const candidate of uniqueCandidates) {
    if (!durableAuthorities.has(candidate.key)) continue
    const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
    const expected = findExpectedEvidence(latest)
    const verification = await verifySnapshotObject(bucket, candidate.key, docId, expected)
    const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      expected,
    )
    const latestAfterRecord = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
    if (
      verification.status === 'verified' &&
      logicalStatus !== 'quarantined' &&
      latestAfterRecord?.logicalStatus !== 'quarantined' &&
      (durableAuthorities.has(candidate.key) ||
        latestAfterRecord?.authorityStatus === 'authoritative')
    ) {
      return { latestSnapshotKey: candidate.key, latestSnapshotSeq: candidate.upperSeq }
    }
  }
  return undefined
}

/** Appends a physical verification while preserving a concurrent logical verdict. */
export async function appendSnapshotVerificationEventPreservingLogical(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  candidate: SnapshotCandidate,
  verification: Awaited<ReturnType<typeof verifySnapshotObject>>,
  expected: SnapshotVerificationExpectedEvidence | undefined,
  authorityStatus?: 'candidate' | 'authoritative',
): Promise<'healthy' | 'quarantined'> {
  let logicalStatus: 'healthy' | 'quarantined' = 'healthy'
  await withSqlTransaction(room, async () => {
    const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
    logicalStatus = latest?.logicalStatus === 'quarantined' ? 'quarantined' : 'healthy'
    const effectiveAuthorityStatus =
      authorityStatus ??
      (latest?.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate')
    const preservedReasons = latest === undefined ? [] : parseSnapshotHealthReasons(latest.reasons)
    const expectedByteLength = expected?.byteLength ?? latest?.expectedByteLength ?? null
    const expectedUpdateSha256 = expected?.updateSha256 ?? latest?.expectedUpdateSha256 ?? null
    const expectedStateVectorSha256 =
      expected?.stateVectorSha256 ?? latest?.expectedStateVectorSha256 ?? null
    const actualUpdateSha256 = verification.actualUpdateSha256 || null
    const actualStateVectorSha256 = verification.actualStateVectorSha256 ?? null
    const nextReasons = [...new Set([...preservedReasons, ...verification.reasons])]
    if (
      latest !== undefined &&
      latest.authorityStatus === effectiveAuthorityStatus &&
      latest.expectedByteLength === expectedByteLength &&
      latest.expectedUpdateSha256 === expectedUpdateSha256 &&
      latest.expectedStateVectorSha256 === expectedStateVectorSha256 &&
      latest.actualByteLength === verification.actualByteLength &&
      latest.actualUpdateSha256 === actualUpdateSha256 &&
      latest.actualStateVectorSha256 === actualStateVectorSha256 &&
      latest.physicalStatus === verification.status &&
      latest.logicalStatus === logicalStatus &&
      JSON.stringify(parseSnapshotHealthReasons(latest.reasons)) === JSON.stringify(nextReasons)
    ) {
      return
    }
    await insertSnapshotHealthEvent(db, {
      docId: docKey(docId),
      snapshotKey: candidate.key,
      upperSeq: candidate.upperSeq,
      event: 'verification',
      actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
      authorityStatus: effectiveAuthorityStatus,
      expectedByteLength,
      expectedUpdateSha256,
      expectedStateVectorSha256,
      actualByteLength: verification.actualByteLength,
      actualUpdateSha256,
      actualStateVectorSha256,
      physicalStatus: verification.status,
      logicalStatus,
      reasons: nextReasons,
      observedAt: Date.now(),
    })
  })
  return logicalStatus
}

function parseSnapshotHealthReasons(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((reason): reason is string => typeof reason === 'string')
      : []
  } catch {
    return []
  }
}

async function listSnapshotCandidates(
  room: VaultRoom,
  docId: DocId,
): Promise<readonly SnapshotCandidate[]> {
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (bucket === undefined || vaultId === undefined) return []

  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const objects = await listR2Objects(bucket, prefix)
  return objects
    .map((object) => snapshotCandidateFromKey(prefix, object.key))
    .filter((c): c is SnapshotCandidate => c !== undefined)
    .sort((left, right) => right.upperSeq - left.upperSeq)
}

function findExpectedEvidence(
  event: SnapshotHealthEventRow | undefined,
): SnapshotVerificationExpectedEvidence | undefined {
  if (
    event === undefined ||
    event.expectedByteLength === null ||
    event.expectedUpdateSha256 === null ||
    event.expectedStateVectorSha256 === null
  ) {
    return undefined
  }
  return {
    byteLength: event.expectedByteLength,
    updateSha256: event.expectedUpdateSha256,
    stateVectorSha256: event.expectedStateVectorSha256,
  }
}

/**
 * Lists every object under an R2 prefix, following opaque continuation cursors.
 *
 * @param bucket R2 bucket to query.
 * @param prefix Prefix to list.
 * @returns All listed object metadata in page order.
 * @throws If a truncated response omits a usable continuation cursor or loops.
 */
export async function listR2Objects(
  bucket: R2BucketBinding,
  prefix: string,
): Promise<readonly R2ObjectBinding[]> {
  const objects: R2ObjectBinding[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const result = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor })
    objects.push(...result.objects)
    if (typeof result.truncated !== 'boolean') throw new Error('invalid-r2-list-result')
    if (!result.truncated) return objects
    if (
      typeof result.cursor !== 'string' ||
      result.cursor.length === 0 ||
      seenCursors.has(result.cursor)
    ) {
      throw new Error('invalid-r2-list-cursor')
    }
    seenCursors.add(result.cursor)
    cursor = result.cursor
  }
}
