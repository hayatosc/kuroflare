import { CURRENT_PROTOCOL_VERSION, type SyncRequest, type SyncUpdate } from '@kuroflare/core'

import {
  type SyncRuntimeWebSocketOutboxSendInput,
  type SyncRuntimeWebSocketOutboxSendPlan,
  type SyncRuntimeWebSocketOutboxSendPort,
  type SyncRuntimeWebSocketOutboxSendPortInput,
  type SyncRuntimeWebSocketSyncRequestSendInput,
  type SyncRuntimeWebSocketSyncRequestSendPlan,
  type SyncRuntimeWebSocketSyncRequestSendPort,
  type SyncRuntimeWebSocketSyncRequestSendPortInput,
} from '../../engine/websocket.types'
import { encodeBase64Bytes } from './remote-update'

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
