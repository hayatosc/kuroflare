import { type AwarenessUpdate } from '@kuroflare/core'

import {
  type SyncRuntimeWebSocketAwarenessApplyPortInput,
  type SyncRuntimeWebSocketAwarenessSendInput,
  type SyncRuntimeWebSocketAwarenessSendPlan,
  type SyncRuntimeWebSocketAwarenessSendPort,
  type SyncRuntimeWebSocketAwarenessSendPortInput,
  type SyncRuntimeWebSocketInboundRoutePorts,
} from '../../engine/websocket.types'

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

/**
 * Creates the inbound awareness-update apply port used by dispatch.
 *
 * @param input Local awareness instance to feed peer presence into.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.applyRemoteAwareness`.
 */
export function createSyncRuntimeWebSocketAwarenessApplyPort(
  input: SyncRuntimeWebSocketAwarenessApplyPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'applyRemoteAwareness'> {
  return {
    async applyRemoteAwareness(message) {
      input.awareness.applyRemoteState(message.clientId, message.state)
    },
  }
}
