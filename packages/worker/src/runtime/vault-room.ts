import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseControlMessage,
  type DocId,
  type VaultId,
} from '@kuroflare/core'
import { Hono } from 'hono'
import * as Y from 'yjs'

import { acceptHello, broadcast, rememberVaultId } from './auth'
import {
  handleBlobHead,
  handleBlobUploadUrl,
  handleBlobGet,
  handleBlobPut,
  handleBlobManifestGet,
  handleBlobManifestPut,
} from './blob-handlers'
import {
  checkpointDoc,
  recoverOrphanedCheckpointRuns,
  readCheckpointableDocIds,
} from './checkpoint'
import { E2E_SETUP_TOKEN_PATH, E2E_SNAPSHOT_PATH, CHECKPOINT_ALARM_DOC_LIMIT } from './constants'
import {
  handleE2eSetupTokenSeed,
  handleE2eSnapshotSeed,
  handleSetupExchange,
  handleAuthRefresh,
  handleDeviceRevoke,
  handleQuarantineList,
  handleQuarantineDetail,
  handleRetentionInspect,
  handleSnapshotHealthList,
  handleSnapshotHealthVerify,
  handleSnapshotHealthQuarantine,
  handleSnapshotRollback,
  handleMetaLatest,
  handleFileLatest,
  handleMetaSnapshotImport,
  handleFileSnapshotImport,
  handleWebSocketUpgrade,
} from './route-handlers'
import { ensureSchema } from './storage'
import { handleSyncRequest, handleSyncUpdate } from './sync'
import type {
  WorkerEnv,
  DurableObjectStateBinding,
  RuntimeWebSocket,
  SessionState,
  RuntimeCheckpointResult,
} from './types'
import { makeArrayBuffer, encodeBase64 } from './utils'

/** Cloudflare Durable Object shell for one vault room. */
export class VaultRoom {
  readonly sessions = new Set<RuntimeWebSocket>()
  readonly sessionStates = new Map<RuntimeWebSocket, SessionState>()
  readonly socketTokens = new Map<RuntimeWebSocket, string | undefined>()
  readonly docs = new Map<string, Y.Doc>()
  readonly hydratedDocs = new Set<string>()
  readonly hydrationInFlight = new Map<string, Promise<void>>()
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
      .post(E2E_SETUP_TOKEN_PATH, (c) => handleE2eSetupTokenSeed(this, c))
      .post(E2E_SNAPSHOT_PATH, (c) => handleE2eSnapshotSeed(this, c))
      .post('/setup/exchange', (c) => handleSetupExchange(this, c))
      .post('/auth/refresh', (c) => handleAuthRefresh(this, c))
      .post('/devices/:deviceId/revoke', (c) => handleDeviceRevoke(this, c))
      .get('/admin/quarantine', (c) => handleQuarantineList(this, c))
      .get('/admin/quarantine/:id', (c) => handleQuarantineDetail(this, c))
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
      .get('/blob-manifests/*', (c) => handleBlobManifestGet(this, c))
      .put('/blob-manifests/*', (c) => handleBlobManifestPut(this, c))
      .all('*', (c) => handleWebSocketUpgrade(this, c))
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
    this.sessions.delete(webSocket)
    this.sessionStates.delete(webSocket)
    this.socketTokens.delete(webSocket)
  }

  webSocketError(webSocket: RuntimeWebSocket): void {
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
  }
}
