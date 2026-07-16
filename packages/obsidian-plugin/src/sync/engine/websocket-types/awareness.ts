import { type AwarenessUpdate, type DeviceId, type DocId, type VaultId } from '@kuroflare/core'

import { type SyncRuntimeWebSocketSessionPort } from './session'

/** Minimal presence surface the WebSocket layer needs from `LocalAwareness`. */
export interface SyncRuntimeWebSocketAwarenessPort {
  /** Applies a peer's awareness state, or its removal when `state` is null. */
  applyRemoteState(clientId: number, state: Record<string, unknown> | null): void
}

/** Input for planning one outbound awareness-update WebSocket frame. */
export interface SyncRuntimeWebSocketAwarenessSendInput {
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly clientId: number
  readonly state: Record<string, unknown> | null
}

/** Result of turning a local awareness change into one outbound control frame. */
export interface SyncRuntimeWebSocketAwarenessSendPlan {
  readonly message: AwarenessUpdate
  readonly frame: string
}

/** Input for creating the outbound awareness-update WebSocket sender. */
export interface SyncRuntimeWebSocketAwarenessSendPortInput {
  readonly session: SyncRuntimeWebSocketSessionPort
}

/** Port used to broadcast local presence changes over the active WebSocket. */
export interface SyncRuntimeWebSocketAwarenessSendPort {
  /**
   * Sends one local awareness state change, silently doing nothing when no
   * WebSocket session is open. Presence is loss-tolerant ephemeral data, so a
   * missed broadcast while disconnected is not queued for retry (no outbox item).
   */
  sendAwarenessUpdate(input: SyncRuntimeWebSocketAwarenessSendInput): void
}

/** Input for creating the inbound awareness-update apply port. */
export interface SyncRuntimeWebSocketAwarenessApplyPortInput {
  readonly awareness: SyncRuntimeWebSocketAwarenessPort
}
