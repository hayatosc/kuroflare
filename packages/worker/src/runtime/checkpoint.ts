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
import { planSnapshotRetention } from '../db/retention'
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
import { ensureDocHydrated } from './sync'
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

  try {
    await ensureDocHydrated(room, docId)
  } catch {
    return { action: 'skipped', reason: 'hydrate-failed' }
  }

  const doc = room.docs.get(docKey(docId))
  const clock = await readDocClock(room, docId)
  const snapshotSeq = await readSnapshotSeq(room, docId)
  if (doc === undefined) return { action: 'skipped', reason: 'doc-unavailable' }
  if (clock === undefined || !v.is(PosIntSchema, clock.latestSeq))
    return { action: 'skipped', reason: 'invalid-clock' }

  const snapshotKey = makeSnapshotObjectKey(vaultId, docId, clock.latestSeq)
  const decision = decideCheckpointWrite({
    latestSeq: clock.latestSeq,
    latestSnapshotSeq: snapshotSeq,
    snapshotKey,
    now,
  })
  if (decision.action === 'skip') return { action: 'skipped', reason: decision.reason }

  logEvent('checkpoint-start', { vaultId, docId, upperSeq: decision.upperSeq })
  try {
    const snapshotBytes = Y.encodeStateAsUpdate(doc)
    const stateVector = Y.encodeStateVector(doc)
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
    const compact = decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: decision.upperSeq,
      latestSnapshotSeq: decision.upperSeq,
      retainedSnapshotFloorSeq: undefined,
      now,
    })
    if (compact.action === 'compact') {
      await deleteOpLogBelowSeq(db, docKey(docId), compact.compactedSeq)
      await updateDocCompact(
        db,
        compact.compactedSeq,
        stateVector,
        compact.compactedAt,
        docKey(docId),
        compact.compactedSeq,
      )
      await updateCheckpointCompacted(db, decision.runId, compact.compactedAt)
    }
    await cleanupSnapshotRetention(room, docId, now)

    logEvent('checkpoint-complete', { vaultId, docId, upperSeq: decision.upperSeq })
    return {
      action: 'checkpointed',
      snapshotKey: decision.snapshotKey,
      upperSeq: decision.upperSeq,
      compactedSeq: compact.action === 'compact' ? compact.compactedSeq : undefined,
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

async function cleanupSnapshotRetention(room: VaultRoom, docId: DocId, now: number): Promise<void> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = await resolveVaultId(room)
  if (db === undefined || bucket === undefined || vaultId === undefined) return

  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const listed = await bucket.list({ prefix })
  const snapshots = listed.objects
    .map((object) => snapshotCandidateFromKey(prefix, object.key))
    .filter((snapshot): snapshot is SnapshotCandidate => snapshot !== undefined)
  const pointer = await readSnapshotPointer(room, docId)
  const checkpointRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(docId))).map(
    (run) => ({
      status: isCheckpointRunStatus(run.status) ? run.status : ('failed' as const),
      snapshotKey: run.snapshotKey ?? undefined,
    }),
  )
  const plan = planSnapshotRetention({
    snapshots,
    checkpointRuns,
    currentPointerKey: pointer?.latestSnapshotKey,
    minGenerationCount: SNAPSHOT_RETENTION_MIN_GENERATIONS,
  })

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
  const doc = await readCheckpointDocRecoveryState(room, db, run.docId)
  const snapshot = await readCheckpointSnapshotEvidence(room, bucket, run.snapshotKey)
  const pointerVerified = await checkpointPointerVerified(room, bucket, doc)
  const decision = decideOrphanedCheckpointRecovery({
    run,
    doc: { latestSnapshotSeq: doc.latestSnapshotSeq, pointerVerified },
    snapshot,
    retainedSnapshotFloorSeq: undefined,
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
      await compactRecoveredCheckpointRun(room, db, run, snapshot.stateVector, now)
      return
  }
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

  await updateDocSnapshotPointer(
    db,
    run.upperSeq,
    run.snapshotKey,
    stateVector,
    now,
    docKey(run.docId),
    run.upperSeq,
  )
  await updateCheckpointPointerUpdated(db, run.runId, now)
}

async function compactRecoveredCheckpointRun(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  run: RuntimeCheckpointRunRecord,
  horizonStateVector: Uint8Array,
  now: number,
): Promise<void> {
  await deleteOpLogBelowSeq(db, docKey(run.docId), run.upperSeq)
  await updateDocCompact(db, run.upperSeq, horizonStateVector, now, docKey(run.docId), run.upperSeq)
  await updateCheckpointCompacted(db, run.runId, now)
}
