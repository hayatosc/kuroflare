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
  DocIdSchema,
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
} from '@kuroflare/protocol'
import { VaultIdSchema } from '@kuroflare/protocol'
import * as v from 'valibot'
import * as Y from 'yjs'

import { planDeviceTokenRefreshHttpResponse } from './auth-refresh-http.js'
import { decideAuthAdmission } from './auth.js'
import {
  planBlobHeadHttpResponse,
  planBlobUploadUrlHttpResponse,
  type BlobHeadObjectEvidence,
  type BlobUploadObjectEvidence,
} from './blob-http.js'
import {
  decideCheckpointCompact,
  decideCheckpointWrite,
  decideOrphanedCheckpointRecovery,
  type CheckpointRunStatus,
} from './checkpoint.js'
import { planRevokeDeviceHttpResponse } from './device-http.js'
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
} from './devices.js'
import { decideSchemaMigration } from './migrations.js'
import {
  buildQuarantinedUpdateDetailResponse,
  buildQuarantinedUpdateListResponse,
} from './quarantine-http.js'
import type { QuarantinedUpdateRecord } from './quarantine.js'
import { SCHEMA_MIGRATIONS } from './schema.js'
import { planSetupExchangeHttpResponse } from './setup-http.js'
import { decideSetupTokenConsume, type SetupTokenEntry } from './setup-tokens.js'
import {
  chooseSnapshotForRestore,
  makeSnapshotListPrefix,
  makeSnapshotObjectKey,
  type SnapshotCandidate,
} from './snapshots.js'
import { decideSyncRequest, type SyncRequestDocState } from './sync-request.js'
import {
  decideSyncUpdateAppend,
  decideSyncUpdateQuarantine,
  type SyncUpdateDocClock,
  type SyncUpdateDuplicateEvidence,
} from './sync-update.js'

/** Environment bindings required by the Worker entrypoint. */
export interface WorkerEnv {
  readonly VAULT_ROOM: DurableObjectNamespaceBinding
  readonly SNAPSHOT_BUCKET?: R2BucketBinding
  readonly DEVICE_TOKEN_SECRET?: string
  readonly E2E_SETUP_TOKEN_SECRET?: string
}

/** Minimal Durable Object namespace surface used by the Worker shell. */
export interface DurableObjectNamespaceBinding {
  idFromName(name: string): DurableObjectIdBinding
  get(id: DurableObjectIdBinding): DurableObjectStubBinding
}

/** Opaque Durable Object id returned by the runtime. */
export interface DurableObjectIdBinding {
  readonly toString?: () => string
}

/** Minimal Durable Object stub surface used by the Worker shell. */
export interface DurableObjectStubBinding {
  fetch(request: Request): Response | Promise<Response>
}

/** Minimal Durable Object state surface used by `VaultRoom`. */
export interface DurableObjectStateBinding {
  readonly storage: DurableObjectStorageBinding
  acceptWebSocket(webSocket: RuntimeWebSocket): void
  getWebSockets?(): readonly RuntimeWebSocket[]
}

/** Minimal Durable Object storage surface reserved for op-log wiring. */
export interface DurableObjectStorageBinding {
  readonly sql?: DurableObjectSqlStorageBinding
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  setAlarm?(scheduledTime: number | Date): Promise<void>
  transactionSync?<T>(closure: () => T): T
}

/** Minimal SQLite surface used by the Durable Object runtime shell. */
export interface DurableObjectSqlStorageBinding {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: readonly unknown[]
  ): Iterable<T>
}

/** Minimal R2 bucket surface used by cold-start snapshot hydration. */
export interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBodyBinding | null>
  head(key: string): Promise<R2ObjectMetadataBinding | null>
  list(options: R2ListOptionsBinding): Promise<R2ObjectsBinding>
  put(key: string, value: Uint8Array): Promise<void>
}

/** Minimal R2 object metadata used by blob HEAD planning. */
export interface R2ObjectMetadataBinding {
  readonly size: number
}

/** Minimal R2 object body surface used by cold-start snapshot hydration. */
export interface R2ObjectBodyBinding {
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Minimal R2 list options used by cold-start snapshot fallback. */
export interface R2ListOptionsBinding {
  readonly prefix: string
}

/** Minimal R2 list result used by cold-start snapshot fallback. */
export interface R2ObjectsBinding {
  readonly objects: readonly R2ObjectBinding[]
}

/** Minimal R2 listed object metadata used by cold-start snapshot fallback. */
export interface R2ObjectBinding {
  readonly key: string
}

/** WebSocket methods used by the Worker shell and tests. */
export interface RuntimeWebSocket {
  accept?: () => void
  send(message: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  serializeAttachment?: (attachment: unknown) => void
  deserializeAttachment?: () => unknown
}

interface RuntimeWebSocketPair {
  readonly 0: RuntimeWebSocket
  readonly 1: RuntimeWebSocket
}

interface RuntimeWebSocketPairConstructor {
  new (): RuntimeWebSocketPair
}

interface WebSocketUpgradeResponseInit extends ResponseInit {
  readonly webSocket: RuntimeWebSocket
}

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
const Y_CLIENT_ID_RANGE = { min: 1, max: 2_147_483_647 } as const
const E2E_SETUP_TOKEN_PATH = '/__e2e/setup-token'
const E2E_SNAPSHOT_PATH = '/__e2e/snapshot'

const E2eSetupTokenSeedRequestSchema = v.object({
  vaultId: VaultIdSchema,
  setupToken: v.pipe(v.string(), v.minLength(1)),
  expiresInMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400_000))),
})

const E2eSnapshotSeedRequestSchema = v.object({
  vaultId: VaultIdSchema,
  docId: DocIdSchema,
  update: v.pipe(v.string(), v.minLength(1)),
  latestSeq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})

interface SessionState {
  readonly vaultId: VaultId
  readonly deviceId: ClientHello['deviceId']
  readonly yClientId: YClientId
}

interface WebSocketAttachment {
  readonly authToken?: string
  readonly session?: SessionState
}

interface RuntimeDocClockRecord {
  readonly latestSeq: number
  readonly updatedAt: number
}

interface RuntimeSnapshotPointerRecord {
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string
}

interface RuntimeCheckpointRunRecord {
  readonly runId: string
  readonly docId: DocId
  readonly status: CheckpointRunStatus
  readonly upperSeq: number
  readonly snapshotKey: string | undefined
}

interface RuntimeCheckpointDocRecoveryRecord {
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | undefined
}

interface RuntimeCheckpointSnapshotEvidence {
  readonly exists: boolean
  readonly verified: boolean
  readonly stateVector: Uint8Array | undefined
}

/** Result of attempting to checkpoint one active document. */
export type RuntimeCheckpointResult =
  | {
      readonly action: 'checkpointed'
      readonly snapshotKey: string
      readonly upperSeq: number
      readonly compactedSeq: number | undefined
    }
  | {
      readonly action: 'skipped'
      readonly reason:
        | 'runtime-unavailable'
        | 'doc-unavailable'
        | 'invalid-clock'
        | 'no-new-ops'
        | 'hydrate-failed'
    }

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

  constructor(
    private readonly state: DurableObjectStateBinding,
    private readonly env: WorkerEnv,
  ) {}

  /**
   * Handles a WebSocket upgrade for one vault room.
   *
   * @param request Incoming Durable Object request.
   * @returns A 101 response with the client WebSocket, or an error response for unsupported requests.
   */
  fetch(request: Request): Response | Promise<Response> {
    this.rememberVaultId(request)
    if (new URL(request.url).pathname === E2E_SETUP_TOKEN_PATH) {
      return this.handleE2eSetupTokenSeed(request)
    }
    if (new URL(request.url).pathname === E2E_SNAPSHOT_PATH) {
      return this.handleE2eSnapshotSeed(request)
    }
    if (new URL(request.url).pathname === '/setup/exchange') {
      return this.handleSetupExchange(request)
    }
    if (new URL(request.url).pathname === '/auth/refresh') {
      return this.handleAuthRefresh(request)
    }
    if (/^\/devices\/[^/]+\/revoke$/.test(new URL(request.url).pathname)) {
      return this.handleRevokeDevice(request)
    }
    if (/^\/admin\/quarantine(?:\/[^/]+)?$/.test(new URL(request.url).pathname)) {
      return this.handleQuarantineInspect(request)
    }
    if (new URL(request.url).pathname === '/blobs/head') {
      return this.handleBlobHead(request)
    }
    if (new URL(request.url).pathname === '/blobs/upload-url') {
      return this.handleBlobUploadUrl(request)
    }
    if (/^\/blobs\/[^/]+$/.test(new URL(request.url).pathname)) {
      return this.handleBlobObject(request)
    }
    if (/^\/blob-manifests\/[^/]+\.json$/.test(new URL(request.url).pathname)) {
      return this.handleBlobManifestObject(request)
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }
    if (typeof WebSocketPair === 'undefined') {
      return new Response('WebSocketPair is not available', { status: 500 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.state.acceptWebSocket(server)
    this.sessions.add(server)
    this.rememberSocketToken(server, extractWebSocketBearerToken(request))

    const init: WebSocketUpgradeResponseInit = { status: 101, webSocket: client }
    return new Response(null, init)
  }

  private handleSetupExchange(request: Request): Promise<Response> {
    return this.handleSetupExchangeAsync(request)
  }

  private async handleSetupExchangeAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const sql = this.state.storage.sql
    const secret = this.env.DEVICE_TOKEN_SECRET
    if (sql === undefined || secret === undefined) {
      return new Response('Setup exchange unavailable', { status: 503 })
    }
    this.ensureSchema()

    const body = await parseJsonBody(request)
    if (!v.is(SetupExchangeRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-setup-exchange-request' }, 400)
    }
    if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = body.vaultId

    const now = Date.now()
    const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
    const tokenDecision = decideSetupTokenConsume({
      token: this.readSetupToken(setupTokenHash),
      requestedVaultId: body.vaultId,
      now,
    })
    if (tokenDecision.action === 'reject') {
      return jsonResponse({ error: `setup-token:${tokenDecision.reason}` }, 403)
    }

    const existingDevice =
      body.existingDeviceId === undefined
        ? undefined
        : this.readDeviceRegistryEntry(body.existingDeviceId)
    const setupDecision = decideSetupExchange({
      requestedDeviceId: body.existingDeviceId,
      registry: {
        existingDevice,
        usedYClientIds: this.readUsedYClientIds(),
      },
      yClientIdRange: Y_CLIENT_ID_RANGE,
    })
    if (setupDecision.action === 'reject') {
      return jsonResponse({ error: `setup-exchange:${setupDecision.reason}` }, 403)
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
      return jsonResponse({ error: `setup-credentials:${credentialPlan.reason}` }, 500)
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
      endpoint: new URL(request.url).origin,
      vaultId: body.vaultId,
      accessToken,
      refreshToken,
      accessTokenIssuedAt: claims.iat,
      accessTokenExpiresAt: claims.exp,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      bootstrapMode: this.hasAnyPersistedDocs() ? 'join-existing' : 'new-vault',
    })
    if (responsePlan.action === 'reject') {
      return jsonResponse({ error: `setup-response:${responsePlan.reason}` }, 500)
    }

    try {
      this.withSqlTransaction(() => {
        this.consumeSetupToken(setupTokenHash, tokenDecision.consumedAt)
        this.persistSetupDevice(credentialPlan.deviceId, credentialPlan.yClientId, now)
        this.persistRefreshToken(
          credentialPlan.insertRefreshToken.tokenHash,
          credentialPlan.insertRefreshToken.deviceId,
          credentialPlan.insertRefreshToken.issuedAt,
          credentialPlan.insertRefreshToken.expiresAt,
        )
      })
    } catch (error) {
      console.error('[kuroflare] setup exchange persist failed', error)
      return jsonResponse({ error: 'setup-persist:transaction-failed' }, 500)
    }

    return jsonResponse(responsePlan.response, 200)
  }

  private handleE2eSetupTokenSeed(request: Request): Promise<Response> {
    return this.handleE2eSetupTokenSeedAsync(request)
  }

  private async handleE2eSetupTokenSeedAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return new Response('E2E setup token seed unavailable', { status: 503 })
    }
    this.ensureSchema()

    const body = await parseJsonBody(request)
    if (!v.is(E2eSetupTokenSeedRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-e2e-setup-token-seed-request' }, 400)
    }
    if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = body.vaultId

    const now = Date.now()
    const expiresAt = now + (body.expiresInMs ?? 10 * 60 * 1_000)
    const setupTokenHash = makeSha256Hex(await sha256Text(body.setupToken))
    sql.exec(
      `insert into setup_tokens
        (token_hash, vault_id, issued_at, expires_at, consumed_at)
       values (?, ?, ?, ?, null)
       on conflict(token_hash) do update set
         vault_id = excluded.vault_id,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at,
         consumed_at = null`,
      setupTokenHash,
      body.vaultId,
      now,
      expiresAt,
    )

    return jsonResponse(
      {
        ok: true,
        vaultId: body.vaultId,
        expiresAt,
        tokenReadable: this.readSetupToken(setupTokenHash) !== undefined,
      },
      200,
    )
  }

  private handleE2eSnapshotSeed(request: Request): Promise<Response> {
    return this.handleE2eSnapshotSeedAsync(request)
  }

  private async handleE2eSnapshotSeedAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const sql = this.state.storage.sql
    const bucket = this.env.SNAPSHOT_BUCKET
    if (sql === undefined || bucket === undefined) {
      return new Response('E2E snapshot seed unavailable', { status: 503 })
    }
    this.ensureSchema()

    const body = await parseJsonBody(request)
    if (!v.is(E2eSnapshotSeedRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-e2e-snapshot-seed-request' }, 400)
    }
    if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = body.vaultId

    const update = decodeBase64(body.update)
    if (update === null || !canApplyYjsUpdate(update)) {
      return jsonResponse({ error: 'invalid-e2e-snapshot-update' }, 400)
    }
    const doc = new Y.Doc()
    Y.applyUpdate(doc, update)
    const stateVector = Y.encodeStateVector(doc)
    doc.destroy()

    const now = Date.now()
    const latestSeq = body.latestSeq ?? 1
    const snapshotKey = makeSnapshotObjectKey(body.vaultId, body.docId, latestSeq)
    await bucket.put(snapshotKey, update)
    sql.exec(
      `insert into docs
        (doc_id, kind, latest_seq, latest_snapshot_seq, latest_snapshot_key, latest_state_vector, min_retained_seq, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(doc_id) do update set
         latest_seq = excluded.latest_seq,
         latest_snapshot_seq = excluded.latest_snapshot_seq,
         latest_snapshot_key = excluded.latest_snapshot_key,
         latest_state_vector = excluded.latest_state_vector,
         min_retained_seq = excluded.min_retained_seq,
         updated_at = excluded.updated_at`,
      docKey(body.docId),
      body.docId.kind,
      latestSeq,
      latestSeq,
      snapshotKey,
      stateVector,
      0,
      now,
    )

    return jsonResponse({ ok: true, vaultId: body.vaultId, docId: body.docId, snapshotKey }, 200)
  }

  private handleRevokeDevice(request: Request): Promise<Response> {
    return this.handleRevokeDeviceAsync(request)
  }

  private async handleRevokeDeviceAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const sql = this.state.storage.sql
    const secret = this.env.DEVICE_TOKEN_SECRET
    if (sql === undefined || secret === undefined) {
      return new Response('Device revoke unavailable', { status: 503 })
    }
    this.ensureSchema()

    const targetDeviceId = parseRevokeDevicePath(request)
    if (targetDeviceId === undefined) {
      return jsonResponse({ error: 'invalid-device-id' }, 400)
    }
    const body = await parseJsonBody(request)
    if (!v.is(RevokeDeviceRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-revoke-device-request' }, 400)
    }
    const claims = await this.verifyRequestClaims(request)
    if (claims === undefined) {
      return jsonResponse({ error: 'auth-reject:invalid-token' }, 401)
    }
    if (this.vaultId !== undefined && claims.aud !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = claims.aud

    const actorDevice = this.readDeviceRegistryEntry(claims.sub)
    const admission = decideAuthAdmission({
      claims,
      expectedVaultId: claims.aud,
      device: actorDevice,
      requiredScopes: ['sync:write'],
      now: Date.now(),
    })
    if (admission.action === 'reject') {
      return jsonResponse({ error: `auth-reject:${admission.reason}` }, 403)
    }

    const targetDevice = this.readDeviceRegistryEntry(targetDeviceId)
    const revokeDecision = decideRevokeDevice({
      device: targetDevice,
      revokedAt: Date.now(),
    })
    if (revokeDecision.action === 'reject') {
      return jsonResponse({ error: `revoke-device:${revokeDecision.reason}` }, 404)
    }
    const responsePlan = planRevokeDeviceHttpResponse({
      revokeDecision,
      deviceId: targetDeviceId,
    })
    if (responsePlan.action === 'reject') {
      return jsonResponse({ error: `revoke-device-response:${responsePlan.reason}` }, 500)
    }

    if (revokeDecision.action === 'revoke-device') {
      this.persistDeviceRevocation(
        targetDeviceId,
        revokeDecision.tokenVersion,
        revokeDecision.revokedAt,
      )
    }

    return jsonResponse(responsePlan.response, 200)
  }

  private handleAuthRefresh(request: Request): Promise<Response> {
    return this.handleAuthRefreshAsync(request)
  }

  private async handleAuthRefreshAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const sql = this.state.storage.sql
    const secret = this.env.DEVICE_TOKEN_SECRET
    if (sql === undefined || secret === undefined) {
      return new Response('Auth refresh unavailable', { status: 503 })
    }
    this.ensureSchema()

    const body = await parseJsonBody(request)
    if (!v.is(DeviceTokenRefreshRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-auth-refresh-request' }, 400)
    }
    if (this.vaultId !== undefined && body.vaultId !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = body.vaultId

    const now = Date.now()
    const currentTokenHash = makeSha256Hex(await sha256Text(body.refreshToken))
    const device = this.readDeviceRegistryEntry(body.deviceId)
    const refreshDecision = decideDeviceTokenRefresh({
      device,
      refreshToken: this.readRefreshToken(currentTokenHash),
      previousTokenVersion: body.previousTokenVersion,
      now,
    })
    if (refreshDecision.action === 'reject') {
      return jsonResponse({ error: `auth-refresh:${refreshDecision.reason}` }, 403)
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
      return jsonResponse({ error: `auth-refresh-rotation:${rotationPlan.reason}` }, 500)
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
      return jsonResponse({ error: `auth-refresh-response:${responsePlan.reason}` }, 500)
    }

    try {
      this.withSqlTransaction(() => {
        this.revokeRefreshToken(rotationPlan.revoke.tokenHash, rotationPlan.revoke.revokedAt)
        this.persistRefreshToken(
          rotationPlan.insert.tokenHash,
          rotationPlan.insert.deviceId,
          rotationPlan.insert.issuedAt,
          rotationPlan.insert.expiresAt,
        )
      })
    } catch {
      return jsonResponse({ error: 'auth-refresh-persist:transaction-failed' }, 500)
    }

    return jsonResponse(responsePlan.response, 200)
  }

  private handleQuarantineInspect(request: Request): Promise<Response> {
    return this.handleQuarantineInspectAsync(request)
  }

  private async handleQuarantineInspectAsync(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const sql = this.state.storage.sql
    const secret = this.env.DEVICE_TOKEN_SECRET
    if (sql === undefined || secret === undefined) {
      return new Response('Quarantine inspect unavailable', { status: 503 })
    }
    this.ensureSchema()

    const claims = await this.verifyRequestClaims(request)
    if (claims === undefined) {
      return jsonResponse({ error: 'auth-reject:invalid-token' }, 401)
    }
    if (this.vaultId !== undefined && claims.aud !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = claims.aud

    const actorDevice = this.readDeviceRegistryEntry(claims.sub)
    const admission = decideAuthAdmission({
      claims,
      expectedVaultId: claims.aud,
      device: actorDevice,
      requiredScopes: ['sync:write'],
      now: Date.now(),
    })
    if (admission.action === 'reject') {
      return jsonResponse({ error: `auth-reject:${admission.reason}` }, 403)
    }

    const quarantineId = parseQuarantineInspectPath(request)
    if (quarantineId === undefined) {
      return jsonResponse(buildQuarantinedUpdateListResponse(this.readQuarantinedUpdates()), 200)
    }

    const record = this.readQuarantinedUpdate(quarantineId)
    if (record === undefined) {
      return jsonResponse({ error: 'unknown-quarantine' }, 404)
    }

    return jsonResponse(
      buildQuarantinedUpdateDetailResponse(
        record,
        encodeOptionalBase64(this.readQuarantinedUpdateBytes(quarantineId)),
      ),
      200,
    )
  }

  private handleBlobHead(request: Request): Promise<Response> {
    return this.handleBlobHeadAsync(request)
  }

  private async handleBlobHeadAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    if (this.env.SNAPSHOT_BUCKET === undefined) {
      return new Response('Blob storage unavailable', { status: 503 })
    }

    const admission = await this.authorizeHttpRequest(request, ['blob:read'])
    if (admission !== undefined) {
      return admission
    }
    const vaultId = this.vaultId
    if (vaultId === undefined) {
      return jsonResponse({ error: 'vault-unavailable' }, 500)
    }

    const body = await parseJsonBody(request)
    if (!v.is(BlobHeadRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-blob-head-request' }, 400)
    }

    const objects: BlobHeadObjectEvidence[] = []
    for (const hash of body.hashes) {
      objects.push(await this.readBlobHeadEvidence(vaultId, hash))
    }

    const plan = planBlobHeadHttpResponse({ request: body, objects })
    if (plan.action === 'reject') {
      return jsonResponse({ error: `blob-head:${plan.reason}` }, 400)
    }
    return jsonResponse(plan.response, 200)
  }

  private handleBlobUploadUrl(request: Request): Promise<Response> {
    return this.handleBlobUploadUrlAsync(request)
  }

  private async handleBlobUploadUrlAsync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    if (this.env.SNAPSHOT_BUCKET === undefined) {
      return new Response('Blob storage unavailable', { status: 503 })
    }

    const admission = await this.authorizeHttpRequest(request, ['blob:write'])
    if (admission !== undefined) {
      return admission
    }

    const body = await parseJsonBody(request)
    if (!v.is(BlobUploadUrlRequestSchema, body)) {
      return jsonResponse({ error: 'invalid-blob-upload-url-request' }, 400)
    }
    if (body.size > BLOB_SINGLE_PUT_MAX_BYTES || body.multipart === true) {
      return jsonResponse({ error: 'blob-upload-url:multipart-unimplemented' }, 413)
    }
    const vaultId = this.vaultId
    if (vaultId === undefined) {
      return jsonResponse({ error: 'vault-unavailable' }, 500)
    }

    const now = Date.now()
    const expiresAt = now + BLOB_UPLOAD_URL_TTL_MS
    const uploadUrl = new URL(request.url)
    uploadUrl.pathname = `/blobs/${body.sha256}`
    uploadUrl.search = `?size=${body.size}`
    const object = await this.readBlobUploadEvidence(vaultId, body.sha256)
    const plan = planBlobUploadUrlHttpResponse({
      request: body,
      object,
      now,
      policy: { multipartThresholdBytes: BLOB_MULTIPART_THRESHOLD_BYTES },
      singlePut: {
        kind: 'single-put',
        url: uploadUrl.toString(),
        headers: {},
        expiresAt,
      },
    })
    if (plan.action === 'reject') {
      const status = plan.reason === 'multipart-required' ? 413 : 400
      return jsonResponse({ error: `blob-upload-url:${plan.reason}` }, status)
    }
    return jsonResponse(plan.response, 200)
  }

  private handleBlobObject(request: Request): Promise<Response> {
    return this.handleBlobObjectAsync(request)
  }

  private async handleBlobObjectAsync(request: Request): Promise<Response> {
    const hash = parseBlobObjectPath(request)
    if (hash === undefined) {
      return jsonResponse({ error: 'invalid-blob-hash' }, 400)
    }

    if (request.method === 'GET') {
      const admission = await this.authorizeHttpRequest(request, ['blob:read'])
      if (admission !== undefined) {
        return admission
      }
      const vaultId = this.vaultId
      if (vaultId === undefined) {
        return jsonResponse({ error: 'vault-unavailable' }, 500)
      }
      const object = await this.env.SNAPSHOT_BUCKET?.get(blobObjectKey(vaultId, hash))
      if (object === undefined) {
        return new Response('Blob storage unavailable', { status: 503 })
      }
      if (object === null) {
        return jsonResponse({ error: 'blob-not-found' }, 404)
      }
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (makeSha256Hex(await sha256Hex(bytes)) !== hash) {
        return jsonResponse({ error: 'blob/hash-mismatch' }, 500)
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'x-content-sha256': hash,
        },
      })
    }

    if (request.method !== 'PUT') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const bucket = this.env.SNAPSHOT_BUCKET
    if (bucket === undefined) {
      return new Response('Blob storage unavailable', { status: 503 })
    }
    const admission = await this.authorizeHttpRequest(request, ['blob:write'])
    if (admission !== undefined) {
      return admission
    }
    const vaultId = this.vaultId
    if (vaultId === undefined) {
      return jsonResponse({ error: 'vault-unavailable' }, 500)
    }

    const expectedSize = parseBlobSize(request)
    if (expectedSize === undefined) {
      return jsonResponse({ error: 'invalid-blob-size' }, 400)
    }
    if (expectedSize > BLOB_SINGLE_PUT_MAX_BYTES) {
      return jsonResponse({ error: 'blob-upload-url:multipart-unimplemented' }, 413)
    }
    const contentLength = parseContentLength(request)
    if (contentLength === undefined || contentLength > BLOB_SINGLE_PUT_MAX_BYTES) {
      return jsonResponse({ error: 'invalid-blob-size' }, 413)
    }
    const bytes = await readRequestBytesWithLimit(request, BLOB_SINGLE_PUT_MAX_BYTES)
    if (bytes === undefined) {
      return jsonResponse({ error: 'invalid-blob-size' }, 413)
    }
    if (bytes.byteLength !== expectedSize) {
      return jsonResponse({ error: 'blob/size-mismatch' }, 400)
    }
    if (makeSha256Hex(await sha256Hex(bytes)) !== hash) {
      return jsonResponse({ error: 'blob/hash-mismatch' }, 400)
    }

    await bucket.put(blobObjectKey(vaultId, hash), bytes)
    return jsonResponse({ status: 'stored', sha256: hash, size: bytes.byteLength }, 200)
  }

  private handleBlobManifestObject(request: Request): Promise<Response> {
    return this.handleBlobManifestObjectAsync(request)
  }

  private async handleBlobManifestObjectAsync(request: Request): Promise<Response> {
    const hash = parseBlobManifestObjectPath(request)
    if (hash === undefined) {
      return jsonResponse({ error: 'invalid-blob-manifest-hash' }, 400)
    }

    if (request.method === 'GET') {
      const admission = await this.authorizeHttpRequest(request, ['blob:read'])
      if (admission !== undefined) {
        return admission
      }
      const vaultId = this.vaultId
      if (vaultId === undefined) {
        return jsonResponse({ error: 'vault-unavailable' }, 500)
      }
      const object = await this.env.SNAPSHOT_BUCKET?.get(blobManifestObjectKey(vaultId, hash))
      if (object === undefined) {
        return new Response('Blob storage unavailable', { status: 503 })
      }
      if (object === null) {
        return jsonResponse({ error: 'blob-manifest-not-found' }, 404)
      }
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (makeSha256Hex(await sha256Hex(bytes)) !== hash) {
        return jsonResponse({ error: 'blob-manifest/hash-mismatch' }, 500)
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(bytes.byteLength),
          'x-content-sha256': hash,
        },
      })
    }

    if (request.method !== 'PUT') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const bucket = this.env.SNAPSHOT_BUCKET
    if (bucket === undefined) {
      return new Response('Blob storage unavailable', { status: 503 })
    }
    const admission = await this.authorizeHttpRequest(request, ['blob:write'])
    if (admission !== undefined) {
      return admission
    }
    const vaultId = this.vaultId
    if (vaultId === undefined) {
      return jsonResponse({ error: 'vault-unavailable' }, 500)
    }
    const contentLength = parseContentLength(request)
    if (contentLength === undefined || contentLength > BLOB_MANIFEST_MAX_BYTES) {
      return jsonResponse({ error: 'invalid-blob-manifest-size' }, 413)
    }
    const requestBytes = await readRequestBytesWithLimit(request, BLOB_MANIFEST_MAX_BYTES)
    if (requestBytes === undefined) {
      return jsonResponse({ error: 'invalid-blob-manifest-size' }, 413)
    }
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder().decode(requestBytes))
    } catch {
      return jsonResponse({ error: 'invalid-blob-manifest-json' }, 400)
    }
    if (!v.is(BlobManifestSchema, body)) {
      return jsonResponse({ error: 'invalid-blob-manifest-json' }, 400)
    }
    const canonicalBytes = encodeBlobManifestJson(body)
    if (makeSha256Hex(await sha256Hex(canonicalBytes)) !== hash) {
      return jsonResponse({ error: 'blob-manifest/hash-mismatch' }, 400)
    }

    await bucket.put(blobManifestObjectKey(vaultId, hash), canonicalBytes)
    return jsonResponse({ status: 'stored', sha256: hash, size: canonicalBytes.byteLength }, 200)
  }

  /**
   * Broadcasts an inbound update frame to every other connected socket.
   *
   * @param webSocket Sender socket supplied by the Durable Object runtime.
   * @param message Text or binary WebSocket message.
   */
  async webSocketMessage(
    webSocket: RuntimeWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    this.ensureSchema()
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

  /**
   * Removes closed sockets from the live-session index.
   *
   * @param webSocket Socket supplied by the Durable Object runtime.
   */
  webSocketClose(webSocket: RuntimeWebSocket): void {
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  /**
   * Removes errored sockets from the live-session index.
   *
   * @param webSocket Socket supplied by the Durable Object runtime.
   */
  webSocketError(webSocket: RuntimeWebSocket): void {
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  /**
   * Runs scheduled checkpoints for documents with uncheckpointed durable ops.
   *
   * @returns A promise that resolves after the current checkpoint batch finishes.
   */
  async alarm(): Promise<void> {
    this.ensureSchema()
    await this.recoverOrphanedCheckpointRuns(CHECKPOINT_ALARM_DOC_LIMIT)
    for (const docId of this.readCheckpointableDocIds(CHECKPOINT_ALARM_DOC_LIMIT)) {
      await this.checkpointDoc(docId)
    }
  }

  /**
   * Writes an active document snapshot to R2 and advances the SQLite snapshot pointer.
   *
   * @param docId Document to checkpoint.
   * @param now Timestamp to store on checkpoint rows.
   * @returns The checkpoint result or a skip reason.
   */
  async checkpointDoc(docId: DocId, now = Date.now()): Promise<RuntimeCheckpointResult> {
    this.ensureSchema()
    const sql = this.state.storage.sql
    const bucket = this.env.SNAPSHOT_BUCKET
    const vaultId = await this.resolveVaultId()
    if (sql === undefined || bucket === undefined || vaultId === undefined) {
      return { action: 'skipped', reason: 'runtime-unavailable' }
    }

    try {
      await this.ensureDocHydrated(docId)
    } catch {
      return { action: 'skipped', reason: 'hydrate-failed' }
    }

    const doc = this.docs.get(docKey(docId))
    const clock = await this.readDocClock(docId)
    const snapshotSeq = this.readSnapshotSeq(docId)
    if (doc === undefined) {
      return { action: 'skipped', reason: 'doc-unavailable' }
    }
    if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), clock?.latestSeq)) {
      return { action: 'skipped', reason: 'invalid-clock' }
    }

    const snapshotKey = makeSnapshotObjectKey(vaultId, docId, clock.latestSeq)
    const decision = decideCheckpointWrite({
      latestSeq: clock?.latestSeq,
      latestSnapshotSeq: snapshotSeq,
      snapshotKey,
      now,
    })
    if (decision.action === 'skip') {
      return { action: 'skipped', reason: decision.reason }
    }

    const snapshotBytes = Y.encodeStateAsUpdate(doc)
    const stateVector = Y.encodeStateVector(doc)
    sql.exec(
      `insert into checkpoint_runs
        (run_id, doc_id, upper_seq, snapshot_key, state_vector, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      decision.runId,
      docKey(docId),
      decision.upperSeq,
      decision.snapshotKey,
      stateVector,
      'writing',
      decision.createdAt,
    )
    await bucket.put(decision.snapshotKey, snapshotBytes)
    sql.exec(
      `update checkpoint_runs
       set status = ?, r2_written_at = ?
       where run_id = ?`,
      'r2-written',
      now,
      decision.runId,
    )
    sql.exec(
      `update docs
       set latest_snapshot_seq = ?,
           latest_snapshot_key = ?,
           latest_state_vector = ?,
           updated_at = ?
       where doc_id = ? and latest_snapshot_seq <= ?`,
      decision.upperSeq,
      decision.snapshotKey,
      stateVector,
      now,
      docKey(docId),
      decision.upperSeq,
    )
    sql.exec(
      `update checkpoint_runs
       set status = ?, pointer_updated_at = ?
       where run_id = ?`,
      'pointer-updated',
      now,
      decision.runId,
    )
    const compact = decideCheckpointCompact({
      status: 'pointer-updated',
      upperSeq: decision.upperSeq,
      latestSnapshotSeq: decision.upperSeq,
      now,
    })
    if (compact.action === 'compact') {
      sql.exec(
        'delete from op_log where doc_id = ? and seq <= ?',
        docKey(docId),
        compact.compactedSeq,
      )
      sql.exec(
        `update docs
         set min_retained_seq = ?,
             horizon_state_vector = ?,
             updated_at = ?
         where doc_id = ? and min_retained_seq <= ?`,
        compact.compactedSeq,
        stateVector,
        compact.compactedAt,
        docKey(docId),
        compact.compactedSeq,
      )
      sql.exec(
        `update checkpoint_runs
         set status = ?, compacted_at = ?
         where run_id = ?`,
        'compacted',
        compact.compactedAt,
        decision.runId,
      )
    }

    return {
      action: 'checkpointed',
      snapshotKey: decision.snapshotKey,
      upperSeq: decision.upperSeq,
      compactedSeq: compact.action === 'compact' ? compact.compactedSeq : undefined,
    }
  }

  private async recoverOrphanedCheckpointRuns(limit: number, now = Date.now()): Promise<void> {
    const sql = this.state.storage.sql
    const bucket = this.env.SNAPSHOT_BUCKET
    if (sql === undefined || bucket === undefined || limit <= 0) {
      return
    }

    for (const run of this.readRecoverableCheckpointRuns(limit)) {
      await this.recoverOrphanedCheckpointRun(run, now)
    }
  }

  private async recoverOrphanedCheckpointRun(
    run: RuntimeCheckpointRunRecord,
    now: number,
  ): Promise<void> {
    const doc = this.readCheckpointDocRecoveryState(run.docId)
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
        this.markCheckpointRunFailed(run.runId)
        return
      case 'mark-r2-written':
        this.markCheckpointRunR2Written(run.runId, now)
        return
      case 'advance-pointer':
        if (run.snapshotKey === undefined || snapshot === undefined || !snapshot.verified) {
          this.markCheckpointRunFailed(run.runId)
          return
        }
        this.advanceRecoveredCheckpointPointer(run, snapshot.stateVector, now)
        return
      case 'compact-op-log':
        if (snapshot === undefined || !snapshot.verified || snapshot.stateVector === undefined) {
          return
        }
        this.compactRecoveredCheckpointRun(run, snapshot.stateVector, now)
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

    const device = this.readDeviceRegistryEntry(hello.deviceId)
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

  private async verifyRequestClaims(request: Request): Promise<DeviceTokenClaims | undefined> {
    const secret = this.env.DEVICE_TOKEN_SECRET
    const token = extractBearerToken(request.headers.get('Authorization'))
    if (secret === undefined || token === undefined) {
      return undefined
    }
    return verifyHs256DeviceToken({ token, secret })
  }

  private async authorizeHttpRequest(
    request: Request,
    requiredScopes: readonly DeviceTokenScope[],
  ): Promise<Response | undefined> {
    const claims = await this.verifyRequestClaims(request)
    if (claims === undefined) {
      return jsonResponse({ error: 'auth-reject:invalid-token' }, 401)
    }
    if (this.vaultId !== undefined && claims.aud !== this.vaultId) {
      return jsonResponse({ error: 'vault-mismatch' }, 400)
    }
    this.vaultId = claims.aud

    const actorDevice = this.readDeviceRegistryEntry(claims.sub)
    const admission = decideAuthAdmission({
      claims,
      expectedVaultId: claims.aud,
      device: actorDevice,
      requiredScopes,
      now: Date.now(),
    })
    if (admission.action === 'reject') {
      return jsonResponse({ error: `auth-reject:${admission.reason}` }, 403)
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
    const sql = this.state.storage.sql
    if (sql === undefined) {
      throw new Error('sql-unavailable')
    }

    sql.exec(
      `insert into quarantined_updates
        (id, doc_id, message_id, device_id, reason, update_sha256, update_bytes, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do nothing`,
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
    const sql = this.state.storage.sql
    if (sql === undefined) {
      throw new Error('sql-unavailable')
    }

    const docId = docKey(update.docId)
    sql.exec(
      `insert into op_log
        (doc_id, seq, message_id, device_id, y_client_id, update_bytes, update_sha256, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      docId,
      seq,
      update.messageId,
      update.deviceId,
      yClientId,
      updateBytes,
      updateSha256,
      now,
    )
    sql.exec(
      `insert into docs (doc_id, kind, latest_seq, updated_at)
       values (?, ?, ?, ?)
       on conflict(doc_id) do update set
         latest_seq = excluded.latest_seq,
         updated_at = excluded.updated_at`,
      docId,
      update.docId.kind,
      docPatch.latestSeq,
      docPatch.updatedAt,
    )
    sql.exec(
      `insert into message_dedup (doc_id, message_id, durable_seq, seen_at)
       values (?, ?, ?, ?)
       on conflict(doc_id, message_id) do update set seen_at = excluded.seen_at`,
      docId,
      update.messageId,
      seq,
      now,
    )
  }

  private async persistDocClock(docId: DocId, docPatch: RuntimeDocClockRecord): Promise<void> {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      throw new Error('sql-unavailable')
    }

    sql.exec(
      `insert into docs (doc_id, kind, latest_seq, updated_at)
       values (?, ?, ?, ?)
       on conflict(doc_id) do update set
         latest_seq = excluded.latest_seq,
         updated_at = excluded.updated_at`,
      docKey(docId),
      docId.kind,
      docPatch.latestSeq,
      docPatch.updatedAt,
    )
  }

  private async persistDuplicate(
    docId: DocId,
    messageId: MessageId,
    durableSeq: number,
    now: number,
  ): Promise<void> {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      throw new Error('sql-unavailable')
    }

    sql.exec(
      `insert into message_dedup (doc_id, message_id, durable_seq, seen_at)
       values (?, ?, ?, ?)
       on conflict(doc_id, message_id) do update set seen_at = excluded.seen_at`,
      docKey(docId),
      messageId,
      durableSeq,
      now,
    )
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

    const sql = this.state.storage.sql
    if (sql === undefined) {
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
    for (const row of sql.exec(
      'select update_bytes as updateBytes from op_log where doc_id = ? and seq > ? order by seq asc',
      key,
      minSeq,
    )) {
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
    const pointer = this.readSnapshotPointer(docId)
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

  private readSnapshotPointer(docId: DocId): RuntimeSnapshotPointerRecord | undefined {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec(
        `select
           latest_snapshot_seq as latestSnapshotSeq,
           latest_snapshot_key as latestSnapshotKey
         from docs
         where doc_id = ?`,
        docKey(docId),
      ),
    )
    const latestSnapshotSeq = row?.latestSnapshotSeq
    const latestSnapshotKey = row?.latestSnapshotKey
    if (
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), latestSnapshotSeq) ||
      typeof latestSnapshotKey !== 'string' ||
      latestSnapshotKey.length === 0
    ) {
      return undefined
    }

    return { latestSnapshotSeq, latestSnapshotKey }
  }

  private readSnapshotSeq(docId: DocId): number {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return 0
    }

    const row = firstSqlRow(
      sql.exec(
        'select latest_snapshot_seq as latestSnapshotSeq from docs where doc_id = ?',
        docKey(docId),
      ),
    )
    const latestSnapshotSeq = row?.latestSnapshotSeq
    return v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), latestSnapshotSeq)
      ? latestSnapshotSeq
      : 0
  }

  private readCheckpointableDocIds(limit: number): readonly DocId[] {
    const sql = this.state.storage.sql
    if (sql === undefined || limit <= 0) {
      return []
    }

    const docIds: DocId[] = []
    for (const row of sql.exec(
      `select doc_id as docId
       from docs
       where latest_seq > latest_snapshot_seq
       order by updated_at asc
       limit ?`,
      limit,
    )) {
      const docId = docIdFromKey(row.docId)
      if (docId !== undefined) {
        docIds.push(docId)
      }
    }
    return docIds
  }

  private readRecoverableCheckpointRuns(limit: number): readonly RuntimeCheckpointRunRecord[] {
    const sql = this.state.storage.sql
    if (sql === undefined || limit <= 0) {
      return []
    }

    const runs: RuntimeCheckpointRunRecord[] = []
    for (const row of sql.exec(
      `select
         run_id as runId,
         doc_id as docId,
         status,
         upper_seq as upperSeq,
         snapshot_key as snapshotKey
       from checkpoint_runs
       where status in ('writing', 'r2-written', 'pointer-updated')
       order by created_at asc
       limit ?`,
      limit,
    )) {
      const docId = docIdFromKey(row.docId)
      if (
        docId !== undefined &&
        typeof row.runId === 'string' &&
        isCheckpointRunStatus(row.status) &&
        v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), row.upperSeq) &&
        (typeof row.snapshotKey === 'string' || row.snapshotKey === undefined)
      ) {
        runs.push({
          runId: row.runId,
          docId,
          status: row.status,
          upperSeq: row.upperSeq,
          snapshotKey: row.snapshotKey,
        })
      }
    }
    return runs
  }

  private readCheckpointDocRecoveryState(docId: DocId): RuntimeCheckpointDocRecoveryRecord {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return { latestSnapshotSeq: 0, latestSnapshotKey: undefined }
    }

    const row = firstSqlRow(
      sql.exec(
        `select
           latest_snapshot_seq as latestSnapshotSeq,
           latest_snapshot_key as latestSnapshotKey
         from docs
         where doc_id = ?`,
        docKey(docId),
      ),
    )
    const latestSnapshotSeq = row?.latestSnapshotSeq
    const latestSnapshotKey = row?.latestSnapshotKey
    return {
      latestSnapshotSeq: v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), latestSnapshotSeq)
        ? latestSnapshotSeq
        : 0,
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

  private markCheckpointRunFailed(runId: string): void {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return
    }
    sql.exec('update checkpoint_runs set status = ? where run_id = ?', 'failed', runId)
  }

  private markCheckpointRunR2Written(runId: string, now: number): void {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return
    }
    sql.exec(
      `update checkpoint_runs
       set status = ?, r2_written_at = ?
       where run_id = ?`,
      'r2-written',
      now,
      runId,
    )
  }

  private advanceRecoveredCheckpointPointer(
    run: RuntimeCheckpointRunRecord,
    stateVector: Uint8Array | undefined,
    now: number,
  ): void {
    const sql = this.state.storage.sql
    if (sql === undefined || run.snapshotKey === undefined || stateVector === undefined) {
      return
    }

    sql.exec(
      `update docs
       set latest_snapshot_seq = ?,
           latest_snapshot_key = ?,
           latest_state_vector = ?,
           updated_at = ?
       where doc_id = ? and latest_snapshot_seq <= ?`,
      run.upperSeq,
      run.snapshotKey,
      stateVector,
      now,
      docKey(run.docId),
      run.upperSeq,
    )
    sql.exec(
      `update checkpoint_runs
       set status = ?, pointer_updated_at = ?
       where run_id = ?`,
      'pointer-updated',
      now,
      run.runId,
    )
  }

  private compactRecoveredCheckpointRun(
    run: RuntimeCheckpointRunRecord,
    horizonStateVector: Uint8Array,
    now: number,
  ): void {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return
    }

    sql.exec('delete from op_log where doc_id = ? and seq <= ?', docKey(run.docId), run.upperSeq)
    sql.exec(
      `update docs
       set min_retained_seq = ?,
           horizon_state_vector = ?,
           updated_at = ?
       where doc_id = ? and min_retained_seq <= ?`,
      run.upperSeq,
      horizonStateVector,
      now,
      docKey(run.docId),
      run.upperSeq,
    )
    sql.exec(
      `update checkpoint_runs
       set status = ?, compacted_at = ?
       where run_id = ?`,
      'compacted',
      now,
      run.runId,
    )
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
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec('select latest_seq as latestSeq from docs where doc_id = ?', docKey(docId)),
    )
    const latestSeq = row?.latestSeq
    return v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), latestSeq)
      ? { latestSeq }
      : undefined
  }

  private async readDuplicate(
    docId: DocId,
    messageId: MessageId,
  ): Promise<SyncUpdateDuplicateEvidence | undefined> {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec(
        'select durable_seq as durableSeq from message_dedup where doc_id = ? and message_id = ?',
        docKey(docId),
        messageId,
      ),
    )
    const durableSeq = row?.durableSeq
    return v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), durableSeq)
      ? { durableSeq }
      : undefined
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
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec(
        `select
           latest_seq as latestSeq,
           min_retained_seq as minRetainedSeq,
           horizon_state_vector as horizonStateVector
         from docs
         where doc_id = ?`,
        docKey(docId),
      ),
    )
    const latestSeq = row?.latestSeq
    const minRetainedSeq = row?.minRetainedSeq
    const horizonStateVector = readSqlUpdateBytes(row?.horizonStateVector)
    if (
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), latestSeq) ||
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), minRetainedSeq)
    ) {
      return undefined
    }

    return { latestSeq, minRetainedSeq, horizonStateVector }
  }

  /**
   * Applies pending Durable Object schema migrations before any SQL-backed handler runs.
   *
   * The migration plan is decided by {@link decideSchemaMigration}; this method performs the
   * SQL execution it omits. Idempotent: it runs at most once per live instance and every
   * statement is `create ... if not exists`, so a crashed mid-migration instance re-applies safely.
   */
  private ensureSchema(): void {
    if (this.schemaReady) {
      return
    }
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return
    }

    sql.exec(
      `create table if not exists schema_migrations (
         version integer primary key,
         applied_at integer not null
       )`,
    )
    const appliedVersions = new Set<number>()
    for (const row of sql.exec<{ readonly version: unknown }>(
      'select version from schema_migrations',
    )) {
      if (v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), row.version)) {
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
        for (const statement of migration.statements) {
          sql.exec(statement)
        }
        sql.exec(
          'insert into schema_migrations (version, applied_at) values (?, ?)',
          migration.version,
          now,
        )
      }
    }

    this.schemaReady = true
  }

  private readDeviceRegistryEntry(
    deviceId: ClientHello['deviceId'],
  ): DeviceRegistryEntry | undefined {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec(
        `select
           y_client_id as yClientId,
           token_version as tokenVersion,
           revoked_at as revokedAt
         from devices
         where device_id = ?`,
        deviceId,
      ),
    )
    const yClientId = row?.yClientId
    const tokenVersion = row?.tokenVersion
    // SQLite returns NULL columns as `null`; the registry treats absent as `undefined`.
    const revokedAt = nullToUndefined(row?.revokedAt)
    if (
      !isValidYClientId(yClientId) ||
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), tokenVersion)
    ) {
      return undefined
    }
    if (
      revokedAt !== undefined &&
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), revokedAt)
    ) {
      return undefined
    }

    return {
      deviceId,
      yClientId,
      tokenVersion,
      revokedAt,
    }
  }

  private readSetupToken(tokenHash: string): SetupTokenEntry | undefined {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec(
        `select
           vault_id as vaultId,
           issued_at as issuedAt,
           expires_at as expiresAt,
           consumed_at as consumedAt
         from setup_tokens
         where token_hash = ?`,
        tokenHash,
      ),
    )
    if (
      !v.is(VaultIdSchema, row?.vaultId) ||
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), row.issuedAt) ||
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), row.expiresAt)
    ) {
      return undefined
    }
    const consumedAt = nullToUndefined(row.consumedAt)
    if (
      consumedAt !== undefined &&
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), consumedAt)
    ) {
      return undefined
    }

    return {
      vaultId: row.vaultId,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      consumedAt,
    }
  }

  private readUsedYClientIds(): ReadonlySet<YClientId> {
    const sql = this.state.storage.sql
    const used = new Set<YClientId>()
    if (sql === undefined) {
      return used
    }

    for (const row of sql.exec('select y_client_id as yClientId from devices')) {
      if (isValidYClientId(row.yClientId)) {
        used.add(row.yClientId)
      }
    }
    return used
  }

  private readRefreshToken(tokenHash: string): DeviceRefreshTokenEvidence | undefined {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec(
        `select
           issued_at as issuedAt,
           expires_at as expiresAt,
           revoked_at as revokedAt
         from device_refresh_tokens
         where token_hash = ?`,
        tokenHash,
      ),
    )
    if (
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), row?.issuedAt) ||
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), row.expiresAt)
    ) {
      return undefined
    }
    const revokedAt = row.revokedAt
    if (
      revokedAt !== undefined &&
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), revokedAt)
    ) {
      return undefined
    }

    return {
      tokenHashMatches: true,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      revokedAt,
    }
  }

  private readQuarantinedUpdates(): readonly QuarantinedUpdateRecord[] {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return []
    }

    return [
      ...sql.exec(
        `select
         id,
         doc_id as docId,
         message_id as messageId,
         device_id as deviceId,
         reason,
         update_sha256 as updateSha256,
         update_bytes as updateBytes,
         created_at as createdAt
       from quarantined_updates
       order by created_at asc
       limit 1024`,
      ),
    ]
      .map(quarantinedUpdateRecordFromSqlRow)
      .filter((record): record is QuarantinedUpdateRecord => record !== undefined)
  }

  private readQuarantinedUpdate(id: string): QuarantinedUpdateRecord | undefined {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    return quarantinedUpdateRecordFromSqlRow(
      firstSqlRow(
        sql.exec(
          `select
         id,
         doc_id as docId,
         message_id as messageId,
         device_id as deviceId,
         reason,
         update_sha256 as updateSha256,
         update_bytes as updateBytes,
         created_at as createdAt
       from quarantined_updates
       where id = ?`,
          id,
        ),
      ),
    )
  }

  private readQuarantinedUpdateBytes(id: string): Uint8Array | undefined {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return undefined
    }

    const row = firstSqlRow(
      sql.exec('select update_bytes as updateBytes from quarantined_updates where id = ?', id),
    )
    return readSqlUpdateBytes(row?.updateBytes)
  }

  private hasAnyPersistedDocs(): boolean {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      return false
    }

    return firstSqlRow(sql.exec('select doc_id as docId from docs limit 1')) !== undefined
  }

  private consumeSetupToken(tokenHash: string, consumedAt: number): void {
    this.state.storage.sql?.exec(
      'update setup_tokens set consumed_at = ? where token_hash = ?',
      consumedAt,
      tokenHash,
    )
  }

  private persistSetupDevice(deviceId: DeviceId, yClientId: YClientId, now: number): void {
    this.state.storage.sql?.exec(
      `insert into devices
        (device_id, y_client_id, token_version, created_at, last_seen_at)
       values (?, ?, ?, ?, ?)
       on conflict(device_id) do update set
         last_seen_at = excluded.last_seen_at`,
      deviceId,
      yClientId,
      1,
      now,
      now,
    )
  }

  private persistRefreshToken(
    tokenHash: string,
    deviceId: DeviceId,
    issuedAt: number,
    expiresAt: number,
  ): void {
    this.state.storage.sql?.exec(
      `insert into device_refresh_tokens
        (token_hash, device_id, issued_at, expires_at)
       values (?, ?, ?, ?)`,
      tokenHash,
      deviceId,
      issuedAt,
      expiresAt,
    )
  }

  private revokeRefreshToken(tokenHash: string, revokedAt: number): void {
    this.state.storage.sql?.exec(
      'update device_refresh_tokens set revoked_at = ? where token_hash = ?',
      revokedAt,
      tokenHash,
    )
  }

  private persistDeviceRevocation(
    deviceId: DeviceId,
    tokenVersion: number,
    revokedAt: number,
  ): void {
    this.state.storage.sql?.exec(
      `update devices
       set token_version = ?,
           revoked_at = ?,
           last_seen_at = ?
       where device_id = ?`,
      tokenVersion,
      revokedAt,
      revokedAt,
      deviceId,
    )
  }

  private withSqlTransaction(write: () => void): void {
    const sql = this.state.storage.sql
    if (sql === undefined) {
      throw new Error('sql-unavailable')
    }
    if (this.state.storage.transactionSync !== undefined) {
      this.state.storage.transactionSync(write)
      return
    }

    sql.exec('begin immediate')
    try {
      write()
      sql.exec('commit')
    } catch (error) {
      try {
        sql.exec('rollback')
      } catch {
        // Preserve the original write failure for the caller.
      }
      throw error
    }
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
    const snapshotSeq = this.readSnapshotSeq(docId)
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

/** Worker entrypoint that routes vault setup and WebSocket requests to `VaultRoom` Durable Objects. */
export const workerEntrypoint = {
  /**
   * Routes setup exchange and `/ws/:vaultId` upgrade requests to the vault Durable Object.
   *
   * @param request Incoming Worker request.
   * @param env Cloudflare Worker bindings.
   * @returns The Durable Object response or an HTTP error response.
   */
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    if (url.pathname === E2E_SETUP_TOKEN_PATH) {
      const secret = env.E2E_SETUP_TOKEN_SECRET
      if (secret === undefined) {
        return new Response('Not found', { status: 404 })
      }
      if (request.headers.get('x-kuroflare-e2e-secret') !== secret) {
        return jsonResponse({ error: 'e2e-seed-forbidden' }, 403)
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const body = await parseJsonBody(request.clone())
      if (!v.is(E2eSetupTokenSeedRequestSchema, body)) {
        return jsonResponse({ error: 'invalid-e2e-setup-token-seed-request' }, 400)
      }
      return routeVaultRoom(request, env, body.vaultId)
    }
    if (url.pathname === E2E_SNAPSHOT_PATH) {
      const secret = env.E2E_SETUP_TOKEN_SECRET
      if (secret === undefined) {
        return new Response('Not found', { status: 404 })
      }
      if (request.headers.get('x-kuroflare-e2e-secret') !== secret) {
        return jsonResponse({ error: 'e2e-seed-forbidden' }, 403)
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const body = await parseJsonBody(request.clone())
      if (!v.is(E2eSnapshotSeedRequestSchema, body)) {
        return jsonResponse({ error: 'invalid-e2e-snapshot-seed-request' }, 400)
      }
      return routeVaultRoom(request, env, body.vaultId)
    }
    if (url.pathname === '/setup/exchange') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const body = await parseJsonBody(request.clone())
      if (!v.is(SetupExchangeRequestSchema, body)) {
        return jsonResponse({ error: 'invalid-setup-exchange-request' }, 400)
      }
      return routeVaultRoom(request, env, body.vaultId)
    }
    if (url.pathname === '/auth/refresh') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const body = await parseJsonBody(request.clone())
      if (!v.is(DeviceTokenRefreshRequestSchema, body)) {
        return jsonResponse({ error: 'invalid-auth-refresh-request' }, 400)
      }
      return routeVaultRoom(request, env, body.vaultId)
    }
    if (/^\/devices\/[^/]+\/revoke$/.test(url.pathname)) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      if (parseRevokeDevicePath(request) === undefined) {
        return jsonResponse({ error: 'invalid-device-id' }, 400)
      }
      const body = await parseJsonBody(request.clone())
      if (!v.is(RevokeDeviceRequestSchema, body)) {
        return jsonResponse({ error: 'invalid-revoke-device-request' }, 400)
      }
      const secret = env.DEVICE_TOKEN_SECRET
      const token = extractBearerToken(request.headers.get('Authorization'))
      const claims =
        secret === undefined || token === undefined
          ? undefined
          : await verifyHs256DeviceToken({ token, secret })
      if (claims === undefined) {
        return jsonResponse({ error: 'auth-reject:invalid-token' }, 401)
      }
      return routeVaultRoom(request, env, claims.aud)
    }
    if (/^\/admin\/quarantine(?:\/[^/]+)?$/.test(url.pathname)) {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const secret = env.DEVICE_TOKEN_SECRET
      const token = extractBearerToken(request.headers.get('Authorization'))
      const claims =
        secret === undefined || token === undefined
          ? undefined
          : await verifyHs256DeviceToken({ token, secret })
      if (claims === undefined) {
        return jsonResponse({ error: 'auth-reject:invalid-token' }, 401)
      }
      return routeVaultRoom(request, env, claims.aud)
    }
    if (
      url.pathname === '/blobs/head' ||
      url.pathname === '/blobs/upload-url' ||
      /^\/blobs\/[^/]+$/.test(url.pathname) ||
      /^\/blob-manifests\/[^/]+\.json$/.test(url.pathname)
    ) {
      if (!['GET', 'POST', 'PUT'].includes(request.method)) {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const secret = env.DEVICE_TOKEN_SECRET
      const token = extractBearerToken(request.headers.get('Authorization'))
      const claims =
        secret === undefined || token === undefined
          ? undefined
          : await verifyHs256DeviceToken({ token, secret })
      if (claims === undefined) {
        return jsonResponse({ error: 'auth-reject:invalid-token' }, 401)
      }
      return routeVaultRoom(request, env, claims.aud)
    }

    const match = /^\/ws\/([^/]+)$/.exec(url.pathname)
    if (match === null) {
      return new Response('Not found', { status: 404 })
    }

    const vaultId = match[1]
    if (!v.is(VaultIdSchema, vaultId)) {
      return new Response('Invalid vaultId', { status: 400 })
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE) {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    return routeVaultRoom(request, env, vaultId)
  },
}

export default workerEntrypoint

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

function parseBlobObjectPath(request: Request): Sha256Hex | undefined {
  const match = /^\/blobs\/([^/]+)$/.exec(new URL(request.url).pathname)
  const hash = match?.[1]
  return v.is(Sha256HexSchema, hash) ? hash : undefined
}

function parseBlobManifestObjectPath(request: Request): Sha256Hex | undefined {
  const match = /^\/blob-manifests\/([^/]+)\.json$/.exec(new URL(request.url).pathname)
  const hash = match?.[1]
  return v.is(Sha256HexSchema, hash) ? hash : undefined
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
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), upperSeq)) {
    return undefined
  }

  return { key, upperSeq, healthy: true }
}

function firstSqlRow<T extends Record<string, unknown>>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row
  }
  return undefined
}

/** Normalizes a SQLite `NULL` (returned as `null`) to the `undefined` absent-sentinel the runtime uses. */
function nullToUndefined(value: unknown): unknown {
  return value === null ? undefined : value
}

function readSqlUpdateBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return undefined
}

function quarantinedUpdateRecordFromSqlRow(
  row: Record<string, unknown> | undefined,
): QuarantinedUpdateRecord | undefined {
  if (row === undefined || typeof row.id !== 'string' || row.id.length === 0) {
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
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), row.createdAt)
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

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown
  } catch {
    return undefined
  }
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-kuroflare-e2e-secret',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST, PUT',
    'Access-Control-Allow-Origin': '*',
  }
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

function parseRevokeDevicePath(request: Request): DeviceId | undefined {
  const match = /^\/devices\/([^/]+)\/revoke$/.exec(new URL(request.url).pathname)
  const deviceId = match?.[1]
  return v.is(DeviceIdSchema, deviceId) ? deviceId : undefined
}

function parseQuarantineInspectPath(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname
  if (pathname === '/admin/quarantine') {
    return undefined
  }

  const match = /^\/admin\/quarantine\/([^/]+)$/.exec(pathname)
  const quarantineId = match?.[1]
  return quarantineId === undefined || quarantineId.length === 0
    ? undefined
    : decodeURIComponent(quarantineId)
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
