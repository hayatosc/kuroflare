import {
  CURRENT_PROTOCOL_VERSION,
  DeviceTokenRefreshRequestSchema,
  DeviceIdSchema,
  hashBytesSha256,
  makeSha256Hex,
  QuarantinedUpdateActionHttpRequestSchema,
  RevokeDeviceRequestSchema,
  SetupExchangeRequestSchema,
  SnapshotImportRequestSchema,
  SnapshotHealthQuarantineRequestSchema,
  SnapshotHealthListResponseSchema,
  SnapshotHealthMutationResponseSchema,
  SnapshotHealthVerifyRequestSchema,
  SnapshotRollbackRequestSchema,
  SnapshotRollbackResponseSchema,
  Sha256HexSchema,
  type QuarantinedUpdateActionRequest,
  type SnapshotHealthEntry,
  YDocIdSchema,
  signHs256DeviceToken,
  type ApiErrorCode,
  type DeviceId,
  type DeviceTokenClaims,
  type DocId,
} from '@kuroflare/core'
import { type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as v from 'valibot'
import * as Y from 'yjs'

import {
  getSnapshotRetentionEvents,
  getSnapshotRetentionCheckpointRuns,
  getQuarantineAuditEvents,
  insertCheckpointRun,
  updateCheckpointR2Written,
  updateCheckpointPointerUpdated,
  updateCheckpointFailed,
  insertSnapshotExpectedEvidence,
  insertSnapshotHealthEvent,
  getAllLatestSnapshotHealthEvents,
  getLatestSnapshotHealthEvent,
} from '../db/checkpointRepo'
import { insertDoc, updateDocSnapshotPointer } from '../db/docRepo'
import { getOpLogUpdatesBetween } from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import { upsertSetupToken } from '../db/setupRepo'
import {
  decideSetupExchange,
  decideRevokeDevice,
  planSetupExchangeCredentials,
  decideDeviceTokenRefresh,
  planDeviceRefreshTokenRotation,
  type DeviceTokenRefreshDecision,
} from '../devices'
import { decideSetupTokenConsume } from '../devices/tokens'
import { planDeviceTokenRefreshHttpResponse } from '../http/authRefresh'
import { planRevokeDeviceHttpResponse } from '../http/device'
import {
  buildQuarantinedUpdateListResponse,
  buildQuarantinedUpdateDetailResponse,
  effectFromAdminDecision,
  planQuarantinedUpdateActionHttp,
  quarantineConfirmationSubject,
  type QuarantinedUpdateActionHttpRejectReason,
} from '../http/quarantine'
import { planSetupExchangeHttpResponse } from '../http/setup'
import { decideQuarantinedUpdateAdmin, type QuarantinedUpdateRecord } from '../quarantine'
import {
  verifySnapshotObject,
  SNAPSHOT_HEALTH_SYSTEM_ACTORS,
  type SnapshotVerificationExpectedEvidence,
} from '../sync/snapshot-health'
import {
  makeSnapshotListPrefix,
  makeSnapshotObjectKey,
  type SnapshotCandidate,
} from '../sync/snapshots'
import { authorizeHttpRequest, authorizeHttpRequestWithClaims, rememberSocketToken } from './auth'
import {
  QUARANTINE_CONFIRMATION_TTL_MS,
  REFRESH_ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SETUP_ACCESS_TOKEN_TTL_MS,
  SETUP_REFRESH_TOKEN_TTL_MS,
  WEBSOCKET_UPGRADE,
} from './constants'
import {
  getDb,
  ensureSchema,
  readDeviceRegistryEntry,
  readSetupToken,
  readRefreshToken,
  readQuarantinedUpdates,
  readQuarantinedUpdate,
  readQuarantinedUpdateBytes,
  hasAnyPersistedDocs,
  consumeSetupToken,
  persistSetupDevice,
  persistRefreshToken,
  revokeRefreshToken,
  persistDeviceRevocation,
  withSqlTransaction,
  readDocClock,
  readSyncRequestDocState,
  readSnapshotPointer,
} from './storage'
import {
  admitDocLoad,
  applyUpdate,
  appendSnapshotVerificationEventPreservingLogical,
  ensureDocHydrated,
  listR2Objects,
  metaSchemaValidAfterUpdate,
  persistQuarantineDiscard,
  persistQuarantineForceApply,
  rehydrateAfterApplyFailure,
  rehydrateAfterDocPointer,
  scheduleCheckpointAfterAppend,
  withDocWriteQueue,
} from './sync'
import type { RuntimeWebSocketPairConstructor, WebSocketResponseInit } from './types'
import { AdminSetupTokenIssueRequestSchema, AdminSnapshotSeedRequestSchema } from './types'
import {
  apiErrorBody,
  compareCodeUnitString,
  docKey,
  canApplyYjsUpdate,
  canApplyYjsUpdateToDoc,
  decodeBase64,
  encodeBase64,
  encodeOptionalBase64,
  extractWebSocketBearerToken,
  isStoredQuarantineConfirmation,
  makeOpaqueToken,
  makeGeneratedDeviceId,
  quarantineAuditEntryFromSqlRow,
  quarantineConfirmationStorageKey,
  sha256Text,
  sha256Hex,
  logEvent,
  metaYDocSchemaDisposition,
  metaYDocWritable,
  metaIdentityImmutable,
  metaRootMutationAllowed,
  retentionErrorMessage,
  timingSafeEqualString,
} from './utils'
import type { VaultRoom } from './vault-room'

declare const WebSocketPair: RuntimeWebSocketPairConstructor | undefined

export async function handleAdminSetupTokenIssue(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  if (db === undefined)
    return c.json(apiErrorBody('server/degraded', 'admin-setup-token-issue-unavailable'), 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(AdminSetupTokenIssueRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-setup-token-issue-request'), 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  room.vaultId = body.vaultId

  const now = Date.now()
  const expiresAt = now + (body.expiresInMs ?? 10 * 60 * 1_000)
  const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
  await upsertSetupToken(db, setupTokenHash, body.vaultId, now, expiresAt)

  return c.json(
    {
      ok: true,
      vaultId: body.vaultId,
      expiresAt,
      tokenReadable: (await readSetupToken(room, setupTokenHash)) !== undefined,
    },
    200,
  )
}

export async function handleAdminSnapshotSeed(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'admin-snapshot-seed-unavailable'), 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(AdminSnapshotSeedRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-snapshot-seed-request'), 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  room.vaultId = body.vaultId

  const update = decodeBase64(body.update)
  if (update === null || !canApplyYjsUpdate(update))
    return c.json(apiErrorBody('request/invalid', 'invalid-admin-snapshot-seed-update'), 400)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  const stateVector = Y.encodeStateVector(doc)
  doc.destroy()

  const now = Date.now()
  const latestSeq = body.latestSeq ?? 1
  const snapshotKey = makeSnapshotObjectKey(body.vaultId, body.docId, latestSeq)
  const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(update))
  const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVector))
  await insertSnapshotExpectedEvidence(
    db,
    {
      docId: body.docId,
      snapshotKey,
      upperSeq: latestSeq,
      actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.import,
      expectedByteLength: update.byteLength,
      expectedUpdateSha256,
      expectedStateVectorSha256,
    },
    now,
  )
  await bucket.put(snapshotKey, update)
  await insertSnapshotHealthEvent(db, {
    docId: docKey(body.docId),
    snapshotKey,
    upperSeq: latestSeq,
    event: 'verification',
    actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
    authorityStatus: 'authoritative',
    expectedByteLength: update.byteLength,
    expectedUpdateSha256,
    expectedStateVectorSha256,
    actualByteLength: update.byteLength,
    actualUpdateSha256: expectedUpdateSha256,
    actualStateVectorSha256: expectedStateVectorSha256,
    physicalStatus: 'verified',
    logicalStatus: 'healthy',
    observedAt: now,
  })
  await insertDoc(
    db,
    docKey(body.docId),
    body.docId.kind,
    latestSeq,
    latestSeq,
    snapshotKey,
    stateVector,
    0,
    now,
  )

  return c.json({ ok: true, vaultId: body.vaultId, docId: body.docId, snapshotKey }, 200)
}

export async function handleSetupExchange(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'setup-exchange-unavailable'), 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SetupExchangeRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-setup-exchange-request'), 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  room.vaultId = body.vaultId

  const now = Date.now()
  const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
  const tokenDecision = decideSetupTokenConsume({
    token: await readSetupToken(room, setupTokenHash),
    requestedVaultId: body.vaultId,
    now,
  })
  if (tokenDecision.action === 'reject')
    return c.json(apiErrorBody('auth/rejected', `setup-token:${tokenDecision.reason}`), 403)

  const existingDevice =
    body.existingDeviceId === undefined
      ? undefined
      : await readDeviceRegistryEntry(room, body.existingDeviceId)
  const setupDecision = decideSetupExchange({
    requestedDeviceId: body.existingDeviceId,
    registry: { existingDevice },
  })
  if (setupDecision.action === 'reject')
    return c.json(apiErrorBody('auth/rejected', `setup-exchange:${setupDecision.reason}`), 403)

  const deviceId = body.existingDeviceId ?? makeGeneratedDeviceId()
  const refreshToken = makeOpaqueToken()
  const refreshTokenHash = makeSha256Hex(await sha256Text(refreshToken))
  const credentialPlan = planSetupExchangeCredentials({
    setupDecision,
    deviceId,
    refreshTokenHash,
    now,
    refreshTokenExpiresAt: now + SETUP_REFRESH_TOKEN_TTL_MS,
  })
  if (credentialPlan.action === 'reject')
    return c.json(apiErrorBody('server/error', `setup-credentials:${credentialPlan.reason}`), 500)

  const claims: DeviceTokenClaims = {
    iss: 'kuroflare-worker',
    aud: body.vaultId,
    sub: credentialPlan.deviceId,
    scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
    iat: now,
    exp: now + SETUP_ACCESS_TOKEN_TTL_MS,
    tokenVersion: credentialPlan.tokenVersion,
  }
  const accessToken = await signHs256DeviceToken({ claims, secret })
  const responsePlan = planSetupExchangeHttpResponse({
    credentialPlan,
    endpoint: new URL(c.req.url).origin,
    vaultId: body.vaultId,
    accessToken,
    refreshToken,
    accessTokenIssuedAt: claims.iat,
    accessTokenExpiresAt: claims.exp,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    bootstrapMode: (await hasAnyPersistedDocs(room)) ? 'join-existing' : 'new-vault',
  })
  if (responsePlan.action === 'reject')
    return c.json(apiErrorBody('server/error', `setup-response:${responsePlan.reason}`), 500)

  try {
    await withSqlTransaction(room, async () => {
      await consumeSetupToken(room, setupTokenHash, tokenDecision.consumedAt)
      await persistSetupDevice(room, credentialPlan.deviceId, now)
      await persistRefreshToken(
        room,
        credentialPlan.insertRefreshToken.tokenHash,
        credentialPlan.insertRefreshToken.deviceId,
        credentialPlan.insertRefreshToken.issuedAt,
        credentialPlan.insertRefreshToken.expiresAt,
      )
    })
  } catch (error) {
    console.error('[kuroflare] setup exchange persist failed', error)
    return c.json(apiErrorBody('server/error', 'setup-persist:transaction-failed'), 500)
  }

  return c.json(responsePlan.response, 200)
}

export async function handleAuthRefresh(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'auth-refresh-unavailable'), 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(DeviceTokenRefreshRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-auth-refresh-request'), 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json(apiErrorBody('auth/rejected', 'vault-mismatch'), 400)
  room.vaultId = body.vaultId

  const now = Date.now()
  const currentTokenHash = makeSha256Hex(await sha256Text(body.refreshToken))
  const device = await readDeviceRegistryEntry(room, body.deviceId)
  const refreshDecision = decideDeviceTokenRefresh({
    device,
    refreshToken: await readRefreshToken(room, currentTokenHash),
    previousTokenVersion: body.previousTokenVersion,
    now,
  })
  if (refreshDecision.action === 'reject')
    return c.json(
      apiErrorBody(
        apiErrorCodeForDeviceTokenRefresh(refreshDecision.reason),
        `auth-refresh:${refreshDecision.reason}`,
      ),
      403,
    )

  const nextRefreshToken = makeOpaqueToken()
  const nextRefreshTokenHash = makeSha256Hex(await sha256Text(nextRefreshToken))
  const rotationPlan = planDeviceRefreshTokenRotation({
    refreshDecision,
    currentTokenHash,
    nextTokenHash: nextRefreshTokenHash,
    deviceId: body.deviceId,
    now,
    nextExpiresAt: now + REFRESH_TOKEN_TTL_MS,
  })
  if (rotationPlan.action === 'reject')
    return c.json(apiErrorBody('server/error', `auth-refresh-rotation:${rotationPlan.reason}`), 500)

  const claims: DeviceTokenClaims = {
    iss: 'kuroflare-worker',
    aud: body.vaultId,
    sub: body.deviceId,
    scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
    iat: now,
    exp: now + REFRESH_ACCESS_TOKEN_TTL_MS,
    tokenVersion: refreshDecision.tokenVersion,
  }
  const accessToken = await signHs256DeviceToken({ claims, secret })
  const responsePlan = planDeviceTokenRefreshHttpResponse({
    refreshDecision,
    rotationPlan,
    vaultId: body.vaultId,
    accessToken,
    refreshToken: nextRefreshToken,
    accessTokenIssuedAt: claims.iat,
    accessTokenExpiresAt: claims.exp,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
  })
  if (responsePlan.action === 'reject')
    return c.json(apiErrorBody('server/error', `auth-refresh-response:${responsePlan.reason}`), 500)

  try {
    await withSqlTransaction(room, async () => {
      await revokeRefreshToken(room, rotationPlan.revoke.tokenHash, rotationPlan.revoke.revokedAt)
      await persistRefreshToken(
        room,
        rotationPlan.insert.tokenHash,
        rotationPlan.insert.deviceId,
        rotationPlan.insert.issuedAt,
        rotationPlan.insert.expiresAt,
      )
    })
  } catch {
    return c.json(apiErrorBody('server/error', 'auth-refresh-persist:transaction-failed'), 500)
  }

  return c.json(responsePlan.response, 200)
}

/** Maps a device-token refresh rejection to its guarded `ApiError` code. */
function apiErrorCodeForDeviceTokenRefresh(
  reason: Extract<DeviceTokenRefreshDecision, { readonly action: 'reject' }>['reason'],
): ApiErrorCode {
  switch (reason) {
    case 'refresh-token-expired':
      return 'auth/expired'
    case 'device-revoked':
    case 'stale-token':
    case 'refresh-token-revoked':
      return 'auth/revoked'
    default:
      return 'auth/rejected'
  }
}

export async function handleDeviceRevoke(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'device-revoke-unavailable'), 503)
  await ensureSchema(room)

  const rawDeviceId = c.req.param('deviceId')
  const targetDeviceId = v.is(DeviceIdSchema, rawDeviceId) ? rawDeviceId : undefined
  if (targetDeviceId === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-device-id'), 400)
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(RevokeDeviceRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-revoke-device-request'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const targetDevice = await readDeviceRegistryEntry(room, targetDeviceId)
  const revokeDecision = decideRevokeDevice({ device: targetDevice, revokedAt: Date.now() })
  if (revokeDecision.action === 'reject')
    return c.json(apiErrorBody('request/not-found', `revoke-device:${revokeDecision.reason}`), 404)

  const responsePlan = planRevokeDeviceHttpResponse({ revokeDecision, deviceId: targetDeviceId })
  if (responsePlan.action === 'reject')
    return c.json(
      apiErrorBody('server/error', `revoke-device-response:${responsePlan.reason}`),
      500,
    )

  if (revokeDecision.action === 'revoke-device') {
    await persistDeviceRevocation(
      room,
      targetDeviceId,
      revokeDecision.tokenVersion,
      revokeDecision.revokedAt,
    )
  }

  return c.json(responsePlan.response, 200)
}

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
  const items = page
    .map(quarantineAuditEntryFromSqlRow)
    .filter((entry) => entry !== undefined)

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
    return { ok: false, code: 'server/error', status: 500, detail: 'quarantine-action-hydrate-failed' }
  }
  const updateBytes = await readQuarantinedUpdateBytes(room, record.id)
  if (updateBytes === undefined) {
    return { ok: false, code: 'request/not-found', status: 404, detail: 'unknown-quarantine' }
  }
  const currentDoc = room.docs.get(docKey(record.docId))
  const yjsApplySucceeded = currentDoc !== undefined && canApplyYjsUpdateToDoc(currentDoc, updateBytes)
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

export async function handleMetaLatest(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-fetch-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:read'])
  if (rejection !== undefined) return rejection

  return handleLatestSnapshotRequest(room, c, { kind: 'meta' })
}

export async function handleFileLatest(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-fetch-unavailable'), 503)
  await ensureSchema(room)

  const rawYDocId = c.req.param('ydocId')
  if (!v.is(YDocIdSchema, rawYDocId))
    return c.json(apiErrorBody('request/invalid', 'invalid-ydoc-id'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:read'])
  if (rejection !== undefined) return rejection

  return handleLatestSnapshotRequest(room, c, { kind: 'file', ydocId: rawYDocId })
}

export async function handleMetaSnapshotImport(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-import-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return handleSnapshotImportRequest(room, c, { kind: 'meta' })
}

export async function handleFileSnapshotImport(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-import-unavailable'), 503)
  await ensureSchema(room)

  const rawYDocId = c.req.param('ydocId')
  if (!v.is(YDocIdSchema, rawYDocId))
    return c.json(apiErrorBody('request/invalid', 'invalid-ydoc-id'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return handleSnapshotImportRequest(room, c, { kind: 'file', ydocId: rawYDocId })
}

async function handleLatestSnapshotRequest(
  room: VaultRoom,
  c: Context,
  docId: DocId,
): Promise<Response> {
  const clock = await readDocClock(room, docId)
  if (clock === undefined) return c.json(apiErrorBody('snapshot/not-found', 'doc-not-found'), 404)

  if (admitDocLoad(room, docId).action === 'degraded') {
    return c.json(apiErrorBody('server/degraded', 'doc-load-degraded'), 503)
  }
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    logEvent('snapshot-hydrate-failed', {
      vaultId: room.vaultId,
      docId,
      error: retentionErrorMessage(error),
    })
    return c.json(apiErrorBody('server/error', 'snapshot-hydrate-failed'), 500)
  }

  const doc = room.docs.get(docKey(docId))
  const vaultId = room.vaultId
  if (doc === undefined || vaultId === undefined)
    return c.json(apiErrorBody('snapshot/not-found', 'doc-not-found'), 404)

  const updateBytes = Y.encodeStateAsUpdate(doc)
  const stateVectorBytes = Y.encodeStateVector(doc)
  const snapshotKey = makeSnapshotObjectKey(vaultId, docId, clock.latestSeq)
  const body = {
    manifestSeq: clock.latestSeq,
    snapshotKey,
    snapshotSeq: clock.latestSeq,
    updateSha256: makeSha256Hex(await sha256Hex(updateBytes)),
    stateVectorSha256: makeSha256Hex(await sha256Hex(stateVectorBytes)),
    stateVector: encodeBase64(stateVectorBytes),
    updateBytesBase64: encodeBase64(updateBytes),
  }
  return c.json(docId.kind === 'meta' ? body : { ...body, docId }, 200)
}

async function handleSnapshotImportRequest(
  room: VaultRoom,
  c: Context,
  docId: DocId,
): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (db === undefined || bucket === undefined || vaultId === undefined)
    return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotImportRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-request'), 400)
  if (docId.kind === 'meta' && body.metadataSchemaVersion !== 2) {
    return c.json(apiErrorBody('request/invalid', 'metadata-schema-v2-evidence-required'), 400)
  }

  const update = decodeBase64(body.updateBytesBase64)
  if (update === null || !canApplyYjsUpdate(update))
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-update'), 400)

  return await withDocWriteQueue(room, docId, async () => {
    let existingLatestSeq: number
    try {
      existingLatestSeq = (await readDocClock(room, docId))?.latestSeq ?? 0
    } catch {
      return c.json(apiErrorBody('server/error', 'snapshot-import-hydrate-failed'), 500)
    }
    if (existingLatestSeq > 0 && body.latestSeq === undefined) {
      return c.json(
        {
          ...apiErrorBody('request/conflict', 'snapshot-import-latest-seq-required'),
          latestSeq: existingLatestSeq,
        },
        409,
      )
    }
    if (body.latestSeq !== undefined && body.latestSeq !== existingLatestSeq) {
      return c.json(
        {
          ...apiErrorBody('request/conflict', 'snapshot-import-stale-seq'),
          latestSeq: existingLatestSeq,
        },
        409,
      )
    }
    const initialSnapshotKey = makeSnapshotObjectKey(vaultId, docId, existingLatestSeq + 1)
    if ((await bucket.head(initialSnapshotKey)) !== null) {
      return c.json(apiErrorBody('request/conflict', 'snapshot-import-target-exists'), 409)
    }
    if (admitDocLoad(room, docId).action === 'degraded') {
      return c.json(apiErrorBody('server/degraded', 'doc-load-degraded'), 503)
    }
    try {
      await ensureDocHydrated(room, docId)
    } catch {
      return c.json(apiErrorBody('server/error', 'snapshot-import-hydrate-failed'), 500)
    }

    const key = docKey(docId)
    const importedDoc = new Y.Doc()
    const existingDoc = room.docs.get(key)
    if (
      docId.kind === 'meta' &&
      existingDoc !== undefined &&
      !['supported-v2', 'legacy-v1'].includes(metaYDocSchemaDisposition(existingDoc))
    ) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-meta-schema'), 400)
    }
    if (!canApplyYjsUpdateToDoc(existingDoc ?? importedDoc, update)) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-update'), 400)
    }
    if (existingDoc !== undefined) Y.applyUpdate(importedDoc, Y.encodeStateAsUpdate(existingDoc))
    Y.applyUpdate(importedDoc, update)
    if (
      docId.kind === 'meta' &&
      (!metaYDocWritable(importedDoc) ||
        (existingDoc !== undefined &&
          (!metaIdentityImmutable(existingDoc, importedDoc) ||
            !metaRootMutationAllowed(existingDoc, update, true))))
    ) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-import-meta-schema'), 400)
    }
    const mergedBytes = Y.encodeStateAsUpdate(importedDoc)
    const stateVector = Y.encodeStateVector(importedDoc)

    const now = Date.now()
    const snapshotSeq = existingLatestSeq + 1
    const snapshotKey = makeSnapshotObjectKey(vaultId, docId, snapshotSeq)
    if ((await bucket.head(snapshotKey)) !== null) {
      importedDoc.destroy()
      return c.json(apiErrorBody('request/conflict', 'snapshot-import-target-exists'), 409)
    }
    const runId = `checkpoint:import:${snapshotKey}:${now}`
    let pointerPersisted = false
    try {
      await insertCheckpointRun(
        db,
        runId,
        key,
        snapshotSeq,
        snapshotKey,
        stateVector,
        'writing',
        now,
      )
      const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(mergedBytes))
      const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(stateVector))
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId,
          snapshotKey,
          upperSeq: snapshotSeq,
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.import,
          expectedByteLength: mergedBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
        },
        now,
      )
      await bucket.put(snapshotKey, mergedBytes)
      const verification = await verifySnapshotObject(bucket, snapshotKey, docId, {
        byteLength: mergedBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      })
      const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        docId,
        { key: snapshotKey, upperSeq: snapshotSeq, healthy: true },
        verification,
        {
          byteLength: mergedBytes.byteLength,
          updateSha256: expectedUpdateSha256,
          stateVectorSha256: expectedStateVectorSha256,
        },
      )
      if (verification.status !== 'verified' || logicalStatus === 'quarantined') {
        await updateCheckpointFailed(db, runId)
        throw new Error(`snapshot-verification-failed:${verification.reasons.join(',')}`)
      }
      await updateCheckpointR2Written(db, runId, now)
      let pointerInvalidated = false
      await withSqlTransaction(room, async () => {
        const latest = await getLatestSnapshotHealthEvent(db, key, snapshotKey)
        if (
          latest?.logicalStatus !== 'healthy' ||
          latest?.physicalStatus !== 'verified' ||
          latest.expectedByteLength !== mergedBytes.byteLength ||
          latest.expectedUpdateSha256 !== expectedUpdateSha256 ||
          latest.expectedStateVectorSha256 !== expectedStateVectorSha256
        ) {
          pointerInvalidated = true
          await updateCheckpointFailed(db, runId)
          return
        }
        await insertDoc(
          db,
          key,
          docId.kind,
          snapshotSeq,
          snapshotSeq,
          snapshotKey,
          stateVector,
          0,
          now,
        )
        pointerPersisted = true
      })
      if (pointerInvalidated) {
        importedDoc.destroy()
        return c.json(apiErrorBody('request/conflict', 'snapshot-import-target-changed'), 409)
      }
      await updateCheckpointPointerUpdated(db, runId, now)
      await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        docId,
        { key: snapshotKey, upperSeq: snapshotSeq, healthy: true },
        verification,
        {
          byteLength: mergedBytes.byteLength,
          updateSha256: expectedUpdateSha256,
          stateVectorSha256: expectedStateVectorSha256,
        },
        'authoritative',
      )
    } catch (error) {
      const pointerAdvanced =
        pointerPersisted ||
        (await snapshotPointerMatchesImport(room, docId, snapshotSeq, snapshotKey))
      if (pointerAdvanced) {
        await activateImportedDoc(room, docId, importedDoc)
      } else {
        importedDoc.destroy()
      }
      throw error
    }
    room.docs.set(key, importedDoc)
    room.hydratedDocs.add(key)

    return c.json({ ok: true, vaultId, docId, snapshotKey, snapshotSeq }, 200)
  })
}

async function snapshotPointerMatchesImport(
  room: VaultRoom,
  docId: DocId,
  snapshotSeq: number,
  snapshotKey: string,
): Promise<boolean> {
  try {
    const pointer = await readSnapshotPointer(room, docId)
    return pointer?.latestSnapshotSeq === snapshotSeq && pointer.latestSnapshotKey === snapshotKey
  } catch {
    return false
  }
}

async function activateImportedDoc(
  room: VaultRoom,
  docId: DocId,
  importedDoc: Y.Doc,
): Promise<void> {
  const key = docKey(docId)
  const inFlight = room.hydrationInFlight.get(key)
  if (inFlight !== undefined) {
    try {
      await inFlight
    } catch (error) {
      // The stale hydration is superseded by the durable imported snapshot.
      logEvent('snapshot-import-stale-hydration-failed', {
        vaultId: room.vaultId,
        docId,
        error: retentionErrorMessage(error),
      })
    }
  }
  const current = room.docs.get(key)
  room.docs.delete(key)
  room.hydratedDocs.delete(key)
  if (inFlight !== undefined && room.hydrationInFlight.get(key) === inFlight) {
    room.hydrationInFlight.delete(key)
  }
  current?.destroy()
  room.docs.set(key, importedDoc)
  room.hydratedDocs.add(key)
}

/** Lists paginated snapshot health generations for an authenticated operator. */
export async function handleSnapshotHealthList(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined)
    return c.json(apiErrorBody('server/degraded', 'snapshot-health-inspect-unavailable'), 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const docId = parseSnapshotHealthDocId(c.req.query('docId'))
  if (docId === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-doc-id'), 400)
  const limit = parseSnapshotHealthLimit(c.req.query('limit'))
  const cursor = parseSnapshotHealthCursor(c.req.query('cursor'))
  if (limit === undefined || (c.req.query('cursor') !== undefined && cursor === undefined)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-pagination'), 400)
  }

  const latestRows = await collectSnapshotHealthRows(room, db, docId)
  const actionContext = await readSnapshotHealthActionContext(room, db, docId, latestRows)
  const candidates = latestRows
    .filter((row) => cursor === undefined || row.upperSeq < cursor)
    .sort(
      (left, right) =>
        right.upperSeq - left.upperSeq || (left.snapshotKey < right.snapshotKey ? -1 : 1),
    )
  const page = candidates.slice(0, limit)
  const lastPageRow = page.at(-1)
  const response = {
    entries: page.map((row) => snapshotHealthEntryFromRow(row, actionContext)),
    ...(lastPageRow !== undefined && candidates.length > page.length
      ? { nextCursor: String(lastPageRow.upperSeq) }
      : {}),
  }
  if (!v.is(SnapshotHealthListResponseSchema, response)) {
    return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
  }
  return c.json(response, 200)
}

/** Explicitly verifies and approves one legacy or unverified snapshot. */
export async function handleSnapshotHealthVerify(room: VaultRoom, c: Context): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotHealthVerifyRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-health-verify-request'), 400)
  }
  if (!snapshotHealthRouteDocMatches(c.req.param('docId'), body.docId)) {
    return c.json(apiErrorBody('request/invalid', 'snapshot-health-doc-mismatch'), 400)
  }
  const admission = await admitSnapshotHealthMutation(
    room,
    c,
    body.docId,
    body.snapshotKey,
    body.upperSeq,
  )
  if (admission.response !== undefined) return admission.response
  const { db, bucket, candidate, actor } = admission
  const persisted = await readSyncRequestDocState(room, body.docId)
  const recoverMissingDoc = persisted === undefined
  if (
    !recoverMissingDoc &&
    (candidate.upperSeq < persisted.minRetainedSeq || candidate.upperSeq > persisted.latestSeq)
  ) {
    return c.json(apiErrorBody('request/conflict', 'snapshot-health-approval-out-of-range'), 409)
  }
  const pointer = await readSnapshotPointer(room, body.docId)
  const pointerMatches =
    pointer?.latestSnapshotSeq === candidate.upperSeq && pointer.latestSnapshotKey === candidate.key
  const matchingRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))).filter(
    (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
  )
  const initialRunState = snapshotHealthRunState(matchingRuns)
  const hasCompletedRun = matchingRuns.some(
    (run) =>
      run.status === 'pointer-updated' || run.status === 'compacted' || run.status === 'completed',
  )
  if (!recoverMissingDoc && !pointerMatches && !hasCompletedRun) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-approval-not-authoritative'),
      409,
    )
  }
  const existingLatest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
  if (
    existingLatest?.authorityStatus === 'authoritative' &&
    existingLatest.physicalStatus === 'verified' &&
    existingLatest.logicalStatus === 'healthy'
  ) {
    const hasRunEvidence = matchingRuns.some(
      (run) => run.status !== 'failed' && run.stateVector !== null,
    )
    if (!recoverMissingDoc && !hasRunEvidence) {
      const runBackfilled = await backfillSnapshotHealthCheckpointRun(
        room,
        db,
        body.docId,
        candidate,
        existingLatest,
        pointerMatches ? pointer?.stateVector : undefined,
      )
      if (!runBackfilled) {
        // Do not manufacture checkpoint evidence from an authority row alone;
        // continue through the full R2 verification path below.
      } else {
        const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
        const response = {
          ok: true as const,
          entry: snapshotHealthEntryFromRow(existingLatest, actionContext),
        }
        if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
          return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
        }
        return c.json(response, 200)
      }
    } else if (!recoverMissingDoc) {
      const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
      const response = {
        ok: true as const,
        entry: snapshotHealthEntryFromRow(existingLatest, actionContext),
      }
      if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
        return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
      }
      return c.json(response, 200)
    }
  }
  let pendingEventId: number | undefined
  let pendingExpected: SnapshotVerificationExpectedEvidence | undefined
  let pendingRejectedByQuarantine = false
  let pendingRejectedByAuthority = false
  await withDocWriteQueue(room, body.docId, async () => {
    await withSqlTransaction(room, async () => {
      const commitPersisted = await readSyncRequestDocState(room, body.docId)
      const commitRecovery = commitPersisted === undefined
      if (recoverMissingDoc !== commitRecovery) {
        pendingRejectedByAuthority = true
        return
      }
      if (
        !commitRecovery &&
        (candidate.upperSeq < commitPersisted.minRetainedSeq ||
          candidate.upperSeq > commitPersisted.latestSeq ||
          commitPersisted.latestSeq !== persisted?.latestSeq ||
          commitPersisted.minRetainedSeq !== persisted?.minRetainedSeq)
      ) {
        pendingRejectedByAuthority = true
        return
      }
      const commitPointer = await readSnapshotPointer(room, body.docId)
      if (
        pointer?.latestSnapshotSeq !== commitPointer?.latestSnapshotSeq ||
        pointer?.latestSnapshotKey !== commitPointer?.latestSnapshotKey
      ) {
        pendingRejectedByAuthority = true
        return
      }
      const commitRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))).filter(
        (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
      )
      if (snapshotHealthRunState(commitRuns) !== initialRunState) {
        pendingRejectedByAuthority = true
        return
      }
      const commitPointerMatches =
        commitPointer?.latestSnapshotSeq === candidate.upperSeq &&
        commitPointer.latestSnapshotKey === candidate.key
      const commitHasCompletedRun = commitRuns.some(
        (run) =>
          run.status === 'pointer-updated' ||
          run.status === 'compacted' ||
          run.status === 'completed',
      )
      if (commitRuns.length > 0 && !commitHasCompletedRun && !commitPointerMatches) {
        pendingRejectedByAuthority = true
        return
      }
      const latest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      if (latest?.logicalStatus === 'quarantined') {
        pendingRejectedByQuarantine = true
        return
      }
      pendingExpected = snapshotExpectedEvidenceFromEvent(latest)
      await insertSnapshotHealthEvent(db, {
        docId: docKey(body.docId),
        snapshotKey: candidate.key,
        upperSeq: candidate.upperSeq,
        event: 'verification',
        actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
        authorityStatus: 'candidate',
        expectedByteLength: latest?.expectedByteLength ?? null,
        expectedUpdateSha256: latest?.expectedUpdateSha256 ?? null,
        expectedStateVectorSha256: latest?.expectedStateVectorSha256 ?? null,
        physicalStatus: 'unverified',
        logicalStatus: 'healthy',
        reasons: ['verification-pending'],
        observedAt: Date.now(),
      })
      const pending = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      if (pending === undefined) throw new Error('snapshot-health-pending-event-missing')
      pendingEventId = pending.id
    })
  })
  if (pendingRejectedByQuarantine) {
    return c.json(apiErrorBody('request/conflict', 'snapshot-health-quarantined'), 409)
  }
  if (pendingRejectedByAuthority || pendingEventId === undefined) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-approval-not-authoritative'),
      409,
    )
  }
  const verificationRunId = `checkpoint:verify:${pendingEventId}`

  const verification = await verifySnapshotObject(
    bucket,
    candidate.key,
    body.docId,
    pendingExpected,
  )
  const verifiedStateVector = verification.stateVector
  const expected: SnapshotVerificationExpectedEvidence | undefined =
    verification.stateVector === undefined || verification.actualStateVectorSha256 === undefined
      ? undefined
      : {
          byteLength: verification.actualByteLength,
          updateSha256: verification.actualUpdateSha256,
          stateVectorSha256: verification.actualStateVectorSha256,
        }
  let approvalRejectedByQuarantine = false
  let approvalRejectedByAuthority = false
  let approvalRecorded = false
  await withDocWriteQueue(room, body.docId, async () => {
    await withSqlTransaction(room, async () => {
      const commitPersisted = await readSyncRequestDocState(room, body.docId)
      const commitRecovery = commitPersisted === undefined
      if (recoverMissingDoc !== commitRecovery) {
        approvalRejectedByAuthority = true
        return
      }
      if (
        !commitRecovery &&
        (candidate.upperSeq < commitPersisted.minRetainedSeq ||
          candidate.upperSeq > commitPersisted.latestSeq ||
          commitPersisted.latestSeq !== persisted?.latestSeq ||
          commitPersisted.minRetainedSeq !== persisted?.minRetainedSeq)
      ) {
        approvalRejectedByAuthority = true
        return
      }
      const commitPointer = await readSnapshotPointer(room, body.docId)
      const commitPointerMatches =
        commitPointer?.latestSnapshotSeq === candidate.upperSeq &&
        commitPointer.latestSnapshotKey === candidate.key
      if (
        pointer?.latestSnapshotSeq !== commitPointer?.latestSnapshotSeq ||
        pointer?.latestSnapshotKey !== commitPointer?.latestSnapshotKey
      ) {
        approvalRejectedByAuthority = true
        return
      }
      const commitRuns = (await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))).filter(
        (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
      )
      if (snapshotHealthRunState(commitRuns) !== initialRunState) {
        approvalRejectedByAuthority = true
        return
      }
      const commitHasCompletedRun = commitRuns.some(
        (run) =>
          run.status === 'pointer-updated' ||
          run.status === 'compacted' ||
          run.status === 'completed',
      )
      if (commitRuns.length > 0 && !commitHasCompletedRun && !commitPointerMatches) {
        approvalRejectedByAuthority = true
        return
      }
      const latest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      if (latest === undefined) {
        approvalRejectedByAuthority = true
        return
      }
      if (latest.logicalStatus === 'quarantined') {
        approvalRejectedByQuarantine = true
        return
      }
      if (latest.id !== pendingEventId) {
        approvalRejectedByAuthority = true
        return
      }
      if (verification.status !== 'unverified' && verification.status !== 'verified') {
        await insertSnapshotHealthEvent(db, {
          docId: docKey(body.docId),
          snapshotKey: candidate.key,
          upperSeq: candidate.upperSeq,
          event: 'verification',
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
          authorityStatus: 'candidate',
          expectedByteLength: latest.expectedByteLength,
          expectedUpdateSha256: latest.expectedUpdateSha256,
          expectedStateVectorSha256: latest.expectedStateVectorSha256,
          actualByteLength: verification.actualByteLength,
          actualUpdateSha256: verification.actualUpdateSha256 || null,
          actualStateVectorSha256: verification.actualStateVectorSha256 ?? null,
          physicalStatus: verification.status,
          logicalStatus: 'healthy',
          reasons: verification.reasons,
          observedAt: Date.now(),
        })
        return
      }
      if (expected === undefined || verifiedStateVector === undefined) {
        await insertSnapshotHealthEvent(db, {
          docId: docKey(body.docId),
          snapshotKey: candidate.key,
          upperSeq: candidate.upperSeq,
          event: 'verification',
          actor: SNAPSHOT_HEALTH_SYSTEM_ACTORS.verifier,
          authorityStatus: 'candidate',
          expectedByteLength: latest.expectedByteLength,
          expectedUpdateSha256: latest.expectedUpdateSha256,
          expectedStateVectorSha256: latest.expectedStateVectorSha256,
          actualByteLength: verification.actualByteLength,
          actualUpdateSha256: verification.actualUpdateSha256 || null,
          actualStateVectorSha256: verification.actualStateVectorSha256 ?? null,
          physicalStatus: verification.status,
          logicalStatus: 'healthy',
          reasons: verification.reasons,
          observedAt: Date.now(),
        })
        return
      }
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId: body.docId,
          snapshotKey: candidate.key,
          upperSeq: candidate.upperSeq,
          actor,
          expectedByteLength: expected.byteLength,
          expectedUpdateSha256: makeSha256Hex(expected.updateSha256),
          expectedStateVectorSha256: makeSha256Hex(expected.stateVectorSha256),
        },
        Date.now(),
      )
      await insertSnapshotHealthEvent(db, {
        docId: docKey(body.docId),
        snapshotKey: candidate.key,
        upperSeq: candidate.upperSeq,
        event: 'approval',
        actor,
        authorityStatus: 'authoritative',
        expectedByteLength: expected.byteLength,
        expectedUpdateSha256: expected.updateSha256,
        expectedStateVectorSha256: expected.stateVectorSha256,
        actualByteLength: expected.byteLength,
        actualUpdateSha256: expected.updateSha256,
        actualStateVectorSha256: expected.stateVectorSha256,
        physicalStatus: 'verified',
        logicalStatus: 'healthy',
        reasons: [body.reason],
        observedAt: Date.now(),
      })
      if (
        !commitRuns.some(
          (run) =>
            run.snapshotKey === candidate.key &&
            run.upperSeq === candidate.upperSeq &&
            run.status !== 'failed',
        )
      ) {
        await insertCheckpointRun(
          db,
          verificationRunId,
          docKey(body.docId),
          candidate.upperSeq,
          candidate.key,
          verifiedStateVector,
          'completed',
          Date.now(),
        )
      }
      if (commitRecovery) {
        await insertDoc(
          db,
          docKey(body.docId),
          body.docId.kind,
          candidate.upperSeq,
          candidate.upperSeq,
          candidate.key,
          verifiedStateVector,
          0,
          Date.now(),
        )
      }
      approvalRecorded = true
    })
  })
  if (approvalRejectedByQuarantine) {
    return c.json(apiErrorBody('request/conflict', 'snapshot-health-quarantined'), 409)
  }
  if (approvalRejectedByAuthority) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-approval-not-authoritative'),
      409,
    )
  }
  if (!approvalRecorded) {
    return c.json(
      apiErrorBody(
        'request/conflict',
        `snapshot-health-verification-failed:${verification.reasons.join(',')}`,
      ),
      409,
    )
  }
  if (recoverMissingDoc) {
    try {
      await rehydrateAfterDocPointer(room, body.docId)
    } catch {
      return c.json(apiErrorBody('server/error', 'snapshot-health-recovery-failed'), 500)
    }
  }
  const row = await getLatestSnapshotHealthEventForEntry(db, body.docId, candidate.key)
  const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
  const response = { ok: true as const, entry: snapshotHealthEntryFromRow(row, actionContext) }
  if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
    return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
  }
  return c.json(response, 200)
}

/** Logically quarantines one generation while preserving it for inspection. */
export async function handleSnapshotHealthQuarantine(
  room: VaultRoom,
  c: Context,
): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotHealthQuarantineRequestSchema, body)) {
    return c.json(
      apiErrorBody('request/invalid', 'invalid-snapshot-health-quarantine-request'),
      400,
    )
  }
  if (!snapshotHealthRouteDocMatches(c.req.param('docId'), body.docId)) {
    return c.json(apiErrorBody('request/invalid', 'snapshot-health-doc-mismatch'), 400)
  }
  const admission = await admitSnapshotHealthMutation(
    room,
    c,
    body.docId,
    body.snapshotKey,
    body.upperSeq,
  )
  if (admission.response !== undefined) return admission.response
  const { db, candidate, actor } = admission
  let quarantineBlocked = false
  await withDocWriteQueue(room, body.docId, async () => {
    await withSqlTransaction(room, async () => {
      const latest = await getLatestSnapshotHealthEventForEntry(db, body.docId, candidate.key)
      if (latest.logicalStatus === 'quarantined') {
        return
      }
      const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
      if (
        !snapshotHealthAllowedActions(latest, actionContext).allowedActions.includes('quarantine')
      ) {
        quarantineBlocked = true
        return
      }
      await insertSnapshotHealthEvent(db, {
        docId: docKey(body.docId),
        snapshotKey: candidate.key,
        upperSeq: candidate.upperSeq,
        event: 'quarantine',
        actor,
        authorityStatus: latest.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
        expectedByteLength: latest.expectedByteLength ?? null,
        expectedUpdateSha256: latest.expectedUpdateSha256 ?? null,
        expectedStateVectorSha256: latest.expectedStateVectorSha256 ?? null,
        actualByteLength: latest.actualByteLength ?? null,
        actualUpdateSha256: latest.actualUpdateSha256 ?? null,
        actualStateVectorSha256: latest.actualStateVectorSha256 ?? null,
        physicalStatus: latest.physicalStatus,
        logicalStatus: 'quarantined',
        reasons: [body.reason],
        observedAt: Date.now(),
      })
    })
  })
  if (quarantineBlocked) {
    return c.json(
      apiErrorBody('request/conflict', 'snapshot-health-quarantine-would-break-floor'),
      409,
    )
  }
  const row = await getLatestSnapshotHealthEventForEntry(db, body.docId, candidate.key)
  const actionContext = await readSnapshotHealthActionContext(room, db, body.docId)
  const response = { ok: true as const, entry: snapshotHealthEntryFromRow(row, actionContext) }
  if (!v.is(SnapshotHealthMutationResponseSchema, response)) {
    return c.json(apiErrorBody('server/error', 'invalid-snapshot-health-response'), 500)
  }
  return c.json(response, 200)
}

/** Creates a new authoritative generation from a verified older snapshot. */
export async function handleSnapshotRollback(room: VaultRoom, c: Context): Promise<Response> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotRollbackRequestSchema, body)) {
    return c.json(apiErrorBody('request/invalid', 'invalid-snapshot-rollback-request'), 400)
  }
  if (!snapshotHealthRouteDocMatches(c.req.param('docId'), body.docId)) {
    return c.json(apiErrorBody('request/invalid', 'snapshot-health-doc-mismatch'), 400)
  }
  const admission = await admitSnapshotHealthMutation(
    room,
    c,
    body.docId,
    body.snapshotKey,
    body.upperSeq,
  )
  if (admission.response !== undefined) return admission.response
  const { db, bucket, candidate, actor } = admission
  return await withDocWriteQueue(room, body.docId, async () => {
    let runId: string | undefined
    let rollbackDoc: Y.Doc | undefined
    let snapshotKey: string | undefined
    try {
      const clock = await readDocClock(room, body.docId)
      const persisted = await readSyncRequestDocState(room, body.docId)
      const currentLatestSeq = clock?.latestSeq
      if (
        currentLatestSeq === undefined ||
        !Number.isSafeInteger(currentLatestSeq) ||
        currentLatestSeq < candidate.upperSeq ||
        (persisted !== undefined && candidate.upperSeq < persisted.minRetainedSeq)
      ) {
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-stale-source'), 409)
      }

      const latest = await getLatestSnapshotHealthEvent(db, docKey(body.docId), candidate.key)
      const expected = snapshotExpectedEvidenceFromEvent(latest)
      if (
        latest?.authorityStatus !== 'authoritative' ||
        latest?.logicalStatus !== 'healthy' ||
        expected === undefined
      ) {
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-unhealthy-source'), 409)
      }
      const pointer = await readSnapshotPointer(room, body.docId)
      const pointerMatches =
        pointer?.latestSnapshotSeq === candidate.upperSeq &&
        pointer.latestSnapshotKey === candidate.key
      const matchingRuns = (
        await getSnapshotRetentionCheckpointRuns(db, docKey(body.docId))
      ).filter((run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq)
      const hasCompletedRun = matchingRuns.some(
        (run) =>
          run.status === 'pointer-updated' ||
          run.status === 'compacted' ||
          run.status === 'completed',
      )
      if (matchingRuns.length > 0 && !hasCompletedRun && !pointerMatches) {
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-unhealthy-source'), 409)
      }
      const verification = await verifySnapshotObject(bucket, candidate.key, body.docId, expected)
      const logicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        body.docId,
        candidate,
        verification,
        expected,
      )
      const latestAfterVerification = await getLatestSnapshotHealthEvent(
        db,
        docKey(body.docId),
        candidate.key,
      )
      if (
        verification.status !== 'verified' ||
        verification.stateVector === undefined ||
        logicalStatus === 'quarantined' ||
        latestAfterVerification?.logicalStatus === 'quarantined'
      ) {
        return c.json(
          apiErrorBody(
            'request/conflict',
            `snapshot-rollback-unhealthy-source:${verification.reasons.join(',')}`,
          ),
          409,
        )
      }

      const source = await bucket.get(candidate.key)
      if (source === null)
        return c.json(apiErrorBody('snapshot/not-found', 'snapshot-rollback-source-missing'), 404)
      const sourceBytes = new Uint8Array(await source.arrayBuffer())
      rollbackDoc = new Y.Doc()
      Y.applyUpdate(rollbackDoc, sourceBytes)
      let expectedSeq = candidate.upperSeq + 1
      for (const row of await getOpLogUpdatesBetween(
        db,
        docKey(body.docId),
        candidate.upperSeq,
        currentLatestSeq,
      )) {
        if (row.seq !== expectedSeq) throw new Error('snapshot-rollback-op-log-gap')
        const updateBytes = readSqlUpdateBytes(row.updateBytes)
        if (updateBytes === undefined) throw new Error('snapshot-rollback-op-log-bytes-invalid')
        Y.applyUpdate(rollbackDoc, updateBytes)
        expectedSeq += 1
      }
      if (expectedSeq !== currentLatestSeq + 1) {
        throw new Error('snapshot-rollback-op-log-gap')
      }
      const currentRollbackDoc = room.docs.get(docKey(body.docId))
      if (
        body.docId.kind === 'meta' &&
        (!metaYDocWritable(rollbackDoc) ||
          (currentRollbackDoc !== undefined &&
            !metaIdentityImmutable(currentRollbackDoc, rollbackDoc)))
      ) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(
          apiErrorBody('request/conflict', 'snapshot-rollback-meta-schema-invalid'),
          409,
        )
      }

      const mergedBytes = Y.encodeStateAsUpdate(rollbackDoc)
      const rollbackStateVector = Y.encodeStateVector(rollbackDoc)
      const snapshotSeq = currentLatestSeq + 1
      const vaultId = room.vaultId
      if (vaultId === undefined) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)
      }
      snapshotKey = makeSnapshotObjectKey(vaultId, body.docId, snapshotSeq)
      if ((await bucket.head(snapshotKey)) !== null) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-target-exists'), 409)
      }
      const expectedUpdateSha256 = makeSha256Hex(await hashBytesSha256(mergedBytes))
      const expectedStateVectorSha256 = makeSha256Hex(await hashBytesSha256(rollbackStateVector))
      const now = Date.now()
      runId = `checkpoint:rollback:${snapshotKey}:${now}`
      const auditId = `rollback:${await sha256Text(`${snapshotKey}:${now}:${actor}`)}`
      const response = {
        ok: true,
        docId: body.docId,
        actor,
        snapshotKey,
        snapshotSeq,
        sourceSnapshotKey: candidate.key,
        sourceSnapshotSeq: candidate.upperSeq,
        auditId,
      } as const
      if (!v.is(SnapshotRollbackResponseSchema, response)) {
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('server/error', 'invalid-snapshot-rollback-response'), 500)
      }
      await insertCheckpointRun(
        db,
        runId,
        docKey(body.docId),
        snapshotSeq,
        snapshotKey,
        rollbackStateVector,
        'writing',
        now,
      )
      await insertSnapshotExpectedEvidence(
        db,
        {
          docId: body.docId,
          snapshotKey,
          upperSeq: snapshotSeq,
          actor,
          expectedByteLength: mergedBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
        },
        now,
      )
      await bucket.put(snapshotKey, mergedBytes)
      const written = await verifySnapshotObject(bucket, snapshotKey, body.docId, {
        byteLength: mergedBytes.byteLength,
        updateSha256: expectedUpdateSha256,
        stateVectorSha256: expectedStateVectorSha256,
      })
      const writtenLogicalStatus = await appendSnapshotVerificationEventPreservingLogical(
        room,
        db,
        body.docId,
        { key: snapshotKey, upperSeq: snapshotSeq, healthy: true },
        written,
        {
          byteLength: mergedBytes.byteLength,
          updateSha256: expectedUpdateSha256,
          stateVectorSha256: expectedStateVectorSha256,
        },
      )
      if (written.status !== 'verified' || writtenLogicalStatus === 'quarantined') {
        await updateCheckpointFailed(db, runId)
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(
          apiErrorBody('request/conflict', 'snapshot-rollback-verification-failed'),
          409,
        )
      }
      await updateCheckpointR2Written(db, runId, now)
      let sourceInvalidated = false
      let targetInvalidated = false
      await withSqlTransaction(room, async () => {
        const latestSource = await getLatestSnapshotHealthEvent(
          db,
          docKey(body.docId),
          candidate.key,
        )
        const latestTarget = await getLatestSnapshotHealthEvent(
          db,
          docKey(body.docId),
          snapshotKey as string,
        )
        sourceInvalidated =
          latestSource?.authorityStatus !== 'authoritative' ||
          latestSource.physicalStatus !== 'verified' ||
          latestSource.logicalStatus !== 'healthy'
        targetInvalidated =
          latestTarget?.logicalStatus !== 'healthy' ||
          latestTarget?.physicalStatus !== 'verified' ||
          (latestTarget?.authorityStatus !== 'candidate' &&
            latestTarget?.authorityStatus !== 'authoritative')
        if (sourceInvalidated || targetInvalidated) return
        await updateDocSnapshotPointer(
          db,
          snapshotSeq,
          snapshotKey as string,
          rollbackStateVector,
          now,
          docKey(body.docId),
          snapshotSeq,
        )
        await updateCheckpointPointerUpdated(db, runId as string, now)
        await insertSnapshotHealthEvent(db, {
          docId: docKey(body.docId),
          snapshotKey: snapshotKey as string,
          upperSeq: snapshotSeq,
          event: 'rollback',
          actor,
          authorityStatus: 'authoritative',
          expectedByteLength: mergedBytes.byteLength,
          expectedUpdateSha256,
          expectedStateVectorSha256,
          actualByteLength: written.actualByteLength,
          actualUpdateSha256: written.actualUpdateSha256 || null,
          actualStateVectorSha256: written.actualStateVectorSha256 ?? null,
          physicalStatus: written.status,
          logicalStatus: 'healthy',
          reasons: [body.reason, `source:${candidate.key}`],
          observedAt: now,
        })
      })
      if (sourceInvalidated || targetInvalidated) {
        await updateCheckpointFailed(db, runId)
        rollbackDoc.destroy()
        rollbackDoc = undefined
        return c.json(apiErrorBody('request/conflict', 'snapshot-rollback-source-changed'), 409)
      }
      rollbackDoc.destroy()
      rollbackDoc = undefined
      await rehydrateAfterDocPointer(room, body.docId)
      return c.json(response, 200)
    } catch (error) {
      rollbackDoc?.destroy()
      if (runId !== undefined) await updateCheckpointFailed(db, runId).catch(() => undefined)
      logEvent('snapshot-rollback-failed', {
        vaultId: room.vaultId,
        docId: body.docId,
        snapshotKey,
        error: retentionErrorMessage(error),
      })
      return c.json(apiErrorBody('server/error', 'snapshot-rollback-failed'), 500)
    }
  })
}

async function admitSnapshotHealthMutation(
  room: VaultRoom,
  c: Context,
  docId: DocId,
  snapshotKey: string,
  upperSeq: number,
): Promise<
  | {
      readonly response: Response
      readonly db?: undefined
      readonly bucket?: undefined
      readonly candidate?: undefined
    }
  | {
      readonly response?: undefined
      readonly db: NonNullable<ReturnType<typeof getDb>>
      readonly bucket: NonNullable<VaultRoom['env']['SNAPSHOT_BUCKET']>
      readonly candidate: SnapshotCandidate
      readonly actor: string
    }
> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || bucket === undefined || secret === undefined) {
    return {
      response: c.json(
        apiErrorBody('server/degraded', 'snapshot-health-mutation-unavailable'),
        503,
      ),
    }
  }
  await ensureSchema(room)
  const authorization = await authorizeHttpRequestWithClaims(room, c, ['sync:write'])
  if (authorization.action === 'reject') return { response: authorization.response }
  const actor = authorization.claims.sub
  if (!v.is(DeviceIdSchema, actor)) {
    return { response: c.json(apiErrorBody('auth/rejected', 'auth-reject:missing-actor'), 403) }
  }
  const vaultId = room.vaultId
  if (vaultId === undefined)
    return { response: c.json(apiErrorBody('server/error', 'vault-unavailable'), 500) }
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const candidate = snapshotCandidateFromKeyForHealth(prefix, snapshotKey)
  if (candidate === undefined || candidate.upperSeq !== upperSeq) {
    return {
      response: c.json(apiErrorBody('request/invalid', 'snapshot-health-target-mismatch'), 400),
    }
  }
  return { db, bucket, candidate, actor }
}

async function collectSnapshotHealthRows(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
): Promise<readonly import('../db/checkpointRepo').SnapshotHealthEventRow[]> {
  const rows = new Map<string, import('../db/checkpointRepo').SnapshotHealthEventRow>()
  const legacyCandidates = new Map<string, SnapshotCandidate>()
  const runSequences = new Map<string, number>()
  for (const run of await getSnapshotRetentionCheckpointRuns(db, docKey(docId))) {
    if (run.snapshotKey !== null && Number.isSafeInteger(run.upperSeq) && run.upperSeq > 0) {
      runSequences.set(run.snapshotKey, run.upperSeq)
    }
  }
  for (const row of await getAllLatestSnapshotHealthEvents(db, docKey(docId))) {
    rows.set(row.snapshotKey, row)
    const prefix =
      room.vaultId === undefined ? undefined : makeSnapshotListPrefix(room.vaultId, docId)
    const parsedCandidate =
      prefix === undefined ? undefined : snapshotCandidateFromKeyForHealth(prefix, row.snapshotKey)
    const candidate =
      parsedCandidate ??
      (row.upperSeq <= 0 && runSequences.has(row.snapshotKey)
        ? {
            key: row.snapshotKey,
            upperSeq: runSequences.get(row.snapshotKey) as number,
            healthy: true,
          }
        : undefined)
    if (row.upperSeq <= 0 && candidate !== undefined) legacyCandidates.set(candidate.key, candidate)
  }
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (bucket === undefined || vaultId === undefined) {
    return [...rows.values()].filter((row) => row.upperSeq > 0)
  }
  const prefix = makeSnapshotListPrefix(vaultId, docId)
  const listedKeys = new Set<string>()
  for (const object of await listR2Objects(bucket, prefix)) {
    const candidate = snapshotCandidateFromKeyForHealth(prefix, object.key)
    if (candidate !== undefined) listedKeys.add(candidate.key)
    if (
      candidate === undefined ||
      (rows.has(candidate.key) && !legacyCandidates.has(candidate.key))
    )
      continue
    const verification = await verifySnapshotObject(bucket, candidate.key, docId, undefined)
    const existing = rows.get(candidate.key)
    await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      snapshotExpectedEvidenceFromEvent(existing),
    )
    const latest = await getLatestSnapshotHealthEventForEntry(db, docId, candidate.key)
    rows.set(candidate.key, latest)
    legacyCandidates.delete(candidate.key)
  }
  for (const candidate of legacyCandidates.values()) {
    const existing = rows.get(candidate.key)
    if (existing === undefined) continue
    const verification = await verifySnapshotObject(
      bucket,
      candidate.key,
      docId,
      snapshotExpectedEvidenceFromEvent(existing),
    )
    await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      snapshotExpectedEvidenceFromEvent(existing),
      existing.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
    )
    rows.set(candidate.key, await getLatestSnapshotHealthEventForEntry(db, docId, candidate.key))
  }
  for (const existing of Array.from(rows.values())) {
    if (existing.upperSeq <= 0 || listedKeys.has(existing.snapshotKey)) continue
    const candidate = snapshotCandidateFromKeyForHealth(prefix, existing.snapshotKey)
    if (candidate === undefined || candidate.upperSeq !== existing.upperSeq) continue
    const expected = snapshotExpectedEvidenceFromEvent(existing)
    const verification = await verifySnapshotObject(bucket, candidate.key, docId, expected)
    await appendSnapshotVerificationEventPreservingLogical(
      room,
      db,
      docId,
      candidate,
      verification,
      expected,
      existing.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate',
    )
    rows.set(candidate.key, await getLatestSnapshotHealthEventForEntry(db, docId, candidate.key))
  }
  return [...rows.values()].filter((row) => row.upperSeq > 0)
}

async function getLatestSnapshotHealthEventForEntry(
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  snapshotKey: string,
): Promise<import('../db/checkpointRepo').SnapshotHealthEventRow> {
  const row = await getLatestSnapshotHealthEvent(db, docKey(docId), snapshotKey)
  if (row === undefined) throw new Error('snapshot-health-event-missing')
  return row
}

type SnapshotHealthEventRow = import('../db/checkpointRepo').SnapshotHealthEventRow

interface SnapshotHealthActionContext {
  readonly persisted: Awaited<ReturnType<typeof readSyncRequestDocState>>
  readonly pointer: Awaited<ReturnType<typeof readSnapshotPointer>>
  readonly runs: Awaited<ReturnType<typeof getSnapshotRetentionCheckpointRuns>>
  readonly latestRows: readonly SnapshotHealthEventRow[]
}

async function backfillSnapshotHealthCheckpointRun(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  candidate: SnapshotCandidate,
  existing: SnapshotHealthEventRow,
  pointerStateVector: Uint8Array | undefined,
): Promise<boolean> {
  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined) return false
  const verification = await verifySnapshotObject(
    bucket,
    candidate.key,
    docId,
    snapshotExpectedEvidenceFromEvent(existing),
  )
  if (
    verification.status !== 'verified' ||
    verification.stateVector === undefined ||
    (pointerStateVector !== undefined && !sameBytes(pointerStateVector, verification.stateVector))
  ) {
    return false
  }
  const verifiedStateVector = verification.stateVector

  let committed = false
  await withDocWriteQueue(room, docId, async () => {
    await withSqlTransaction(room, async () => {
      const latest = await getLatestSnapshotHealthEvent(db, docKey(docId), candidate.key)
      if (
        latest?.id !== existing.id ||
        latest.authorityStatus !== 'authoritative' ||
        latest.physicalStatus !== 'verified' ||
        latest.logicalStatus !== 'healthy'
      ) {
        return
      }
      const runs = (await getSnapshotRetentionCheckpointRuns(db, docKey(docId))).filter(
        (run) => run.snapshotKey === candidate.key && run.upperSeq === candidate.upperSeq,
      )
      if (runs.some((run) => run.status !== 'failed' && run.stateVector !== null)) {
        committed = true
        return
      }
      await insertCheckpointRun(
        db,
        `checkpoint:verify:${existing.id}`,
        docKey(docId),
        candidate.upperSeq,
        candidate.key,
        verifiedStateVector,
        'completed',
        Date.now(),
      )
      committed = true
    })
  })
  return committed
}

async function readSnapshotHealthActionContext(
  room: VaultRoom,
  db: NonNullable<ReturnType<typeof getDb>>,
  docId: DocId,
  latestRows?: readonly SnapshotHealthEventRow[],
): Promise<SnapshotHealthActionContext> {
  return {
    persisted: await readSyncRequestDocState(room, docId),
    pointer: await readSnapshotPointer(room, docId),
    runs: await getSnapshotRetentionCheckpointRuns(db, docKey(docId)),
    latestRows: latestRows ?? (await getAllLatestSnapshotHealthEvents(db, docKey(docId))),
  }
}

function snapshotHealthEntryFromRow(
  row: SnapshotHealthEventRow,
  context: SnapshotHealthActionContext,
): SnapshotHealthEntry {
  const docId = docIdFromSnapshotHealthKey(row.docId)
  if (docId === undefined) throw new Error('invalid-snapshot-health-doc-id')
  const actions = snapshotHealthAllowedActions(row, context)
  const authorityStatus = row.authorityStatus === 'authoritative' ? 'authoritative' : 'candidate'
  return {
    docId,
    snapshotKey: row.snapshotKey,
    upperSeq: row.upperSeq,
    actor: row.actor,
    authorityStatus,
    allowedActions: actions.allowedActions,
    ...(actions.actionBlockReason === undefined
      ? {}
      : { actionBlockReason: actions.actionBlockReason }),
    ...(row.expectedByteLength === null ? {} : { expectedByteLength: row.expectedByteLength }),
    ...(safeSha256(row.expectedUpdateSha256) === undefined
      ? {}
      : { expectedUpdateSha256: safeSha256(row.expectedUpdateSha256) }),
    ...(safeSha256(row.expectedStateVectorSha256) === undefined
      ? {}
      : { expectedStateVectorSha256: safeSha256(row.expectedStateVectorSha256) }),
    ...(row.actualByteLength === null ? {} : { actualByteLength: row.actualByteLength }),
    ...(safeSha256(row.actualUpdateSha256) === undefined
      ? {}
      : { actualUpdateSha256: safeSha256(row.actualUpdateSha256) }),
    ...(safeSha256(row.actualStateVectorSha256) === undefined
      ? {}
      : { actualStateVectorSha256: safeSha256(row.actualStateVectorSha256) }),
    physicalStatus: isSnapshotPhysicalStatus(row.physicalStatus)
      ? row.physicalStatus
      : 'unverified',
    logicalStatus: row.logicalStatus === 'quarantined' ? 'quarantined' : 'healthy',
    reasons: parseSnapshotHealthReasons(row.reasons),
    observedAt: row.observedAt,
  }
}

function snapshotHealthAllowedActions(
  row: SnapshotHealthEventRow,
  context: SnapshotHealthActionContext,
): {
  readonly allowedActions: SnapshotHealthEntry['allowedActions']
  readonly actionBlockReason: string | undefined
} {
  const pointerMatches =
    context.pointer?.latestSnapshotSeq === row.upperSeq &&
    context.pointer.latestSnapshotKey === row.snapshotKey
  const matchingRuns = context.runs.filter(
    (run) => run.snapshotKey === row.snapshotKey && run.upperSeq === row.upperSeq,
  )
  if (
    row.physicalStatus === 'mismatch' &&
    parseSnapshotHealthReasons(row.reasons).includes('missing-object')
  ) {
    return { allowedActions: [], actionBlockReason: 'snapshot-health-deleted' }
  }
  const hasCompletedRun = matchingRuns.some(
    (run) =>
      run.status === 'pointer-updated' || run.status === 'compacted' || run.status === 'completed',
  )
  const verifyAllowed =
    row.physicalStatus === 'unverified' &&
    row.logicalStatus !== 'quarantined' &&
    row.logicalStatus === 'healthy' &&
    (context.persisted === undefined || pointerMatches || hasCompletedRun)
  const rollbackAllowed =
    row.authorityStatus === 'authoritative' &&
    row.physicalStatus === 'verified' &&
    row.logicalStatus === 'healthy' &&
    context.persisted !== undefined &&
    row.upperSeq >= context.persisted.minRetainedSeq &&
    row.upperSeq <= context.persisted.latestSeq &&
    (matchingRuns.length === 0 || hasCompletedRun || pointerMatches)
  const floor = context.persisted?.minRetainedSeq ?? 0
  const hasAlternativeFloor = context.latestRows.some(
    (other) =>
      other.snapshotKey !== row.snapshotKey &&
      other.authorityStatus === 'authoritative' &&
      other.physicalStatus === 'verified' &&
      other.logicalStatus === 'healthy' &&
      other.upperSeq >= floor &&
      (context.persisted === undefined || other.upperSeq <= context.persisted.latestSeq),
  )
  const quarantineBlocked =
    row.logicalStatus === 'quarantined' ||
    (row.authorityStatus === 'authoritative' &&
      row.physicalStatus === 'verified' &&
      row.logicalStatus === 'healthy' &&
      context.persisted !== undefined &&
      row.upperSeq >= context.persisted.minRetainedSeq &&
      !hasAlternativeFloor)
  const actions: SnapshotHealthEntry['allowedActions'] = [
    ...(verifyAllowed ? (['verify'] as const) : []),
    ...(!quarantineBlocked ? (['quarantine'] as const) : []),
    ...(rollbackAllowed ? (['rollback'] as const) : []),
  ]
  if (actions.length > 0) return { allowedActions: actions, actionBlockReason: undefined }
  const actionBlockReason =
    row.logicalStatus === 'quarantined'
      ? 'snapshot-health-already-quarantined'
      : !verifyAllowed
        ? 'snapshot-health-approval-not-authoritative'
        : !rollbackAllowed
          ? 'snapshot-rollback-unhealthy-source'
          : 'snapshot-health-quarantine-would-break-floor'
  return { allowedActions: actions, actionBlockReason }
}

function snapshotExpectedEvidenceFromEvent(
  row: import('../db/checkpointRepo').SnapshotHealthEventRow | undefined,
): SnapshotVerificationExpectedEvidence | undefined {
  if (
    row === undefined ||
    row.expectedByteLength === null ||
    row.expectedUpdateSha256 === null ||
    row.expectedStateVectorSha256 === null
  ) {
    return undefined
  }
  return {
    byteLength: row.expectedByteLength,
    updateSha256: row.expectedUpdateSha256,
    stateVectorSha256: row.expectedStateVectorSha256,
  }
}

function parseSnapshotHealthDocId(value: string | undefined): DocId | undefined {
  if (value === 'meta') return { kind: 'meta' }
  if (typeof value !== 'string' || !value.startsWith('file:')) return undefined
  const ydocId = value.slice('file:'.length)
  return v.is(YDocIdSchema, ydocId) ? { kind: 'file', ydocId } : undefined
}

function snapshotHealthRouteDocMatches(routeDocId: string | undefined, docId: DocId): boolean {
  if (routeDocId === undefined) return true
  return docId.kind === 'meta' ? routeDocId === 'meta' : routeDocId === docId.ydocId
}

function docIdFromSnapshotHealthKey(value: string): DocId | undefined {
  return parseSnapshotHealthDocId(value)
}

function parseSnapshotHealthLimit(value: string | undefined): number | undefined {
  if (value === undefined) return 64
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 256 ? parsed : undefined
}

function parseSnapshotHealthCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function snapshotCandidateFromKeyForHealth(
  prefix: string,
  key: string,
): SnapshotCandidate | undefined {
  if (!key.startsWith(prefix) || !key.endsWith('.yupdate')) return undefined
  const seqText = key.slice(prefix.length, -'.yupdate'.length)
  if (!/^[1-9][0-9]*$/.test(seqText)) return undefined
  const upperSeq = Number(seqText)
  return Number.isSafeInteger(upperSeq) && upperSeq > 0
    ? { key, upperSeq, healthy: true }
    : undefined
}

function parseSnapshotHealthReasons(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((reason): reason is string => typeof reason === 'string')
      : []
  } catch {
    return []
  }
}

function snapshotHealthRunState(
  runs: readonly {
    readonly status: string
    readonly upperSeq: number
    readonly snapshotKey: string | null
  }[],
): string {
  return runs
    .map((run) => `${run.status}:${run.upperSeq}:${run.snapshotKey ?? ''}`)
    .sort()
    .join('|')
}

function isSnapshotPhysicalStatus(
  value: string | null,
): value is SnapshotHealthEntry['physicalStatus'] {
  return value === 'verified' || value === 'unverified' || value === 'mismatch'
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function safeSha256(value: string | null): string | undefined {
  return value !== null && v.is(Sha256HexSchema, value) ? value : undefined
}

export async function handleWebSocketUpgrade(room: VaultRoom, c: Context): Promise<Response> {
  if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE)
    return c.json(apiErrorBody('request/invalid', 'expected-websocket-upgrade'), 426)
  if (typeof WebSocketPair === 'undefined')
    return c.json(apiErrorBody('server/error', 'websocket-pair-unavailable'), 500)

  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  room.state.acceptWebSocket(server)
  room.sessions.add(server)
  rememberSocketToken(room, server, extractWebSocketBearerToken(c.req.raw))

  const upgradeInit: WebSocketResponseInit = {
    status: 101,
    webSocket: client,
    headers: { 'Sec-WebSocket-Protocol': 'kuroflare.v1' },
  }
  return new Response(null, upgradeInit)
}
