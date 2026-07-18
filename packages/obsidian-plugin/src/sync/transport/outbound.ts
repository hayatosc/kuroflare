import {
  CURRENT_PROTOCOL_VERSION,
  hashBytesSha256,
  makeSha256Hex,
  type AwarenessUpdate,
  type DeviceId,
  type DocId,
  type SyncRequest,
  type SyncUpdate,
  type VaultId,
} from '@kuroflare/core'
import * as Y from 'yjs'

import { type LocalStoreOutboxRecord } from '../store/store'
import { type SyncRuntimeWebSocketInboundRoutePorts } from './inbound'
import {
  decodeBase64Bytes,
  encodeBase64Bytes,
  type SyncRuntimeWebSocketYDocRegistryPort,
} from './remote-update'
import { type SyncRuntimeWebSocketSessionPort } from './socket'
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
 * Plans one outbound sync-request control frame from local state-vector evidence.
 *
 * @param input Trusted local identity, target document, and encoded Yjs state vector source.
 * @returns Serialized sync-request frame ready for WebSocket I/O.
 */
export function planSyncRuntimeWebSocketSyncRequestSend(
  input: SyncRuntimeWebSocketSyncRequestSendInput,
): SyncRuntimeWebSocketSyncRequestSendPlan {
  const message: SyncRequest = {
    type: 'sync-request',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    messageId: input.messageId,
    docId: input.docId,
    stateVector: encodeBase64Bytes(input.stateVector),
  }
  return { ok: true, message, frame: JSON.stringify(message) }
}

/**
 * Creates the outbound sync-request sender used by startup/resume state-vector exchange.
 *
 * @param input Shared active WebSocket session.
 * @returns Sender that serializes local document state vectors as sync-request frames.
 */
export function createSyncRuntimeWebSocketSyncRequestSendPort(
  input: SyncRuntimeWebSocketSyncRequestSendPortInput,
): SyncRuntimeWebSocketSyncRequestSendPort {
  return {
    async sendSyncRequest(sendInput) {
      const plan = planSyncRuntimeWebSocketSyncRequestSend(sendInput)
      input.session.send(plan.frame)
      return plan
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

const OPEN_READY_STATE = 1

/**
 * Plans one outbound awareness-update control frame from a local presence change.
 *
 * @param input Trusted local identity, target document, and the changed presence state.
 * @returns Serialized awareness-update frame.
 */
export function planSyncRuntimeWebSocketAwarenessSend(
  input: SyncRuntimeWebSocketAwarenessSendInput,
): SyncRuntimeWebSocketAwarenessSendPlan {
  const message: AwarenessUpdate = {
    type: 'awareness-update',
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    clientId: input.clientId,
    state: input.state,
  }
  return { message, frame: JSON.stringify(message) }
}

/**
 * Creates the outbound awareness-update sender used by local presence changes.
 *
 * @param input Shared active WebSocket session.
 * @returns Port that silently drops the update when no session is open.
 */
export function createSyncRuntimeWebSocketAwarenessSendPort(
  input: SyncRuntimeWebSocketAwarenessSendPortInput,
): SyncRuntimeWebSocketAwarenessSendPort {
  return {
    sendAwarenessUpdate(sendInput) {
      const snapshot = input.session.snapshot()
      if (!snapshot.hasConnection || snapshot.readyState !== OPEN_READY_STATE) return
      input.session.send(planSyncRuntimeWebSocketAwarenessSend(sendInput).frame)
    },
  }
}
