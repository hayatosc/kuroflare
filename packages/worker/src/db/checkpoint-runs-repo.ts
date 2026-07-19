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
  readonly id: number
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

/**
 * Lists retention events newest-first, keyed by the autoincrement row `id`
 * (unique and insertion-ordered, unlike `attempted_at` which can tie).
 *
 * @param cursor When set, only returns events with `id` strictly below it —
 *   i.e. the `id` of the last item from the previous page.
 */
export async function getSnapshotRetentionEvents(
  db: Kysely<Database>,
  limit: number,
  cursor: number | undefined,
): Promise<readonly SnapshotRetentionEventRow[]> {
  const query = db
    .selectFrom('snapshot_retention_events')
    .select((eb) => [
      eb.ref('id').as('id'),
      eb.ref('doc_id').as('docId'),
      eb.ref('snapshot_key').as('snapshotKey'),
      'action',
      'error',
      eb.ref('attempted_at').as('attemptedAt'),
    ])
  return (cursor === undefined ? query : query.where('id', '<', cursor))
    .orderBy('id', 'desc')
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
