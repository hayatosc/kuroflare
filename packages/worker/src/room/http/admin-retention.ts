import { type Context } from 'hono'

import { getSnapshotRetentionEvents } from '../../db/checkpointRepo'
import { authorizeHttpRequest } from '../../runtime/auth'
import { getDb, ensureSchema } from '../../runtime/storage'
import { apiErrorBody } from '../../runtime/utils'
import type { VaultRoom } from '../../runtime/vault-room'

export async function handleRetentionInspect(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'retention-inspect-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const limit = parseRetentionEventLimit(c.req.query('limit'))
  const cursor = parseRetentionEventCursor(c.req.query('cursor'))
  if (limit === undefined || (c.req.query('cursor') !== undefined && cursor === undefined)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-retention-pagination'), 400)
  }

  const rows = await getSnapshotRetentionEvents(db, limit + 1, cursor)
  const page = rows.slice(0, limit)
  const lastRow = page.at(-1)
  return c.json(
    {
      items: page.map((row) => ({
        docId: row.docId,
        snapshotKey: row.snapshotKey,
        action: row.action,
        error: row.error,
        attemptedAt: row.attemptedAt,
      })),
      ...(lastRow !== undefined && rows.length > page.length
        ? { nextCursor: String(lastRow.id) }
        : {}),
    },
    200,
  )
}

/** Default/maximum page size and cursor parsing for `GET /admin/retention`. */
function parseRetentionEventLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 50
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 200 ? parsed : undefined
}

function parseRetentionEventCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
