import { type DeviceId, type DocId, type SyncRequest, type SyncUpdate } from '@kuroflare/core'
import type * as Y from 'yjs'

import { type SyncRuntimeWebSocketStepPort } from '../../engine/actuation.types'
import { type SyncRuntimeWebSocketStepPortState } from './connection'
import { type SyncRuntimeWebSocketSessionPort } from './session'

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

/** WebSocket step port plus observable state for tests and lifecycle logging. */
export interface SyncRuntimeWebSocketStartupStepPort extends SyncRuntimeWebSocketStepPort {
  /** Returns current WebSocket startup state without exposing token material. */
  snapshot(): SyncRuntimeWebSocketStepPortState
}
