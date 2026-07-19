import type { SnapshotExpectedEvidence, SnapshotHealthActor } from '@kuroflare/core'
import { sql, type Kysely } from 'kysely'

import type { Database } from './types'

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
  return selectSnapshotHealthEventsAliased(db)
    .where('event.doc_id', '=', docKey)
    .where('event.id', '=', latestId)
    .orderBy('event.upper_seq', 'desc')
    .orderBy('event.id', 'desc')
    .limit(limit)
    .execute()
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
