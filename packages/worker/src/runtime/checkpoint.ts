import { hashBytesSha256, makeSha256Hex, type DocId } from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

import { decideCheckpointCompact, decideCheckpointWrite } from '../checkpoint/checkpoint'
import {
  insertCheckpointRun,
  updateCheckpointR2Written,
  updateCheckpointPointerUpdated,
  updateCheckpointCompacted,
  updateCheckpointFailed,
  getRecoverableCheckpointRuns,
  getSnapshotRetentionCheckpointRuns,
  insertSnapshotRetentionEvent,
  insertSnapshotExpectedEvidence,
  insertSnapshotHealthEvent,
  getLatestSnapshotHealthEvent,
} from '../db/checkpointRepo'
import {
  getDocsNeedingCheckpoint,
  updateDocSnapshotPointer,
  updateDocCompact,
  deleteOpLogBelowSeq,
} from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import { planSnapshotRetention, type SnapshotRetentionPlan } from '../db/retention'
import {
  verifySnapshotObject,
  SNAPSHOT_HEALTH_SYSTEM_ACTORS,
  type SnapshotVerificationExpectedEvidence,
} from '../sync/snapshot-health'
import { makeSnapshotObjectKey, type SnapshotCandidate } from '../sync/snapshots'
import { makeSnapshotListPrefix } from '../sync/snapshots'
import { EVICTION_IDLE_THRESHOLD_MS, SNAPSHOT_RETENTION_MIN_GENERATIONS } from './constants'
import {
  appendSnapshotVerificationEventPreservingLogical,
  ensureDocHydrated,
  listR2Objects,
} from './document-hydration'
import { decideDocEviction } from './eviction'
import {
  getDb,
  readDocClock,
  readSnapshotSeq,
  readSnapshotPointer,
  resolveVaultId,
  ensureSchema,
  withSqlTransaction,
} from './storage'
import { withDocWriteQueue } from './sync'
import { PosIntSchema, type WorkerEnv } from './types'
import type { RuntimeCheckpointResult } from './types'
import {
  docKey,
  docIdFromKey,
  snapshotCandidateFromKey,
  isCheckpointRunStatus,
  logEvent,
  retentionErrorMessage,
} from './utils'
import type { VaultRoom } from './vault-room'

export async function readCheckpointableDocIds(
  room: VaultRoom,
  limit: number,
): Promise<readonly DocId[]> {
  const db = getDb(room)
  if (db === undefined || limit <= 0) return []

  const activeCheckpointDocs = new Set(
    (await getRecoverableCheckpointRuns(db, Math.max(limit * 4, limit))).map((run) => run.docId),
  )
  const docIds: DocId[] = []
  for (const row of await getDocsNeedingCheckpoint(db, limit)) {
    if (activeCheckpointDocs.has(row.docId)) continue
    const docId = docIdFromKey(row.docId)
    if (docId !== undefined) docIds.push(docId)
  }
  return docIds
}

/**
 * Removes resident file docs from memory once they are checkpointed and idle,
 * so a room under memory pressure can recover instead of staying degraded.
 *
 * deliberate: `activeSocketCount` is always treated as 0 because the runtime
 * doesn't yet track which sockets have touched which doc (server.md §11 notes
 * this is only an approximation once added). Evicting a doc a client is still
 * using just costs an extra re-hydrate on its next access, not data loss, so
 * this is safe, if not optimal; add per-doc socket tracking if the churn
 * becomes a problem.
 */
export async function evictIdleDocs(room: VaultRoom, now = Date.now()): Promise<void> {
  const db = getDb(room)
  if (db === undefined) return

  // Deleting the current key while iterating a Set is safe and doesn't skip
  // later entries, so no defensive copy is needed here.
  for (const key of room.hydratedDocs) {
    if (key === 'meta') continue
    const docId = docIdFromKey(key)
    if (docId === undefined) continue

    const clock = await readDocClock(room, docId)
    const snapshotSeq = await readSnapshotSeq(room, docId)
    const decision = decideDocEviction({
      isMeta: false,
      checkpointed: clock !== undefined && clock.latestSeq === snapshotSeq,
      activeSocketCount: 0,
      lastAccessedAt: room.docLastAccessedAt.get(key) ?? 0,
      now,
      idleThresholdMs: EVICTION_IDLE_THRESHOLD_MS,
    })
    if (decision.action !== 'evict') continue

    room.docs.get(key)?.destroy()
    room.docs.delete(key)
    room.hydratedDocs.delete(key)
    room.docLastAccessedAt.delete(key)
  }
}

export async function checkpointDoc(
  room: VaultRoom,
  docId: DocId,
  now = Date.now(),
): Promise<RuntimeCheckpointResult> {
  await ensureSchema(room)
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = await resolveVaultId(room)
  if (db === undefined || bucket === undefined || vaultId === undefined) {
    return { action: 'skipped', reason: 'runtime-unavailable' }
  }

  const capture = await withDocWriteQueue(room, docId, async () => {
    try {
      await ensureDocHydrated(room, docId)
    } catch {
      return { action: 'skipped' as const, reason: 'hydrate-failed' as const }
    }

    const doc = room.docs.get(docKey(docId))
    const clock = await readDocClock(room, docId)
    const snapshotSeq = await readSnapshotSeq(room, docId)
    if (doc === undefined) return { action: 'skipped' as const, reason: 'doc-unavailable' as const }
    if (clock === undefined || !v.is(PosIntSchema, clock.latestSeq)) {
      return { action: 'skipped' as const, reason: 'invalid-clock' as const }
    }

    const decision = decideCheckpointWrite({
      latestSeq: clock.latestSeq,
      latestSnapshotSeq: snapshotSeq,
      snapshotKey: makeSnapshotObjectKey(vaultId, docId, clock.latestSeq),
      now,
    })
    if (decision.action === 'skip') return { action: 'skipped' as const, reason: decision.reason }

    return {
      action: 'captured' as const,
      decision,
      snapshotBytes: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
    }
  })
  if (capture.action === 'skipped') return capture
  const { decision, snapshotBytes, stateVector } = capture
  const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(snapshotBytes))
  const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVector))

  logEvent('checkpoint-start', { vaultId, docId, upperSeq: decision.upperSeq })
  try {
    let existingVerification: Awaited<ReturnType<typeof verifySnapshotObject>> | undefined
    if ((await bucket.head(decision.snapshotKey)) !== null) {
      const existing = await getLatestSnapshotHealthEvent(db, docKey(docId), decision.snapshotKey)
      const existingExpected = snapshotExpectedEvidenceFromEvent(existing)
      if (existing?.authorityStatus !== 'authoritative' || existingExpected === undefined) {
        throw new Error('snapshot-checkpoint-target-exists')
      }
      existingVerification = await verifySnapshotObject(
        bucket,
        decision.snapshotKey,
        docId,
        existingExpected,
      )
      const existingLogicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        docId,
        { key: decision.snapshotKey, upperSeq: decision.upperSeq, healthy: true },
        existingVerification,
        existingExpected,
        'authoritative',
      )
      if (
        existingVerification.status !== 'verified' ||
        existingLogicalStatus === 'quarantined' ||
        existingVerification.stateVector === undefined ||
        existingVerification.actualByteLength !== snapshotBytes.byteLength ||
        existingVerification.actualUpdateSha256 !== expectedUpdateSha256 ||
        existingVerification.actualStateVectorSha256 !== expectedStateVectorSha256 ||
        !sameBytes(existingVerification.stateVector, stateVector)
      ) {
        throw new Error('snapshot-checkpoint-target-exists')
      }
    }
    await insertCheckpointRun(
      db,
      decision.runId,
      docKey(docId),
      decision.upperSeq,
      decision.snapshotKey,
      stateVector,
      'writing',
      decision.createdAt,
    )
    let verification = existingVerification
    if (verification === undefined) {
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId,
          snapshotKey: decision.snapshotKey,
          upperSeq: decision.upperSeq,
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.checkpoint,
          expectedByteLength: snapshotBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
        },
        now,
      )
      await bucket.put(decision.snapshotKey, snapshotBytes)
      verification = await verifySnapshotObject(bucket, decision.snapshotKey, docId, {
        byteLength: snapshotBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      })
    }
    const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      { key: decision.snapshotKey, upperSeq: decision.upperSeq, healthy: true },
      verification,
      {
        byteLength: snapshotBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      },
    )
    if (verification.status !== 'verified' || logicalStatus === 'quarantined') {
      await updateCheckpointFailed(db, decision.runId)
      throw new Error(`snapshot-verification-failed:${verification.reasons.join(',')}`)
    }
    await updateCheckpointR2Written(db, decision.runId, now)
    let pointerInvalidated = false
    await withDocWriteQueue(room, docId, async () => {
      const finalVerification = await verifySnapshotObject(bucket, decision.snapshotKey, docId, {
        byteLength: snapshotBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      })
      await withSqlTransaction(room, async () => {
        const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), decision.snapshotKey)
        if (
          finalVerification.status !== 'verified' ||
          latest?.logicalStatus !== 'healthy' ||
          latest?.physicalStatus !== 'verified' ||
          latest.expectedByteLength !== snapshotBytes.byteLength ||
          latest.expectedUpdateSha256 !== expectedUpdateSha256 ||
          latest.expectedStateVectorSha256 !== expectedStateVectorSha256 ||
          finalVerification.actualByteLength !== snapshotBytes.byteLength ||
          finalVerification.actualUpdateSha256 !== expectedUpdateSha256 ||
          finalVerification.actualStateVectorSha256 !== expectedStateVectorSha256
        ) {
          pointerInvalidated = true
          await updateCheckpointFailed(db, decision.runId)
          return
        }
        await updateDocSnapshotPointer(
          db,
          decision.upperSeq,
          decision.snapshotKey,
          stateVector,
          now,
          docKey(docId),
          decision.upperSeq,
        )
        await updateCheckpointPointerUpdated(db, decision.runId, now)
        await insertSnapshotHealthEvent(db, {
          docId: docKey(docId),
          snapshotKey: decision.snapshotKey,
          upperSeq: decision.upperSeq,
          event: 'verification',
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
          authorityStatus: 'authoritative',
          expectedByteLength: snapshotBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
          actualByteLength: finalVerification.actualByteLength,
          actualUpdateSha256: finalVerification.actualUpdateSha256,
          actualStateVectorSha256: finalVerification.actualStateVectorSha256,
          physicalStatus: 'verified',
          logicalStatus: 'healthy',
          reasons: [],
          observedAt: Date.now(),
        })
      })
    })
    if (pointerInvalidated) throw new Error('snapshot-checkpoint-target-changed')
    const compaction = await withDocWriteQueue(room, docId, async () => {
      const retention = await readSnapshotRetentionPlan(room, docId)
      const compact = decideCheckpointCompact({
        status: 'pointer-updated',
        upperSeq: decision.upperSeq,
        latestSnapshotSeq: decision.upperSeq,
        // A missing or invalid retention plan must block compaction.
        retainedSnapshotFloorSeq: retention?.retainedSnapshotFloorSeq ?? 0,
        now,
      })
      if (compact.action === 'compact' && retention !== undefined) {
        const horizonStateVector =
          compact.compactedSeq === retention.retainedSnapshotFloorSeq
            ? retention.retainedSnapshotStateVector
            : stateVector
        await deleteOpLogBelowSeq(db, docKey(docId), compact.compactedSeq)
        await updateDocCompact(
          db,
          compact.compactedSeq,
          horizonStateVector,
          compact.compactedAt,
          docKey(docId),
          compact.compactedSeq,
        )
        await updateCheckpointCompacted(db, decision.runId, compact.compactedAt)
        await applySnapshotRetentionPlanSerialized(room, docId, retention.plan, now)
      }
      return { compact, retention }
    })
    const { compact, retention } = compaction

    logEvent('checkpoint-complete', { vaultId, docId, upperSeq: decision.upperSeq })
    return {
      action: 'checkpointed',
      snapshotKey: decision.snapshotKey,
      upperSeq: decision.upperSeq,
      compactedSeq:
        compact.action === 'compact' && retention !== undefined ? compact.compactedSeq : undefined,
    }
  } catch (error) {
    logEvent('checkpoint-failed', {
      vaultId,
      docId,
      upperSeq: decision.upperSeq,
      error: retentionErrorMessage(error),
    })
    throw error
  }
}

interface SnapshotRetentionExecutionPlan {
  readonly plan: SnapshotRetentionPlan
  readonly retainedSnapshotFloorSeq: number
  readonly retainedSnapshotStateVector: Uint8Array
}

export async function readSnapshotRetentionPlan(
  room: VaultRoom,
  docId: DocId,
): Promise<SnapshotRetentionExecutionPlan | undefined> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = await resolveVaultId(room)
  if (db === undefined || bucket === undefined || vaultId === undefined) return undefined

  const minGenerationCount = resolveSnapshotRetentionMinGenerations(room.env)
  if (minGenerationCount === undefined) {
    logEvent('snapshot-retention-invalid-config', {
      vaultId,
      docId,
      variable: 'SNAPSHOT_RETENTION_MIN_GENERATIONS',
    })
    return undefined
  }

  try {
    const prefix = makeSnapshotListPrefix(vaultId, docId)
    const listed = await listR2Objects(bucket, prefix)
    const snapshots: SnapshotCandidate[] = []
    const snapshotStateVectors = new Map<string, Uint8Array>()
    const listedKeys = new Set<string>()
    for (const object of listed) {
      if (typeof object.key !== 'string') return undefined
      if (listedKeys.has(object.key)) return undefined
      listedKeys.add(object.key)
      const snapshot = snapshotCandidateFromKey(prefix, object.key)
      // Unknown objects in the snapshot prefix make the cleanup boundary
      // untrustworthy; leave both compaction and deletion for a later retry.
      if (snapshot === undefined) return undefined
      const latestHealth = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshot.key)
      if (
        latestHealth?.physicalStatus !== 'verified' &&
        parseSnapshotHealthReasons(latestHealth?.reasons ?? '').includes('verification-pending')
      ) {
        snapshots.push({ ...snapshot, healthy: false })
        continue
      }
      const expected = snapshotExpectedEvidenceFromEvent(latestHealth)
      const verification = await verifySnapshotObject(bucket, snapshot.key, docId, expected)
      const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        docId,
        snapshot,
        verification,
        expected,
      )
      const recorded = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshot.key)
      const healthy =
        verification.status === 'verified' &&
        logicalStatus !== 'quarantined' &&
        recorded?.authorityStatus === 'authoritative' &&
        recorded.physicalStatus === 'verified'
      const stateVector = verification.stateVector
      snapshots.push({ ...snapshot, healthy })
      if (stateVector !== undefined) snapshotStateVectors.set(snapshot.key, stateVector)
    }
    const pointer = await readSnapshotPointer(room, docId)
    const checkpointRuns = []
    const checkpointStateVectors = new Map<string, Uint8Array>()
    const checkpointEvidenceMissing = new Set<string>()
    for (const run of await getSnapshotRetentionCheckpointRuns(db, docKey(docId))) {
      if (!isCheckpointRunStatus(run.status)) return undefined
      if (run.snapshotKey !== null) {
        const runSnapshot = snapshotCandidateFromKey(prefix, run.snapshotKey)
        if (runSnapshot === undefined || runSnapshot.upperSeq !== run.upperSeq) return undefined
        const stateVector = readSqlUpdateBytes(run.stateVector ?? undefined)
        if (stateVector === undefined) checkpointEvidenceMissing.add(run.snapshotKey)
        else {
          const previous = checkpointStateVectors.get(run.snapshotKey)
          if (previous !== undefined && !sameBytes(previous, stateVector)) return undefined
          checkpointStateVectors.set(run.snapshotKey, stateVector)
        }
      }
      checkpointRuns.push({ status: run.status, snapshotKey: run.snapshotKey ?? undefined })
    }
    const plan = planSnapshotRetention({
      snapshots,
      checkpointRuns,
      currentPointerKey: pointer?.latestSnapshotKey,
      minGenerationCount,
    })

    const retainedKeys = new Set(plan.retainKeys)
    const retainedSnapshots = snapshots.filter(
      (snapshot) => snapshot.healthy && retainedKeys.has(snapshot.key),
    )
    if (
      retainedSnapshots.length === 0 ||
      plan.retainKeys.some((key) => !snapshots.some((snapshot) => snapshot.key === key))
    ) {
      return undefined
    }

    const floorSnapshot = retainedSnapshots.reduce((oldest, snapshot) =>
      snapshot.upperSeq < oldest.upperSeq ? snapshot : oldest,
    )
    const retainedSnapshotFloorSeq = floorSnapshot.upperSeq
    if (!v.is(PosIntSchema, retainedSnapshotFloorSeq)) return undefined

    for (const snapshot of retainedSnapshots) {
      const stateVector = snapshotStateVectors.get(snapshot.key)
      const durableStateVector = checkpointStateVectors.get(snapshot.key)
      if (
        checkpointEvidenceMissing.has(snapshot.key) ||
        stateVector === undefined ||
        durableStateVector === undefined ||
        !sameBytes(stateVector, durableStateVector)
      ) {
        return undefined
      }
    }
    const retainedSnapshotStateVector = snapshotStateVectors.get(floorSnapshot.key)
    if (retainedSnapshotStateVector === undefined) return undefined

    return { plan, retainedSnapshotFloorSeq, retainedSnapshotStateVector }
  } catch {
    return undefined
  }
}

export async function applySnapshotRetentionPlan(
  room: VaultRoom,
  docId: DocId,
  plan: SnapshotRetentionPlan,
  now: number,
): Promise<void> {
  await withDocWriteQueue(room, docId, async () => {
    await applySnapshotRetentionPlanSerialized(room, docId, plan, now)
  })
}

async function applySnapshotRetentionPlanSerialized(
  room: VaultRoom,
  docId: DocId,
  plan: SnapshotRetentionPlan,
  now: number,
): Promise<void> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = await resolveVaultId(room)
  if (db === undefined || bucket === undefined || vaultId === undefined) return

  for (const snapshotKey of plan.deleteKeys) {
    try {
      const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshotKey)
      if (
        latest?.logicalStatus !== 'healthy' ||
        latest?.physicalStatus !== 'verified' ||
        latest?.authorityStatus !== 'authoritative'
      ) {
        const reason = 'snapshot-health-not-eligible'
        await insertSnapshotRetentionEvent(db, docKey(docId), snapshotKey, 'skip', reason, now)
        logEvent('snapshot-retention-delete-skipped', {
          vaultId,
          docId,
          snapshotKey,
          reason,
        })
        continue
      }
      await bucket.delete(snapshotKey)
      await insertSnapshotHealthEvent(db, {
        docId: docKey(docId),
        snapshotKey,
        upperSeq: latest.upperSeq,
        event: 'verification',
        actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
        authorityStatus: latest.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
        expectedByteLength: latest.expectedByteLength,
        expectedUpdateSha256: latest.expectedUpdateSha256,
        expectedStateVectorSha256: latest.expectedStateVectorSha256,
        actualByteLength: 0,
        actualUpdateSha256: null,
        actualStateVectorSha256: null,
        physicalStatus: 'mismatch',
        logicalStatus: 'healthy',
        reasons: [...new Set([...parseSnapshotHealthReasons(latest.reasons), 'missing-object'])],
        observedAt: now,
      })
      await insertSnapshotRetentionEvent(db, docKey(docId), snapshotKey, 'delete', null, now)
      logEvent('snapshot-retention-delete', { vaultId, docId, snapshotKey })
    } catch (error) {
      const message = retentionErrorMessage(error)
      await insertSnapshotRetentionEvent(db, docKey(docId), snapshotKey, 'delete', message, now)
      logEvent('snapshot-retention-delete-failed', {
        vaultId,
        docId,
        snapshotKey,
        error: message,
      })
    }
  }
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

export function snapshotExpectedEvidenceFromEvent(
  event: import('../db/checkpointRepo').SnapshotHealthEventRow | undefined,
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
 * Resolves the deploy-configurable minimum snapshot generation count.
 *
 * Falls back to `SNAPSHOT_RETENTION_MIN_GENERATIONS` (constants.ts) when the
 * `WorkerEnv` var is unset. Returns `undefined` — never a silently clamped or
 * default value — when the var is set but not a positive integer, so callers
 * fail closed instead of running retention with an unvalidated policy.
 */
export function resolveSnapshotRetentionMinGenerations(env: WorkerEnv): number | undefined {
  const raw = env.SNAPSHOT_RETENTION_MIN_GENERATIONS
  if (raw === undefined) return SNAPSHOT_RETENTION_MIN_GENERATIONS
  if (!/^[1-9][0-9]*$/.test(raw)) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function parseSnapshotHealthReasons(value: string | undefined): readonly string[] {
  if (value === undefined) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((reason): reason is string => typeof reason === 'string')
      : []
  } catch {
    return []
  }
}
