import {
  CURRENT_PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  DeviceTokenRefreshRequestSchema,
  DeviceIdSchema,
  FileIdSchema,
  MetaFileSchema,
  BlobManifestSchema,
  BlobHeadRequestSchema,
  BlobUploadUrlRequestSchema,
  RevokeDeviceRequestSchema,
  SetupExchangeRequestSchema,
  MessageIdSchema,
  Sha256HexSchema,
  YDocIdSchema,
  makeDeviceId,
  makeSha256Hex,
  encodeBlobManifestJson,
  parseControlMessage,
  signHs256DeviceToken,
  verifyHs256DeviceToken,
  type ClientHello,
  type DeviceId,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type DocId,
  type MessageId,
  type Sha256Hex,
  type SyncRequest,
  type SyncUpdate,
  type VaultId,
} from '@kuroflare/core'
import { VaultIdSchema } from '@kuroflare/core'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import * as v from 'valibot'
import * as Y from 'yjs'

import {
  decideCheckpointCompact,
  decideCheckpointWrite,
  decideOrphanedCheckpointRecovery,
  type CheckpointRunStatus,
} from './checkpoint/checkpoint'
import {
  insertCheckpointRun,
  updateCheckpointR2Written,
  updateCheckpointPointerUpdated,
  updateCheckpointCompacted,
  updateCheckpointFailed,
  getRecoverableCheckpointRuns,
  getCheckpointDocRecoveryState,
  insertQuarantinedUpdate,
  getQuarantinedUpdates,
  getQuarantinedUpdateById,
  getQuarantinedUpdateBytes,
  type QuarantinedUpdateRow,
} from './db/checkpointRepo'
import { createDb } from './db/db'
import {
  getDevice,
  getAllDeviceYClientIds,
  upsertDevice,
  updateDeviceRevoked,
  getRefreshToken,
  insertRefreshToken,
  updateRefreshTokenRevoked,
} from './db/deviceRepo'
import {
  insertDoc,
  upsertDocClock,
  insertOpLog,
  upsertMessageDedup,
  getDocClock,
  getDocSnapshotPointer,
  getDocSnapshotSeq,
  getDocRetention,
  getDocsNeedingCheckpoint,
  getFirstDocId,
  getOpLogUpdatesSince,
  getMessageDedupSeq,
  updateDocSnapshotPointer,
  updateDocCompact,
  deleteOpLogBelowSeq,
} from './db/docRepo'
import { readSqlUpdateBytes } from './db/helpers'
import { decideSchemaMigration } from './db/migrations'
import { SCHEMA_MIGRATIONS } from './db/schema'
import { createSchemaMigrationsTable, getAppliedMigrations, insertMigration } from './db/schemaRepo'
import { upsertSetupToken, getSetupToken, consumeSetupToken } from './db/setupRepo'
import {
  decideDeviceTokenRefresh,
  decideRevokeDevice,
  decideSetupExchange,
  decideClientHelloRegistry,
  isValidYClientId,
  planDeviceRefreshTokenRotation,
  planSetupExchangeCredentials,
  type DeviceRefreshTokenEvidence,
  type DeviceRegistryEntry,
  type YClientId,
  type YClientIdRange,
} from './devices'
import { decideSetupTokenConsume, type SetupTokenEntry } from './devices/tokens'
import { decideAuthAdmission } from './http/auth'
import { planDeviceTokenRefreshHttpResponse } from './http/authRefresh'
import {
  planBlobHeadHttpResponse,
  planBlobUploadUrlHttpResponse,
  type BlobHeadObjectEvidence,
  type BlobUploadObjectEvidence,
} from './http/blob'
import { planRevokeDeviceHttpResponse } from './http/device'
import {
  buildQuarantinedUpdateDetailResponse,
  buildQuarantinedUpdateListResponse,
} from './http/quarantine'
import { planSetupExchangeHttpResponse } from './http/setup'
import type { QuarantinedUpdateRecord } from './quarantine'
import { decideSyncRequest, type SyncRequestDocState } from './sync/request'
import {
  chooseSnapshotForRestore,
  makeSnapshotListPrefix,
  makeSnapshotObjectKey,
  type SnapshotCandidate,
} from './sync/snapshots'
import {
  decideSyncUpdateAppend,
  decideSyncUpdateQuarantine,
  type SyncUpdateDocClock,
  type SyncUpdateDuplicateEvidence,
} from './sync/update'
export * from './runtime/types'
import type { Kysely } from 'kysely'

import type { Database } from './db/types'
import {
  type WorkerEnv,
  type DurableObjectStateBinding,
  type RuntimeWebSocket,
  type RuntimeWebSocketPairConstructor,
  type SessionState,
  type WebSocketAttachment,
  type WebSocketResponseInit,
  type RuntimeDocClockRecord,
  type RuntimeSnapshotPointerRecord,
  type RuntimeCheckpointRunRecord,
  type RuntimeCheckpointDocRecoveryRecord,
  type RuntimeCheckpointSnapshotEvidence,
  type RuntimeCheckpointResult,
  PosIntSchema,
  NonNegIntSchema,
  E2eSetupTokenSeedRequestSchema,
  E2eSnapshotSeedRequestSchema,
} from './runtime/types'

declare const WebSocketPair: RuntimeWebSocketPairConstructor | undefined

const WEBSOCKET_UPGRADE = 'websocket'
const LARGE_UPDATE_THRESHOLD_BYTES = 512 * 1024
const SETUP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const SETUP_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const REFRESH_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1_000
const CHECKPOINT_ALARM_DELAY_MS = 30_000
const CHECKPOINT_ALARM_DOC_LIMIT = 16
const CHECKPOINT_OP_THRESHOLD = 128
const BLOB_MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024
const BLOB_SINGLE_PUT_MAX_BYTES = BLOB_MULTIPART_THRESHOLD_BYTES - 1
const BLOB_MANIFEST_MAX_BYTES = 1024 * 1024
const BLOB_UPLOAD_URL_TTL_MS = 10 * 60 * 1_000
const VAULT_ID_STORAGE_KEY = 'vault:id'
const Y_CLIENT_ID_RANGE: YClientIdRange = { min: 1, max: 2_147_483_647 }
const E2E_SETUP_TOKEN_PATH = '/__e2e/setup-token'
const E2E_SNAPSHOT_PATH = '/__e2e/snapshot'

/** Cloudflare Durable Object shell for one vault room. */
export class VaultRoom {
  private readonly sessions = new Set<RuntimeWebSocket>()
  private readonly sessionStates = new Map<RuntimeWebSocket, SessionState>()
  private readonly socketTokens = new Map<RuntimeWebSocket, string | undefined>()
  private readonly docs = new Map<string, Y.Doc>()
  private readonly hydratedDocs = new Set<string>()
  private readonly docWriteQueues = new Map<string, Promise<void>>()
  private vaultId: VaultId | undefined
  private schemaReady = false
  private readonly doRouter: Hono

  constructor(
    private readonly state: DurableObjectStateBinding,
    private readonly env: WorkerEnv,
  ) {
    this.doRouter = new Hono()
      .post(E2E_SETUP_TOKEN_PATH, async (c) => {
        const db = this.getDb()
        if (db === undefined) return c.text('E2E setup token seed unavailable', 503)
        await this.ensureSchema()

        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(E2eSetupTokenSeedRequestSchema, body)) {
          return c.json({ error: 'invalid-e2e-setup-token-seed-request' }, 400)
        }
        if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
          return c.json({ error: 'vault-mismatch' }, 400)
        }
        this.vaultId = body.vaultId

        const now = Date.now()
        const expiresAt = now + (body.expiresInMs ?? 10 * 60 * 1_000)
        const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
        await upsertSetupToken(db, setupTokenHash, body.vaultId, now, expiresAt)

        return c.json(
          {
            ok: true,
            vaultId: body.vaultId,
            expiresAt,
            tokenReadable: (await this.readSetupToken(setupTokenHash)) !== undefined,
          },
          200,
        )
      })
      .post(E2E_SNAPSHOT_PATH, async (c) => {
        const db = this.getDb()
        const bucket = this.env.SNAPSHOT_BUCKET
        if (db === undefined || bucket === undefined) {
          return c.text('E2E snapshot seed unavailable', 503)
        }
        await this.ensureSchema()

        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(E2eSnapshotSeedRequestSchema, body)) {
          return c.json({ error: 'invalid-e2e-snapshot-seed-request' }, 400)
        }
        if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
          return c.json({ error: 'vault-mismatch' }, 400)
        }
        this.vaultId = body.vaultId

        const update = decodeBase64(body.update)
        if (update === null || !canApplyYjsUpdate(update)) {
          return c.json({ error: 'invalid-e2e-snapshot-update' }, 400)
        }
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
      })
      .post('/setup/exchange', async (c) => {
        const db = this.getDb()
        const secret = this.env.DEVICE_TOKEN_SECRET
        if (db === undefined || secret === undefined)
          return c.text('Setup exchange unavailable', 503)
        await this.ensureSchema()

        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(SetupExchangeRequestSchema, body)) {
          return c.json({ error: 'invalid-setup-exchange-request' }, 400)
        }
        if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
          return c.json({ error: 'vault-mismatch' }, 400)
        }
        this.vaultId = body.vaultId

        const now = Date.now()
        const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
        const tokenDecision = decideSetupTokenConsume({
          token: await this.readSetupToken(setupTokenHash),
          requestedVaultId: body.vaultId,
          now,
        })
        if (tokenDecision.action === 'reject') {
          return c.json({ error: `setup-token:${tokenDecision.reason}` }, 403)
        }

        const existingDevice =
          body.existingDeviceId === undefined
            ? undefined
            : await this.readDeviceRegistryEntry(body.existingDeviceId)
        const setupDecision = decideSetupExchange({
          requestedDeviceId: body.existingDeviceId,
          registry: { existingDevice, usedYClientIds: await this.readUsedYClientIds() },
          yClientIdRange: Y_CLIENT_ID_RANGE,
        })
        if (setupDecision.action === 'reject') {
          return c.json({ error: `setup-exchange:${setupDecision.reason}` }, 403)
        }

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
        if (credentialPlan.action === 'reject') {
          return c.json({ error: `setup-credentials:${credentialPlan.reason}` }, 500)
        }

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
          bootstrapMode: (await this.hasAnyPersistedDocs()) ? 'join-existing' : 'new-vault',
        })
        if (responsePlan.action === 'reject') {
          return c.json({ error: `setup-response:${responsePlan.reason}` }, 500)
        }

        try {
          await this.withSqlTransaction(async () => {
            await this.consumeSetupToken(setupTokenHash, tokenDecision.consumedAt)
            await this.persistSetupDevice(credentialPlan.deviceId, credentialPlan.yClientId, now)
            await this.persistRefreshToken(
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
      })
      .post('/auth/refresh', async (c) => {
        const db = this.getDb()
        const secret = this.env.DEVICE_TOKEN_SECRET
        if (db === undefined || secret === undefined) return c.text('Auth refresh unavailable', 503)
        await this.ensureSchema()

        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(DeviceTokenRefreshRequestSchema, body)) {
          return c.json({ error: 'invalid-auth-refresh-request' }, 400)
        }
        if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
          return c.json({ error: 'vault-mismatch' }, 400)
        }
        this.vaultId = body.vaultId

        const now = Date.now()
        const currentTokenHash = makeSha256Hex(await sha256Text(body.refreshToken))
        const device = await this.readDeviceRegistryEntry(body.deviceId)
        const refreshDecision = decideDeviceTokenRefresh({
          device,
          refreshToken: await this.readRefreshToken(currentTokenHash),
          previousTokenVersion: body.previousTokenVersion,
          now,
        })
        if (refreshDecision.action === 'reject') {
          return c.json({ error: `auth-refresh:${refreshDecision.reason}` }, 403)
        }

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
        if (rotationPlan.action === 'reject') {
          return c.json({ error: `auth-refresh-rotation:${rotationPlan.reason}` }, 500)
        }

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
        if (responsePlan.action === 'reject') {
          return c.json({ error: `auth-refresh-response:${responsePlan.reason}` }, 500)
        }

        try {
          await this.withSqlTransaction(async () => {
            await this.revokeRefreshToken(
              rotationPlan.revoke.tokenHash,
              rotationPlan.revoke.revokedAt,
            )
            await this.persistRefreshToken(
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
      })
      .post('/devices/:deviceId/revoke', async (c) => {
        const db = this.getDb()
        const secret = this.env.DEVICE_TOKEN_SECRET
        if (db === undefined || secret === undefined)
          return c.text('Device revoke unavailable', 503)
        await this.ensureSchema()

        const rawDeviceId = c.req.param('deviceId')
        const targetDeviceId = v.is(DeviceIdSchema, rawDeviceId) ? rawDeviceId : undefined
        if (targetDeviceId === undefined) return c.json({ error: 'invalid-device-id' }, 400)
        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(RevokeDeviceRequestSchema, body)) {
          return c.json({ error: 'invalid-revoke-device-request' }, 400)
        }

        const rejection = await this.authorizeHttpRequest(c, ['sync:write'])
        if (rejection !== undefined) return rejection

        const targetDevice = await this.readDeviceRegistryEntry(targetDeviceId)
        const revokeDecision = decideRevokeDevice({ device: targetDevice, revokedAt: Date.now() })
        if (revokeDecision.action === 'reject') {
          return c.json({ error: `revoke-device:${revokeDecision.reason}` }, 404)
        }
        const responsePlan = planRevokeDeviceHttpResponse({
          revokeDecision,
          deviceId: targetDeviceId,
        })
        if (responsePlan.action === 'reject') {
          return c.json({ error: `revoke-device-response:${responsePlan.reason}` }, 500)
        }

        if (revokeDecision.action === 'revoke-device') {
          await this.persistDeviceRevocation(
            targetDeviceId,
            revokeDecision.tokenVersion,
            revokeDecision.revokedAt,
          )
        }

        return c.json(responsePlan.response, 200)
      })
      .get('/admin/quarantine', async (c) => {
        const db = this.getDb()
        const secret = this.env.DEVICE_TOKEN_SECRET
        if (db === undefined || secret === undefined)
          return c.text('Quarantine inspect unavailable', 503)
        await this.ensureSchema()

        const rejection = await this.authorizeHttpRequest(c, ['sync:write'])
        if (rejection !== undefined) return rejection

        return c.json(buildQuarantinedUpdateListResponse(await this.readQuarantinedUpdates()), 200)
      })
      .get('/admin/quarantine/:id', async (c) => {
        const db = this.getDb()
        const secret = this.env.DEVICE_TOKEN_SECRET
        if (db === undefined || secret === undefined)
          return c.text('Quarantine inspect unavailable', 503)
        await this.ensureSchema()

        const rejection = await this.authorizeHttpRequest(c, ['sync:write'])
        if (rejection !== undefined) return rejection

        const quarantineId = c.req.param('id') ?? ''
        const record = await this.readQuarantinedUpdate(quarantineId)
        if (record === undefined) return c.json({ error: 'unknown-quarantine' }, 404)

        return c.json(
          buildQuarantinedUpdateDetailResponse(
            record,
            encodeOptionalBase64(await this.readQuarantinedUpdateBytes(quarantineId)),
          ),
          200,
        )
      })
      .post('/blobs/head', async (c) => {
        if (this.env.SNAPSHOT_BUCKET === undefined) return c.text('Blob storage unavailable', 503)

        const rejection = await this.authorizeHttpRequest(c, ['blob:read'])
        if (rejection !== undefined) return rejection
        const vaultId = this.vaultId
        if (vaultId === undefined) return c.json({ error: 'vault-unavailable' }, 500)

        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(BlobHeadRequestSchema, body)) {
          return c.json({ error: 'invalid-blob-head-request' }, 400)
        }

        const objects: BlobHeadObjectEvidence[] = []
        for (const hash of body.hashes) {
          objects.push(await this.readBlobHeadEvidence(vaultId, hash))
        }

        const plan = planBlobHeadHttpResponse({ request: body, objects })
        if (plan.action === 'reject') return c.json({ error: `blob-head:${plan.reason}` }, 400)
        return c.json(plan.response, 200)
      })
      .post('/blobs/upload-url', async (c) => {
        if (this.env.SNAPSHOT_BUCKET === undefined) return c.text('Blob storage unavailable', 503)

        const rejection = await this.authorizeHttpRequest(c, ['blob:write'])
        if (rejection !== undefined) return rejection

        const body: unknown = await c.req.json().catch(() => undefined)
        if (!v.is(BlobUploadUrlRequestSchema, body)) {
          return c.json({ error: 'invalid-blob-upload-url-request' }, 400)
        }
        if (body.size > BLOB_SINGLE_PUT_MAX_BYTES || body.multipart === true) {
          return c.json({ error: 'blob-upload-url:multipart-unimplemented' }, 413)
        }
        const vaultId = this.vaultId
        if (vaultId === undefined) return c.json({ error: 'vault-unavailable' }, 500)

        const now = Date.now()
        const expiresAt = now + BLOB_UPLOAD_URL_TTL_MS
        const uploadUrl = new URL(c.req.url)
        uploadUrl.pathname = `/blobs/${body.sha256}`
        uploadUrl.search = `?size=${body.size}`
        const object = await this.readBlobUploadEvidence(vaultId, body.sha256)
        const plan = planBlobUploadUrlHttpResponse({
          request: body,
          object,
          now,
          policy: { multipartThresholdBytes: BLOB_MULTIPART_THRESHOLD_BYTES },
          singlePut: { kind: 'single-put', url: uploadUrl.toString(), headers: {}, expiresAt },
        })
        if (plan.action === 'reject') {
          const status = plan.reason === 'multipart-required' ? 413 : 400
          return c.json({ error: `blob-upload-url:${plan.reason}` }, status)
        }
        return c.json(plan.response, 200)
      })
      .get('/blobs/:hash', async (c) => {
        const hash = c.req.param('hash')
        if (!v.is(Sha256HexSchema, hash)) return c.json({ error: 'invalid-blob-hash' }, 400)

        const rejection = await this.authorizeHttpRequest(c, ['blob:read'])
        if (rejection !== undefined) return rejection
        const vaultId = this.vaultId
        if (vaultId === undefined) return c.json({ error: 'vault-unavailable' }, 500)

        const object = await this.env.SNAPSHOT_BUCKET?.get(blobObjectKey(vaultId, hash))
        if (object === undefined) return c.text('Blob storage unavailable', 503)
        if (object === null) return c.json({ error: 'blob-not-found' }, 404)

        const bytes = new Uint8Array(await object.arrayBuffer())
        if (makeSha256Hex(await sha256Hex(bytes)) !== hash) {
          return c.json({ error: 'blob/hash-mismatch' }, 500)
        }
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.byteLength),
            'x-content-sha256': hash,
          },
        })
      })
      .put('/blobs/:hash', async (c) => {
        const hash = c.req.param('hash')
        if (!v.is(Sha256HexSchema, hash)) return c.json({ error: 'invalid-blob-hash' }, 400)

        const bucket = this.env.SNAPSHOT_BUCKET
        if (bucket === undefined) return c.text('Blob storage unavailable', 503)

        const rejection = await this.authorizeHttpRequest(c, ['blob:write'])
        if (rejection !== undefined) return rejection
        const vaultId = this.vaultId
        if (vaultId === undefined) return c.json({ error: 'vault-unavailable' }, 500)

        const expectedSize = parseBlobSize(c.req.raw)
        if (expectedSize === undefined) return c.json({ error: 'invalid-blob-size' }, 400)
        if (expectedSize > BLOB_SINGLE_PUT_MAX_BYTES) {
          return c.json({ error: 'blob-upload-url:multipart-unimplemented' }, 413)
        }
        const contentLength = parseContentLength(c.req.raw)
        if (contentLength === undefined || contentLength > BLOB_SINGLE_PUT_MAX_BYTES) {
          return c.json({ error: 'invalid-blob-size' }, 413)
        }
        const bytes = await readRequestBytesWithLimit(c.req.raw, BLOB_SINGLE_PUT_MAX_BYTES)
        if (bytes === undefined) return c.json({ error: 'invalid-blob-size' }, 413)
        if (bytes.byteLength !== expectedSize) return c.json({ error: 'blob/size-mismatch' }, 400)
        if (makeSha256Hex(await sha256Hex(bytes)) !== hash)
          return c.json({ error: 'blob/hash-mismatch' }, 400)

        await bucket.put(blobObjectKey(vaultId, hash), bytes)
        return c.json({ status: 'stored', sha256: hash, size: bytes.byteLength }, 200)
      })
      .get('/blob-manifests/*', async (c) => {
        const match = /^\/blob-manifests\/([^/]+)\.json$/.exec(c.req.path)
        const hash = match !== null && v.is(Sha256HexSchema, match[1]) ? match[1] : undefined
        if (hash === undefined) return c.json({ error: 'invalid-blob-manifest-hash' }, 400)

        const rejection = await this.authorizeHttpRequest(c, ['blob:read'])
        if (rejection !== undefined) return rejection
        const vaultId = this.vaultId
        if (vaultId === undefined) return c.json({ error: 'vault-unavailable' }, 500)

        const object = await this.env.SNAPSHOT_BUCKET?.get(blobManifestObjectKey(vaultId, hash))
        if (object === undefined) return c.text('Blob storage unavailable', 503)
        if (object === null) return c.json({ error: 'blob-manifest-not-found' }, 404)

        const bytes = new Uint8Array(await object.arrayBuffer())
        if (makeSha256Hex(await sha256Hex(bytes)) !== hash) {
          return c.json({ error: 'blob-manifest/hash-mismatch' }, 500)
        }
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(bytes.byteLength),
            'x-content-sha256': hash,
          },
        })
      })
      .put('/blob-manifests/*', async (c) => {
        const match = /^\/blob-manifests\/([^/]+)\.json$/.exec(c.req.path)
        const hash = match !== null && v.is(Sha256HexSchema, match[1]) ? match[1] : undefined
        if (hash === undefined) return c.json({ error: 'invalid-blob-manifest-hash' }, 400)

        const bucket = this.env.SNAPSHOT_BUCKET
        if (bucket === undefined) return c.text('Blob storage unavailable', 503)

        const rejection = await this.authorizeHttpRequest(c, ['blob:write'])
        if (rejection !== undefined) return rejection
        const vaultId = this.vaultId
        if (vaultId === undefined) return c.json({ error: 'vault-unavailable' }, 500)

        const contentLength = parseContentLength(c.req.raw)
        if (contentLength === undefined || contentLength > BLOB_MANIFEST_MAX_BYTES) {
          return c.json({ error: 'invalid-blob-manifest-size' }, 413)
        }
        const requestBytes = await readRequestBytesWithLimit(c.req.raw, BLOB_MANIFEST_MAX_BYTES)
        if (requestBytes === undefined) return c.json({ error: 'invalid-blob-manifest-size' }, 413)

        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(requestBytes))
        } catch {
          return c.json({ error: 'invalid-blob-manifest-json' }, 400)
        }
        if (!v.is(BlobManifestSchema, body))
          return c.json({ error: 'invalid-blob-manifest-json' }, 400)

        const canonicalBytes = encodeBlobManifestJson(body)
        if (makeSha256Hex(await sha256Hex(canonicalBytes)) !== hash) {
          return c.json({ error: 'blob-manifest/hash-mismatch' }, 400)
        }

        await bucket.put(blobManifestObjectKey(vaultId, hash), canonicalBytes)
        return c.json({ status: 'stored', sha256: hash, size: canonicalBytes.byteLength }, 200)
      })
      .all('*', (c) => {
        if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
          return c.text('Expected WebSocket upgrade', 426)
        }
        if (typeof WebSocketPair === 'undefined') {
          return c.text('WebSocketPair is not available', 500)
        }

        const pair = new WebSocketPair()
        const client = pair[0]
        const server = pair[1]
        this.state.acceptWebSocket(server)
        this.sessions.add(server)
        this.rememberSocketToken(server, extractWebSocketBearerToken(c.req.raw))

        const upgradeInit: WebSocketResponseInit = { status: 101, webSocket: client }
        return new Response(null, upgradeInit)
      })
  }

  private getDb(): Kysely<Database> | undefined {
    const sql = this.state.storage.sql
    return sql === undefined ? undefined : createDb(sql)
  }

  fetch(request: Request): Response | Promise<Response> {
    this.rememberVaultId(request)
    return this.doRouter.fetch(request)
  }

  async webSocketMessage(
    webSocket: RuntimeWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ensureSchema()
    if (typeof message !== 'string') {
      const frame = decodeBinaryFrame(new Uint8Array(message))
      if (frame === null) {
        webSocket.close(1003, 'invalid-binary-frame')
        return
      }
      const result = await this.handleSyncUpdate(webSocket, {
        ...frame.header,
        update: encodeBase64(frame.payload),
      })
      if (result.action === 'broadcast') {
        this.broadcast(
          webSocket,
          makeArrayBuffer(
            encodeBinaryFrame({ ...frame.header, durableSeq: result.durableSeq }, frame.payload),
          ),
        )
      }
      return
    }

    const control = parseControlMessage(message)
    if (control === null) {
      webSocket.close(1003, 'invalid-control-message')
      return
    }

    if (control.type === 'hello') {
      await this.acceptHello(webSocket, control)
      return
    }

    if (control.type === 'sync-request') {
      await this.handleSyncRequest(webSocket, control)
      return
    }

    if (control.type !== 'sync-update') {
      webSocket.close(1003, 'unsupported-control-message')
      return
    }

    const result = await this.handleSyncUpdate(webSocket, control)
    if (result.action === 'broadcast') {
      this.broadcast(webSocket, JSON.stringify({ ...control, durableSeq: result.durableSeq }))
    }
  }

  webSocketClose(webSocket: RuntimeWebSocket): void {
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  webSocketError(webSocket: RuntimeWebSocket): void {
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  async alarm(): Promise<void> {
    await this.ensureSchema()
    await this.recoverOrphanedCheckpointRuns(CHECKPOINT_ALARM_DOC_LIMIT)
    for (const docId of await this.readCheckpointableDocIds(CHECKPOINT_ALARM_DOC_LIMIT)) {
      await this.checkpointDoc(docId)
    }
  }

  async checkpointDoc(docId: DocId, now = Date.now()): Promise<RuntimeCheckpointResult> {
    await this.ensureSchema()
    const db = this.getDb()
    const bucket = this.env.SNAPSHOT_BUCKET
    const vaultId = await this.resolveVaultId()
    if (db === undefined || bucket === undefined || vaultId === undefined) {
      return { action: 'skipped', reason: 'runtime-unavailable' }
    }

    try {
      await this.ensureDocHydrated(docId)
    } catch {
      return { action: 'skipped', reason: 'hydrate-failed' }
    }

    const doc = this.docs.get(docKey(docId))
    const clock = await this.readDocClock(docId)
    const snapshotSeq = await this.readSnapshotSeq(docId)
    if (doc === undefined) {
      return { action: 'skipped', reason: 'doc-unavailable' }
    }
    if (clock === undefined || !v.is(PosIntSchema, clock.latestSeq)) {
      return { action: 'skipped', reason: 'invalid-clock' }
    }

    const snapshotKey = makeSnapshotObjectKey(vaultId, docId, clock.latestSeq)
    const decision = decideCheckpointWrite({
      latestSeq: clock.latestSeq,
      latestSnapshotSeq: snapshotSeq,
      snapshotKey,
      now,
    })
    if (decision.action === 'skip') {
      return { action: 'skipped', reason: decision.reason }
    }

    const snapshotBytes = Y.encodeStateAsUpdate(doc)
    const stateVector = Y.encodeStateVector(doc)
    await insertCheckpointRun(
      db,
      decision.runId,
      docKey(docId),
      decision.upperSeq,
      decision.snapshotKey,
      stateVector,
      'writing',
      decision.createdAt,
    )
    await bucket.put(decision.snapshotKey, snapshotBytes)
    await updateCheckpointR2Written(db, decision.runId, now)
    await updateDocSnapshotPointer(
      db,
      decision.upperSeq,
      decision.snapshotKey,
      stateVector,
      now,
      docKey(docId),
      decision.upperSeq,
    )
    await updateCheckpointPointerUpdated(db, decision.runId, now)
    const compact = decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: decision.upperSeq,
      latestSnapshotSeq: decision.upperSeq,
      now,
    })
    if (compact.action === 'compact') {
      await deleteOpLogBelowSeq(db, docKey(docId), compact.compactedSeq)
      await updateDocCompact(
        db,
        compact.compactedSeq,
        stateVector,
        compact.compactedAt,
        docKey(docId),
        compact.compactedSeq,
      )
      await updateCheckpointCompacted(db, decision.runId, compact.compactedAt)
    }

    return {
      action: 'checkpointed',
      snapshotKey: decision.snapshotKey,
      upperSeq: decision.upperSeq,
      compactedSeq: compact.action === 'compact' ? compact.compactedSeq : undefined,
    }
  }

  private async recoverOrphanedCheckpointRuns(limit: number, now = Date.now()): Promise<void> {
    const db = this.getDb()
    const bucket = this.env.SNAPSHOT_BUCKET
    if (db === undefined || bucket === undefined || limit <= 0) {
      return
    }

    for (const run of await this.readRecoverableCheckpointRuns(limit)) {
      await this.recoverOrphanedCheckpointRun(run, now)
    }
  }

  private async recoverOrphanedCheckpointRun(
    run: RuntimeCheckpointRunRecord,
    now: number,
  ): Promise<void> {
    const doc = await this.readCheckpointDocRecoveryState(run.docId)
    const snapshot = await this.readCheckpointSnapshotEvidence(run.snapshotKey)
    const pointerVerified = await this.checkpointPointerVerified(doc)
    const decision = decideOrphanedCheckpointRecovery({
      run,
      doc: {
        latestSnapshotSeq: doc.latestSnapshotSeq,
        pointerVerified,
      },
      snapshot,
    })

    switch (decision.action) {
      case 'ignore-terminal':
      case 'block-compact':
        return
      case 'fail-run':
      case 'mark-stale':
        await this.markCheckpointRunFailed(run.runId)
        return
      case 'mark-r2-written':
        await this.markCheckpointRunR2Written(run.runId, now)
        return
      case 'advance-pointer':
        if (run.snapshotKey === undefined || snapshot === undefined || !snapshot.verified) {
          await this.markCheckpointRunFailed(run.runId)
          return
        }
        await this.advanceRecoveredCheckpointPointer(run, snapshot.stateVector, now)
        return
      case 'compact-op-log':
        if (snapshot === undefined || !snapshot.verified || snapshot.stateVector === undefined) {
          return
        }
        await this.compactRecoveredCheckpointRun(run, snapshot.stateVector, now)
        return
    }
  }

  private async acceptHello(webSocket: RuntimeWebSocket, hello: ClientHello): Promise<void> {
    if (this.vaultId !== undefined && hello.vaultId !== this.vaultId) {
      webSocket.close(1008, 'vault-mismatch')
      return
    }
    if (!isValidYClientId(hello.yClientId)) {
      webSocket.close(1003, 'invalid-y-client-id')
      return
    }

    const device = await this.readDeviceRegistryEntry(hello.deviceId)
    const tokenVersion = await this.authorizeHello(webSocket, hello, device)
    if (tokenVersion === undefined) {
      return
    }
    const registry = decideClientHelloRegistry({
      device,
      claimedYClientId: hello.yClientId,
      tokenVersion,
    })
    if (registry.action === 'reject') {
      webSocket.close(1008, `hello-reject:${registry.reason}`)
      return
    }
    if (registry.action === 'require-full-snapshot') {
      webSocket.close(1008, `hello-requires-full-snapshot:${registry.reason}`)
      return
    }

    this.rememberSession(webSocket, {
      vaultId: hello.vaultId,
      deviceId: hello.deviceId,
      yClientId: hello.yClientId,
    })
    await this.persistVaultId(hello.vaultId)
    webSocket.send(
      JSON.stringify({
        type: 'hello-accepted',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: hello.vaultId,
        deviceId: hello.deviceId,
        yClientId: hello.yClientId,
      }),
    )
  }

  private async authorizeHello(
    webSocket: RuntimeWebSocket,
    hello: ClientHello,
    device: DeviceRegistryEntry | undefined,
  ): Promise<number | undefined> {
    const secret = this.env.DEVICE_TOKEN_SECRET
    if (secret === undefined) {
      if (this.state.storage.sql !== undefined) {
        webSocket.close(1008, 'auth-reject:missing-secret')
        return undefined
      }
      return device?.tokenVersion ?? 1
    }

    const token = this.readSocketToken(webSocket)
    if (token === undefined) {
      webSocket.close(1008, 'auth-reject:missing-token')
      return undefined
    }

    const claims = await verifyHs256DeviceToken({ token, secret })
    if (claims === undefined) {
      webSocket.close(1008, 'auth-reject:invalid-token')
      return undefined
    }

    const admission = decideAuthAdmission({
      claims,
      expectedVaultId: hello.vaultId,
      device,
      requiredScopes: ['sync:read', 'sync:write'],
      now: Date.now(),
    })
    if (admission.action === 'reject') {
      webSocket.close(1008, `auth-reject:${admission.reason}`)
      return undefined
    }

    return claims.tokenVersion
  }

  private async verifyRequestClaims(c: Context): Promise<DeviceTokenClaims | undefined> {
    const secret = this.env.DEVICE_TOKEN_SECRET
    const token = extractBearerToken(c.req.header('Authorization') ?? null)
    if (secret === undefined || token === undefined) {
      return undefined
    }
    return verifyHs256DeviceToken({ token, secret })
  }

  private async authorizeHttpRequest(
    c: Context,
    requiredScopes: readonly DeviceTokenScope[],
  ): Promise<Response | undefined> {
    const claims = await this.verifyRequestClaims(c)
    if (claims === undefined) {
      return c.json({ error: 'auth-reject:invalid-token' }, 401)
    }
    if (this.vaultId !== undefined && claims.aud !== this.vaultId) {
      return c.json({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = claims.aud

    const actorDevice = await this.readDeviceRegistryEntry(claims.sub)
    const admission = decideAuthAdmission({
      claims,
      expectedVaultId: claims.aud,
      device: actorDevice,
      requiredScopes,
      now: Date.now(),
    })
    if (admission.action === 'reject') {
      return c.json({ error: `auth-reject:${admission.reason}` }, 403)
    }
    return undefined
  }

  private async readBlobHeadEvidence(
    vaultId: VaultId,
    sha256: Sha256Hex,
  ): Promise<BlobHeadObjectEvidence> {
    const object = await this.env.SNAPSHOT_BUCKET?.head(blobObjectKey(vaultId, sha256))
    if (object === undefined || object === null) {
      return { sha256, found: false }
    }
    return { sha256, found: true, size: object.size }
  }

  private async readBlobUploadEvidence(
    vaultId: VaultId,
    sha256: Sha256Hex,
  ): Promise<BlobUploadObjectEvidence> {
    const object = await this.env.SNAPSHOT_BUCKET?.head(blobObjectKey(vaultId, sha256))
    if (object === undefined || object === null) {
      return { sha256, found: false }
    }
    return { sha256, found: true, size: object.size }
  }

  private async handleSyncRequest(
    webSocket: RuntimeWebSocket,
    request: SyncRequest,
  ): Promise<void> {
    const session = this.readSession(webSocket)
    if (session === undefined) {
      webSocket.close(1008, 'hello-required')
      return
    }
    if (!this.messageMatchesSession(session, request)) {
      webSocket.close(1008, 'session-mismatch')
      return
    }
    if (this.state.storage.sql === undefined) {
      webSocket.close(1011, 'sync-storage-unavailable')
      return
    }

    const clientStateVector = decodeBase64(request.stateVector)
    if (clientStateVector === null) {
      webSocket.close(1003, 'invalid-state-vector')
      return
    }

    const persisted = await this.readSyncRequestDocState(request.docId)
    let docState: SyncRequestDocState | undefined
    if (persisted !== undefined) {
      try {
        await this.ensureDocHydrated(request.docId)
      } catch {
        webSocket.close(1011, 'hydrate-failed')
        return
      }
      const doc = this.docs.get(docKey(request.docId))
      if (doc !== undefined) {
        const diffUpdate = Y.encodeStateAsUpdate(doc, clientStateVector)
        docState = {
          ...persisted,
          stateVectorCoversHorizon: stateVectorCoversHorizon(
            clientStateVector,
            persisted.horizonStateVector,
          ),
          diffSourceAvailable: true,
          diffUpdateBase64: isEmptyYjsUpdate(diffUpdate) ? undefined : encodeBase64(diffUpdate),
        }
      }
    }

    const decision = decideSyncRequest({
      request,
      doc: docState,
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    })

    if (decision.action === 'send-update') {
      webSocket.send(JSON.stringify(decision.response))
      return
    }
    if (decision.action === 'need-full-snapshot') {
      webSocket.send(JSON.stringify(decision.response))
      return
    }
    if (decision.action === 'reject') {
      webSocket.close(1011, `sync-request-reject:${decision.reason}`)
    }
  }

  private async handleSyncUpdate(
    webSocket: RuntimeWebSocket,
    update: SyncUpdate,
  ): Promise<
    { readonly action: 'broadcast'; readonly durableSeq: number } | { readonly action: 'stop' }
  > {
    const session = this.readSession(webSocket)
    if (session === undefined) {
      webSocket.close(1008, 'hello-required')
      return { action: 'stop' }
    }
    if (!this.messageMatchesSession(session, update)) {
      webSocket.close(1008, 'session-mismatch')
      return { action: 'stop' }
    }
    if (this.state.storage.sql === undefined) {
      webSocket.close(1011, 'sync-storage-unavailable')
      return { action: 'stop' }
    }

    const updateBytes = decodeBase64(update.update)
    if (updateBytes === null) {
      webSocket.close(1003, 'invalid-update-base64')
      return { action: 'stop' }
    }

    return await this.withDocWriteQueue(update.docId, async () => {
      return await this.handleSyncUpdateSerialized(webSocket, update, updateBytes, session)
    })
  }

  private async handleSyncUpdateSerialized(
    webSocket: RuntimeWebSocket,
    update: SyncUpdate,
    updateBytes: Uint8Array,
    session: SessionState,
  ): Promise<
    { readonly action: 'broadcast'; readonly durableSeq: number } | { readonly action: 'stop' }
  > {
    if (this.readSession(webSocket) === undefined) {
      webSocket.close(1008, 'hello-required')
      return { action: 'stop' }
    }

    const now = Date.now()
    const updateSha256 = makeSha256Hex(await sha256Hex(updateBytes))
    const doc = await this.readDocClock(update.docId)
    const duplicate = await this.readDuplicate(update.docId, update.messageId)
    if (duplicate !== undefined) {
      const duplicateDecision = decideSyncUpdateAppend({
        update,
        doc,
        duplicate,
        updateBytesLength: updateBytes.byteLength,
        updateSha256,
        yClientId: session.yClientId,
        now,
        largeUpdateThresholdBytes: LARGE_UPDATE_THRESHOLD_BYTES,
      })
      if (duplicateDecision.action === 'ack-duplicate') {
        webSocket.send(JSON.stringify(duplicateDecision.ack))
        return { action: 'stop' }
      }
      webSocket.close(1011, 'duplicate-reject')
      return { action: 'stop' }
    }

    try {
      await this.ensureDocHydrated(update.docId)
    } catch {
      webSocket.close(1011, 'hydrate-failed')
      return { action: 'stop' }
    }

    const yjsApplySucceeded = canApplyYjsUpdate(updateBytes)
    const metaSchemaValid =
      update.docId.kind === 'meta' && yjsApplySucceeded
        ? this.metaSchemaValidAfterUpdate(updateBytes)
        : undefined
    const quarantine = decideSyncUpdateQuarantine({
      update,
      quarantineId: makeQuarantineId(update),
      updateBytesLength: updateBytes.byteLength,
      actualUpdateSha256: updateSha256,
      ...(update.updateSha256 === undefined ? {} : { expectedUpdateSha256: update.updateSha256 }),
      yjsApplySucceeded,
      metaSchemaValid,
      now,
    })

    if (quarantine.action === 'reject') {
      webSocket.close(1011, `quarantine-reject:${quarantine.reason}`)
      return { action: 'stop' }
    }
    if (quarantine.action === 'quarantine') {
      await this.persistQuarantine(updateBytes, quarantine.row)
      return { action: 'stop' }
    }

    const append = decideSyncUpdateAppend({
      update,
      doc,
      duplicate: undefined,
      updateBytesLength: quarantine.updateBytesLength,
      updateSha256: quarantine.updateSha256,
      yClientId: session.yClientId,
      now,
      largeUpdateThresholdBytes: LARGE_UPDATE_THRESHOLD_BYTES,
    })

    if (append.action === 'reject') {
      webSocket.close(1011, `append-reject:${append.reason}`)
      return { action: 'stop' }
    }

    if (append.action === 'ack-duplicate') {
      webSocket.send(JSON.stringify(append.ack))
      return { action: 'stop' }
    }

    if (append.action === 'snapshot-escape') {
      await this.persistDocClock(update.docId, {
        latestSeq: append.docPatch.latestSeq,
        updatedAt: append.docPatch.updatedAt,
      })
      await this.persistDuplicate(update.docId, update.messageId, append.seq, now)
      webSocket.send(JSON.stringify(append.ack))
      webSocket.send(JSON.stringify(append.boundary))
      return { action: 'stop' }
    }

    await this.persistAppend(
      update,
      updateBytes,
      append.opLogAppend.seq,
      {
        latestSeq: append.docPatch.latestSeq,
        updatedAt: append.docPatch.updatedAt,
      },
      session.yClientId,
      quarantine.updateSha256,
      now,
    )
    this.applyUpdate(update.docId, updateBytes)
    await this.scheduleCheckpointAfterAppend(update.docId, append.docPatch.latestSeq, now)
    webSocket.send(JSON.stringify(append.ack))

    return { action: 'broadcast', durableSeq: append.opLogAppend.seq }
  }

  private async withDocWriteQueue<T>(docId: DocId, task: () => Promise<T>): Promise<T> {
    const key = docKey(docId)
    const previous = this.docWriteQueues.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(
      () => current,
      () => current,
    )
    this.docWriteQueues.set(key, queued)

    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.docWriteQueues.get(key) === queued) {
        this.docWriteQueues.delete(key)
      }
    }
  }

  private async persistQuarantine(
    updateBytes: Uint8Array,
    row: {
      readonly id: string
      readonly docId: DocId
      readonly messageId: MessageId
      readonly deviceId: SyncUpdate['deviceId']
      readonly reason: string
      readonly updateSha256: string
      readonly createdAt: number
    },
  ): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      throw new Error('sql-unavailable')
    }

    await insertQuarantinedUpdate(
      db,
      row.id,
      docKey(row.docId),
      row.messageId,
      row.deviceId,
      row.reason,
      row.updateSha256,
      updateBytes,
      row.createdAt,
    )
  }

  private async persistAppend(
    update: SyncUpdate,
    updateBytes: Uint8Array,
    seq: number,
    docPatch: RuntimeDocClockRecord,
    yClientId: YClientId,
    updateSha256: string,
    now: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      throw new Error('sql-unavailable')
    }

    const docId = docKey(update.docId)
    await insertOpLog(
      db,
      docId,
      seq,
      update.messageId,
      update.deviceId,
      yClientId,
      updateBytes,
      updateSha256,
      now,
    )
    await upsertDocClock(db, docId, update.docId.kind, docPatch.latestSeq, docPatch.updatedAt)
    await upsertMessageDedup(db, docId, update.messageId, seq, now)
  }

  private async persistDocClock(docId: DocId, docPatch: RuntimeDocClockRecord): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      throw new Error('sql-unavailable')
    }

    await upsertDocClock(db, docKey(docId), docId.kind, docPatch.latestSeq, docPatch.updatedAt)
  }

  private async persistDuplicate(
    docId: DocId,
    messageId: MessageId,
    durableSeq: number,
    now: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      throw new Error('sql-unavailable')
    }

    await upsertMessageDedup(db, docKey(docId), messageId, durableSeq, now)
  }

  private applyUpdate(docId: DocId, updateBytes: Uint8Array): void {
    const key = docKey(docId)
    const doc = this.docs.get(key) ?? new Y.Doc()
    this.docs.set(key, doc)
    Y.applyUpdate(doc, updateBytes)
  }

  private metaSchemaValidAfterUpdate(updateBytes: Uint8Array): boolean {
    const doc = this.docs.get(docKey({ kind: 'meta' }))
    if (doc === undefined) {
      return false
    }

    const candidate = new Y.Doc()
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc))
      Y.applyUpdate(candidate, updateBytes)
      return metaYDocSchemaValid(candidate)
    } catch {
      return false
    } finally {
      candidate.destroy()
    }
  }

  private async ensureDocHydrated(docId: DocId): Promise<void> {
    const key = docKey(docId)
    if (this.hydratedDocs.has(key)) {
      return
    }

    const db = this.getDb()
    if (db === undefined) {
      throw new Error('sql-unavailable')
    }

    const doc = new Y.Doc()
    const snapshot = await this.chooseSnapshot(docId)
    if (snapshot !== undefined) {
      const snapshotKey = snapshot.latestSnapshotKey
      const bucket = this.env.SNAPSHOT_BUCKET
      if (bucket === undefined) {
        throw new Error('snapshot-bucket-unavailable')
      }
      const snapshotObject = await bucket.get(snapshotKey)
      if (snapshotObject === null) {
        throw new Error('snapshot-missing')
      }
      Y.applyUpdate(doc, new Uint8Array(await snapshotObject.arrayBuffer()))
    }

    const minSeq = snapshot?.latestSnapshotSeq ?? 0
    for (const row of await getOpLogUpdatesSince(db, key, minSeq)) {
      const updateBytes = readSqlUpdateBytes(row.updateBytes)
      if (updateBytes === undefined) {
        throw new Error('invalid op_log update_bytes')
      }
      Y.applyUpdate(doc, updateBytes)
    }
    this.docs.set(key, doc)
    this.hydratedDocs.add(key)
  }

  private async chooseSnapshot(docId: DocId): Promise<RuntimeSnapshotPointerRecord | undefined> {
    const pointer = await this.readSnapshotPointer(docId)
    const listed = await this.listSnapshotCandidates(docId)
    if (listed.length === 0) {
      return pointer
    }

    const choice = chooseSnapshotForRestore(
      pointer === undefined
        ? undefined
        : {
            key: pointer.latestSnapshotKey,
            upperSeq: pointer.latestSnapshotSeq,
            healthy: true,
          },
      listed,
    )
    return {
      latestSnapshotKey: choice.key,
      latestSnapshotSeq: choice.upperSeq,
    }
  }

  private async readSnapshotPointer(
    docId: DocId,
  ): Promise<RuntimeSnapshotPointerRecord | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getDocSnapshotPointer(db, docKey(docId))
    const latestSnapshotSeq = row?.latestSnapshotSeq
    const latestSnapshotKey = row?.latestSnapshotKey
    if (
      !v.is(PosIntSchema, latestSnapshotSeq) ||
      typeof latestSnapshotKey !== 'string' ||
      latestSnapshotKey.length === 0
    ) {
      return undefined
    }

    return { latestSnapshotSeq, latestSnapshotKey }
  }

  private async readSnapshotSeq(docId: DocId): Promise<number> {
    const db = this.getDb()
    if (db === undefined) {
      return 0
    }

    const row = await getDocSnapshotSeq(db, docKey(docId))
    const latestSnapshotSeq = row?.latestSnapshotSeq
    return v.is(NonNegIntSchema, latestSnapshotSeq) ? latestSnapshotSeq : 0
  }

  private async readCheckpointableDocIds(limit: number): Promise<readonly DocId[]> {
    const db = this.getDb()
    if (db === undefined || limit <= 0) {
      return []
    }

    const docIds: DocId[] = []
    for (const row of await getDocsNeedingCheckpoint(db, limit)) {
      const docId = docIdFromKey(row.docId)
      if (docId !== undefined) {
        docIds.push(docId)
      }
    }
    return docIds
  }

  private async readRecoverableCheckpointRuns(
    limit: number,
  ): Promise<readonly RuntimeCheckpointRunRecord[]> {
    const db = this.getDb()
    if (db === undefined || limit <= 0) {
      return []
    }

    const runs: RuntimeCheckpointRunRecord[] = []
    for (const row of await getRecoverableCheckpointRuns(db, limit)) {
      const docId = docIdFromKey(row.docId)
      if (
        docId !== undefined &&
        isCheckpointRunStatus(row.status) &&
        v.is(PosIntSchema, row.upperSeq)
      ) {
        runs.push({
          runId: row.runId,
          docId,
          status: row.status,
          upperSeq: row.upperSeq,
          snapshotKey: row.snapshotKey ?? undefined,
        })
      }
    }
    return runs
  }

  private async readCheckpointDocRecoveryState(
    docId: DocId,
  ): Promise<RuntimeCheckpointDocRecoveryRecord> {
    const db = this.getDb()
    if (db === undefined) {
      return { latestSnapshotSeq: 0, latestSnapshotKey: undefined }
    }

    const row = await getCheckpointDocRecoveryState(db, docKey(docId))
    const latestSnapshotSeq = row?.latestSnapshotSeq
    const latestSnapshotKey = row?.latestSnapshotKey
    return {
      latestSnapshotSeq: v.is(NonNegIntSchema, latestSnapshotSeq) ? latestSnapshotSeq : 0,
      latestSnapshotKey: typeof latestSnapshotKey === 'string' ? latestSnapshotKey : undefined,
    }
  }

  private async readCheckpointSnapshotEvidence(
    snapshotKey: string | undefined,
  ): Promise<RuntimeCheckpointSnapshotEvidence | undefined> {
    const bucket = this.env.SNAPSHOT_BUCKET
    if (bucket === undefined || snapshotKey === undefined) {
      return undefined
    }

    const object = await bucket.get(snapshotKey)
    if (object === null) {
      return { exists: false, verified: false, stateVector: undefined }
    }

    try {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(await object.arrayBuffer()))
      const stateVector = Y.encodeStateVector(doc)
      doc.destroy()
      return { exists: true, verified: true, stateVector }
    } catch {
      return { exists: true, verified: false, stateVector: undefined }
    }
  }

  private async checkpointPointerVerified(
    doc: RuntimeCheckpointDocRecoveryRecord,
  ): Promise<boolean> {
    if (doc.latestSnapshotKey === undefined || doc.latestSnapshotSeq <= 0) {
      return false
    }
    const evidence = await this.readCheckpointSnapshotEvidence(doc.latestSnapshotKey)
    return evidence?.verified === true
  }

  private async markCheckpointRunFailed(runId: string): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      return
    }
    await updateCheckpointFailed(db, runId)
  }

  private async markCheckpointRunR2Written(runId: string, now: number): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      return
    }
    await updateCheckpointR2Written(db, runId, now)
  }

  private async advanceRecoveredCheckpointPointer(
    run: RuntimeCheckpointRunRecord,
    stateVector: Uint8Array | undefined,
    now: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db === undefined || run.snapshotKey === undefined || stateVector === undefined) {
      return
    }

    await updateDocSnapshotPointer(
      db,
      run.upperSeq,
      run.snapshotKey,
      stateVector,
      now,
      docKey(run.docId),
      run.upperSeq,
    )
    await updateCheckpointPointerUpdated(db, run.runId, now)
  }

  private async compactRecoveredCheckpointRun(
    run: RuntimeCheckpointRunRecord,
    horizonStateVector: Uint8Array,
    now: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db === undefined) {
      return
    }

    await deleteOpLogBelowSeq(db, docKey(run.docId), run.upperSeq)
    await updateDocCompact(
      db,
      run.upperSeq,
      horizonStateVector,
      now,
      docKey(run.docId),
      run.upperSeq,
    )
    await updateCheckpointCompacted(db, run.runId, now)
  }

  private async listSnapshotCandidates(docId: DocId): Promise<readonly SnapshotCandidate[]> {
    const bucket = this.env.SNAPSHOT_BUCKET
    const vaultId = this.vaultId
    if (bucket === undefined || vaultId === undefined) {
      return []
    }

    const prefix = makeSnapshotListPrefix(vaultId, docId)
    const result = await bucket.list({ prefix })
    return result.objects
      .map((object) => snapshotCandidateFromKey(prefix, object.key))
      .filter((candidate): candidate is SnapshotCandidate => candidate !== undefined)
  }

  private async readDocClock(docId: DocId): Promise<SyncUpdateDocClock | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getDocClock(db, docKey(docId))
    const latestSeq = row?.latestSeq
    return v.is(NonNegIntSchema, latestSeq) ? { latestSeq } : undefined
  }

  private async readDuplicate(
    docId: DocId,
    messageId: MessageId,
  ): Promise<SyncUpdateDuplicateEvidence | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getMessageDedupSeq(db, docKey(docId), messageId)
    const durableSeq = row?.durableSeq
    return v.is(PosIntSchema, durableSeq) ? { durableSeq } : undefined
  }

  private async readSyncRequestDocState(
    docId: DocId,
  ): Promise<
    | (Omit<
        SyncRequestDocState,
        'stateVectorCoversHorizon' | 'diffSourceAvailable' | 'diffUpdateBase64'
      > & { readonly horizonStateVector: Uint8Array | undefined })
    | undefined
  > {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getDocRetention(db, docKey(docId))
    const latestSeq = row?.latestSeq
    const minRetainedSeq = row?.minRetainedSeq
    const horizonStateVector = readSqlUpdateBytes(row?.horizonStateVector)
    if (!v.is(NonNegIntSchema, latestSeq) || !v.is(NonNegIntSchema, minRetainedSeq)) {
      return undefined
    }

    return { latestSeq, minRetainedSeq, horizonStateVector }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return
    }
    const sql = this.state.storage.sql
    const db = this.getDb()
    if (sql === undefined || db === undefined) {
      return
    }

    await createSchemaMigrationsTable(db)
    const appliedVersions = new Set<number>()
    for (const row of await getAppliedMigrations(db)) {
      if (v.is(PosIntSchema, row.version)) {
        appliedVersions.add(row.version)
      }
    }

    const decision = decideSchemaMigration({
      appliedVersions,
      availableMigrations: SCHEMA_MIGRATIONS,
      failedMigration: undefined,
    })
    if (decision.action === 'apply-migrations') {
      const now = Date.now()
      for (const migration of decision.migrations) {
        await migration.migrate(db)
        await insertMigration(db, migration.version, now)
      }
    }

    this.schemaReady = true
  }

  private async readDeviceRegistryEntry(
    deviceId: ClientHello['deviceId'],
  ): Promise<DeviceRegistryEntry | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getDevice(db, deviceId)
    const yClientId = row?.yClientId
    const tokenVersion = row?.tokenVersion
    const revokedAt = row?.revokedAt ?? undefined

    if (!isValidYClientId(yClientId) || !v.is(PosIntSchema, tokenVersion)) {
      return undefined
    }

    return { deviceId, yClientId, tokenVersion, revokedAt }
  }

  private async readSetupToken(tokenHash: string): Promise<SetupTokenEntry | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getSetupToken(db, tokenHash)
    if (
      row === undefined ||
      !v.is(VaultIdSchema, row.vaultId) ||
      !v.is(NonNegIntSchema, row.issuedAt) ||
      !v.is(NonNegIntSchema, row.expiresAt)
    ) {
      return undefined
    }
    const consumedAt = row.consumedAt ?? undefined
    if (consumedAt !== undefined && !v.is(NonNegIntSchema, consumedAt)) {
      return undefined
    }

    return {
      vaultId: row.vaultId,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      consumedAt,
    }
  }

  private async readUsedYClientIds(): Promise<ReadonlySet<YClientId>> {
    const db = this.getDb()
    const used = new Set<YClientId>()
    if (db === undefined) {
      return used
    }

    for (const row of await getAllDeviceYClientIds(db)) {
      if (isValidYClientId(row.yClientId)) {
        used.add(row.yClientId)
      }
    }
    return used
  }

  private async readRefreshToken(
    tokenHash: string,
  ): Promise<DeviceRefreshTokenEvidence | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getRefreshToken(db, tokenHash)
    if (
      row === undefined ||
      !v.is(NonNegIntSchema, row.issuedAt) ||
      !v.is(NonNegIntSchema, row.expiresAt)
    ) {
      return undefined
    }
    const revokedAt = row.revokedAt ?? undefined

    return {
      tokenHashMatches: true,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      revokedAt,
    }
  }

  private async readQuarantinedUpdates(): Promise<readonly QuarantinedUpdateRecord[]> {
    const db = this.getDb()
    if (db === undefined) {
      return []
    }

    return [...(await getQuarantinedUpdates(db))]
      .map(quarantinedUpdateRecordFromSqlRow)
      .filter((record): record is QuarantinedUpdateRecord => record !== undefined)
  }

  private async readQuarantinedUpdate(id: string): Promise<QuarantinedUpdateRecord | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    return quarantinedUpdateRecordFromSqlRow(await getQuarantinedUpdateById(db, id))
  }

  private async readQuarantinedUpdateBytes(id: string): Promise<Uint8Array | undefined> {
    const db = this.getDb()
    if (db === undefined) {
      return undefined
    }

    const row = await getQuarantinedUpdateBytes(db, id)
    return readSqlUpdateBytes(row?.updateBytes)
  }

  private async hasAnyPersistedDocs(): Promise<boolean> {
    const db = this.getDb()
    if (db === undefined) {
      return false
    }

    return (await getFirstDocId(db)) !== undefined
  }

  private async consumeSetupToken(tokenHash: string, consumedAt: number): Promise<void> {
    const db = this.getDb()
    if (db !== undefined) {
      await consumeSetupToken(db, tokenHash, consumedAt)
    }
  }

  private async persistSetupDevice(
    deviceId: string,
    yClientId: YClientId,
    now: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db !== undefined) {
      await upsertDevice(db, deviceId, yClientId, now)
    }
  }

  private async persistRefreshToken(
    tokenHash: string,
    deviceId: string,
    issuedAt: number,
    expiresAt: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db !== undefined) {
      await insertRefreshToken(db, tokenHash, deviceId, issuedAt, expiresAt)
    }
  }

  private async revokeRefreshToken(tokenHash: string, revokedAt: number): Promise<void> {
    const db = this.getDb()
    if (db !== undefined) {
      await updateRefreshTokenRevoked(db, tokenHash, revokedAt)
    }
  }

  private async persistDeviceRevocation(
    deviceId: string,
    tokenVersion: number,
    revokedAt: number,
  ): Promise<void> {
    const db = this.getDb()
    if (db !== undefined) {
      await updateDeviceRevoked(db, deviceId, tokenVersion, revokedAt)
    }
  }

  private async withSqlTransaction(write: () => Promise<void>): Promise<void> {
    if (this.state.storage.sql === undefined) {
      throw new Error('sql-unavailable')
    }

    await this.state.storage.transaction(write)
  }

  private messageMatchesSession(
    session: SessionState,
    message: Pick<SyncRequest | SyncUpdate, 'vaultId' | 'deviceId'>,
  ): boolean {
    return message.vaultId === session.vaultId && message.deviceId === session.deviceId
  }

  private rememberSocketToken(webSocket: RuntimeWebSocket, authToken: string | undefined): void {
    this.socketTokens.set(webSocket, authToken)
    this.writeSocketAttachment(webSocket, {
      ...this.readSocketAttachment(webSocket),
      ...(authToken === undefined ? {} : { authToken }),
    })
  }

  private readSocketToken(webSocket: RuntimeWebSocket): string | undefined {
    const token = this.socketTokens.get(webSocket)
    if (token !== undefined) {
      return token
    }

    const attachmentToken = this.readSocketAttachment(webSocket).authToken
    if (attachmentToken !== undefined) {
      this.socketTokens.set(webSocket, attachmentToken)
    }
    return attachmentToken
  }

  private rememberSession(webSocket: RuntimeWebSocket, session: SessionState): void {
    this.sessions.add(webSocket)
    this.sessionStates.set(webSocket, session)
    this.writeSocketAttachment(webSocket, {
      ...this.readSocketAttachment(webSocket),
      session,
    })
  }

  private readSession(webSocket: RuntimeWebSocket): SessionState | undefined {
    const session = this.sessionStates.get(webSocket)
    if (session !== undefined) {
      return session
    }

    const attachmentSession = this.readSocketAttachment(webSocket).session
    if (attachmentSession !== undefined) {
      this.sessions.add(webSocket)
      this.sessionStates.set(webSocket, attachmentSession)
    }
    return attachmentSession
  }

  private readSocketAttachment(webSocket: RuntimeWebSocket): WebSocketAttachment {
    const attachment = webSocket.deserializeAttachment?.()
    return isWebSocketAttachment(attachment) ? attachment : {}
  }

  private writeSocketAttachment(
    webSocket: RuntimeWebSocket,
    attachment: WebSocketAttachment,
  ): void {
    webSocket.serializeAttachment?.(attachment)
  }

  private async scheduleCheckpointAlarm(scheduledTime: number): Promise<void> {
    if (
      this.state.storage.sql === undefined ||
      this.env.SNAPSHOT_BUCKET === undefined ||
      this.state.storage.setAlarm === undefined
    ) {
      return
    }

    await this.state.storage.setAlarm(scheduledTime)
  }

  private async scheduleCheckpointAfterAppend(
    docId: DocId,
    latestSeq: number,
    now: number,
  ): Promise<void> {
    const snapshotSeq = await this.readSnapshotSeq(docId)
    const delay = latestSeq - snapshotSeq >= CHECKPOINT_OP_THRESHOLD ? 0 : CHECKPOINT_ALARM_DELAY_MS
    await this.scheduleCheckpointAlarm(now + delay)
  }

  private async persistVaultId(vaultId: VaultId): Promise<void> {
    if (this.vaultId === undefined) {
      this.vaultId = vaultId
    }
    if (this.vaultId !== vaultId) {
      return
    }
    await this.state.storage.put(VAULT_ID_STORAGE_KEY, vaultId)
  }

  private async resolveVaultId(): Promise<VaultId | undefined> {
    if (this.vaultId !== undefined) {
      return this.vaultId
    }
    const storedVaultId = await this.state.storage.get(VAULT_ID_STORAGE_KEY)
    if (!v.is(VaultIdSchema, storedVaultId)) {
      return undefined
    }
    this.vaultId = storedVaultId
    return storedVaultId
  }

  private broadcast(sender: RuntimeWebSocket, message: string | ArrayBuffer): void {
    for (const session of this.connectedAuthenticatedSockets()) {
      if (session !== sender) {
        session.send(message)
      }
    }
  }

  private connectedAuthenticatedSockets(): readonly RuntimeWebSocket[] {
    const hibernated = this.state.getWebSockets?.() ?? []
    return [...new Set([...this.sessions, ...hibernated])].filter(
      (session) => this.readSession(session) !== undefined,
    )
  }

  private rememberVaultId(request: Request): void {
    const match = /^\/ws\/([^/]+)$/.exec(new URL(request.url).pathname)
    const vaultId = match?.[1]
    if (vaultId !== undefined && v.is(VaultIdSchema, vaultId)) {
      this.vaultId = vaultId
    }
  }
}

async function verifyBearerToken(
  env: WorkerEnv,
  request: Request,
): Promise<DeviceTokenClaims | undefined> {
  const secret = env.DEVICE_TOKEN_SECRET
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (secret === undefined || token === undefined) return undefined
  return verifyHs256DeviceToken({ token, secret })
}

const workerApp = new Hono<{ Bindings: WorkerEnv }>()

workerApp.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'x-kuroflare-e2e-secret'],
    allowMethods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'],
  }),
)

workerApp.post(E2E_SETUP_TOKEN_PATH, async (c) => {
  const secret = c.env.E2E_SETUP_TOKEN_SECRET
  if (secret === undefined) return c.notFound()
  if (c.req.header('x-kuroflare-e2e-secret') !== secret) {
    return c.json({ error: 'e2e-seed-forbidden' }, 403)
  }
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(E2eSetupTokenSeedRequestSchema, body)) {
    return c.json({ error: 'invalid-e2e-setup-token-seed-request' }, 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post(E2E_SNAPSHOT_PATH, async (c) => {
  const secret = c.env.E2E_SETUP_TOKEN_SECRET
  if (secret === undefined) return c.notFound()
  if (c.req.header('x-kuroflare-e2e-secret') !== secret) {
    return c.json({ error: 'e2e-seed-forbidden' }, 403)
  }
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(E2eSnapshotSeedRequestSchema, body)) {
    return c.json({ error: 'invalid-e2e-snapshot-seed-request' }, 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post('/setup/exchange', async (c) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(SetupExchangeRequestSchema, body)) {
    return c.json({ error: 'invalid-setup-exchange-request' }, 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post('/auth/refresh', async (c) => {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(DeviceTokenRefreshRequestSchema, body)) {
    return c.json({ error: 'invalid-auth-refresh-request' }, 400)
  }
  return routeVaultRoom(c.req.raw, c.env, body.vaultId)
})

workerApp.post('/devices/:deviceId/revoke', async (c) => {
  const rawDeviceId = c.req.param('deviceId')
  if (!v.is(DeviceIdSchema, rawDeviceId)) {
    return c.json({ error: 'invalid-device-id' }, 400)
  }
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined)
  if (!v.is(RevokeDeviceRequestSchema, body)) {
    return c.json({ error: 'invalid-revoke-device-request' }, 400)
  }
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.get('/admin/quarantine', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.get('/admin/quarantine/:id', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.post('/blobs/head', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.post('/blobs/upload-url', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.on(['GET', 'PUT'], '/blobs/:hash', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.on(['GET', 'PUT'], '/blob-manifests/*', async (c) => {
  const claims = await verifyBearerToken(c.env, c.req.raw)
  if (claims === undefined) return c.json({ error: 'auth-reject:invalid-token' }, 401)
  return routeVaultRoom(c.req.raw, c.env, claims.aud)
})

workerApp.get('/ws/:vaultId', async (c) => {
  const vaultId = c.req.param('vaultId')
  if (!v.is(VaultIdSchema, vaultId)) {
    return c.text('Invalid vaultId', 400)
  }
  if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
    return c.text('Expected WebSocket upgrade', 426)
  }
  return routeVaultRoom(c.req.raw, c.env, vaultId)
})

export const workerEntrypoint = workerApp
export default workerApp

function routeVaultRoom(request: Request, env: WorkerEnv, vaultId: VaultId): Promise<Response> {
  const id = env.VAULT_ROOM.idFromName(vaultId)
  const room = env.VAULT_ROOM.get(id)
  return Promise.resolve(room.fetch(request))
}

function docKey(docId: DocId): string {
  return docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
}

function docIdFromKey(key: unknown): DocId | undefined {
  if (key === 'meta') {
    return { kind: 'meta' }
  }
  if (typeof key !== 'string' || !key.startsWith('file:')) {
    return undefined
  }

  const ydocId = key.slice('file:'.length)
  return v.is(YDocIdSchema, ydocId) ? { kind: 'file', ydocId } : undefined
}

function makeQuarantineId(update: SyncUpdate): string {
  return `q-${update.messageId}`
}

function blobObjectKey(vaultId: VaultId, sha256: Sha256Hex): string {
  return `vaults/${vaultId}/blobs/${sha256}`
}

function blobManifestObjectKey(vaultId: VaultId, sha256: Sha256Hex): string {
  return `vaults/${vaultId}/blob-manifests/${sha256}.json`
}

function parseBlobSize(request: Request): number | undefined {
  const rawSize = new URL(request.url).searchParams.get('size')
  if (rawSize === null || !/^(0|[1-9][0-9]*)$/.test(rawSize)) {
    return undefined
  }
  const size = Number(rawSize)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

function parseContentLength(request: Request): number | undefined {
  const rawLength = request.headers.get('content-length')
  if (rawLength === null || !/^(0|[1-9][0-9]*)$/.test(rawLength)) {
    return undefined
  }
  const length = Number(rawLength)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

async function readRequestBytesWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (request.body === null) {
    return new Uint8Array()
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) {
      break
    }
    total += result.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function snapshotCandidateFromKey(prefix: string, key: string): SnapshotCandidate | undefined {
  if (!key.startsWith(prefix) || !key.endsWith('.yupdate')) {
    return undefined
  }

  const seqText = key.slice(prefix.length, -'.yupdate'.length)
  if (!/^[1-9][0-9]*$/.test(seqText)) {
    return undefined
  }

  const upperSeq = Number(seqText)
  if (!v.is(PosIntSchema, upperSeq)) {
    return undefined
  }

  return { key, upperSeq, healthy: true }
}

function quarantinedUpdateRecordFromSqlRow(
  row: QuarantinedUpdateRow | undefined,
): QuarantinedUpdateRecord | undefined {
  if (row === undefined) {
    return undefined
  }

  const docId = docIdFromKey(row.docId)
  const updateBytes = readSqlUpdateBytes(row.updateBytes)
  if (
    docId === undefined ||
    !v.is(MessageIdSchema, row.messageId) ||
    !v.is(DeviceIdSchema, row.deviceId) ||
    !isQuarantineReason(row.reason) ||
    !v.is(Sha256HexSchema, row.updateSha256) ||
    updateBytes === undefined ||
    !v.is(NonNegIntSchema, row.createdAt)
  ) {
    return undefined
  }

  return {
    id: row.id,
    docId,
    messageId: row.messageId,
    deviceId: row.deviceId,
    reason: row.reason,
    updateSha256: row.updateSha256,
    updateBytesLength: updateBytes.byteLength,
    createdAt: row.createdAt,
  }
}

function isQuarantineReason(value: unknown): value is QuarantinedUpdateRecord['reason'] {
  return (
    value === 'hash-mismatch' || value === 'yjs-apply-failed' || value === 'meta-schema-invalid'
  )
}

function stateVectorCoversHorizon(
  clientStateVector: Uint8Array,
  horizonStateVector: Uint8Array | undefined,
): boolean {
  if (horizonStateVector === undefined || horizonStateVector.byteLength === 0) {
    return true
  }

  try {
    const client = Y.decodeStateVector(clientStateVector)
    const horizon = Y.decodeStateVector(horizonStateVector)
    for (const [clientId, horizonClock] of horizon) {
      if ((client.get(clientId) ?? 0) < horizonClock) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function canApplyYjsUpdate(updateBytes: Uint8Array): boolean {
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, updateBytes)
    return true
  } catch {
    return false
  } finally {
    candidate.destroy()
  }
}

function metaYDocSchemaValid(doc: Y.Doc): boolean {
  const meta = doc.getMap<unknown>('meta')
  for (const [fileId, value] of meta.entries()) {
    if (!v.is(FileIdSchema, fileId) || !(v.is(MetaFileSchema, value) && value.fileId === fileId)) {
      return false
    }
  }
  return true
}

function isEmptyYjsUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    const bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function encodeOptionalBase64(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : encodeBase64(value)
}

function extractBearerToken(authorization: string | null): string | undefined {
  if (authorization === null) {
    return undefined
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)
  return match?.[1]
}

function extractWebSocketBearerToken(request: Request): string | undefined {
  const headerToken = extractBearerToken(request.headers.get('Authorization'))
  if (headerToken !== undefined) {
    return headerToken
  }

  const queryToken = new URL(request.url).searchParams.get('access_token')
  if (queryToken !== null && isCompactJwt(queryToken)) {
    return queryToken
  }

  return extractWebSocketProtocolToken(request.headers.get('Sec-WebSocket-Protocol'))
}

function extractWebSocketProtocolToken(protocolHeader: string | null): string | undefined {
  if (protocolHeader === null) {
    return undefined
  }
  for (const token of protocolHeader.split(',')) {
    const trimmed = token.trim()
    if (isCompactJwt(trimmed)) {
      return trimmed
    }
    if (trimmed.startsWith('kuroflare-token.')) {
      const encoded = trimmed.slice('kuroflare-token.'.length)
      if (isCompactJwt(encoded)) {
        return encoded
      }
    }
  }
  return undefined
}

function isCompactJwt(value: string | null): boolean {
  return value !== null && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}

function isWebSocketAttachment(value: unknown): value is WebSocketAttachment {
  if (!isRecord(value)) {
    return false
  }
  const authToken = value.authToken
  const session = value.session
  return (
    (authToken === undefined || typeof authToken === 'string') &&
    (session === undefined || isSessionState(session))
  )
}

function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) {
    return false
  }
  return (
    v.is(VaultIdSchema, value.vaultId) &&
    v.is(DeviceIdSchema, value.deviceId) &&
    isValidYClientId(value.yClientId)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCheckpointRunStatus(value: unknown): value is CheckpointRunStatus {
  return (
    value === 'writing' ||
    value === 'r2-written' ||
    value === 'pointer-updated' ||
    value === 'compacted' ||
    value === 'failed'
  )
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function makeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function makeOpaqueToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeGeneratedDeviceId(): DeviceId {
  return makeDeviceId(`device-${crypto.randomUUID()}`)
}
