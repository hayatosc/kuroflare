import type { AwarenessUpdate } from '@kuroflare/core'

import {
  broadcast,
  messageMatchesSession,
  readAwarenessAttachment,
  readSession,
  rememberAwarenessAttachment,
} from './auth'
import type { RuntimeWebSocket } from './types'
import type { VaultRoom } from './vault-room'

/**
 * Broadcasts one awareness-update frame to every other authenticated socket in the vault.
 *
 * Awareness is never persisted by the Durable Object: this is a pure fan-out of the
 * sender's own presence state, gated only by the same session identity check every
 * other control message uses.
 */
export function handleAwarenessUpdate(
  room: VaultRoom,
  webSocket: RuntimeWebSocket,
  update: AwarenessUpdate,
): void {
  const session = readSession(room, webSocket)
  if (session === undefined) {
    webSocket.close(1008, 'hello-required')
    return
  }
  if (!messageMatchesSession(session, update)) {
    webSocket.close(1008, 'session-mismatch')
    return
  }
  rememberAwarenessAttachment(room, webSocket, { docId: update.docId, clientId: update.clientId })
  broadcast(room, webSocket, JSON.stringify(update))
}

/**
 * Broadcasts a synthetic `state: null` for the last presence a closing connection
 * advertised, so peers drop its remote cursor instead of keeping a stale one forever.
 */
export function broadcastAwarenessLeave(room: VaultRoom, webSocket: RuntimeWebSocket): void {
  const session = readSession(room, webSocket)
  const awareness = readAwarenessAttachment(room, webSocket)
  room.awarenessByWebSocket.delete(webSocket)
  if (session === undefined || awareness === undefined) return

  const leave: AwarenessUpdate = {
    type: 'awareness-update',
    vaultId: session.vaultId,
    deviceId: session.deviceId,
    docId: awareness.docId,
    clientId: awareness.clientId,
    state: null,
  }
  broadcast(room, webSocket, JSON.stringify(leave))
}
