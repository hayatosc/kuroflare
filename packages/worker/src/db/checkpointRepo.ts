import type { SnapshotExpectedEvidence, SnapshotHealthActor } from '@kuroflare/core'
import { sql, type Kysely } from 'kysely'

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

/** One append-only snapshot health audit event read from SQLite. */
export interface SnapshotHealthEventRow {
  readonly id: number
  readonly docId: string
  readonly snapshotKey: string
  readonly upperSeq: number
  readonly event: string
  readonly actor: string
  readonly authorityStatus: string
  readonly expectedByteLength: number | null
  readonly expectedUpdateSha256: string | null
  readonly expectedStateVectorSha256: string | null
  readonly actualByteLength: number | null
  readonly actualUpdateSha256: string | null
  readonly actualStateVectorSha256: string | null
  readonly physicalStatus: string | null
  readonly logicalStatus: string | null
  readonly reasons: string
  readonly observedAt: number
}

/** Values written to one append-only snapshot health audit event. */
export interface SnapshotHealthEventInput {
  readonly docId: string
  readonly snapshotKey: string
  readonly upperSeq: number
  readonly event: string
  readonly actor: SnapshotHealthActor
  readonly authorityStatus: 'candidate' | 'authoritative'
  readonly expectedByteLength?: number | null
  readonly expectedUpdateSha256?: string | null
  readonly expectedStateVectorSha256?: string | null
  readonly actualByteLength?: number | null
  readonly actualUpdateSha256?: string | null
  readonly actualStateVectorSha256?: string | null
  readonly physicalStatus?: string | null
  readonly logicalStatus?: string | null
  readonly reasons?: readonly string[]
  readonly observedAt: number
}

/** Appends expected snapshot evidence before the corresponding R2 write. */
export async function insertSnapshotExpectedEvidence(
  db: Kysely<Database>,
  evidence: SnapshotExpectedEvidence,
  observedAt: number,
): Promise<void> {
  await insertSnapshotHealthEvent(db, {
    docId: docKeyForSnapshotHealth(evidence.docId),
    snapshotKey: evidence.snapshotKey,
    upperSeq: evidence.upperSeq,
    event: 'expected',
    actor: evidence.actor,
    authorityStatus: 'candidate',
    expectedByteLength: evidence.expectedByteLength,
    expectedUpdateSha256: evidence.expectedUpdateSha256,
    expectedStateVectorSha256: evidence.expectedStateVectorSha256,
    physicalStatus: 'unverified',
    logicalStatus: 'healthy',
    observedAt,
  })
}

/** Appends one snapshot health event without mutating previous evidence. */
export async function insertSnapshotHealthEvent(
  db: Kysely<Database>,
  input: SnapshotHealthEventInput,
): Promise<void> {
  await db
    .insertInto('snapshot_health_events')
    .values({
      doc_id: input.docId,
      snapshot_key: input.snapshotKey,
      upper_seq: input.upperSeq,
      event: input.event,
      actor: input.actor,
      authority_status: input.authorityStatus,
      expected_byte_length: input.expectedByteLength ?? null,
      expected_update_sha256: input.expectedUpdateSha256 ?? null,
      expected_state_vector_sha256: input.expectedStateVectorSha256 ?? null,
      actual_byte_length: input.actualByteLength ?? null,
      actual_update_sha256: input.actualUpdateSha256 ?? null,
      actual_state_vector_sha256: input.actualStateVectorSha256 ?? null,
      physical_status: input.physicalStatus ?? null,
      logical_status: input.logicalStatus ?? null,
      reasons: JSON.stringify(input.reasons ?? []),
      observed_at: input.observedAt,
    })
    .execute()
}

/** Returns the latest health event for one immutable generation. */
export async function getLatestSnapshotHealthEvent(
  db: Kysely<Database>,
  docKey: string,
  snapshotKey: string,
): Promise<SnapshotHealthEventRow | undefined> {
  return selectSnapshotHealthEvents(db)
    .where('doc_id', '=', docKey)
    .where('snapshot_key', '=', snapshotKey)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
}

/** Returns latest health events in descending generation order for inspection and recovery. */
export async function getLatestSnapshotHealthEvents(
  db: Kysely<Database>,
  docKey: string,
  limit: number,
): Promise<readonly SnapshotHealthEventRow[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return []
  const latestId = sql<number>`(
    SELECT MAX(latest.id)
    FROM snapshot_health_events AS latest
    WHERE latest.doc_id = event.doc_id
      AND latest.snapshot_key = event.snapshot_key
  )`
  const rows = await selectSnapshotHealthEventsAliased(db)
    .where('event.doc_id', '=', docKey)
    .where('event.id', '=', latestId)
    .orderBy('event.upper_seq', 'desc')
    .orderBy('event.id', 'desc')
    .limit(limit)
    .execute()
  return rows
}

/** Returns the latest event for every generation without an audit-history cap. */
export async function getAllLatestSnapshotHealthEvents(
  db: Kysely<Database>,
  docKey: string,
): Promise<readonly SnapshotHealthEventRow[]> {
  const latestId = sql<number>`(
    SELECT MAX(latest.id)
    FROM snapshot_health_events AS latest
    WHERE latest.doc_id = event.doc_id
      AND latest.snapshot_key = event.snapshot_key
  )`
  return selectSnapshotHealthEventsAliased(db)
    .where('event.doc_id', '=', docKey)
    .where('event.id', '=', latestId)
    .orderBy('event.upper_seq', 'desc')
    .orderBy('event.id', 'desc')
    .execute()
}

/** Returns every append-only health event for one generation in audit order. */
export async function getSnapshotHealthHistory(
  db: Kysely<Database>,
  docKey: string,
  snapshotKey: string,
  limit = 256,
): Promise<readonly SnapshotHealthEventRow[]> {
  return selectSnapshotHealthEvents(db)
    .where('doc_id', '=', docKey)
    .where('snapshot_key', '=', snapshotKey)
    .orderBy('id', 'asc')
    .limit(Math.max(1, Math.min(limit, 1024)))
    .execute()
}

function selectSnapshotHealthEvents(db: Kysely<Database>) {
  return db
    .selectFrom('snapshot_health_events')
    .select((eb) => [
      eb.ref('id').as('id'),
      eb.ref('doc_id').as('docId'),
      eb.ref('snapshot_key').as('snapshotKey'),
      eb.ref('upper_seq').as('upperSeq'),
      'event',
      'actor',
      eb.ref('authority_status').as('authorityStatus'),
      eb.ref('expected_byte_length').as('expectedByteLength'),
      eb.ref('expected_update_sha256').as('expectedUpdateSha256'),
      eb.ref('expected_state_vector_sha256').as('expectedStateVectorSha256'),
      eb.ref('actual_byte_length').as('actualByteLength'),
      eb.ref('actual_update_sha256').as('actualUpdateSha256'),
      eb.ref('actual_state_vector_sha256').as('actualStateVectorSha256'),
      eb.ref('physical_status').as('physicalStatus'),
      eb.ref('logical_status').as('logicalStatus'),
      'reasons',
      eb.ref('observed_at').as('observedAt'),
    ])
}

function selectSnapshotHealthEventsAliased(db: Kysely<Database>) {
  return db
    .selectFrom('snapshot_health_events as event')
    .select((eb) => [
      eb.ref('event.id').as('id'),
      eb.ref('event.doc_id').as('docId'),
      eb.ref('event.snapshot_key').as('snapshotKey'),
      eb.ref('event.upper_seq').as('upperSeq'),
      eb.ref('event.event').as('event'),
      eb.ref('event.actor').as('actor'),
      eb.ref('event.authority_status').as('authorityStatus'),
      eb.ref('event.expected_byte_length').as('expectedByteLength'),
      eb.ref('event.expected_update_sha256').as('expectedUpdateSha256'),
      eb.ref('event.expected_state_vector_sha256').as('expectedStateVectorSha256'),
      eb.ref('event.actual_byte_length').as('actualByteLength'),
      eb.ref('event.actual_update_sha256').as('actualUpdateSha256'),
      eb.ref('event.actual_state_vector_sha256').as('actualStateVectorSha256'),
      eb.ref('event.physical_status').as('physicalStatus'),
      eb.ref('event.logical_status').as('logicalStatus'),
      eb.ref('event.reasons').as('reasons'),
      eb.ref('event.observed_at').as('observedAt'),
    ])
}

function docKeyForSnapshotHealth(docId: SnapshotExpectedEvidence['docId']): string {
  return docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
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
  const query = db.selectFrom('snapshot_retention_events').select((eb) => [
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
