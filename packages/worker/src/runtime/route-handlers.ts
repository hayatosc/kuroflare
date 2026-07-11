import {
  CURRENT_PROTOCOL_VERSION,
  DeviceTokenRefreshRequestSchema,
  DeviceIdSchema,
  RevokeDeviceRequestSchema,
  SetupExchangeRequestSchema,
  SnapshotImportRequestSchema,
  YDocIdSchema,
  makeSha256Hex,
  signHs256DeviceToken,
  type DeviceTokenClaims,
  type DocId,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'
import * as Y from 'yjs'

import {
  getSnapshotRetentionEvents,
  insertCheckpointRun,
  updateCheckpointR2Written,
  updateCheckpointPointerUpdated,
} from '../db/checkpointRepo'
import { insertDoc } from '../db/docRepo'
import { upsertSetupToken } from '../db/setupRepo'
import { decideSetupExchange, decideRevokeDevice, planSetupExchangeCredentials } from '../devices'
import { decideDeviceTokenRefresh, planDeviceRefreshTokenRotation } from '../devices'
import { decideSetupTokenConsume } from '../devices/tokens'
import { planDeviceTokenRefreshHttpResponse } from '../http/authRefresh'
import { planRevokeDeviceHttpResponse } from '../http/device'
import {
  buildQuarantinedUpdateListResponse,
  buildQuarantinedUpdateDetailResponse,
} from '../http/quarantine'
import { planSetupExchangeHttpResponse } from '../http/setup'
import { makeSnapshotObjectKey } from '../sync/snapshots'
import { authorizeHttpRequest, rememberSocketToken } from './auth'
import {
  REFRESH_ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SETUP_ACCESS_TOKEN_TTL_MS,
  SETUP_REFRESH_TOKEN_TTL_MS,
  SNAPSHOT_RETENTION_EVENT_LIMIT,
  WEBSOCKET_UPGRADE,
  Y_CLIENT_ID_RANGE,
} from './constants'
import {
  getDb,
  ensureSchema,
  readDeviceRegistryEntry,
  readSetupToken,
  readUsedYClientIds,
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
  readSnapshotPointer,
} from './storage'
import { ensureDocHydrated, withDocWriteQueue } from './sync'
import type { RuntimeWebSocketPairConstructor, WebSocketResponseInit } from './types'
import { E2eSetupTokenSeedRequestSchema, E2eSnapshotSeedRequestSchema } from './types'
import {
  docKey,
  canApplyYjsUpdate,
  decodeBase64,
  encodeBase64,
  encodeOptionalBase64,
  extractWebSocketBearerToken,
  makeOpaqueToken,
  makeGeneratedDeviceId,
  sha256Text,
  sha256Hex,
  logEvent,
  metaYDocSchemaValid,
  retentionErrorMessage,
} from './utils'
import type { VaultRoom } from './vault-room'

declare const WebSocketPair: RuntimeWebSocketPairConstructor | undefined

export async function handleE2eSetupTokenSeed(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  if (db === undefined) return c.text('E2E setup token seed unavailable', 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(E2eSetupTokenSeedRequestSchema, body))
    return c.json({ error: 'invalid-e2e-setup-token-seed-request' }, 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json({ error: 'vault-mismatch' }, 400)
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

export async function handleE2eSnapshotSeed(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined) return c.text('E2E snapshot seed unavailable', 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(E2eSnapshotSeedRequestSchema, body))
    return c.json({ error: 'invalid-e2e-snapshot-seed-request' }, 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json({ error: 'vault-mismatch' }, 400)
  room.vaultId = body.vaultId

  const update = decodeBase64(body.update)
  if (update === null || !canApplyYjsUpdate(update))
    return c.json({ error: 'invalid-e2e-snapshot-update' }, 400)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, update)
  const stateVector = Y.encodeStateVector(doc)
  doc.destroy()

  const now = Date.now()
  const latestSeq = body.latestSeq ?? 1
  const snapshotKey = makeSnapshotObjectKey(body.vaultId, body.docId, latestSeq)
  await bucket.put(snapshotKey, update)
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
  if (db === undefined || secret === undefined) return c.text('Setup exchange unavailable', 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SetupExchangeRequestSchema, body))
    return c.json({ error: 'invalid-setup-exchange-request' }, 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json({ error: 'vault-mismatch' }, 400)
  room.vaultId = body.vaultId

  const now = Date.now()
  const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
  const tokenDecision = decideSetupTokenConsume({
    token: await readSetupToken(room, setupTokenHash),
    requestedVaultId: body.vaultId,
    now,
  })
  if (tokenDecision.action === 'reject')
    return c.json({ error: `setup-token:${tokenDecision.reason}` }, 403)

  const existingDevice =
    body.existingDeviceId === undefined
      ? undefined
      : await readDeviceRegistryEntry(room, body.existingDeviceId)
  const setupDecision = decideSetupExchange({
    requestedDeviceId: body.existingDeviceId,
    registry: { existingDevice, usedYClientIds: await readUsedYClientIds(room) },
    yClientIdRange: Y_CLIENT_ID_RANGE,
  })
  if (setupDecision.action === 'reject')
    return c.json({ error: `setup-exchange:${setupDecision.reason}` }, 403)

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
    return c.json({ error: `setup-credentials:${credentialPlan.reason}` }, 500)

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
    return c.json({ error: `setup-response:${responsePlan.reason}` }, 500)

  try {
    await withSqlTransaction(room, async () => {
      await consumeSetupToken(room, setupTokenHash, tokenDecision.consumedAt)
      await persistSetupDevice(room, credentialPlan.deviceId, credentialPlan.yClientId, now)
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
    return c.json({ error: 'setup-persist:transaction-failed' }, 500)
  }

  return c.json(responsePlan.response, 200)
}

export async function handleAuthRefresh(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined) return c.text('Auth refresh unavailable', 503)
  await ensureSchema(room)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(DeviceTokenRefreshRequestSchema, body))
    return c.json({ error: 'invalid-auth-refresh-request' }, 400)
  if (room.vaultId !== undefined && body.vaultId !== room.vaultId)
    return c.json({ error: 'vault-mismatch' }, 400)
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
    return c.json({ error: `auth-refresh:${refreshDecision.reason}` }, 403)

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
    return c.json({ error: `auth-refresh-rotation:${rotationPlan.reason}` }, 500)

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
    return c.json({ error: `auth-refresh-response:${responsePlan.reason}` }, 500)

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
    return c.json({ error: 'auth-refresh-persist:transaction-failed' }, 500)
  }

  return c.json(responsePlan.response, 200)
}

export async function handleDeviceRevoke(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined) return c.text('Device revoke unavailable', 503)
  await ensureSchema(room)

  const rawDeviceId = c.req.param('deviceId')
  const targetDeviceId = v.is(DeviceIdSchema, rawDeviceId) ? rawDeviceId : undefined
  if (targetDeviceId === undefined) return c.json({ error: 'invalid-device-id' }, 400)
  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(RevokeDeviceRequestSchema, body))
    return c.json({ error: 'invalid-revoke-device-request' }, 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const targetDevice = await readDeviceRegistryEntry(room, targetDeviceId)
  const revokeDecision = decideRevokeDevice({ device: targetDevice, revokedAt: Date.now() })
  if (revokeDecision.action === 'reject')
    return c.json({ error: `revoke-device:${revokeDecision.reason}` }, 404)

  const responsePlan = planRevokeDeviceHttpResponse({ revokeDecision, deviceId: targetDeviceId })
  if (responsePlan.action === 'reject')
    return c.json({ error: `revoke-device-response:${responsePlan.reason}` }, 500)

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
  if (db === undefined || secret === undefined) return c.text('Quarantine inspect unavailable', 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return c.json(buildQuarantinedUpdateListResponse(await readQuarantinedUpdates(room)), 200)
}

export async function handleQuarantineDetail(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined) return c.text('Quarantine inspect unavailable', 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  const quarantineId = c.req.param('id') ?? ''
  const record = await readQuarantinedUpdate(room, quarantineId)
  if (record === undefined) return c.json({ error: 'unknown-quarantine' }, 404)

  return c.json(
    buildQuarantinedUpdateDetailResponse(
      record,
      encodeOptionalBase64(await readQuarantinedUpdateBytes(room, quarantineId)),
    ),
    200,
  )
}

export async function handleRetentionInspect(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined) return c.text('Retention inspect unavailable', 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return c.json(
    { events: await getSnapshotRetentionEvents(db, SNAPSHOT_RETENTION_EVENT_LIMIT) },
    200,
  )
}

export async function handleMetaLatest(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined) return c.text('Snapshot fetch unavailable', 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:read'])
  if (rejection !== undefined) return rejection

  return handleLatestSnapshotRequest(room, c, { kind: 'meta' })
}

export async function handleFileLatest(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const secret = room.env.DEVICE_TOKEN_SECRET
  if (db === undefined || secret === undefined) return c.text('Snapshot fetch unavailable', 503)
  await ensureSchema(room)

  const rawYDocId = c.req.param('ydocId')
  if (!v.is(YDocIdSchema, rawYDocId)) return c.json({ error: 'invalid-ydoc-id' }, 400)

  const rejection = await authorizeHttpRequest(room, c, ['sync:read'])
  if (rejection !== undefined) return rejection

  return handleLatestSnapshotRequest(room, c, { kind: 'file', ydocId: rawYDocId })
}

export async function handleMetaSnapshotImport(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined) return c.text('Snapshot import unavailable', 503)
  await ensureSchema(room)

  const rejection = await authorizeHttpRequest(room, c, ['sync:write'])
  if (rejection !== undefined) return rejection

  return handleSnapshotImportRequest(room, c, { kind: 'meta' })
}

export async function handleFileSnapshotImport(room: VaultRoom, c: Context): Promise<Response> {
  const db = getDb(room)
  const bucket = room.env.SNAPSHOT_BUCKET
  if (db === undefined || bucket === undefined) return c.text('Snapshot import unavailable', 503)
  await ensureSchema(room)

  const rawYDocId = c.req.param('ydocId')
  if (!v.is(YDocIdSchema, rawYDocId)) return c.json({ error: 'invalid-ydoc-id' }, 400)

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
  if (clock === undefined) return c.json({ error: 'doc-not-found' }, 404)

  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    logEvent('snapshot-hydrate-failed', {
      vaultId: room.vaultId,
      docId,
      error: retentionErrorMessage(error),
    })
    return c.json({ error: 'snapshot-hydrate-failed' }, 500)
  }

  const doc = room.docs.get(docKey(docId))
  const vaultId = room.vaultId
  if (doc === undefined || vaultId === undefined) return c.json({ error: 'doc-not-found' }, 404)

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
    return c.json({ error: 'vault-unavailable' }, 500)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(SnapshotImportRequestSchema, body))
    return c.json({ error: 'invalid-snapshot-import-request' }, 400)

  const update = decodeBase64(body.updateBytesBase64)
  if (update === null || !canApplyYjsUpdate(update))
    return c.json({ error: 'invalid-snapshot-import-update' }, 400)

  return await withDocWriteQueue(room, docId, async () => {
    let existingLatestSeq: number
    try {
      existingLatestSeq = (await readDocClock(room, docId))?.latestSeq ?? 0
    } catch {
      return c.json({ error: 'snapshot-import-hydrate-failed' }, 500)
    }
    if (existingLatestSeq > 0 && body.latestSeq === undefined) {
      return c.json(
        { error: 'snapshot-import-latest-seq-required', latestSeq: existingLatestSeq },
        409,
      )
    }
    if (body.latestSeq !== undefined && body.latestSeq !== existingLatestSeq) {
      return c.json({ error: 'snapshot-import-stale-seq', latestSeq: existingLatestSeq }, 409)
    }
    try {
      await ensureDocHydrated(room, docId)
    } catch {
      return c.json({ error: 'snapshot-import-hydrate-failed' }, 500)
    }

    const key = docKey(docId)
    const importedDoc = new Y.Doc()
    const existingDoc = room.docs.get(key)
    if (existingDoc !== undefined) Y.applyUpdate(importedDoc, Y.encodeStateAsUpdate(existingDoc))
    Y.applyUpdate(importedDoc, update)
    if (docId.kind === 'meta' && !metaYDocSchemaValid(importedDoc)) {
      importedDoc.destroy()
      return c.json({ error: 'invalid-snapshot-import-meta-schema' }, 400)
    }
    const mergedBytes = Y.encodeStateAsUpdate(importedDoc)
    const stateVector = Y.encodeStateVector(importedDoc)

    const now = Date.now()
    const snapshotSeq = existingLatestSeq + 1
    const snapshotKey = makeSnapshotObjectKey(vaultId, docId, snapshotSeq)
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
      await bucket.put(snapshotKey, mergedBytes)
      await updateCheckpointR2Written(db, runId, now)
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
      await updateCheckpointPointerUpdated(db, runId, now)
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

export async function handleWebSocketUpgrade(room: VaultRoom, c: Context): Promise<Response> {
  if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE)
    return c.text('Expected WebSocket upgrade', 426)
  if (typeof WebSocketPair === 'undefined') return c.text('WebSocketPair is not available', 500)

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
