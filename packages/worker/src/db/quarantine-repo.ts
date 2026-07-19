import { type Kysely } from 'kysely'

import { toArrayBuffer } from './helpers'
import type { Database } from './types'

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

/** One append-only audit row recorded when an operator resolves a quarantined update. */
export interface QuarantineAuditEventRow {
  readonly id: number
  readonly quarantineId: string
  readonly docId: string
  readonly messageId: string
  readonly deviceId: string
  readonly reason: string
  readonly action: string
  readonly actor: string
  readonly appliedSeq: number | null
  readonly quarantinedAt: number
  readonly resolvedAt: number
}

export async function insertQuarantineAuditEvent(
  db: Kysely<Database>,
  quarantineId: string,
  docKey: string,
  messageId: string,
  deviceId: string,
  reason: string,
  action: string,
  actor: string,
  appliedSeq: number | null,
  quarantinedAt: number,
  resolvedAt: number,
): Promise<void> {
  await db
    .insertInto('quarantine_audit_events')
    .values({
      quarantine_id: quarantineId,
      doc_id: docKey,
      message_id: messageId,
      device_id: deviceId,
      reason,
      action,
      actor,
      applied_seq: appliedSeq,
      quarantined_at: quarantinedAt,
      resolved_at: resolvedAt,
    })
    .execute()
}

/**
 * Lists quarantine audit events newest-first, keyed by the autoincrement row `id`
 * (unique and insertion-ordered, unlike `resolved_at` which can tie).
 *
 * @param cursor When set, only returns events with `id` strictly below it —
 *   i.e. the `id` of the last item from the previous page.
 */
export async function getQuarantineAuditEvents(
  db: Kysely<Database>,
  limit: number,
  cursor: number | undefined,
): Promise<readonly QuarantineAuditEventRow[]> {
  const query = db
    .selectFrom('quarantine_audit_events')
    .select((eb) => [
      eb.ref('id').as('id'),
      eb.ref('quarantine_id').as('quarantineId'),
      eb.ref('doc_id').as('docId'),
      eb.ref('message_id').as('messageId'),
      eb.ref('device_id').as('deviceId'),
      'reason',
      'action',
      'actor',
      eb.ref('applied_seq').as('appliedSeq'),
      eb.ref('quarantined_at').as('quarantinedAt'),
      eb.ref('resolved_at').as('resolvedAt'),
    ])
  return (cursor === undefined ? query : query.where('id', '<', cursor))
    .orderBy('id', 'desc')
    .limit(limit)
    .execute()
}
