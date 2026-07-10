import {
  CURRENT_PROTOCOL_VERSION,
  hashBytesSha256,
  makeSha256Hex,
  type SyncUpdate,
} from '@kuroflare/core'
import * as Y from 'yjs'

import {
  type SyncRuntimeWebSocketInboundRoutePorts,
  type SyncRuntimeWebSocketSyncRequestAnswerInput,
  type SyncRuntimeWebSocketSyncRequestAnswerPlan,
  type SyncRuntimeWebSocketSyncRequestAnswerPortInput,
} from '../../engine/websocket.types'
import { decodeBase64Bytes, encodeBase64Bytes } from './remote-update'

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
