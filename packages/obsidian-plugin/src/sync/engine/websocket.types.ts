import {
  type ClientCapability,
  type ClientHello,
  type ControlMessage,
  type DeviceId,
  type DocId,
  type HelloAccepted,
  type SyncRequest,
  type SyncUpdate,
  type VaultId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import {
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'
import { type LocalStoreOutboxRecord } from '../store/store'
import { type OutboxWorkerCompletionPlan } from '../engine/worker'
import { type LocalSetupMetadata } from '../engine/setup'
import { type SyncRuntimeWebSocketStepPort } from '../engine/actuation.types'
import type * as Y from 'yjs'

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
  /** Commits an outbound queue completion or full-snapshot pause after a server response. */
  completeOutbox(
    message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>,
  ): Promise<void>
  /** Applies a peer update to the local YDoc and follow-up materialization pipeline. */
  applyRemoteUpdate(
    message: Extract<ControlMessage, { readonly type: 'sync-update' }>,
  ): Promise<void>
  /** Answers a peer state-vector request with a local update or full-snapshot response. */
  answerSyncRequest(
    message: Extract<ControlMessage, { readonly type: 'sync-request' }>,
  ): Promise<void>
  /** Observes dropped inbound messages without receiving token material or raw payloads. */
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
  /** Attaches the current WebSocket connection to the shared sync session. */
  attach(connection: SyncRuntimeWebSocketConnection): void
  /** Sends one frame over the active sync WebSocket. */
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
  /** Reads the current outbox records and running leases needed for completion planning. */
  read(): Promise<SyncRuntimeWebSocketOutboxCompletionSnapshot>
}

/** Port that durably commits a successful inbound outbox completion plan. */
export interface SyncRuntimeWebSocketOutboxCompletionCommitPort {
  /** Commits a successful completion plan to the local store. */
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
  /** Sends one local y-update or meta-ref-update record as a sync-update control frame. */
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
  /** Applies one verified peer update to the correct local YDoc. */
  applyRemoteUpdate(
    input: SyncRuntimeWebSocketRemoteUpdateApplyInput,
  ): Promise<SyncRuntimeWebSocketAppliedYDocState>
}

/** Port that records a successfully applied peer update durably. */
export interface SyncRuntimeWebSocketRemoteUpdateCommitPort {
  /** Persists cursor/update evidence after the in-memory YDoc apply succeeds. */
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
  /** Observes a rejected peer update without raw token material. */
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
  /** Returns the local YDoc for the given sync document. */
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
  /** Observes a sync-request answer rejection without raw token material. */
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
