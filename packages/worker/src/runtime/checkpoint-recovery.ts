import type { DocId } from '@kuroflare/core'
import * as v from 'valibot'

import { decideOrphanedCheckpointRecovery } from '../checkpoint/checkpoint'
import {
  getRecoverableCheckpointRuns,
  getCheckpointDocRecoveryState,
  updateCheckpointR2Written,
  updateCheckpointPointerUpdated,
  updateCheckpointCompacted,
  updateCheckpointFailed,
  insertSnapshotHealthEvent,
  getLatestSnapshotHealthEvent,
} from '../db/checkpointRepo'
import { deleteOpLogBelowSeq, updateDocCompact, updateDocSnapshotPointer } from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import { verifySnapshotObject, SNAPSHOT_HEALTH_SYSTEM_ACTORS } from '../sync/snapshot-health'
import { makeSnapshotListPrefix } from '../sync/snapshots'
import {
  applySnapshotRetentionPlan,
  parseSnapshotHealthReasons,
  readSnapshotRetentionPlan,
  sameBytes,
  snapshotExpectedEvidenceFromEvent,
} from './checkpoint'
import {
  appendSnapshotVerificationEventPreservingLogical,
  rehydrateAfterDocPointer,
} from './document-hydration'
import { getDb, resolveVaultId, withSqlTransaction } from './storage'
import { withDocWriteQueue } from './sync'
import { NonNegIntSchema, PosIntSchema, type WorkerEnv } from './types'
import type {
  RuntimeCheckpointDocRecoveryRecord,
  RuntimeCheckpointRunRecord,
  RuntimeCheckpointSnapshotEvidence,
} from './types'
import { docIdFromKey, docKey, isCheckpointRunStatus, snapshotCandidateFromKey } from './utils'
import type { VaultRoom } from './vault-room'

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

function snapshotUpperSeqFromKey(snapshotKey: string): number | undefined {
  const match = /\/([1-9][0-9]*)\.yupdate$/.exec(snapshotKey)
  if (match === null) return undefined
  const upperSeq = Number(match[1])
  return Number.isSafeInteger(upperSeq) && upperSeq > 0 ? upperSeq : undefined
}
