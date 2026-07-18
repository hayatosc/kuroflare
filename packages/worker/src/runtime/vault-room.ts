import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  isMalformedAwarenessUpdate,
  parseControlMessage,
  type DocId,
  type VaultId,
} from '@kuroflare/core'
import { type Context, Hono } from 'hono'
import * as Y from 'yjs'

import {
  handleQuarantineList,
  handleQuarantineDetail,
  handleQuarantineAudit,
  handleQuarantineAction,
} from '../room/http/admin-quarantine'
import { handleRetentionInspect } from '../room/http/admin-retention'
import {
  handleAdminSetupTokenIssue,
  handleAuthRefresh,
  handleDeviceRevoke,
  handleSetupExchange,
} from '../room/http/auth'
import {
  handleSnapshotHealthQuarantine,
  handleSnapshotRollback,
} from '../room/http/snapshot-health-mutations'
import { handleSnapshotHealthList } from '../room/http/snapshot-health-query'
import { handleSnapshotHealthVerify } from '../room/http/snapshot-health-verify'
import {
  handleAdminSnapshotSeed,
  handleFileLatest,
  handleFileSnapshotImport,
  handleMetaLatest,
  handleMetaSnapshotImport,
} from '../room/http/snapshot-transfer'
import { acceptHello, broadcast, rememberSocketToken, rememberVaultId } from './auth'
import { broadcastAwarenessLeave, handleAwarenessUpdate } from './awareness'
import { abortExpiredBlobMultipartUploads } from './blob-gc'
import {
  handleBlobHead,
  handleBlobUploadUrl,
  handleBlobGet,
  handleBlobPut,
  handleBlobPartPut,
  handleBlobMultipartComplete,
  handleBlobMultipartAbort,
  handleBlobManifestGet,
  handleBlobManifestPut,
} from './blob-handlers'
import {
  checkpointDoc,
  evictIdleDocs,
  recoverOrphanedCheckpointRuns,
  readCheckpointableDocIds,
} from './checkpoint'
import {
  ADMIN_SETUP_TOKEN_PATH,
  ADMIN_SNAPSHOT_SEED_PATH,
  CHECKPOINT_ALARM_DOC_LIMIT,
  WEBSOCKET_UPGRADE,
} from './constants'
import { ensureSchema } from './storage'
import { handleSyncRequest, handleSyncUpdate } from './sync'
import type {
  WorkerEnv,
  DurableObjectStateBinding,
  RuntimeWebSocket,
  SessionState,
  RuntimeCheckpointResult,
  RuntimeWebSocketPairConstructor,
  WebSocketAwarenessAttachment,
  WebSocketResponseInit,
} from './types'
import { encodeBase64, extractWebSocketBearerToken, makeArrayBuffer, apiErrorBody } from './utils'

declare const WebSocketPair: RuntimeWebSocketPairConstructor | undefined

/** Cloudflare Durable Object shell for one vault room. */
export class VaultRoom {
  readonly sessions = new Set<RuntimeWebSocket>()
  readonly sessionStates = new Map<RuntimeWebSocket, SessionState>()
  readonly socketTokens = new Map<RuntimeWebSocket, string | undefined>()
  readonly awarenessByWebSocket = new Map<RuntimeWebSocket, WebSocketAwarenessAttachment>()
  readonly docs = new Map<string, Y.Doc>()
  readonly hydratedDocs = new Set<string>()
  readonly hydrationInFlight = new Map<string, Promise<void>>()
  readonly docLastAccessedAt = new Map<string, number>()
  readonly docWriteQueues = new Map<string, Promise<void>>()
  vaultId: VaultId | undefined
  schemaReady = false
  schemaEnsurePromise: Promise<void> | undefined
  private readonly doRouter: Hono

  constructor(
    readonly state: DurableObjectStateBinding,
    readonly env: WorkerEnv,
  ) {
    this.doRouter = new Hono()
      .post(ADMIN_SETUP_TOKEN_PATH, (c) => handleAdminSetupTokenIssue(this, c))
      .post(ADMIN_SNAPSHOT_SEED_PATH, (c) => handleAdminSnapshotSeed(this, c))
      .post('/setup/exchange', (c) => handleSetupExchange(this, c))
      .post('/auth/refresh', (c) => handleAuthRefresh(this, c))
      .post('/devices/:deviceId/revoke', (c) => handleDeviceRevoke(this, c))
      .get('/admin/quarantine', (c) => handleQuarantineList(this, c))
      .get('/admin/quarantine/audit', (c) => handleQuarantineAudit(this, c))
      .get('/admin/quarantine/:id', (c) => handleQuarantineDetail(this, c))
      .post('/admin/quarantine/:id/discard', (c) => handleQuarantineAction(this, c, 'discard'))
      .post('/admin/quarantine/:id/force-apply', (c) =>
        handleQuarantineAction(this, c, 'force-apply'),
      )
      .get('/admin/retention', (c) => handleRetentionInspect(this, c))
      .get('/admin/snapshots', (c) => handleSnapshotHealthList(this, c))
      .post('/admin/snapshots/verify', (c) => handleSnapshotHealthVerify(this, c))
      .post('/admin/snapshots/quarantine', (c) => handleSnapshotHealthQuarantine(this, c))
      .post('/admin/snapshots/rollback', (c) => handleSnapshotRollback(this, c))
      .post('/admin/snapshots/:docId/verify', (c) => handleSnapshotHealthVerify(this, c))
      .post('/admin/snapshots/:docId/quarantine', (c) => handleSnapshotHealthQuarantine(this, c))
      .post('/admin/snapshots/:docId/rollback', (c) => handleSnapshotRollback(this, c))
      .get('/vaults/:vaultId/meta/latest', (c) => handleMetaLatest(this, c))
      .get('/vaults/:vaultId/files/:ydocId/latest', (c) => handleFileLatest(this, c))
      .put('/vaults/:vaultId/meta/snapshot', (c) => handleMetaSnapshotImport(this, c))
      .put('/vaults/:vaultId/files/:ydocId/snapshot', (c) => handleFileSnapshotImport(this, c))
      .post('/blobs/head', (c) => handleBlobHead(this, c))
      .post('/blobs/upload-url', (c) => handleBlobUploadUrl(this, c))
      .get('/blobs/:hash', (c) => handleBlobGet(this, c))
      .put('/blobs/:hash', (c) => handleBlobPut(this, c))
      .put('/blobs/:hash/parts/:uploadId/:partNumber', (c) => handleBlobPartPut(this, c))
      .post('/blobs/:hash/complete', (c) => handleBlobMultipartComplete(this, c))
      .post('/blobs/:hash/abort', (c) => handleBlobMultipartAbort(this, c))
      .get('/blob-manifests/*', (c) => handleBlobManifestGet(this, c))
      .put('/blob-manifests/*', (c) => handleBlobManifestPut(this, c))
      .all('*', (c) => this.handleWebSocketUpgrade(c))
  }

  private handleWebSocketUpgrade(c: Context): Response {
    if (c.req.header('Upgrade')?.toLowerCase() !== WEBSOCKET_UPGRADE)
      return c.json(apiErrorBody('request/invalid', 'expected-websocket-upgrade'), 426)
    if (typeof WebSocketPair === 'undefined')
      return c.json(apiErrorBody('server/error', 'websocket-pair-unavailable'), 500)

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.state.acceptWebSocket(server)
    this.sessions.add(server)
    rememberSocketToken(this, server, extractWebSocketBearerToken(c.req.raw))

    const upgradeInit: WebSocketResponseInit = {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'kuroflare.v1' },
    }
    return new Response(null, upgradeInit)
  }

  fetch(request: Request): Response | Promise<Response> {
    rememberVaultId(this, request)
    return this.doRouter.fetch(request)
  }

  async webSocketMessage(
    webSocket: RuntimeWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await ensureSchema(this)
    if (typeof message !== 'string') {
      const frame = decodeBinaryFrame(new Uint8Array(message))
      if (frame === null) {
        webSocket.close(1003, 'invalid-binary-frame')
        return
      }
      const result = await handleSyncUpdate(this, webSocket, {
        ...frame.header,
        update: encodeBase64(frame.payload),
      })
      if (result.action === 'broadcast') {
        broadcast(
          this,
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
      if (isMalformedAwarenessUpdate(message)) return
      webSocket.close(1003, 'invalid-control-message')
      return
    }

    if (control.type === 'hello') {
      await acceptHello(this, webSocket, control)
      return
    }
    if (control.type === 'sync-request') {
      await handleSyncRequest(this, webSocket, control)
      return
    }
    if (control.type === 'awareness-update') {
      handleAwarenessUpdate(this, webSocket, control)
      return
    }
    if (control.type !== 'sync-update') {
      webSocket.close(1003, 'unsupported-control-message')
      return
    }

    const result = await handleSyncUpdate(this, webSocket, control)
    if (result.action === 'broadcast') {
      broadcast(this, webSocket, JSON.stringify({ ...control, durableSeq: result.durableSeq }))
    }
  }

  webSocketClose(webSocket: RuntimeWebSocket): void {
    broadcastAwarenessLeave(this, webSocket)
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  webSocketError(webSocket: RuntimeWebSocket): void {
    broadcastAwarenessLeave(this, webSocket)
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  checkpointDoc(docId: DocId, now?: number): Promise<RuntimeCheckpointResult> {
    return checkpointDoc(this, docId, now)
  }

  async alarm(): Promise<void> {
    await ensureSchema(this)
    await recoverOrphanedCheckpointRuns(this, CHECKPOINT_ALARM_DOC_LIMIT)
    for (const docId of await readCheckpointableDocIds(this, CHECKPOINT_ALARM_DOC_LIMIT)) {
      await checkpointDoc(this, docId)
    }
    // Eviction runs at the tail of the checkpoint alarm, after dirty docs above
    // have had a chance to flush, per server.md §11's "flush then evict" order.
    await evictIdleDocs(this)
    // deliberate: this only sweeps expired multipart sessions when the alarm
    // happens to fire for some other reason (sync activity keeps rescheduling
    // it); it does not itself schedule a wakeup, so it doesn't regress
    // checkpoint promptness for an otherwise-idle vault. The R2 bucket
    // lifecycle rule (see wrangler.toml) is the authoritative backstop for a
    // vault that goes idle right after starting an upload.
    await abortExpiredBlobMultipartUploads(this)
  }
}
