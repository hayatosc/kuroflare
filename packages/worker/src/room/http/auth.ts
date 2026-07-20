import {
  CURRENT_PROTOCOL_VERSION,
  DeviceIdSchema,
  DeviceTokenRefreshRequestSchema,
  makeSha256Hex,
  RevokeDeviceRequestSchema,
  SetupExchangeRequestSchema,
  signHs256DeviceToken,
  type ApiErrorCode,
  type DeviceTokenClaims,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'

import { upsertSetupToken } from '../../db/setupRepo'
import {
  decideSetupExchange,
  decideRevokeDevice,
  planSetupExchangeCredentials,
  decideDeviceTokenRefresh,
  planDeviceRefreshTokenRotation,
  type DeviceTokenRefreshDecision,
} from '../../devices'
import { decideSetupTokenConsume } from '../../devices/tokens'
import { planDeviceTokenRefreshHttpResponse } from '../../http/authRefresh'
import { planRevokeDeviceHttpResponse } from '../../http/device'
import { planSetupExchangeHttpResponse } from '../../http/setup'
import { authorizeHttpRequest } from '../../runtime/auth'
import {
  REFRESH_ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SETUP_ACCESS_TOKEN_TTL_MS,
  SETUP_REFRESH_TOKEN_TTL_MS,
} from '../../runtime/constants'
import type { VaultRoom } from '../../runtime/room'
import {
  getDb,
  ensureSchema,
  readDeviceRegistryEntry,
  readSetupToken,
  readRefreshToken,
  hasAnyPersistedDocs,
  consumeSetupToken,
  persistSetupDevice,
  persistRefreshToken,
  revokeRefreshToken,
  persistDeviceRevocation,
  withSqlTransaction,
} from '../../runtime/storage'
import { AdminSetupTokenIssueRequestSchema } from '../../runtime/types'
import {
  apiErrorBody,
  logEvent,
  makeGeneratedDeviceId,
  makeOpaqueToken,
  retentionErrorMessage,
  sha256Text,
} from '../../runtime/utils'

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
    logEvent('setup-exchange-persist-failed', {
      vaultId: body.vaultId,
      error: retentionErrorMessage(error),
    })
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
