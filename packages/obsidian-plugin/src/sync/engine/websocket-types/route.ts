import {
  type ControlMessage,
  type DeviceId,
  type HelloAccepted,
  type MessageId,
  type VaultId,
} from '@kuroflare/core'

import { type LocalSetupMetadata } from '../../engine/setup'

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
  /**
   * Message IDs of sync-requests this device has sent and is still awaiting a
   * reply for. The server addresses a sync-request's direct reply using the
   * requesting device's own `deviceId` (see `decideSyncRequest`), which is
   * otherwise indistinguishable from the server re-broadcasting this device's
   * own past edit to a reconnected session, so a match here overrides the
   * self-broadcast drop.
   */
  readonly pendingSyncRequestMessageIds?: ReadonlySet<MessageId> | undefined
}

/** Local runtime route selected for one inbound WebSocket control message. */
export type SyncRuntimeWebSocketInboundRoute =
  | {
      readonly action: 'outbox-completion'
      readonly message: Extract<
        ControlMessage,
        { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
      >
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
  readonly metadata: LocalSetupMetadata
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
    message: Extract<
      ControlMessage,
      { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
    >,
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
  readonly pendingSyncRequestMessageIds?: ReadonlySet<MessageId> | undefined
  readonly ports: SyncRuntimeWebSocketInboundRoutePorts
}

/** Result of dispatching one inbound WebSocket message. */
export interface SyncRuntimeWebSocketInboundDispatchResult {
  readonly route: SyncRuntimeWebSocketInboundRoute
}

/** Handler invoked after one inbound WebSocket frame has crossed parser validation. */
export type SyncRuntimeWebSocketInboundMessageHandler = (
  message: SyncRuntimeWebSocketInboundMessage,
) => void | Promise<void>
