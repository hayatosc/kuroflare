import { hashBytesSha256, type OutboxRunningLease } from '@kuroflare/core'
import {
  CURRENT_PROTOCOL_VERSION,
  makeSha256Hex,
  parseControlMessage,
  type ClientCapability,
  type ClientHello,
  type ControlMessage,
  type DeviceId,
  type DocId,
  type HelloAccepted,
  type SyncRequest,
  type SyncUpdate,
  type VaultId,
} from '@kuroflare/protocol'
import * as Y from 'yjs'

import {
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from './local-store-indexeddb.js'
import { type LocalStoreOutboxRecord } from './local-store.js'
import { planOutboxWorkerAckCompletion, type OutboxWorkerCompletionPlan } from './outbox-worker.js'
import { type LocalSetupMetadata } from './setup-persist.js'
import {
  type SyncRuntimeStartupStepEffect,
  type SyncRuntimeWebSocketStepPort,
} from './startup-actuation.js'

const OPEN_READY_STATE = 1

/** Minimal WebSocket surface needed by startup transport steps. */
export interface SyncRuntimeWebSocketConnection {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  /** Sends one control or binary frame to the worker. */
  send(data: string | ArrayBuffer): void
  /** Closes the socket when startup is torn down or retried. */
  close(code?: number, reason?: string): void
}

/** Factory for browser or fake WebSocket connections. */
export interface SyncRuntimeWebSocketFactoryPort {
  /**
   * Opens a WebSocket for the given URL.
   *
   * @param url Browser-compatible WebSocket URL.
   * @param protocols Optional WebSocket subprotocols sent during upgrade.
   * @returns A connection whose open/error events can be observed by the runtime.
   */
  connect(url: string, protocols?: string | string[]): SyncRuntimeWebSocketConnection
}

/** Browser WebSocket constructor accepted by the concrete runtime factory. */
export interface SyncRuntimeBrowserWebSocketConstructor {
  /** Creates a browser WebSocket for the given URL. */
  new (url: string, protocols?: string | string[]): WebSocket
}

/** SecretStorage reader used to obtain the current access token without exposing refresh tokens. */
export interface SyncRuntimeWebSocketAccessTokenReaderPort {
  /**
   * Reads the current device access token.
   *
   * @param key SecretStorage key from trusted auth metadata.
   * @returns The access token, or undefined when local auth metadata is stale.
   */
  getAccessToken(key: string): Promise<string | undefined>
}

/** Trusted startup metadata needed to open the authenticated sync WebSocket. */
export interface SyncRuntimeWebSocketStartupMetadata {
  readonly setup: LocalSetupMetadata
  readonly accessTokenSecretKey: string
}

/** Input for building a browser-compatible worker WebSocket URL. */
export interface SyncRuntimeWebSocketUrlInput {
  readonly endpoint: string
  readonly vaultId: LocalSetupMetadata['vaultId']
}

/** Input for creating the startup WebSocket step port. */
export interface SyncRuntimeWebSocketStepPortInput {
  readonly metadata: SyncRuntimeWebSocketStartupMetadata
  readonly tokenReader: SyncRuntimeWebSocketAccessTokenReaderPort
  readonly webSocket: SyncRuntimeWebSocketFactoryPort
  readonly capabilities?: readonly ClientCapability[] | undefined
  readonly onInboundMessage?: SyncRuntimeWebSocketInboundMessageHandler | undefined
  readonly session?: SyncRuntimeWebSocketSessionPort | undefined
}

/** Observable state captured by the WebSocket startup step port. */
export interface SyncRuntimeWebSocketStepPortState {
  readonly connectionUrl: string | undefined
  readonly hello: ClientHello | undefined
  readonly socketReadyState: number | undefined
}

/** Reason an inbound WebSocket frame is rejected before sync decisions. */
export type SyncRuntimeWebSocketInboundRejectionReason =
  | 'unsupported-binary-message'
  | 'invalid-control-message'

/** Result of parsing one inbound WebSocket message at the trust boundary. */
export type SyncRuntimeWebSocketInboundMessage =
  | { readonly ok: true; readonly message: ControlMessage }
  | {
      readonly ok: false
      readonly reason: SyncRuntimeWebSocketInboundRejectionReason
    }

/** Input for routing one guarded inbound control message inside the plugin runtime. */
export interface SyncRuntimeWebSocketInboundRouteInput {
  readonly inbound: SyncRuntimeWebSocketInboundMessage
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
}

/** Local runtime route selected for one inbound WebSocket control message. */
export type SyncRuntimeWebSocketInboundRoute =
  | {
      readonly action: 'outbox-completion'
      readonly message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>
    }
  | {
      readonly action: 'apply-remote-update'
      readonly message: Extract<ControlMessage, { readonly type: 'sync-update' }>
    }
  | {
      readonly action: 'answer-sync-request'
      readonly message: Extract<ControlMessage, { readonly type: 'sync-request' }>
    }
  | {
      readonly action: 'drop'
      readonly reason:
        | SyncRuntimeWebSocketInboundRejectionReason
        | 'vault-mismatch'
        | 'device-mismatch'
        | 'self-broadcast'
        | 'unexpected-server-hello'
        | 'unexpected-hello-accepted'
    }

/** Input for validating the server admission response after sending ClientHello. */
export interface SyncRuntimeWebSocketHelloAdmissionInput {
  readonly inbound: SyncRuntimeWebSocketInboundMessage
  readonly metadata: SyncRuntimeWebSocketStartupMetadata['setup']
}

/** Decision for one inbound message observed while waiting for hello admission. */
export type SyncRuntimeWebSocketHelloAdmissionPlan =
  | { readonly action: 'accepted'; readonly message: HelloAccepted }
  | {
      readonly action: 'reject'
      readonly reason:
        | SyncRuntimeWebSocketInboundRejectionReason
        | 'unexpected-message'
        | 'vault-mismatch'
        | 'device-mismatch'
        | 'y-client-id-mismatch'
    }

/** Ports that own local side effects for routed inbound WebSocket messages. */
export interface SyncRuntimeWebSocketInboundRoutePorts {
  /**
   * Commits an outbound queue completion or full-snapshot pause after a server response.
   *
   * @param message Guarded ack or need-full-snapshot message for the local device.
   * @returns Resolves after the local-store transaction has been accepted.
   */
  completeOutbox(
    message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>,
  ): Promise<void>
  /**
   * Applies a peer update to the local YDoc and follow-up materialization pipeline.
   *
   * @param message Guarded sync-update message from a peer device.
   * @returns Resolves after local apply planning or persistence has accepted the update.
   */
  applyRemoteUpdate(
    message: Extract<ControlMessage, { readonly type: 'sync-update' }>,
  ): Promise<void>
  /**
   * Answers a peer state-vector request with a local update or full-snapshot response.
   *
   * @param message Guarded sync-request message from a peer device.
   * @returns Resolves after the response has been queued or sent.
   */
  answerSyncRequest(
    message: Extract<ControlMessage, { readonly type: 'sync-request' }>,
  ): Promise<void>
  /**
   * Observes dropped inbound messages without receiving token material or raw payloads.
   *
   * @param route Safe drop route with a reason code.
   * @returns Resolves after metrics/logging has accepted the drop.
   */
  drop(route: Extract<SyncRuntimeWebSocketInboundRoute, { readonly action: 'drop' }>): Promise<void>
}

/** Input for dispatching one inbound WebSocket message to runtime ports. */
export interface SyncRuntimeWebSocketInboundDispatchInput {
  readonly inbound: SyncRuntimeWebSocketInboundMessage
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly ports: SyncRuntimeWebSocketInboundRoutePorts
}

/** Result of dispatching one inbound WebSocket message. */
export interface SyncRuntimeWebSocketInboundDispatchResult {
  readonly route: SyncRuntimeWebSocketInboundRoute
}

/** Snapshot of the active WebSocket session shared by startup, outbox, and inbound runtime ports. */
export interface SyncRuntimeWebSocketSessionSnapshot {
  readonly hasConnection: boolean
  readonly readyState: number | undefined
}

/** Shared active WebSocket session boundary used after startup opens the transport. */
export interface SyncRuntimeWebSocketSessionPort {
  /**
   * Attaches the current WebSocket connection to the shared sync session.
   *
   * @param connection Open or opening WebSocket connection accepted by startup.
   */
  attach(connection: SyncRuntimeWebSocketConnection): void
  /**
   * Sends one frame over the active sync WebSocket.
   *
   * @param data Serialized control message or binary frame.
   * @throws When no connection is attached or the socket is not open.
   */
  send(data: string | ArrayBuffer): void
  /** Closes the attached connection and clears the shared session. */
  close(code?: number, reason?: string): void
  /** Returns connection presence and readyState without exposing token material. */
  snapshot(): SyncRuntimeWebSocketSessionSnapshot
}

/** Snapshot needed to commit one inbound WebSocket outbox completion. */
export interface SyncRuntimeWebSocketOutboxCompletionSnapshot {
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}

/** Port that reads the current local outbox state before committing an inbound ack. */
export interface SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort {
  /**
   * Reads the current outbox records and running leases needed for completion planning.
   *
   * @returns Local-store snapshot used by the outbox worker planner.
   */
  read(): Promise<SyncRuntimeWebSocketOutboxCompletionSnapshot>
}

/** Port that durably commits a successful inbound outbox completion plan. */
export interface SyncRuntimeWebSocketOutboxCompletionCommitPort {
  /**
   * Commits a successful completion plan to the local store.
   *
   * @param plan Successful outbox completion plan with concrete local-store writes.
   * @returns Resolves after the completion transaction is durable.
   */
  commit(plan: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>): Promise<void>
}

/** Input for planning one inbound WebSocket outbox completion. */
export interface SyncRuntimeWebSocketOutboxCompletionInput {
  readonly message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>
  readonly ownerId: string
  readonly now: number
  readonly snapshot: SyncRuntimeWebSocketOutboxCompletionSnapshot
  readonly minDurableSeqExclusive?: number | undefined
}

/** Result of matching and planning one inbound outbox completion. */
export type SyncRuntimeWebSocketOutboxCompletionPlan =
  | {
      readonly ok: true
      readonly record: LocalStoreOutboxRecord
      readonly completion: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason:
        | 'matching-outbox-record-not-found'
        | 'ambiguous-matching-outbox-record'
        | Extract<OutboxWorkerCompletionPlan, { readonly ok: false }>['reason']
      readonly candidates: readonly LocalStoreOutboxRecord[]
      readonly completion?: Extract<OutboxWorkerCompletionPlan, { readonly ok: false }> | undefined
    }

/** Input for creating the inbound outbox completion dispatch port. */
export interface SyncRuntimeWebSocketOutboxCompletionPortInput {
  readonly ownerId: string
  readonly now: () => number
  readonly snapshot: SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort
  readonly commit: SyncRuntimeWebSocketOutboxCompletionCommitPort
  readonly minDurableSeqExclusive?: number | undefined
}

/** Input for planning one outbound sync-update WebSocket frame from a local outbox record. */
export interface SyncRuntimeWebSocketOutboxSendInput {
  readonly record: LocalStoreOutboxRecord
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
}

/** Result of turning an outbox record into one WebSocket control frame. */
export type SyncRuntimeWebSocketOutboxSendPlan =
  | {
      readonly ok: true
      readonly message: SyncUpdate
      readonly frame: string
    }
  | {
      readonly ok: false
      readonly reason:
        | 'unsupported-kind'
        | 'missing-doc-id'
        | 'missing-message-id'
        | 'missing-update-bytes'
    }

/** Input for creating an outbound sync-update WebSocket sender. */
export interface SyncRuntimeWebSocketOutboxSendPortInput {
  readonly session: SyncRuntimeWebSocketSessionPort
}

/** Port used by outbox runners to send leased sync-control records over the active WebSocket. */
export interface SyncRuntimeWebSocketOutboxSendPort {
  /**
   * Sends one local y-update or meta-ref-update record as a sync-update control frame.
   *
   * @param input Local outbox record plus trusted local vault/device identity.
   * @returns The sent frame plan, or a rejection before touching the WebSocket.
   */
  sendSyncUpdate(
    input: SyncRuntimeWebSocketOutboxSendInput,
  ): Promise<SyncRuntimeWebSocketOutboxSendPlan>
}

/** Verified peer sync-update payload accepted for local YDoc application. */
export interface SyncRuntimeWebSocketRemoteUpdateApplyInput {
  readonly message: SyncUpdate
  readonly updateBytes: Uint8Array
  readonly actualUpdateSha256: NonNullable<SyncUpdate['updateSha256']>
}

/** Local YDoc state captured after applying a verified peer update. */
export interface SyncRuntimeWebSocketAppliedYDocState {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
  readonly stateVectorBase64: string
}

/** Verified peer update plus resulting local YDoc state ready for durable commit. */
export interface SyncRuntimeWebSocketRemoteUpdateCommitInput extends SyncRuntimeWebSocketRemoteUpdateApplyInput {
  readonly appliedState: SyncRuntimeWebSocketAppliedYDocState
}

/** Result of decoding and verifying one peer sync-update before local mutation. */
export type SyncRuntimeWebSocketRemoteUpdateDecodePlan =
  | {
      readonly ok: true
      readonly apply: SyncRuntimeWebSocketRemoteUpdateApplyInput
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-base64'
        | 'missing-update-sha256'
        | 'missing-durable-seq'
        | 'hash-mismatch'
    }

/** Port that applies a verified peer update to the in-memory local YDoc. */
export interface SyncRuntimeWebSocketRemoteUpdateYDocApplyPort {
  /**
   * Applies one verified peer update to the correct local YDoc.
   *
   * @param input Guarded message and decoded update bytes.
   * @returns Resolves after the in-memory YDoc accepted the update.
   */
  applyRemoteUpdate(
    input: SyncRuntimeWebSocketRemoteUpdateApplyInput,
  ): Promise<SyncRuntimeWebSocketAppliedYDocState>
}

/** Port that records a successfully applied peer update durably. */
export interface SyncRuntimeWebSocketRemoteUpdateCommitPort {
  /**
   * Persists cursor/update evidence after the in-memory YDoc apply succeeds.
   *
   * @param input Guarded message, decoded update bytes, and applied local YDoc state.
   * @returns Resolves after local durable state accepted the peer update.
   */
  commitRemoteUpdate(input: SyncRuntimeWebSocketRemoteUpdateCommitInput): Promise<void>
}

/** Local YDoc state write produced after applying an incremental peer update. */
export type SyncRuntimeWebSocketRemoteUpdateYDocWrite =
  | {
      readonly kind: 'put'
      readonly storeName: 'meta-ydoc'
      readonly key: 'meta'
      readonly value: SyncRuntimeWebSocketRemoteUpdateYDocRecord
    }
  | {
      readonly kind: 'put'
      readonly storeName: 'file-ydocs'
      readonly key: string
      readonly value: SyncRuntimeWebSocketRemoteUpdateYDocRecord
    }

/** Compact local YDoc state stored after applying a peer update. */
export interface SyncRuntimeWebSocketRemoteUpdateYDocRecord {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
}

/** Remote cursor write produced after applying a peer update. */
export interface SyncRuntimeWebSocketRemoteUpdateCursorWrite {
  readonly kind: 'put'
  readonly storeName: 'remote-cursors'
  readonly key: string
  readonly value: SyncRuntimeWebSocketRemoteUpdateCursorRecord
}

/** Remote cursor state stored for the durable peer update sequence. */
export interface SyncRuntimeWebSocketRemoteUpdateCursorRecord {
  readonly docId: DocId
  readonly remoteCursorSeq: number
  readonly stateVectorBase64: string
}

/** IndexedDB transaction plan for durable peer update state. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction {
  readonly kind: 'remote-update-apply'
  readonly ydocWrite: SyncRuntimeWebSocketRemoteUpdateYDocWrite
  readonly remoteCursorWrite: SyncRuntimeWebSocketRemoteUpdateCursorWrite
}

/** Object store surface required for remote update YDoc writes. */
export interface SyncRuntimeWebSocketRemoteUpdateYDocObjectStorePort {
  /** Stores one compact local YDoc state by the runtime's stable key. */
  put(
    value: SyncRuntimeWebSocketRemoteUpdateYDocRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object store surface required for remote cursor writes. */
export interface SyncRuntimeWebSocketRemoteUpdateCursorObjectStorePort {
  /** Stores one remote cursor record by the runtime's stable document key. */
  put(
    value: SyncRuntimeWebSocketRemoteUpdateCursorRecord,
    key: IDBValidKey,
  ): LocalStoreIndexedDbRequest<IDBValidKey>
}

/** Object stores required by one remote update commit transaction. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts {
  readonly metaYDoc: SyncRuntimeWebSocketRemoteUpdateYDocObjectStorePort
  readonly fileYDocs: SyncRuntimeWebSocketRemoteUpdateYDocObjectStorePort
  readonly remoteCursors: SyncRuntimeWebSocketRemoteUpdateCursorObjectStorePort
}

/** Open IndexedDB transaction handle for remote update commits. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbTransactionHandle {
  readonly stores: SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts
  readonly lifecycle: LocalStoreIndexedDbTransactionLifecycle
}

/** Database surface that can open a remote update commit transaction. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort {
  /** Opens one readwrite transaction across YDoc and remote cursor stores. */
  openRemoteUpdateCommitTransaction(): SyncRuntimeWebSocketRemoteUpdateIndexedDbTransactionHandle
}

/** Input for committing one remote update through IndexedDB. */
export interface SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput {
  readonly transaction: SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction
  readonly database: SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort
}

/** Observer for rejected peer updates that must not mutate local state. */
export interface SyncRuntimeWebSocketRemoteUpdateRejectPort {
  /**
   * Observes a rejected peer update without raw token material.
   *
   * @param message Guarded sync-update message.
   * @param reason Non-secret rejection reason.
   * @returns Resolves after logging/metrics accepted the rejection.
   */
  rejectRemoteUpdate(
    message: SyncUpdate,
    reason: Extract<SyncRuntimeWebSocketRemoteUpdateDecodePlan, { readonly ok: false }>['reason'],
  ): Promise<void>
}

/** Input for creating the peer sync-update apply port used by inbound dispatch. */
export interface SyncRuntimeWebSocketRemoteUpdateApplyPortInput {
  readonly ydoc: SyncRuntimeWebSocketRemoteUpdateYDocApplyPort
  readonly commit: SyncRuntimeWebSocketRemoteUpdateCommitPort
  readonly reject?: SyncRuntimeWebSocketRemoteUpdateRejectPort | undefined
}

/** Port that returns the local YDoc instance for a sync document id. */
export interface SyncRuntimeWebSocketYDocRegistryPort {
  /**
   * Returns the local YDoc for the given sync document.
   *
   * @param docId Meta or file document id.
   * @returns Local YDoc instance, or undefined when the document is not loaded.
   */
  getYDoc(docId: DocId): Y.Doc | undefined
}

/** Input for creating a concrete Yjs remote-update apply port. */
export interface SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput {
  readonly registry: SyncRuntimeWebSocketYDocRegistryPort
  readonly origin?: unknown
}

/** Input for planning a local answer to one peer sync-request. */
export interface SyncRuntimeWebSocketSyncRequestAnswerInput {
  readonly request: SyncRequest
  readonly deviceId: DeviceId
  readonly registry: SyncRuntimeWebSocketYDocRegistryPort
}

/** Result of planning a sync-request answer before WebSocket I/O. */
export type SyncRuntimeWebSocketSyncRequestAnswerPlan =
  | {
      readonly ok: true
      readonly message: SyncUpdate
      readonly frame: string
    }
  | {
      readonly ok: false
      readonly reason: 'invalid-state-vector' | 'ydoc-not-loaded'
    }

/** Observer for sync-request answers that cannot be produced locally. */
export interface SyncRuntimeWebSocketSyncRequestAnswerRejectPort {
  /**
   * Observes a sync-request answer rejection without raw token material.
   *
   * @param request Guarded sync-request from a peer device.
   * @param reason Non-secret rejection reason.
   * @returns Resolves after logging/metrics accepted the rejection.
   */
  rejectSyncRequestAnswer(
    request: SyncRequest,
    reason: Extract<SyncRuntimeWebSocketSyncRequestAnswerPlan, { readonly ok: false }>['reason'],
  ): Promise<void>
}

/** Input for creating the sync-request answer port used by inbound dispatch. */
export interface SyncRuntimeWebSocketSyncRequestAnswerPortInput {
  readonly deviceId: DeviceId
  readonly registry: SyncRuntimeWebSocketYDocRegistryPort
  readonly session: SyncRuntimeWebSocketSessionPort
  readonly reject?: SyncRuntimeWebSocketSyncRequestAnswerRejectPort | undefined
}

/** Handler invoked after one inbound WebSocket frame has crossed parser validation. */
export type SyncRuntimeWebSocketInboundMessageHandler = (
  message: SyncRuntimeWebSocketInboundMessage,
) => void

/** WebSocket step port plus observable state for tests and lifecycle logging. */
export interface SyncRuntimeWebSocketStartupStepPort extends SyncRuntimeWebSocketStepPort {
  /** Returns current WebSocket startup state without exposing token material. */
  snapshot(): SyncRuntimeWebSocketStepPortState
}

/**
 * Builds the browser-compatible worker WebSocket URL for one vault.
 *
 * @param input Worker HTTP endpoint and vault id.
 * @returns `ws:` or `wss:` URL under `/ws/:vaultId`.
 * @throws When the endpoint is not an HTTP(S) URL.
 */
export function buildSyncRuntimeWebSocketUrl(input: SyncRuntimeWebSocketUrlInput): string {
  const url = new URL(input.endpoint)
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else {
    throw new Error('websocket-endpoint-invalid')
  }
  url.pathname = `/ws/${encodeURIComponent(input.vaultId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Builds browser WebSocket subprotocols carrying the short-lived device access token.
 *
 * @param accessToken Compact JWT device access token.
 * @returns Protocol list accepted by the worker WebSocket upgrade path.
 */
export function buildSyncRuntimeWebSocketProtocols(accessToken: string): readonly string[] {
  return ['kuroflare.v1', `kuroflare-token.${accessToken}`]
}

/**
 * Creates a WebSocket factory backed by the browser runtime.
 *
 * @param WebSocketCtor Browser or Electron WebSocket constructor.
 * @returns Factory compatible with the startup WebSocket step port.
 */
export function createBrowserSyncRuntimeWebSocketFactory(
  WebSocketCtor: SyncRuntimeBrowserWebSocketConstructor,
): SyncRuntimeWebSocketFactoryPort {
  return {
    connect(url, protocols) {
      return new BrowserSyncRuntimeWebSocketConnection(new WebSocketCtor(url, protocols))
    },
  }
}

/**
 * Creates a shared active WebSocket session used by startup and background sync ports.
 *
 * @returns Mutable session boundary that hides the concrete socket from composition code.
 */
export function createSyncRuntimeWebSocketSession(): SyncRuntimeWebSocketSessionPort {
  let connection: SyncRuntimeWebSocketConnection | undefined

  return {
    attach(nextConnection) {
      connection = nextConnection
    },
    send(data) {
      if (connection === undefined) {
        throw new Error('websocket-session-missing')
      }
      if (connection.readyState !== OPEN_READY_STATE) {
        throw new Error('websocket-session-not-open')
      }
      connection.send(data)
    },
    close(code, reason) {
      connection?.close(code, reason)
      connection = undefined
    },
    snapshot() {
      return {
        hasConnection: connection !== undefined,
        readyState: connection?.readyState,
      }
    },
  }
}

/**
 * Parses one inbound WebSocket message before it reaches sync runtime decisions.
 *
 * @param event Browser WebSocket message event.
 * @returns Guarded control message, or a rejection reason for unsupported payloads.
 */
export function parseSyncRuntimeWebSocketMessage(
  event: MessageEvent,
): SyncRuntimeWebSocketInboundMessage {
  if (typeof event.data !== 'string') {
    return { ok: false, reason: 'unsupported-binary-message' }
  }
  const message = parseControlMessage(event.data)
  if (message === null) {
    return { ok: false, reason: 'invalid-control-message' }
  }
  return { ok: true, message }
}

/**
 * Routes a guarded inbound WebSocket message to the next local runtime boundary.
 *
 * @param input Parsed inbound message plus the trusted local vault and device identity.
 * @returns The local boundary that should handle the message, or a safe drop reason.
 */
export function planSyncRuntimeWebSocketInboundRoute(
  input: SyncRuntimeWebSocketInboundRouteInput,
): SyncRuntimeWebSocketInboundRoute {
  if (!input.inbound.ok) {
    return { action: 'drop', reason: input.inbound.reason }
  }

  const message = input.inbound.message
  if (message.vaultId !== input.vaultId) {
    return { action: 'drop', reason: 'vault-mismatch' }
  }

  switch (message.type) {
    case 'ack':
    case 'need-full-snapshot':
      if (message.deviceId !== input.deviceId) {
        return { action: 'drop', reason: 'device-mismatch' }
      }
      return { action: 'outbox-completion', message }
    case 'sync-update':
      if (message.deviceId === input.deviceId) {
        return { action: 'drop', reason: 'self-broadcast' }
      }
      return { action: 'apply-remote-update', message }
    case 'sync-request':
      if (message.deviceId === input.deviceId) {
        return { action: 'drop', reason: 'self-broadcast' }
      }
      return { action: 'answer-sync-request', message }
    case 'hello':
      return { action: 'drop', reason: 'unexpected-server-hello' }
    case 'hello-accepted':
      return { action: 'drop', reason: 'unexpected-hello-accepted' }
  }
}

/**
 * Validates the server response that proves ClientHello admission succeeded.
 *
 * @param input Parsed inbound message plus trusted local setup metadata.
 * @returns Accepted admission evidence, or a non-secret rejection reason.
 */
export function planSyncRuntimeWebSocketHelloAdmission(
  input: SyncRuntimeWebSocketHelloAdmissionInput,
): SyncRuntimeWebSocketHelloAdmissionPlan {
  if (!input.inbound.ok) {
    return { action: 'reject', reason: input.inbound.reason }
  }
  const message = input.inbound.message
  if (message.type !== 'hello-accepted') {
    return { action: 'reject', reason: 'unexpected-message' }
  }
  if (message.vaultId !== input.metadata.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (message.deviceId !== input.metadata.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (message.yClientId !== input.metadata.yClientId) {
    return { action: 'reject', reason: 'y-client-id-mismatch' }
  }
  return { action: 'accepted', message }
}

/**
 * Dispatches one guarded inbound WebSocket message to the runtime port selected by routing.
 *
 * @param input Guarded inbound message, trusted local identity, and side-effect ports.
 * @returns The route that was executed.
 */
export async function dispatchSyncRuntimeWebSocketInboundMessage(
  input: SyncRuntimeWebSocketInboundDispatchInput,
): Promise<SyncRuntimeWebSocketInboundDispatchResult> {
  const route = planSyncRuntimeWebSocketInboundRoute(input)
  switch (route.action) {
    case 'outbox-completion':
      await input.ports.completeOutbox(route.message)
      break
    case 'apply-remote-update':
      await input.ports.applyRemoteUpdate(route.message)
      break
    case 'answer-sync-request':
      await input.ports.answerSyncRequest(route.message)
      break
    case 'drop':
      await input.ports.drop(route)
      break
  }
  return { route }
}

/**
 * Plans how an inbound ack-like WebSocket message completes a local outbox item.
 *
 * @param input Guarded server message, owner identity, clock, and current local-store snapshot.
 * @returns Successful completion plan, or a precise reason the message cannot mutate local state.
 */
export function planSyncRuntimeWebSocketOutboxCompletion(
  input: SyncRuntimeWebSocketOutboxCompletionInput,
): SyncRuntimeWebSocketOutboxCompletionPlan {
  const candidates = input.snapshot.outboxRecords.filter((record) =>
    outboxCompletionCandidateMatches(record, input.message),
  )
  if (candidates.length === 0) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates }
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous-matching-outbox-record', candidates }
  }

  const record = candidates[0]
  if (record === undefined) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates }
  }
  const messageId = record.messageId
  if (messageId === undefined) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates: [] }
  }
  const completion = planOutboxWorkerAckCompletion({
    itemId: record.id,
    status: record.status,
    vaultId: input.message.vaultId,
    deviceId: input.message.deviceId,
    docId: input.message.docId,
    messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
    ownerId: input.ownerId,
    now: input.now,
    currentOutboxRecords: input.snapshot.outboxRecords,
    currentLeaseRows: input.snapshot.leaseRows,
  })
  if (!completion.ok) {
    return { ok: false, reason: completion.reason, candidates, completion }
  }

  return { ok: true, record, completion }
}

/**
 * Creates the inbound outbox-completion port used by the WebSocket dispatcher.
 *
 * @param input Snapshot reader, durable committer, owner identity, and clock.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.completeOutbox`.
 */
export function createSyncRuntimeWebSocketOutboxCompletionPort(
  input: SyncRuntimeWebSocketOutboxCompletionPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'completeOutbox'> {
  return {
    async completeOutbox(message) {
      const plan = planSyncRuntimeWebSocketOutboxCompletion({
        message,
        ownerId: input.ownerId,
        now: input.now(),
        snapshot: await input.snapshot.read(),
        minDurableSeqExclusive: input.minDurableSeqExclusive,
      })
      if (!plan.ok) {
        return
      }
      await input.commit.commit(plan.completion)
    },
  }
}

/**
 * Plans one outbound sync-update control frame from a local outbox record.
 *
 * @param input Local outbox record and trusted local vault/device identity.
 * @returns Serialized sync-update frame, or a rejection reason before WebSocket I/O.
 */
export function planSyncRuntimeWebSocketOutboxSend(
  input: SyncRuntimeWebSocketOutboxSendInput,
): SyncRuntimeWebSocketOutboxSendPlan {
  const record = input.record
  if (record.kind !== 'y-update' && record.kind !== 'meta-ref-update') {
    return { ok: false, reason: 'unsupported-kind' }
  }
  if (record.docId === undefined) {
    return { ok: false, reason: 'missing-doc-id' }
  }
  if (record.messageId === undefined) {
    return { ok: false, reason: 'missing-message-id' }
  }
  if (record.updateBytesBase64 === undefined || record.updateBytesBase64.length === 0) {
    return { ok: false, reason: 'missing-update-bytes' }
  }

  const message: SyncUpdate = {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    messageId: record.messageId,
    docId: record.docId,
    update: record.updateBytesBase64,
  }
  if (record.updateSha256 !== undefined) {
    message.updateSha256 = record.updateSha256
  }
  return { ok: true, message, frame: JSON.stringify(message) }
}

/**
 * Creates the outbound WebSocket sender used by leased sync-control outbox work.
 *
 * @param input Shared active WebSocket session.
 * @returns Sender that serializes guarded outbox records as sync-update frames.
 */
export function createSyncRuntimeWebSocketOutboxSendPort(
  input: SyncRuntimeWebSocketOutboxSendPortInput,
): SyncRuntimeWebSocketOutboxSendPort {
  return {
    async sendSyncUpdate(sendInput) {
      const plan = planSyncRuntimeWebSocketOutboxSend(sendInput)
      if (!plan.ok) {
        return plan
      }
      input.session.send(plan.frame)
      return plan
    },
  }
}

/**
 * Decodes and verifies one peer sync-update before local YDoc mutation.
 *
 * @param message Guarded peer sync-update message.
 * @returns Decoded bytes with a verified SHA-256 hash, or a rejection reason.
 */
export async function decodeSyncRuntimeWebSocketRemoteUpdate(
  message: SyncUpdate,
): Promise<SyncRuntimeWebSocketRemoteUpdateDecodePlan> {
  if (message.updateSha256 === undefined) {
    return { ok: false, reason: 'missing-update-sha256' }
  }
  if (message.durableSeq === undefined) {
    return { ok: false, reason: 'missing-durable-seq' }
  }
  const updateBytes = decodeBase64Bytes(message.update)
  if (updateBytes === null) {
    return { ok: false, reason: 'invalid-base64' }
  }
  const actualUpdateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  if (actualUpdateSha256 !== message.updateSha256) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  return {
    ok: true,
    apply: {
      message,
      updateBytes,
      actualUpdateSha256,
    },
  }
}

/**
 * Creates the peer sync-update apply port used by the inbound WebSocket dispatcher.
 *
 * @param input In-memory YDoc apply port, durable commit port, and optional rejection observer.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.applyRemoteUpdate`.
 */
export function createSyncRuntimeWebSocketRemoteUpdateApplyPort(
  input: SyncRuntimeWebSocketRemoteUpdateApplyPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'applyRemoteUpdate'> {
  return {
    async applyRemoteUpdate(message) {
      const decoded = await decodeSyncRuntimeWebSocketRemoteUpdate(message)
      if (!decoded.ok) {
        await input.reject?.rejectRemoteUpdate(message, decoded.reason)
        return
      }
      const appliedState = await input.ydoc.applyRemoteUpdate(decoded.apply)
      await input.commit.commitRemoteUpdate({ ...decoded.apply, appliedState })
    },
  }
}

/**
 * Creates a concrete Yjs apply port for verified peer sync updates.
 *
 * @param input Registry of loaded YDocs and optional transaction origin.
 * @returns Apply port that mutates the matching YDoc and returns durable state evidence.
 */
export function createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort(
  input: SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput,
): SyncRuntimeWebSocketRemoteUpdateYDocApplyPort {
  return {
    async applyRemoteUpdate(applyInput) {
      const doc = input.registry.getYDoc(applyInput.message.docId)
      if (doc === undefined) {
        throw new Error('remote-update-ydoc-not-loaded')
      }
      Y.applyUpdate(doc, applyInput.updateBytes, input.origin)
      return {
        docId: applyInput.message.docId,
        updateBytes: Y.encodeStateAsUpdate(doc),
        stateVectorBase64: encodeBase64Bytes(Y.encodeStateVector(doc)),
      }
    },
  }
}

/**
 * Plans the IndexedDB writes needed after applying one peer update to a local YDoc.
 *
 * @param input Guarded message, decoded update bytes, and applied local YDoc state.
 * @returns YDoc and remote cursor writes for one durable IndexedDB transaction.
 * @throws When the server did not provide a durable sequence.
 */
export function planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(
  input: SyncRuntimeWebSocketRemoteUpdateCommitInput,
): SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction {
  const durableSeq = input.message.durableSeq
  if (durableSeq === undefined) {
    throw new Error('remote-update-durable-seq-missing')
  }
  return {
    kind: 'remote-update-apply',
    ydocWrite: remoteUpdateYDocWrite(input.appliedState),
    remoteCursorWrite: {
      kind: 'put',
      storeName: 'remote-cursors',
      key: remoteUpdateDocKey(input.message.docId),
      value: {
        docId: input.message.docId,
        remoteCursorSeq: durableSeq,
        stateVectorBase64: input.appliedState.stateVectorBase64,
      },
    },
  }
}

/**
 * Creates a remote update commit database port from a concrete IndexedDB database.
 *
 * @param database Open IndexedDB database containing YDoc and remote cursor stores.
 * @returns Database port that opens one readwrite transaction for peer update commits.
 */
export function createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort(
  database: IDBDatabase,
): SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort {
  return {
    openRemoteUpdateCommitTransaction() {
      const transaction = database.transaction(
        ['meta-ydoc', 'file-ydocs', 'remote-cursors'],
        'readwrite',
      )
      return {
        stores: {
          metaYDoc: transaction.objectStore('meta-ydoc'),
          fileYDocs: transaction.objectStore('file-ydocs'),
          remoteCursors: transaction.objectStore('remote-cursors'),
        },
        lifecycle: transaction,
      }
    },
  }
}

/**
 * Commits a peer update apply plan as one IndexedDB transaction.
 *
 * @param input Planned remote update transaction and database transaction opener.
 * @returns Resolves after YDoc state and remote cursor writes are durable.
 * @throws When a write request rejects or the IndexedDB transaction aborts/errors.
 */
export async function commitSyncRuntimeWebSocketRemoteUpdateIndexedDbTransaction(
  input: SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput,
): Promise<void> {
  const transaction = input.database.openRemoteUpdateCommitTransaction()
  const ydocRequest = queueRemoteUpdateYDocWrite(transaction.stores, input.transaction.ydocWrite)
  const cursorRequest = transaction.stores.remoteCursors.put(
    input.transaction.remoteCursorWrite.value,
    input.transaction.remoteCursorWrite.key,
  )
  await Promise.all(
    [ydocRequest, cursorRequest].map((request) => waitForRemoteUpdateIndexedDbRequest(request)),
  )
  await waitForRemoteUpdateIndexedDbTransaction(transaction.lifecycle)
}

/**
 * Creates a durable commit port for peer updates backed by IndexedDB.
 *
 * @param database Database transaction opener for YDoc and remote cursor stores.
 * @returns Commit port compatible with the inbound remote update apply port.
 */
export function createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(
  database: SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
): SyncRuntimeWebSocketRemoteUpdateCommitPort {
  return {
    async commitRemoteUpdate(input) {
      await commitSyncRuntimeWebSocketRemoteUpdateIndexedDbTransaction({
        database,
        transaction: planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(input),
      })
    },
  }
}

/**
 * Plans the sync-update response for one peer sync-request from a loaded local YDoc.
 *
 * @param input Peer request, trusted local device id, and loaded YDoc registry.
 * @returns Serialized sync-update response, or a rejection before WebSocket I/O.
 */
export async function planSyncRuntimeWebSocketSyncRequestAnswer(
  input: SyncRuntimeWebSocketSyncRequestAnswerInput,
): Promise<SyncRuntimeWebSocketSyncRequestAnswerPlan> {
  const stateVector = decodeBase64Bytes(input.request.stateVector)
  if (stateVector === null) {
    return { ok: false, reason: 'invalid-state-vector' }
  }
  const doc = input.registry.getYDoc(input.request.docId)
  if (doc === undefined) {
    return { ok: false, reason: 'ydoc-not-loaded' }
  }

  const updateBytes = Y.encodeStateAsUpdate(doc, stateVector)
  const update = encodeBase64Bytes(updateBytes)
  const updateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  const message: SyncUpdate = {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: input.request.vaultId,
    deviceId: input.deviceId,
    messageId: input.request.messageId,
    docId: input.request.docId,
    update,
    updateSha256,
    baseStateVector: input.request.stateVector,
  }
  return { ok: true, message, frame: JSON.stringify(message) }
}

/**
 * Creates the sync-request answer port used by the inbound WebSocket dispatcher.
 *
 * @param input Local identity, loaded YDoc registry, active session, and optional rejection observer.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.answerSyncRequest`.
 */
export function createSyncRuntimeWebSocketSyncRequestAnswerPort(
  input: SyncRuntimeWebSocketSyncRequestAnswerPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'answerSyncRequest'> {
  return {
    async answerSyncRequest(request) {
      const plan = await planSyncRuntimeWebSocketSyncRequestAnswer({
        request,
        deviceId: input.deviceId,
        registry: input.registry,
      })
      if (!plan.ok) {
        await input.reject?.rejectSyncRequestAnswer(request, plan.reason)
        return
      }
      input.session.send(plan.frame)
    },
  }
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function encodeBase64Bytes(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function remoteUpdateYDocWrite(
  appliedState: SyncRuntimeWebSocketAppliedYDocState,
): SyncRuntimeWebSocketRemoteUpdateYDocWrite {
  const value = {
    docId: appliedState.docId,
    updateBytes: appliedState.updateBytes,
  }
  if (appliedState.docId.kind === 'meta') {
    return { kind: 'put', storeName: 'meta-ydoc', key: 'meta', value }
  }
  return { kind: 'put', storeName: 'file-ydocs', key: appliedState.docId.ydocId, value }
}

function remoteUpdateDocKey(docId: DocId): string {
  if (docId.kind === 'meta') {
    return 'meta'
  }
  return `file:${docId.ydocId}`
}

function queueRemoteUpdateYDocWrite(
  stores: SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts,
  write: SyncRuntimeWebSocketRemoteUpdateYDocWrite,
): LocalStoreIndexedDbRequest<IDBValidKey> {
  if (write.storeName === 'meta-ydoc') {
    return stores.metaYDoc.put(write.value, write.key)
  }
  return stores.fileYDocs.put(write.value, write.key)
}

async function waitForRemoteUpdateIndexedDbRequest<Result>(
  request: LocalStoreIndexedDbRequest<Result>,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function waitForRemoteUpdateIndexedDbTransaction(
  transaction: LocalStoreIndexedDbTransactionLifecycle,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

function outboxCompletionCandidateMatches(
  record: LocalStoreOutboxRecord,
  message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>,
): boolean {
  if (record.kind !== 'y-update') {
    return false
  }
  if (record.status !== 'pending' && record.status !== 'retrying') {
    return false
  }
  if (record.docId === undefined || !sameDocId(record.docId, message.docId)) {
    return false
  }
  if (message.type === 'ack') {
    return record.messageId === message.messageId
  }
  return record.messageId !== undefined
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta' || right.kind === 'meta') {
    return true
  }
  return left.ydocId === right.ydocId
}

/**
 * Connects one WebSocket connection to the guarded inbound control-message handler.
 *
 * @param socket Open or opening WebSocket connection.
 * @param handler Handler that receives parsed control messages or rejection reasons.
 */
export function attachSyncRuntimeWebSocketInboundMessageHandler(
  socket: SyncRuntimeWebSocketConnection,
  handler: SyncRuntimeWebSocketInboundMessageHandler,
): void {
  socket.onmessage = (event) => {
    handler(parseSyncRuntimeWebSocketMessage(event))
  }
}

/**
 * Creates the concrete startup WebSocket step port used by the Obsidian runtime.
 *
 * @param input Trusted local setup metadata, access-token reader, and WebSocket factory.
 * @returns A startup step port that opens the socket and sends the client hello in separate steps.
 */
export function createSyncRuntimeWebSocketStartupStepPort(
  input: SyncRuntimeWebSocketStepPortInput,
): SyncRuntimeWebSocketStartupStepPort {
  let socket: SyncRuntimeWebSocketConnection | undefined
  let connectionUrl: string | undefined
  let hello: ClientHello | undefined
  let pendingHelloAdmission:
    | {
        readonly resolve: () => void
        readonly reject: (error: Error) => void
      }
    | undefined

  return {
    async openWebSocket() {
      const accessToken = await input.tokenReader.getAccessToken(
        input.metadata.accessTokenSecretKey,
      )
      if (accessToken === undefined) {
        throw new Error('websocket-access-token-missing')
      }

      const url = buildSyncRuntimeWebSocketUrl({
        endpoint: input.metadata.setup.endpoint,
        vaultId: input.metadata.setup.vaultId,
      })
      connectionUrl = redactWebSocketUrlToken(url)
      socket = input.webSocket.connect(url, [...buildSyncRuntimeWebSocketProtocols(accessToken)])
      input.session?.attach(socket)
      attachSyncRuntimeWebSocketInboundMessageHandler(socket, (message) => {
        if (pendingHelloAdmission !== undefined) {
          const admission = planSyncRuntimeWebSocketHelloAdmission({
            inbound: message,
            metadata: input.metadata.setup,
          })
          if (admission.action === 'accepted') {
            const pending = pendingHelloAdmission
            pendingHelloAdmission = undefined
            pending.resolve()
            return
          }
          const pending = pendingHelloAdmission
          pendingHelloAdmission = undefined
          pending.reject(new Error(`websocket-hello-admission:${admission.reason}`))
          return
        }
        input.onInboundMessage?.(message)
      })
      await waitForWebSocketOpen(socket)
    },
    async sendClientHello(effect) {
      if (socket === undefined || socket.readyState !== OPEN_READY_STATE) {
        throw new Error('websocket-not-open')
      }
      hello = clientHelloFromStartupEffect({
        effect,
        metadata: input.metadata.setup,
        capabilities: input.capabilities,
      })
      const admission = waitForHelloAccepted(
        socket,
        (pending) => {
          pendingHelloAdmission = pending
        },
        () => {
          pendingHelloAdmission = undefined
        },
      )
      socket.send(JSON.stringify(hello))
      await admission
    },
    snapshot() {
      return {
        connectionUrl,
        hello,
        socketReadyState: socket?.readyState,
      }
    },
  }
}

async function waitForHelloAccepted(
  socket: SyncRuntimeWebSocketConnection,
  install: (pending: {
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }) => void,
  clear: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    install({
      resolve() {
        clear()
        resolve()
      },
      reject(error) {
        clear()
        reject(error)
      },
    })
    socket.onerror = () => {
      clear()
      reject(new Error('websocket-hello-admission-failed'))
    }
    socket.onclose = () => {
      clear()
      reject(new Error('websocket-closed-before-hello-accepted'))
    }
  })
}

function redactWebSocketUrlToken(value: string): string {
  const url = new URL(value)
  if (url.searchParams.has('access_token')) {
    url.searchParams.set('access_token', '<redacted>')
  }
  return url.toString()
}

function clientHelloFromStartupEffect(input: {
  readonly effect: SyncRuntimeStartupStepEffect<'send-client-hello'>
  readonly metadata: LocalSetupMetadata
  readonly capabilities?: readonly ClientCapability[] | undefined
}): ClientHello {
  if (input.effect.vaultId !== input.metadata.vaultId) {
    throw new Error('websocket-hello-vault-mismatch')
  }
  return {
    type: 'hello',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: input.metadata.vaultId,
    deviceId: input.metadata.deviceId,
    yClientId: input.metadata.yClientId,
    capabilities: [...(input.capabilities ?? ['binary-v1'])],
  }
}

async function waitForWebSocketOpen(socket: SyncRuntimeWebSocketConnection): Promise<void> {
  if (socket.readyState === OPEN_READY_STATE) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      resolve()
    }
    socket.onerror = () => {
      reject(new Error('websocket-open-failed'))
    }
    socket.onclose = () => {
      reject(new Error('websocket-closed-before-open'))
    }
  })
}

class BrowserSyncRuntimeWebSocketConnection implements SyncRuntimeWebSocketConnection {
  private openHandler: ((event: Event) => void) | null = null
  private errorHandler: ((event: Event) => void) | null = null
  private closeHandler: ((event: CloseEvent) => void) | null = null
  private messageHandler: ((event: MessageEvent) => void) | null = null

  constructor(private readonly socket: WebSocket) {
    socket.onopen = (event) => {
      this.openHandler?.(event)
    }
    socket.onerror = (event) => {
      this.errorHandler?.(event)
    }
    socket.onclose = (event) => {
      this.closeHandler?.(event)
    }
    socket.onmessage = (event) => {
      this.messageHandler?.(event)
    }
  }

  get readyState(): number {
    return this.socket.readyState
  }

  get onopen(): ((event: Event) => void) | null {
    return this.openHandler
  }

  set onopen(handler: ((event: Event) => void) | null) {
    this.openHandler = handler
  }

  get onerror(): ((event: Event) => void) | null {
    return this.errorHandler
  }

  set onerror(handler: ((event: Event) => void) | null) {
    this.errorHandler = handler
  }

  get onclose(): ((event: CloseEvent) => void) | null {
    return this.closeHandler
  }

  set onclose(handler: ((event: CloseEvent) => void) | null) {
    this.closeHandler = handler
  }

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.messageHandler
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this.messageHandler = handler
  }

  send(data: string | ArrayBuffer): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }
}
