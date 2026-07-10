import { parseControlMessage, type ControlMessage, type DocId } from '@kuroflare/core'

import {
  type SyncRuntimeWebSocketConnection,
  type SyncRuntimeWebSocketHelloAdmissionInput,
  type SyncRuntimeWebSocketHelloAdmissionPlan,
  type SyncRuntimeWebSocketInboundDispatchInput,
  type SyncRuntimeWebSocketInboundDispatchResult,
  type SyncRuntimeWebSocketInboundMessage,
  type SyncRuntimeWebSocketInboundMessageHandler,
  type SyncRuntimeWebSocketInboundRoute,
  type SyncRuntimeWebSocketInboundRouteInput,
} from '../../engine/websocket.types'
import { type LocalStoreOutboxRecord } from '../../store/store'

/**
 * Parses one inbound WebSocket message before it reaches sync runtime decisions.
 *
 * @param event Browser WebSocket message event.
 * @returns Guarded control message, or a rejection reason for unsupported payloads.
 */
export function parseSyncRuntimeWebSocketMessage(
  event: MessageEvent,
): SyncRuntimeWebSocketInboundMessage {
  if (typeof event.data !== 'string') {
    return { ok: false, reason: 'unsupported-binary-message' }
  }
  const message = parseControlMessage(event.data)
  if (message === null) {
    return { ok: false, reason: 'invalid-control-message' }
  }
  return { ok: true, message }
}

/**
 * Routes a guarded inbound WebSocket message to the next local runtime boundary.
 *
 * @param input Parsed inbound message plus the trusted local vault and device identity.
 * @returns The local boundary that should handle the message, or a safe drop reason.
 */
export function planSyncRuntimeWebSocketInboundRoute(
  input: SyncRuntimeWebSocketInboundRouteInput,
): SyncRuntimeWebSocketInboundRoute {
  if (!input.inbound.ok) {
    return { action: 'drop', reason: input.inbound.reason }
  }

  const message = input.inbound.message
  if (message.vaultId !== input.vaultId) {
    return { action: 'drop', reason: 'vault-mismatch' }
  }

  switch (message.type) {
    case 'ack':
    case 'need-full-snapshot':
      if (message.deviceId !== input.deviceId) {
        return { action: 'drop', reason: 'device-mismatch' }
      }
      return { action: 'outbox-completion', message }
    case 'sync-update':
      if (
        message.deviceId === input.deviceId &&
        !(input.pendingSyncRequestMessageIds?.has(message.messageId) ?? false)
      ) {
        return { action: 'drop', reason: 'self-broadcast' }
      }
      return { action: 'apply-remote-update', message }
    case 'sync-request':
      if (message.deviceId === input.deviceId) {
        return { action: 'drop', reason: 'self-broadcast' }
      }
      return { action: 'answer-sync-request', message }
    case 'hello':
      return { action: 'drop', reason: 'unexpected-server-hello' }
    case 'hello-accepted':
      return { action: 'drop', reason: 'unexpected-hello-accepted' }
  }
}

/**
 * Validates the server response that proves ClientHello admission succeeded.
 *
 * @param input Parsed inbound message plus trusted local setup metadata.
 * @returns Accepted admission evidence, or a non-secret rejection reason.
 */
export function planSyncRuntimeWebSocketHelloAdmission(
  input: SyncRuntimeWebSocketHelloAdmissionInput,
): SyncRuntimeWebSocketHelloAdmissionPlan {
  if (!input.inbound.ok) {
    return { action: 'reject', reason: input.inbound.reason }
  }
  const message = input.inbound.message
  if (message.type !== 'hello-accepted') {
    return { action: 'reject', reason: 'unexpected-message' }
  }
  if (message.vaultId !== input.metadata.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (message.deviceId !== input.metadata.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (message.yClientId !== input.metadata.yClientId) {
    return { action: 'reject', reason: 'y-client-id-mismatch' }
  }
  return { action: 'accepted', message }
}

/**
 * Dispatches one guarded inbound WebSocket message to the runtime port selected by routing.
 *
 * @param input Guarded inbound message, trusted local identity, and side-effect ports.
 * @returns The route that was executed.
 */
export async function dispatchSyncRuntimeWebSocketInboundMessage(
  input: SyncRuntimeWebSocketInboundDispatchInput,
): Promise<SyncRuntimeWebSocketInboundDispatchResult> {
  const route = planSyncRuntimeWebSocketInboundRoute(input)
  switch (route.action) {
    case 'outbox-completion':
      await input.ports.completeOutbox(route.message)
      break
    case 'apply-remote-update':
      await input.ports.applyRemoteUpdate(route.message)
      break
    case 'answer-sync-request':
      await input.ports.answerSyncRequest(route.message)
      break
    case 'drop':
      await input.ports.drop(route)
      break
  }
  return { route }
}

/**
 * Connects one WebSocket connection to the guarded inbound control-message handler.
 *
 * @param socket Open or opening WebSocket connection.
 * @param handler Handler that receives parsed control messages or rejection reasons.
 */
export function attachSyncRuntimeWebSocketInboundMessageHandler(
  socket: SyncRuntimeWebSocketConnection,
  handler: SyncRuntimeWebSocketInboundMessageHandler,
): void {
  socket.onmessage = (event) => {
    handler(parseSyncRuntimeWebSocketMessage(event))
  }
}

export function outboxCompletionCandidateMatches(
  record: LocalStoreOutboxRecord,
  message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>,
): boolean {
  // `meta-ref-update` items (the DAG-scheduled meta write after a binary upload's
  // blob-put/manifest-put chain) go over the wire as the same sync-update frame as
  // `y-update` and must be completable by the same ack, or their lease never
  // releases and permanently starves the single-slot `sync-control` concurrency lane.
  if (record.kind !== 'y-update' && record.kind !== 'meta-ref-update') {
    return false
  }
  if (record.status !== 'pending' && record.status !== 'retrying') {
    return false
  }
  if (record.docId === undefined || !sameDocId(record.docId, message.docId)) {
    return false
  }
  if (message.type === 'ack') {
    return record.messageId === message.messageId
  }
  return record.messageId !== undefined
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta' || right.kind === 'meta') {
    return true
  }
  return left.ydocId === right.ydocId
}
