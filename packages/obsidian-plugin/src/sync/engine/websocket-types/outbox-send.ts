import {
  type DeviceId,
  type DocId,
  type SyncRequest,
  type SyncUpdate,
  type VaultId,
} from '@kuroflare/core'

import { type LocalStoreOutboxRecord } from '../../store/store'
import { type SyncRuntimeWebSocketSessionPort } from './session'

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

/** Input for planning one outbound sync-request WebSocket frame from local YDoc state. */
export interface SyncRuntimeWebSocketSyncRequestSendInput {
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly messageId: SyncRequest['messageId']
  readonly docId: DocId
  readonly stateVector: Uint8Array
}

/** Result of turning local state-vector evidence into one sync-request frame. */
export interface SyncRuntimeWebSocketSyncRequestSendPlan {
  readonly ok: true
  readonly message: SyncRequest
  readonly frame: string
}

/** Input for creating an outbound sync-request WebSocket sender. */
export interface SyncRuntimeWebSocketSyncRequestSendPortInput {
  readonly session: SyncRuntimeWebSocketSessionPort
}

/** Port used by startup/resume runtime code to request peer sync state. */
export interface SyncRuntimeWebSocketSyncRequestSendPort {
  /** Sends one sync-request control frame for the given document state vector. */
  sendSyncRequest(
    input: SyncRuntimeWebSocketSyncRequestSendInput,
  ): Promise<SyncRuntimeWebSocketSyncRequestSendPlan>
}
