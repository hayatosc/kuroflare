import { hashBytesSha256, makeSha256Hex, type DocId } from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

import {
  decideCheckpointCompact,
  decideCheckpointWrite,
  decideOrphanedCheckpointRecovery,
} from '../checkpoint/checkpoint'
import {
  insertCheckpointRun,
  updateCheckpointR2Written,
  updateCheckpointPointerUpdated,
  updateCheckpointCompacted,
  updateCheckpointFailed,
  getRecoverableCheckpointRuns,
  getCheckpointDocRecoveryState,
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
import {
  appendSnapshotVerificationEventPreservingLogical,
  ensureDocHydrated,
  listR2Objects,
  rehydrateAfterDocPointer,
  withDocWriteQueue,
} from './sync'
import { PosIntSchema, NonNegIntSchema, type WorkerEnv } from './types'
import type {
  RuntimeCheckpointResult,
  RuntimeCheckpointRunRecord,
  RuntimeCheckpointDocRecoveryRecord,
  RuntimeCheckpointSnapshotEvidence,
} from './types'
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

async function readSnapshotRetentionPlan(
  room: VaultRoom,
  docId: DocId,
): Promise<SnapshotRetentionExecutionPlan | undefined> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = await resolveVaultId(room)
  if (db === undefined || bucket === undefined || vaultId === undefined) return undefined

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
      minGenerationCount: SNAPSHOT_RETENTION_MIN_GENERATIONS,
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

async function applySnapshotRetentionPlan(
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

export async function recoverOrphanedCheckpointRuns(
  room: VaultRoom,
  limit: number,
  now = Date.now(),
): Promise<void> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined || limit <= 0) return

  for (const run of await readRecoverableCheckpointRuns(room, db, limit)) {
    await recoverOrphanedCheckpointRun(room, db, bucket, run, now)
  }
}

async function recoverOrphanedCheckpointRun(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  run: RuntimeCheckpointRunRecord,
  now: number,
): Promise<void> {
  const snapshotKeyMatchesRun = await checkpointSnapshotKeyMatchesRun(room, run)
  if (!snapshotKeyMatchesRun) {
    if (run.status === 'writing' || run.status === 'r2-written') {
      await markCheckpointRunFailed(room, db, run.runId)
    }
    return
  }
  const doc = await readCheckpointDocRecoveryState(room, db, run.docId)
  const snapshot = await readCheckpointSnapshotEvidence(
    room,
    db,
    bucket,
    run.docId,
    run.snapshotKey,
    run.upperSeq,
  )
  const pointerVerified = await checkpointPointerVerified(room, db, bucket, run.docId, doc)
  const snapshotStateVectorMatchesRun =
    snapshot?.stateVector !== undefined &&
    run.stateVector !== undefined &&
    sameBytes(snapshot.stateVector, run.stateVector)
  if (run.status === 'writing' || run.status === 'r2-written') {
    if (!snapshotStateVectorMatchesRun) {
      await markCheckpointRunFailed(room, db, run.runId)
      return
    }
  } else if (run.status === 'pointer-updated' && !snapshotStateVectorMatchesRun) {
    // The pointer may already be durable, but compaction needs evidence that
    // this run's snapshot is the one represented by its durable state vector.
    return
  }
  const retention =
    run.status === 'pointer-updated' ? await readSnapshotRetentionPlan(room, run.docId) : undefined
  const decision = decideOrphanedCheckpointRecovery({
    run,
    doc: { latestSnapshotSeq: doc.latestSnapshotSeq, pointerVerified },
    snapshot,
    // A missing retention plan must block orphan compaction as well.
    retainedSnapshotFloorSeq:
      run.status === 'pointer-updated' ? (retention?.retainedSnapshotFloorSeq ?? 0) : undefined,
  })

  switch (decision.action) {
    case 'ignore-terminal':
    case 'block-compact':
      return
    case 'fail-run':
    case 'mark-stale':
      await markCheckpointRunFailed(room, db, run.runId)
      return
    case 'mark-r2-written':
      await markCheckpointRunR2Written(room, db, run.runId, now)
      return
    case 'advance-pointer':
      if (run.snapshotKey === undefined || snapshot === undefined || !snapshot.verified) {
        await markCheckpointRunFailed(room, db, run.runId)
        return
      }
      await advanceRecoveredCheckpointPointer(room, db, bucket, run, snapshot.stateVector, now)
      return
    case 'compact-op-log':
      if (snapshot === undefined || !snapshot.verified || snapshot.stateVector === undefined) return
      if (retention === undefined) return
      const horizonStateVector =
        decision.compactedSeq === retention.retainedSnapshotFloorSeq
          ? retention.retainedSnapshotStateVector
          : run.stateVector
      if (horizonStateVector === undefined) return
      await compactRecoveredCheckpointRun(
        room,
        db,
        bucket,
        run,
        decision.compactedSeq,
        horizonStateVector,
        now,
      )
      if (retention !== undefined) {
        await applySnapshotRetentionPlan(room, run.docId, retention.plan, now)
      }
      return
  }
}

async function checkpointSnapshotKeyMatchesRun(
  room: VaultRoom,
  run: RuntimeCheckpointRunRecord,
): Promise<boolean> {
  if (run.snapshotKey === undefined) return false
  const vaultId = await resolveVaultId(room)
  if (vaultId === undefined) return false
  const prefix = makeSnapshotListPrefix(vaultId, run.docId)
  const candidate = snapshotCandidateFromKey(prefix, run.snapshotKey)
  return candidate?.upperSeq === run.upperSeq
}

async function readRecoverableCheckpointRuns(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  limit: number,
): Promise<readonly RuntimeCheckpointRunRecord[]> {
  const runs: RuntimeCheckpointRunRecord[] = []
  for (const row of await getRecoverableCheckpointRuns(db, limit)) {
    const docId = docIdFromKey(row.docId)
    if (
      docId !== undefined &&
      isCheckpointRunStatus(row.status) &&
      v.is(PosIntSchema, row.upperSeq)
    ) {
      runs.push({
        runId: row.runId,
        docId,
        status: row.status,
        upperSeq: row.upperSeq,
        snapshotKey: row.snapshotKey ?? undefined,
        stateVector: readSqlUpdateBytes(row.stateVector ?? undefined),
      })
    }
  }
  return runs
}

async function readCheckpointDocRecoveryState(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
): Promise<RuntimeCheckpointDocRecoveryRecord> {
  const row = await getCheckpointDocRecoveryState(db, docKey(docId))
  const latestSnapshotSeq = row?.latestSnapshotSeq
  const latestSnapshotKey = row?.latestSnapshotKey
  return {
    latestSnapshotSeq: v.is(NonNegIntSchema, latestSnapshotSeq) ? latestSnapshotSeq : 0,
    latestSnapshotKey: typeof latestSnapshotKey === 'string' ? latestSnapshotKey : undefined,
  }
}

async function readCheckpointSnapshotEvidence(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  docId: DocId,
  snapshotKey: string | undefined,
  expectedUpperSeq?: number,
): Promise<RuntimeCheckpointSnapshotEvidence | undefined> {
  if (snapshotKey === undefined) return undefined
  const upperSeq = snapshotUpperSeqFromKey(snapshotKey)
  if (upperSeq === undefined || (expectedUpperSeq !== undefined && upperSeq !== expectedUpperSeq)) {
    return undefined
  }
  const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshotKey)
  const expected = snapshotExpectedEvidenceFromEvent(latest)
  const verification = await verifySnapshotObject(bucket, snapshotKey, docId, expected)
  const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
    room,
    db,
    docId,
    { key: snapshotKey, upperSeq, healthy: true },
    verification,
    expected,
  )
  const recorded = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshotKey)
  return {
    exists: verification.exists,
    verified:
      verification.status === 'verified' &&
      logicalStatus === 'healthy' &&
      recorded?.logicalStatus === 'healthy' &&
      recorded?.physicalStatus === 'verified',
    stateVector: verification.stateVector,
  }
}

async function checkpointPointerVerified(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  docId: DocId,
  doc: RuntimeCheckpointDocRecoveryRecord,
): Promise<boolean> {
  if (doc.latestSnapshotKey === undefined || doc.latestSnapshotSeq <= 0) return false
  const evidence = await readCheckpointSnapshotEvidence(
    room,
    db,
    bucket,
    docId,
    doc.latestSnapshotKey,
    doc.latestSnapshotSeq,
  )
  return evidence?.verified === true
}

async function markCheckpointRunFailed(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  runId: string,
): Promise<void> {
  await updateCheckpointFailed(db, runId)
}

async function markCheckpointRunR2Written(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  runId: string,
  now: number,
): Promise<void> {
  await updateCheckpointR2Written(db, runId, now)
}

async function advanceRecoveredCheckpointPointer(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  run: RuntimeCheckpointRunRecord,
  stateVector: Uint8Array | undefined,
  now: number,
): Promise<void> {
  if (run.snapshotKey === undefined || stateVector === undefined) return
  const snapshotKey = run.snapshotKey
  const capturedStateVector = stateVector

  await withDocWriteQueue(room, run.docId, async () => {
    const initialLatest = await getLatestSnapshotHealthEvent(db, docKey(run.docId), snapshotKey)
    const initialExpected = snapshotExpectedEvidenceFromEvent(initialLatest)
    const verification = await verifySnapshotObject(bucket, snapshotKey, run.docId, initialExpected)
    if (
      verification.status !== 'verified' ||
      verification.stateVector === undefined ||
      !sameBytes(verification.stateVector, capturedStateVector) ||
      initialLatest?.logicalStatus === 'quarantined'
    ) {
      await updateCheckpointFailed(db, run.runId)
      return
    }
    let invalidated = false
    await withSqlTransaction(room, async () => {
      const latest = await getLatestSnapshotHealthEvent(db, docKey(run.docId), snapshotKey)
      const expected = snapshotExpectedEvidenceFromEvent(latest)
      if (
        latest?.logicalStatus === 'quarantined' ||
        expected?.byteLength !== initialExpected?.byteLength ||
        expected?.updateSha256 !== initialExpected?.updateSha256 ||
        expected?.stateVectorSha256 !== initialExpected?.stateVectorSha256
      ) {
        invalidated = true
        await updateCheckpointFailed(db, run.runId)
        return
      }
      await updateDocSnapshotPointer(
        db,
        run.upperSeq,
        snapshotKey,
        capturedStateVector,
        now,
        docKey(run.docId),
        run.upperSeq,
      )
      await updateCheckpointPointerUpdated(db, run.runId, now)
      await insertSnapshotHealthEvent(db, {
        docId: docKey(run.docId),
        snapshotKey,
        upperSeq: run.upperSeq,
        event: 'verification',
        actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
        authorityStatus: 'authoritative',
        expectedByteLength: expected?.byteLength ?? latest?.expectedByteLength ?? null,
        expectedUpdateSha256: expected?.updateSha256 ?? latest?.expectedUpdateSha256 ?? null,
        expectedStateVectorSha256:
          expected?.stateVectorSha256 ?? latest?.expectedStateVectorSha256 ?? null,
        actualByteLength: verification.actualByteLength,
        actualUpdateSha256: verification.actualUpdateSha256 || null,
        actualStateVectorSha256: verification.actualStateVectorSha256 ?? null,
        physicalStatus: verification.status,
        logicalStatus: 'healthy',
        reasons: [...parseSnapshotHealthReasons(latest?.reasons), ...verification.reasons],
        observedAt: now,
      })
    })
    if (!invalidated) await rehydrateAfterDocPointer(room, run.docId)
  })
}

async function compactRecoveredCheckpointRun(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  run: RuntimeCheckpointRunRecord,
  compactedSeq: number,
  horizonStateVector: Uint8Array,
  now: number,
): Promise<void> {
  await withDocWriteQueue(room, run.docId, async () => {
    const authorityAppended = await appendRecoveredCheckpointAuthority(room, db, bucket, run, now)
    if (!authorityAppended) {
      await updateCheckpointFailed(db, run.runId)
      return
    }
    await deleteOpLogBelowSeq(db, docKey(run.docId), compactedSeq)
    await updateDocCompact(
      db,
      compactedSeq,
      horizonStateVector,
      now,
      docKey(run.docId),
      compactedSeq,
    )
    await updateCheckpointCompacted(db, run.runId, now)
    await rehydrateAfterDocPointer(room, run.docId)
  })
}

async function appendRecoveredCheckpointAuthority(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  run: RuntimeCheckpointRunRecord,
  now: number,
): Promise<boolean> {
  if (run.snapshotKey === undefined || run.stateVector === undefined) return false
  const snapshotKey = run.snapshotKey
  const capturedStateVector = run.stateVector
  const initialLatest = await getLatestSnapshotHealthEvent(db, docKey(run.docId), snapshotKey)
  const initialExpected = snapshotExpectedEvidenceFromEvent(initialLatest)
  const verification = await verifySnapshotObject(bucket, snapshotKey, run.docId, initialExpected)
  if (
    verification.status !== 'verified' ||
    verification.stateVector === undefined ||
    !sameBytes(verification.stateVector, capturedStateVector) ||
    initialLatest?.logicalStatus === 'quarantined'
  ) {
    return false
  }
  let committed = false
  await withSqlTransaction(room, async () => {
    const latest = await getLatestSnapshotHealthEvent(db, docKey(run.docId), snapshotKey)
    const expected = snapshotExpectedEvidenceFromEvent(latest)
    if (
      latest?.logicalStatus === 'quarantined' ||
      expected?.byteLength !== initialExpected?.byteLength ||
      expected?.updateSha256 !== initialExpected?.updateSha256 ||
      expected?.stateVectorSha256 !== initialExpected?.stateVectorSha256
    ) {
      return
    }
    await insertSnapshotHealthEvent(db, {
      docId: docKey(run.docId),
      snapshotKey,
      upperSeq: run.upperSeq,
      event: 'verification',
      actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
      authorityStatus: 'authoritative',
      expectedByteLength: expected?.byteLength ?? latest?.expectedByteLength ?? null,
      expectedUpdateSha256: expected?.updateSha256 ?? latest?.expectedUpdateSha256 ?? null,
      expectedStateVectorSha256:
        expected?.stateVectorSha256 ?? latest?.expectedStateVectorSha256 ?? null,
      actualByteLength: verification.actualByteLength,
      actualUpdateSha256: verification.actualUpdateSha256 || null,
      actualStateVectorSha256: verification.actualStateVectorSha256 ?? null,
      physicalStatus: verification.status,
      logicalStatus: 'healthy',
      reasons: [...parseSnapshotHealthReasons(latest?.reasons), ...verification.reasons],
      observedAt: now,
    })
    committed = true
  })
  return committed
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function snapshotExpectedEvidenceFromEvent(
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

function snapshotUpperSeqFromKey(snapshotKey: string): number | undefined {
  const match = /\/([1-9][0-9]*)\.yupdate$/.exec(snapshotKey)
  if (match === null) return undefined
  const upperSeq = Number(match[1])
  return Number.isSafeInteger(upperSeq) && upperSeq > 0 ? upperSeq : undefined
}

function parseSnapshotHealthReasons(value: string | undefined): readonly string[] {
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
