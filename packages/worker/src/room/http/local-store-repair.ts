import {
  LocalOutboxRepairEvidenceRequestSchema,
  type LocalOutboxRepairEvidenceResponse,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'

import { getMessageDedupSeq } from '../../db/docRepo'
import { getQuarantinedUpdateByMessage } from '../../db/quarantine-repo'
import { authorizeHttpRequest } from '../../runtime/auth'
import type { VaultRoom } from '../../runtime/room'
import { ensureSchema, getDb } from '../../runtime/storage'
import { apiErrorBody, docKey } from '../../runtime/utils'

/** Returns current durable and quarantine evidence for bounded repair-import candidates. */
export async function handleLocalOutboxRepairEvidence(
  room: VaultRoom,
  c: Context,
): Promise<Response> {
  const db = getDb(room)
  if (db === undefined || room.env.DEVICE_TOKEN_SECRET === undefined) {
    return c.json(apiErrorBody('server/degraded', 'repair-evidence-unavailable'), 503)
  }
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const parsed = v.safeParse(
    LocalOutboxRepairEvidenceRequestSchema,
    await c.req.json().catch(() => undefined),
  )
  if (!parsed.success) {
    return c.json(apiErrorBody('request/invalid', 'invalid-repair-evidence-request'), 400)
  }

  const response: LocalOutboxRepairEvidenceResponse = {
    durableMessages: [],
    quarantinedMessages: [],
  }
  for (const item of parsed.output.items) {
    const key = docKey(item.docId)
    const durable = await getMessageDedupSeq(db, key, item.messageId)
    if (durable !== undefined) {
      response.durableMessages.push({
        docId: item.docId,
        messageId: item.messageId,
        durableSeq: durable.durableSeq,
      })
    }
    const quarantined = await getQuarantinedUpdateByMessage(
      db,
      key,
      item.messageId,
      item.updateSha256,
    )
    if (
      quarantined !== undefined &&
      (item.updateSha256 === undefined || quarantined.updateSha256 === item.updateSha256)
    ) {
      response.quarantinedMessages.push({
        docId: item.docId,
        messageId: item.messageId,
        updateSha256: quarantined.updateSha256,
      })
    }
  }
  return c.json(response, 200)
}
