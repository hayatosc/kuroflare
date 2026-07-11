import { type DocId } from '@kuroflare/core'
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
} from '../db/checkpointRepo'
import {
  getDocsNeedingCheckpoint,
  updateDocSnapshotPointer,
  updateDocCompact,
  deleteOpLogBelowSeq,
} from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import { planSnapshotRetention, type SnapshotRetentionPlan } from '../db/retention'
import { makeSnapshotObjectKey, type SnapshotCandidate } from '../sync/snapshots'
import { makeSnapshotListPrefix } from '../sync/snapshots'
import { SNAPSHOT_RETENTION_MIN_GENERATIONS } from './constants'
import {
  getDb,
  readDocClock,
  readSnapshotSeq,
  readSnapshotPointer,
  resolveVaultId,
  ensureSchema,
} from './storage'
import { ensureDocHydrated, listR2Objects, withDocWriteQueue } from './sync'
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

  const docIds: DocId[] = []
  for (const row of await getDocsNeedingCheckpoint(db, limit)) {
    const docId = docIdFromKey(row.docId)
    if (docId !== undefined) docIds.push(docId)
  }
  return docIds
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

  logEvent('checkpoint-start', { vaultId, docId, upperSeq: decision.upperSeq })
  try {
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
    await bucket.put(decision.snapshotKey, snapshotBytes)
    await updateCheckpointR2Written(db, decision.runId, now)
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
      await applySnapshotRetentionPlan(room, docId, retention.plan, now)
    }

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
      const objectBody = await bucket.get(snapshot.key)
      if (objectBody === null) return undefined
      let healthy = false
      let stateVector: Uint8Array | undefined
      const candidateDoc = new Y.Doc()
      try {
        Y.applyUpdate(candidateDoc, new Uint8Array(await objectBody.arrayBuffer()))
        stateVector = Y.encodeStateVector(candidateDoc)
        healthy = true
      } catch {
        healthy = false
      } finally {
        candidateDoc.destroy()
      }
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
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = await resolveVaultId(room)
  if (db === undefined || bucket === undefined || vaultId === undefined) return

  for (const snapshotKey of plan.deleteKeys) {
    try {
      await bucket.delete(snapshotKey)
      await insertSnapshotRetentionEvent(db, docKey(docId), snapshotKey, 'delete', null, now)
      logEvent('snapshot-retention-delete', { vaultId, docId, snapshotKey })
    } catch (error) {
      const message = retentionErrorMessage(error)
      await insertSnapshotRetentionEvent(db, docKey(docId), snapshotKey, 'delete', message, now)
      logEvent('snapshot-retention-delete-failed', { vaultId, docId, snapshotKey, error: message })
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
  const snapshot = await readCheckpointSnapshotEvidence(room, bucket, run.snapshotKey)
  const pointerVerified = await checkpointPointerVerified(room, bucket, doc)
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
      await advanceRecoveredCheckpointPointer(room, db, run, snapshot.stateVector, now)
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
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  snapshotKey: string | undefined,
): Promise<RuntimeCheckpointSnapshotEvidence | undefined> {
  if (snapshotKey === undefined) return undefined

  const object = await bucket.get(snapshotKey)
  if (object === null) return { exists: false, verified: false, stateVector: undefined }

  try {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(await object.arrayBuffer()))
    const stateVector = Y.encodeStateVector(doc)
    doc.destroy()
    return { exists: true, verified: true, stateVector }
  } catch {
    return { exists: true, verified: false, stateVector: undefined }
  }
}

async function checkpointPointerVerified(
  room: VaultRoom,
  bucket: NonNullable<WorkerEnv['SNAPSHOT_BUCKET']>,
  doc: RuntimeCheckpointDocRecoveryRecord,
): Promise<boolean> {
  if (doc.latestSnapshotKey === undefined || doc.latestSnapshotSeq <= 0) return false
  const evidence = await readCheckpointSnapshotEvidence(room, bucket, doc.latestSnapshotKey)
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
  run: RuntimeCheckpointRunRecord,
  stateVector: Uint8Array | undefined,
  now: number,
): Promise<void> {
  if (run.snapshotKey === undefined || stateVector === undefined) return
  const snapshotKey = run.snapshotKey
  const capturedStateVector = stateVector

  await withDocWriteQueue(room, run.docId, async () => {
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
    await rehydrateAfterCheckpointPointer(room, run.docId)
  })
}

async function compactRecoveredCheckpointRun(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  run: RuntimeCheckpointRunRecord,
  compactedSeq: number,
  horizonStateVector: Uint8Array,
  now: number,
): Promise<void> {
  await withDocWriteQueue(room, run.docId, async () => {
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
    await rehydrateAfterCheckpointPointer(room, run.docId)
  })
}

async function rehydrateAfterCheckpointPointer(room: VaultRoom, docId: DocId): Promise<void> {
  const key = docKey(docId)
  const inFlight = room.hydrationInFlight.get(key)
  if (inFlight !== undefined) {
    try {
      await inFlight
    } catch (error) {
      // The stale hydration may have failed; retry against the recovered pointer below.
      logEvent('checkpoint-rehydrate-stale-hydration-failed', {
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}
