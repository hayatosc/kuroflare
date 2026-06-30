import { type Kysely, sql } from 'kysely'

import type {
  DocClockRow,
  DocSnapshotPointerRow,
  DocRetentionRow,
  DocIdRow,
  OpLogUpdateRow,
  MessageDedupRow,
} from './docRepo-types'
import { readSqlUpdateBytes, toArrayBuffer } from './helpers'
import type { Database } from './types'

export type {
  DocClockRow,
  DocSnapshotPointerRow,
  DocRetentionRow,
  DocIdRow,
  OpLogUpdateRow,
  MessageDedupRow,
}

export async function insertDoc(
  db: Kysely<Database>,
  docKey: string,
  kind: string,
  latestSeq: number,
  latestSnapshotSeq: number,
  latestSnapshotKey: string,
  stateVector: Uint8Array,
  minRetainedSeq: number,
  updatedAt: number,
): Promise<void> {
  await db
    .insertInto('docs')
    .values({
      doc_id: docKey,
      kind,
      latest_seq: latestSeq,
      latest_snapshot_seq: latestSnapshotSeq,
      latest_snapshot_key: latestSnapshotKey,
      latest_state_vector: toArrayBuffer(stateVector),
      min_retained_seq: minRetainedSeq,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.column('doc_id').doUpdateSet({
        latest_seq: sql`excluded.latest_seq`,
        latest_snapshot_seq: sql`excluded.latest_snapshot_seq`,
        latest_snapshot_key: sql`excluded.latest_snapshot_key`,
        latest_state_vector: sql`excluded.latest_state_vector`,
        min_retained_seq: sql`excluded.min_retained_seq`,
        updated_at: sql`excluded.updated_at`,
      }),
    )
    .execute()
}

export async function upsertDocClock(
  db: Kysely<Database>,
  docKey: string,
  kind: string,
  latestSeq: number,
  updatedAt: number,
): Promise<void> {
  await db
    .insertInto('docs')
    .values({
      doc_id: docKey,
      kind,
      latest_seq: latestSeq,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.column('doc_id').doUpdateSet({
        latest_seq: sql`excluded.latest_seq`,
        updated_at: sql`excluded.updated_at`,
      }),
    )
    .execute()
}

export async function insertOpLog(
  db: Kysely<Database>,
  docKey: string,
  seq: number,
  messageId: string,
  deviceId: string,
  yClientId: number,
  updateBytes: Uint8Array,
  updateSha256: string,
  now: number,
): Promise<void> {
  await db
    .insertInto('op_log')
    .values({
      doc_id: docKey,
      seq,
      message_id: messageId,
      device_id: deviceId,
      y_client_id: yClientId,
      update_bytes: toArrayBuffer(updateBytes),
      update_sha256: updateSha256,
      created_at: now,
    })
    .execute()
}

export async function upsertMessageDedup(
  db: Kysely<Database>,
  docKey: string,
  messageId: string,
  durableSeq: number,
  now: number,
): Promise<void> {
  await db
    .insertInto('message_dedup')
    .values({
      doc_id: docKey,
      message_id: messageId,
      durable_seq: durableSeq,
      seen_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['doc_id', 'message_id']).doUpdateSet({
        seen_at: sql`excluded.seen_at`,
      }),
    )
    .execute()
}

export async function getDocClock(
  db: Kysely<Database>,
  docKey: string,
): Promise<DocClockRow | undefined> {
  return db
    .selectFrom('docs')
    .select((eb) => eb.ref('latest_seq').as('latestSeq'))
    .where('doc_id', '=', docKey)
    .executeTakeFirst()
}

export async function getDocSnapshotPointer(
  db: Kysely<Database>,
  docKey: string,
): Promise<DocSnapshotPointerRow | undefined> {
  return db
    .selectFrom('docs')
    .select((eb) => [
      eb.ref('latest_snapshot_seq').as('latestSnapshotSeq'),
      eb.ref('latest_snapshot_key').as('latestSnapshotKey'),
    ])
    .where('doc_id', '=', docKey)
    .executeTakeFirst()
}

export async function getDocSnapshotSeq(
  db: Kysely<Database>,
  docKey: string,
): Promise<{ readonly latestSnapshotSeq: number } | undefined> {
  return db
    .selectFrom('docs')
    .select((eb) => eb.ref('latest_snapshot_seq').as('latestSnapshotSeq'))
    .where('doc_id', '=', docKey)
    .executeTakeFirst()
}

export async function getDocRetention(
  db: Kysely<Database>,
  docKey: string,
): Promise<DocRetentionRow | undefined> {
  return db
    .selectFrom('docs')
    .select((eb) => [
      eb.ref('latest_seq').as('latestSeq'),
      eb.ref('min_retained_seq').as('minRetainedSeq'),
      eb.ref('horizon_state_vector').as('horizonStateVector'),
    ])
    .where('doc_id', '=', docKey)
    .executeTakeFirst()
}

export async function getDocsNeedingCheckpoint(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly DocIdRow[]> {
  return db
    .selectFrom('docs')
    .select((eb) => eb.ref('doc_id').as('docId'))
    .where('latest_seq', '>', (eb) => eb.ref('latest_snapshot_seq'))
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .execute()
}

export async function getFirstDocId(db: Kysely<Database>): Promise<DocIdRow | undefined> {
  return db
    .selectFrom('docs')
    .select((eb) => eb.ref('doc_id').as('docId'))
    .limit(1)
    .executeTakeFirst()
}

export async function getOpLogUpdatesSince(
  db: Kysely<Database>,
  docKey: string,
  minSeq: number,
): Promise<OpLogUpdateRow[]> {
  return db
    .selectFrom('op_log')
    .select((eb) => eb.ref('update_bytes').as('updateBytes'))
    .where('doc_id', '=', docKey)
    .where('seq', '>', minSeq)
    .orderBy('seq', 'asc')
    .execute()
}

export async function getMessageDedupSeq(
  db: Kysely<Database>,
  docKey: string,
  messageId: string,
): Promise<MessageDedupRow | undefined> {
  return db
    .selectFrom('message_dedup')
    .select((eb) => eb.ref('durable_seq').as('durableSeq'))
    .where('doc_id', '=', docKey)
    .where('message_id', '=', messageId)
    .executeTakeFirst()
}

export async function updateDocSnapshotPointer(
  db: Kysely<Database>,
  upperSeq: number,
  snapshotKey: string,
  stateVector: Uint8Array,
  now: number,
  docKey: string,
  maxSnapshotSeq: number,
): Promise<void> {
  await db
    .updateTable('docs')
    .set({
      latest_snapshot_seq: upperSeq,
      latest_snapshot_key: snapshotKey,
      latest_state_vector: toArrayBuffer(stateVector),
      updated_at: now,
    })
    .where('doc_id', '=', docKey)
    .where('latest_snapshot_seq', '<=', maxSnapshotSeq)
    .execute()
}

export async function updateDocCompact(
  db: Kysely<Database>,
  minRetainedSeq: number,
  horizonStateVector: Uint8Array,
  now: number,
  docKey: string,
  maxRetainedSeq: number,
): Promise<void> {
  await db
    .updateTable('docs')
    .set({
      min_retained_seq: minRetainedSeq,
      horizon_state_vector: toArrayBuffer(horizonStateVector),
      updated_at: now,
    })
    .where('doc_id', '=', docKey)
    .where('min_retained_seq', '<=', maxRetainedSeq)
    .execute()
}

export async function deleteOpLogBelowSeq(
  db: Kysely<Database>,
  docKey: string,
  upperSeq: number,
): Promise<void> {
  await db.deleteFrom('op_log').where('doc_id', '=', docKey).where('seq', '<=', upperSeq).execute()
}

export async function applyOpLogUpdateBytes(
  db: Kysely<Database>,
  docKey: string,
  minSeq: number,
  apply: (updateBytes: Uint8Array) => void,
): Promise<void> {
  const rows = await getOpLogUpdatesSince(db, docKey, minSeq)
  for (const row of rows) {
    const updateBytes = readSqlUpdateBytes(row.updateBytes)
    if (updateBytes === undefined) {
      throw new Error('invalid op_log update_bytes')
    }
    apply(updateBytes)
  }
}
