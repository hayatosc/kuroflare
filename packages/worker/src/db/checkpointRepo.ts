import { type Kysely } from 'kysely'

import { toArrayBuffer } from './helpers'
import type { Database } from './types'

export interface CheckpointRunRow {
  readonly runId: string
  readonly docId: string
  readonly status: string
  readonly upperSeq: number
  readonly snapshotKey: string | null
  readonly stateVector: ArrayBuffer | null
}

export interface SnapshotRetentionCheckpointRunRow {
  readonly status: string
  readonly upperSeq: number
  readonly snapshotKey: string | null
  readonly stateVector: ArrayBuffer | null
}

export interface SnapshotRetentionEventRow {
  readonly docId: string
  readonly snapshotKey: string
  readonly action: string
  readonly error: string | null
  readonly attemptedAt: number
}

export interface CheckpointDocRecoveryRow {
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | null
}

export interface QuarantinedUpdateBytesRow {
  readonly updateBytes: ArrayBuffer
}

export interface QuarantinedUpdateRow {
  readonly id: string
  readonly docId: string
  readonly messageId: string
  readonly deviceId: string
  readonly reason: string
  readonly updateSha256: string
  readonly updateBytes: ArrayBuffer
  readonly createdAt: number
}

export async function insertCheckpointRun(
  db: Kysely<Database>,
  runId: string,
  docKey: string,
  upperSeq: number,
  snapshotKey: string,
  stateVector: Uint8Array,
  status: string,
  createdAt: number,
): Promise<void> {
  await db
    .insertInto('checkpoint_runs')
    .values({
      run_id: runId,
      doc_id: docKey,
      upper_seq: upperSeq,
      snapshot_key: snapshotKey,
      state_vector: toArrayBuffer(stateVector),
      status,
      created_at: createdAt,
    })
    .execute()
}

export async function updateCheckpointR2Written(
  db: Kysely<Database>,
  runId: string,
  now: number,
): Promise<void> {
  await db
    .updateTable('checkpoint_runs')
    .set({ status: 'r2-written', r2_written_at: now })
    .where('run_id', '=', runId)
    .execute()
}

export async function updateCheckpointPointerUpdated(
  db: Kysely<Database>,
  runId: string,
  now: number,
): Promise<void> {
  await db
    .updateTable('checkpoint_runs')
    .set({ status: 'pointer-updated', pointer_updated_at: now })
    .where('run_id', '=', runId)
    .execute()
}

export async function updateCheckpointCompacted(
  db: Kysely<Database>,
  runId: string,
  now: number,
): Promise<void> {
  await db
    .updateTable('checkpoint_runs')
    .set({ status: 'compacted', compacted_at: now })
    .where('run_id', '=', runId)
    .execute()
}

export async function updateCheckpointFailed(db: Kysely<Database>, runId: string): Promise<void> {
  await db
    .updateTable('checkpoint_runs')
    .set({ status: 'failed' })
    .where('run_id', '=', runId)
    .execute()
}

export async function getRecoverableCheckpointRuns(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly CheckpointRunRow[]> {
  return db
    .selectFrom('checkpoint_runs')
    .select((eb) => [
      eb.ref('run_id').as('runId'),
      eb.ref('doc_id').as('docId'),
      'status',
      eb.ref('upper_seq').as('upperSeq'),
      eb.ref('snapshot_key').as('snapshotKey'),
      eb.ref('state_vector').as('stateVector'),
    ])
    .where('status', 'in', ['writing', 'r2-written', 'pointer-updated'])
    .orderBy('created_at', 'asc')
    .limit(limit)
    .execute()
}

export async function getSnapshotRetentionCheckpointRuns(
  db: Kysely<Database>,
  docKey: string,
): Promise<readonly SnapshotRetentionCheckpointRunRow[]> {
  return db
    .selectFrom('checkpoint_runs')
    .select((eb) => [
      'status',
      eb.ref('upper_seq').as('upperSeq'),
      eb.ref('snapshot_key').as('snapshotKey'),
      eb.ref('state_vector').as('stateVector'),
    ])
    .where('doc_id', '=', docKey)
    .execute()
}

export async function insertSnapshotRetentionEvent(
  db: Kysely<Database>,
  docKey: string,
  snapshotKey: string,
  action: string,
  error: string | null,
  attemptedAt: number,
): Promise<void> {
  await db
    .insertInto('snapshot_retention_events')
    .values({
      doc_id: docKey,
      snapshot_key: snapshotKey,
      action,
      error,
      attempted_at: attemptedAt,
    })
    .execute()
}

export async function getSnapshotRetentionEvents(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly SnapshotRetentionEventRow[]> {
  return db
    .selectFrom('snapshot_retention_events')
    .select((eb) => [
      eb.ref('doc_id').as('docId'),
      eb.ref('snapshot_key').as('snapshotKey'),
      'action',
      'error',
      eb.ref('attempted_at').as('attemptedAt'),
    ])
    .orderBy('attempted_at', 'desc')
    .limit(limit)
    .execute()
}

export async function getCheckpointDocRecoveryState(
  db: Kysely<Database>,
  docKey: string,
): Promise<CheckpointDocRecoveryRow | undefined> {
  return db
    .selectFrom('docs')
    .select((eb) => [
      eb.ref('latest_snapshot_seq').as('latestSnapshotSeq'),
      eb.ref('latest_snapshot_key').as('latestSnapshotKey'),
    ])
    .where('doc_id', '=', docKey)
    .executeTakeFirst()
}

export async function insertQuarantinedUpdate(
  db: Kysely<Database>,
  id: string,
  docKey: string,
  messageId: string,
  deviceId: string,
  reason: string,
  updateSha256: string,
  updateBytes: Uint8Array,
  createdAt: number,
): Promise<void> {
  await db
    .insertInto('quarantined_updates')
    .values({
      id,
      doc_id: docKey,
      message_id: messageId,
      device_id: deviceId,
      reason,
      update_sha256: updateSha256,
      update_bytes: toArrayBuffer(updateBytes),
      created_at: createdAt,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
}

export async function getQuarantinedUpdates(db: Kysely<Database>): Promise<QuarantinedUpdateRow[]> {
  return db
    .selectFrom('quarantined_updates')
    .select((eb) => [
      'id',
      eb.ref('doc_id').as('docId'),
      eb.ref('message_id').as('messageId'),
      eb.ref('device_id').as('deviceId'),
      'reason',
      eb.ref('update_sha256').as('updateSha256'),
      eb.ref('update_bytes').as('updateBytes'),
      eb.ref('created_at').as('createdAt'),
    ])
    .orderBy('created_at', 'asc')
    .limit(1024)
    .execute()
}

export async function getQuarantinedUpdateById(
  db: Kysely<Database>,
  id: string,
): Promise<QuarantinedUpdateRow | undefined> {
  return db
    .selectFrom('quarantined_updates')
    .select((eb) => [
      'id',
      eb.ref('doc_id').as('docId'),
      eb.ref('message_id').as('messageId'),
      eb.ref('device_id').as('deviceId'),
      'reason',
      eb.ref('update_sha256').as('updateSha256'),
      eb.ref('update_bytes').as('updateBytes'),
      eb.ref('created_at').as('createdAt'),
    ])
    .where('id', '=', id)
    .executeTakeFirst()
}

export async function getQuarantinedUpdateBytes(
  db: Kysely<Database>,
  id: string,
): Promise<QuarantinedUpdateBytesRow | undefined> {
  return db
    .selectFrom('quarantined_updates')
    .select((eb) => eb.ref('update_bytes').as('updateBytes'))
    .where('id', '=', id)
    .executeTakeFirst()
}

export async function deleteQuarantinedUpdate(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom('quarantined_updates').where('id', '=', id).execute()
}
