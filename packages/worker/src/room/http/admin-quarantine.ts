import {
  QuarantinedUpdateActionHttpRequestSchema,
  type ApiErrorCode,
  type DeviceId,
  type QuarantinedUpdateActionRequest,
} from '@kuroflare/core'
import { type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as v from 'valibot'

import { getQuarantineAuditEvents } from '../../db/checkpointRepo'
import {
  buildQuarantinedUpdateListResponse,
  buildQuarantinedUpdateDetailResponse,
  effectFromAdminDecision,
  planQuarantinedUpdateActionHttp,
  quarantineConfirmationSubject,
  type QuarantinedUpdateActionHttpRejectReason,
} from '../../http/quarantine'
import { decideQuarantinedUpdateAdmin, type QuarantinedUpdateRecord } from '../../quarantine'
import { authorizeHttpRequest, authorizeHttpRequestWithClaims } from '../../runtime/auth'
import { QUARANTINE_CONFIRMATION_TTL_MS } from '../../runtime/constants'
import {
  admitDocLoad,
  ensureDocHydrated,
  rehydrateAfterApplyFailure,
} from '../../runtime/documents'
import type { VaultRoom } from '../../runtime/room'
import {
  getDb,
  ensureSchema,
  readQuarantinedUpdates,
  readQuarantinedUpdate,
  readQuarantinedUpdateBytes,
  readDocClock,
} from '../../runtime/storage'
import {
  applyUpdate,
  metaSchemaValidAfterUpdate,
  persistQuarantineDiscard,
  persistQuarantineForceApply,
  scheduleCheckpointAfterAppend,
  withDocWriteQueue,
} from '../../runtime/sync'
import {
  apiErrorBody,
  compareCodeUnitString,
  docKey,
  encodeOptionalBase64,
  isStoredQuarantineConfirmation,
  logEvent,
  makeOpaqueToken,
  quarantineAuditEntryFromSqlRow,
  quarantineConfirmationStorageKey,
  retentionErrorMessage,
  sha256Text,
  timingSafeEqualString,
} from '../../runtime/utils'
import { canApplyYjsUpdateToDoc } from '../../sync/yjs'

export async function handleQuarantineList(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'quarantine-inspect-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const limit = parseQuarantinePageLimit(c.req.query('limit'))
  const cursor = parseQuarantineListCursor(c.req.query('cursor'))
  if (limit === undefined || (c.req.query('cursor') !== undefined && cursor === undefined)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-quarantine-pagination'), 400)
  }

  const candidates = [...(await readQuarantinedUpdates(room))]
    .filter(
      (record) =>
        cursor === undefined ||
        record.createdAt < cursor.createdAt ||
        (record.createdAt === cursor.createdAt && record.id < cursor.id),
    )
    .sort(
      (left, right) => right.createdAt - left.createdAt || compareCodeUnitString(right.id, left.id),
    )
  const page = candidates.slice(0, limit)
  const lastRecord = page.at(-1)
  const nextCursor =
    lastRecord !== undefined && candidates.length > page.length
      ? encodeQuarantineListCursor(lastRecord)
      : undefined

  return c.json(buildQuarantinedUpdateListResponse(page, nextCursor), 200)
}

/** Default/maximum page size shared by the quarantine list and audit endpoints. */
function parseQuarantinePageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 50
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 200 ? parsed : undefined
}

function encodeQuarantineListCursor(record: QuarantinedUpdateRecord): string {
  return `${record.createdAt}:${record.id}`
}

function parseQuarantineListCursor(
  value: string | undefined,
): { readonly createdAt: number; readonly id: string } | undefined {
  if (value === undefined) return undefined
  const separatorIndex = value.indexOf(':')
  if (separatorIndex <= 0) return undefined
  const createdAtText = value.slice(0, separatorIndex)
  const id = value.slice(separatorIndex + 1)
  if (!/^[0-9]+$/.test(createdAtText) || id.length === 0) return undefined
  const createdAt = Number(createdAtText)
  return Number.isSafeInteger(createdAt) ? { createdAt, id } : undefined
}

function parseQuarantineAuditCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export async function handleQuarantineDetail(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'quarantine-inspect-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const quarantineId = c.req.param('id') ?? ''
  const record = await readQuarantinedUpdate(room, quarantineId)
  if (record === undefined)
    return c.json(apiErrorBody('request/not-found', 'unknown-quarantine'), 404)

  return c.json(
    buildQuarantinedUpdateDetailResponse(
      record,
      encodeOptionalBase64(await readQuarantinedUpdateBytes(room, quarantineId)),
    ),
    200,
  )
}

/** Lists the resolved-quarantine audit trail (who discarded/force-applied what, and when). */
export async function handleQuarantineAudit(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'quarantine-inspect-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const limit = parseQuarantinePageLimit(c.req.query('limit'))
  const cursor = parseQuarantineAuditCursor(c.req.query('cursor'))
  if (limit === undefined || (c.req.query('cursor') !== undefined && cursor === undefined)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-quarantine-pagination'), 400)
  }

  const rows = await getQuarantineAuditEvents(db, limit + 1, cursor)
  const page = rows.slice(0, limit)
  const lastRow = page.at(-1)
  const items = page.map(quarantineAuditEntryFromSqlRow).filter((entry) => entry !== undefined)

  return c.json(
    {
      items,
      ...(lastRow !== undefined && rows.length > page.length
        ? { nextCursor: String(lastRow.id) }
        : {}),
    },
    200,
  )
}

/** Discards or force-applies a quarantined update after dry-run/execute confirmation. */
export async function handleQuarantineAction(
  room: VaultRoom,
  c: Context,
  action: QuarantinedUpdateActionRequest['action'],
): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'quarantine-action-unavailable'), 503)
  await ensureSchema(room)

  const authorization = await authorizeHttpRequestWithClaims(room, c, ['sync:write'])
  if (authorization.action === 'reject') return authorization.response
  const actor = authorization.claims.sub

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(QuarantinedUpdateActionHttpRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-quarantine-action-request'), 400)

  const quarantineId = c.req.param('id') ?? ''
  const record = await readQuarantinedUpdate(room, quarantineId)
  if (record === undefined)
    return c.json(apiErrorBody('request/not-found', 'unknown-quarantine'), 404)

  const now = Date.now()
  return await withDocWriteQueue(room, record.docId, () =>
    body.mode === 'dry-run'
      ? handleQuarantineActionDryRun(room, c, action, record, now)
      : handleQuarantineActionExecute(room, c, action, record, actor, body.confirmationToken, now),
  )
}

type QuarantineForceApplyRevalidation =
  | {
      readonly ok: true
      readonly latestSeq: number | undefined
      readonly yjsApplySucceeded: boolean
      readonly metaSchemaValid: boolean
      readonly updateBytes: Uint8Array
    }
  | {
      readonly ok: false
      readonly code: ApiErrorCode
      readonly status: ContentfulStatusCode
      readonly detail: string
    }

/**
 * Re-validates a quarantined update against the current document state on a
 * temporary candidate doc (never the live one), matching the same checks the
 * normal sync-update apply path uses.
 */
async function revalidateQuarantineForceApply(
  room: VaultRoom,
  record: QuarantinedUpdateRecord,
): Promise<QuarantineForceApplyRevalidation> {
  if (admitDocLoad(room, record.docId).action === 'degraded') {
    return {
      ok: false,
      code: 'server/degraded',
      status: 503,
      detail: 'quarantine-action-doc-load-degraded',
    }
  }
  try {
    await ensureDocHydrated(room, record.docId)
  } catch {
    return {
      ok: false,
      code: 'server/error',
      status: 500,
      detail: 'quarantine-action-hydrate-failed',
    }
  }
  const updateBytes = await readQuarantinedUpdateBytes(room, record.id)
  if (updateBytes === undefined) {
    return { ok: false, code: 'request/not-found', status: 404, detail: 'unknown-quarantine' }
  }
  const currentDoc = room.docs.get(docKey(record.docId))
  const yjsApplySucceeded =
    currentDoc !== undefined && canApplyYjsUpdateToDoc(currentDoc, updateBytes)
  // decideQuarantinedUpdateAdmin requires a definite boolean: `true` when the
  // meta-schema check does not apply (file docs, or the Yjs apply already
  // failed above and will reject regardless of this value).
  const metaSchemaValid =
    record.docId.kind === 'meta' && yjsApplySucceeded
      ? metaSchemaValidAfterUpdate(room, updateBytes)
      : true
  const clock = await readDocClock(room, record.docId)
  return { ok: true, latestSeq: clock?.latestSeq, yjsApplySucceeded, metaSchemaValid, updateBytes }
}

async function handleQuarantineActionDryRun(
  room: VaultRoom,
  c: Context,
  action: QuarantinedUpdateActionRequest['action'],
  record: QuarantinedUpdateRecord,
  now: number,
): Promise<Response> {
  let latestSeq: number | undefined
  let yjsApplySucceeded: boolean | undefined
  let metaSchemaValid: boolean | undefined
  if (action === 'force-apply') {
    const revalidation = await revalidateQuarantineForceApply(room, record)
    if (!revalidation.ok) {
      return c.json(apiErrorBody(revalidation.code, revalidation.detail), revalidation.status)
    }
    latestSeq = revalidation.latestSeq
    yjsApplySucceeded = revalidation.yjsApplySucceeded
    metaSchemaValid = revalidation.metaSchemaValid
  }

  const decision = decideQuarantinedUpdateAdmin({
    action,
    record,
    now,
    confirmationTokenValid: true,
    latestSeq,
    yjsApplySucceeded,
    metaSchemaValid,
  })
  if (decision.action === 'reject') {
    const mapped = apiErrorForQuarantineActionReject(decision.reason)
    return c.json(apiErrorBody(mapped.code, `quarantine-action:${decision.reason}`), mapped.status)
  }
  if (decision.action === 'inspect') {
    return c.json(apiErrorBody('server/error', 'quarantine-action-unexpected-inspect'), 500)
  }

  const confirmationToken = makeOpaqueToken()
  const subject = quarantineConfirmationSubject(action, record.id)
  await room.state.storage.put(quarantineConfirmationStorageKey(subject), {
    subject,
    tokenHash: await sha256Text(confirmationToken),
    expiresAt: now + QUARANTINE_CONFIRMATION_TTL_MS,
  })

  return c.json(
    {
      action,
      id: record.id,
      mode: 'dry-run',
      confirmationRequired: true,
      confirmationToken,
      effects: [effectFromAdminDecision(decision)],
    },
    200,
  )
}

async function handleQuarantineActionExecute(
  room: VaultRoom,
  c: Context,
  action: QuarantinedUpdateActionRequest['action'],
  record: QuarantinedUpdateRecord,
  actor: DeviceId,
  confirmationToken: string,
  now: number,
): Promise<Response> {
  let latestSeq: number | undefined
  let yjsApplySucceeded: boolean | undefined
  let metaSchemaValid: boolean | undefined
  let updateBytes: Uint8Array | undefined
  if (action === 'force-apply') {
    const revalidation = await revalidateQuarantineForceApply(room, record)
    if (!revalidation.ok) {
      return c.json(apiErrorBody(revalidation.code, revalidation.detail), revalidation.status)
    }
    latestSeq = revalidation.latestSeq
    yjsApplySucceeded = revalidation.yjsApplySucceeded
    metaSchemaValid = revalidation.metaSchemaValid
    updateBytes = revalidation.updateBytes
  }

  const subject = quarantineConfirmationSubject(action, record.id)
  const storageKey = quarantineConfirmationStorageKey(subject)
  const stored = await room.state.storage.get(storageKey)
  const confirmation = isStoredQuarantineConfirmation(stored)
    ? {
        subject: stored.subject,
        expiresAt: stored.expiresAt,
        tokenHashMatches: timingSafeEqualString(
          stored.tokenHash,
          await sha256Text(confirmationToken),
        ),
      }
    : undefined

  const plan = planQuarantinedUpdateActionHttp({
    request: { action, confirmationToken, reason: undefined },
    record,
    now,
    confirmation,
    latestSeq,
    yjsApplySucceeded,
    metaSchemaValid,
  })
  if (plan.action === 'reject') {
    const mapped = apiErrorForQuarantineActionReject(plan.reason)
    return c.json(apiErrorBody(mapped.code, `quarantine-action:${plan.reason}`), mapped.status)
  }

  // Single-use: burn the confirmation token before performing the mutation.
  await room.state.storage.delete(storageKey)

  if (plan.adminDecision.action === 'discard') {
    await persistQuarantineDiscard(room, record, plan.adminDecision.deletePatch, actor)
  } else {
    if (updateBytes === undefined) {
      return c.json(apiErrorBody('server/error', 'quarantine-action-missing-revalidation'), 500)
    }
    await persistQuarantineForceApply(
      room,
      record,
      updateBytes,
      plan.adminDecision.opLogAppend,
      plan.adminDecision.docPatch,
      plan.adminDecision.deletePatch,
      actor,
    )
    try {
      applyUpdate(room, record.docId, updateBytes)
    } catch (error) {
      logEvent('quarantine-apply-failed', {
        vaultId: room.vaultId,
        docId: record.docId,
        quarantineId: record.id,
        error: retentionErrorMessage(error),
      })
      try {
        await rehydrateAfterApplyFailure(room, record.docId)
      } catch (rehydrateError) {
        logEvent('quarantine-rehydrate-failed', {
          vaultId: room.vaultId,
          docId: record.docId,
          quarantineId: record.id,
          error: retentionErrorMessage(rehydrateError),
        })
      }
    }
    try {
      await scheduleCheckpointAfterAppend(
        room,
        record.docId,
        plan.adminDecision.docPatch.latestSeq,
        now,
      )
    } catch (error) {
      logEvent('checkpoint-schedule-failed', {
        vaultId: room.vaultId,
        docId: record.docId,
        latestSeq: plan.adminDecision.docPatch.latestSeq,
        error: retentionErrorMessage(error),
      })
    }
  }

  return c.json(plan.response, 200)
}

/** Maps a quarantine action rejection reason to its guarded `ApiError` code and HTTP status. */
function apiErrorForQuarantineActionReject(reason: QuarantinedUpdateActionHttpRejectReason): {
  readonly code: ApiErrorCode
  readonly status: ContentfulStatusCode
} {
  switch (reason) {
    case 'unknown-quarantine':
      return { code: 'request/not-found', status: 404 }
    case 'revalidation-failed':
      return { code: 'request/conflict', status: 409 }
    case 'missing-token':
    case 'token-mismatch':
    case 'subject-mismatch':
    case 'token-expired':
    case 'confirmation-required':
      return { code: 'request/invalid', status: 400 }
    default:
      return { code: 'server/error', status: 500 }
  }
}
