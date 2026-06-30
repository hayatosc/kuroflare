export * from '../engine/websocket.types'

import { hashBytesSha256 } from '@kuroflare/core'
import {
  CURRENT_PROTOCOL_VERSION,
  makeSha256Hex,
  parseControlMessage,
  type ClientCapability,
  type ClientHello,
  type ControlMessage,
  type DocId,
  type SyncUpdate,
} from '@kuroflare/core'
import * as Y from 'yjs'

import { type SyncRuntimeStartupStepEffect } from '../engine/actuation'
import { type LocalSetupMetadata } from '../engine/setup'
import { planOutboxWorkerAckCompletion } from '../engine/worker'
import {
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionLifecycle,
} from '../store/indexeddb'
import { type LocalStoreOutboxRecord } from '../store/store'

const OPEN_READY_STATE = 1

import {
  type SyncRuntimeWebSocketConnection,
  type SyncRuntimeWebSocketFactoryPort,
  type SyncRuntimeBrowserWebSocketConstructor,
  type SyncRuntimeWebSocketUrlInput,
  type SyncRuntimeWebSocketStepPortInput,
  type SyncRuntimeWebSocketInboundMessage,
  type SyncRuntimeWebSocketInboundRouteInput,
  type SyncRuntimeWebSocketInboundRoute,
  type SyncRuntimeWebSocketHelloAdmissionInput,
  type SyncRuntimeWebSocketHelloAdmissionPlan,
  type SyncRuntimeWebSocketInboundRoutePorts,
  type SyncRuntimeWebSocketInboundDispatchInput,
  type SyncRuntimeWebSocketInboundDispatchResult,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketOutboxCompletionInput,
  type SyncRuntimeWebSocketOutboxCompletionPlan,
  type SyncRuntimeWebSocketOutboxCompletionPortInput,
  type SyncRuntimeWebSocketOutboxSendInput,
  type SyncRuntimeWebSocketOutboxSendPlan,
  type SyncRuntimeWebSocketOutboxSendPortInput,
  type SyncRuntimeWebSocketOutboxSendPort,
  type SyncRuntimeWebSocketAppliedYDocState,
  type SyncRuntimeWebSocketRemoteUpdateCommitInput,
  type SyncRuntimeWebSocketRemoteUpdateDecodePlan,
  type SyncRuntimeWebSocketRemoteUpdateYDocApplyPort,
  type SyncRuntimeWebSocketRemoteUpdateCommitPort,
  type SyncRuntimeWebSocketRemoteUpdateYDocWrite,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
  type SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput,
  type SyncRuntimeWebSocketRemoteUpdateApplyPortInput,
  type SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput,
  type SyncRuntimeWebSocketSyncRequestAnswerInput,
  type SyncRuntimeWebSocketSyncRequestAnswerPlan,
  type SyncRuntimeWebSocketSyncRequestAnswerPortInput,
  type SyncRuntimeWebSocketInboundMessageHandler,
  type SyncRuntimeWebSocketStartupStepPort,
} from '../engine/websocket.types'

/**
 * Builds the browser-compatible worker WebSocket URL for one vault.
 *
 * @param input Worker HTTP endpoint and vault id.
 * @returns `ws:` or `wss:` URL under `/ws/:vaultId`.
 * @throws When the endpoint is not an HTTP(S) URL.
 */
export function buildSyncRuntimeWebSocketUrl(input: SyncRuntimeWebSocketUrlInput): string {
  const url = new URL(input.endpoint)
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else {
    throw new Error('websocket-endpoint-invalid')
  }
  url.pathname = `/ws/${encodeURIComponent(input.vaultId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Builds browser WebSocket subprotocols carrying the short-lived device access token.
 *
 * @param accessToken Compact JWT device access token.
 * @returns Protocol list accepted by the worker WebSocket upgrade path.
 */
export function buildSyncRuntimeWebSocketProtocols(accessToken: string): readonly string[] {
  return ['kuroflare.v1', `kuroflare-token.${accessToken}`]
}

/**
 * Creates a WebSocket factory backed by the browser runtime.
 *
 * @param WebSocketCtor Browser or Electron WebSocket constructor.
 * @returns Factory compatible with the startup WebSocket step port.
 */
export function createBrowserSyncRuntimeWebSocketFactory(
  WebSocketCtor: SyncRuntimeBrowserWebSocketConstructor,
): SyncRuntimeWebSocketFactoryPort {
  return {
    connect(url, protocols) {
      return new BrowserSyncRuntimeWebSocketConnection(new WebSocketCtor(url, protocols))
    },
  }
}

/**
 * Creates a shared active WebSocket session used by startup and background sync ports.
 *
 * @returns Mutable session boundary that hides the concrete socket from composition code.
 */
export function createSyncRuntimeWebSocketSession(): SyncRuntimeWebSocketSessionPort {
  let connection: SyncRuntimeWebSocketConnection | undefined

  return {
    attach(nextConnection) {
      connection = nextConnection
    },
    send(data) {
      if (connection === undefined) {
        throw new Error('websocket-session-missing')
      }
      if (connection.readyState !== OPEN_READY_STATE) {
        throw new Error('websocket-session-not-open')
      }
      connection.send(data)
    },
    close(code, reason) {
      connection?.close(code, reason)
      connection = undefined
    },
    snapshot() {
      return {
        hasConnection: connection !== undefined,
        readyState: connection?.readyState,
      }
    },
  }
}

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
      if (message.deviceId === input.deviceId) {
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
 * Plans how an inbound ack-like WebSocket message completes a local outbox item.
 *
 * @param input Guarded server message, owner identity, clock, and current local-store snapshot.
 * @returns Successful completion plan, or a precise reason the message cannot mutate local state.
 */
export function planSyncRuntimeWebSocketOutboxCompletion(
  input: SyncRuntimeWebSocketOutboxCompletionInput,
): SyncRuntimeWebSocketOutboxCompletionPlan {
  const candidates = input.snapshot.outboxRecords.filter((record) =>
    outboxCompletionCandidateMatches(record, input.message),
  )
  if (candidates.length === 0) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates }
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous-matching-outbox-record', candidates }
  }

  const record = candidates[0]
  if (record === undefined) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates }
  }
  const messageId = record.messageId
  if (messageId === undefined) {
    return { ok: false, reason: 'matching-outbox-record-not-found', candidates: [] }
  }
  const completion = planOutboxWorkerAckCompletion({
    itemId: record.id,
    status: record.status,
    vaultId: input.message.vaultId,
    deviceId: input.message.deviceId,
    docId: input.message.docId,
    messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
    ownerId: input.ownerId,
    now: input.now,
    currentOutboxRecords: input.snapshot.outboxRecords,
    currentLeaseRows: input.snapshot.leaseRows,
  })
  if (!completion.ok) {
    return { ok: false, reason: completion.reason, candidates, completion }
  }

  return { ok: true, record, completion }
}

/**
 * Creates the inbound outbox-completion port used by the WebSocket dispatcher.
 *
 * @param input Snapshot reader, durable committer, owner identity, and clock.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.completeOutbox`.
 */
export function createSyncRuntimeWebSocketOutboxCompletionPort(
  input: SyncRuntimeWebSocketOutboxCompletionPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'completeOutbox'> {
  return {
    async completeOutbox(message) {
      const plan = planSyncRuntimeWebSocketOutboxCompletion({
        message,
        ownerId: input.ownerId,
        now: input.now(),
        snapshot: await input.snapshot.read(),
        minDurableSeqExclusive: input.minDurableSeqExclusive,
      })
      if (!plan.ok) {
        return
      }
      await input.commit.commit(plan.completion)
    },
  }
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
 * Decodes and verifies one peer sync-update before local YDoc mutation.
 *
 * @param message Guarded peer sync-update message.
 * @returns Decoded bytes with a verified SHA-256 hash, or a rejection reason.
 */
export async function decodeSyncRuntimeWebSocketRemoteUpdate(
  message: SyncUpdate,
): Promise<SyncRuntimeWebSocketRemoteUpdateDecodePlan> {
  if (message.updateSha256 === undefined) {
    return { ok: false, reason: 'missing-update-sha256' }
  }
  if (message.durableSeq === undefined) {
    return { ok: false, reason: 'missing-durable-seq' }
  }
  const updateBytes = decodeBase64Bytes(message.update)
  if (updateBytes === null) {
    return { ok: false, reason: 'invalid-base64' }
  }
  const actualUpdateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  if (actualUpdateSha256 !== message.updateSha256) {
    return { ok: false, reason: 'hash-mismatch' }
  }
  return {
    ok: true,
    apply: {
      message,
      updateBytes,
      actualUpdateSha256,
    },
  }
}

/**
 * Creates the peer sync-update apply port used by the inbound WebSocket dispatcher.
 *
 * @param input In-memory YDoc apply port, durable commit port, and optional rejection observer.
 * @returns Port implementation for `SyncRuntimeWebSocketInboundRoutePorts.applyRemoteUpdate`.
 */
export function createSyncRuntimeWebSocketRemoteUpdateApplyPort(
  input: SyncRuntimeWebSocketRemoteUpdateApplyPortInput,
): Pick<SyncRuntimeWebSocketInboundRoutePorts, 'applyRemoteUpdate'> {
  return {
    async applyRemoteUpdate(message) {
      const decoded = await decodeSyncRuntimeWebSocketRemoteUpdate(message)
      if (!decoded.ok) {
        await input.reject?.rejectRemoteUpdate(message, decoded.reason)
        return
      }
      const appliedState = await input.ydoc.applyRemoteUpdate(decoded.apply)
      await input.commit.commitRemoteUpdate({ ...decoded.apply, appliedState })
    },
  }
}

/**
 * Creates a concrete Yjs apply port for verified peer sync updates.
 *
 * @param input Registry of loaded YDocs and optional transaction origin.
 * @returns Apply port that mutates the matching YDoc and returns durable state evidence.
 */
export function createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort(
  input: SyncRuntimeWebSocketYjsRemoteUpdateApplyPortInput,
): SyncRuntimeWebSocketRemoteUpdateYDocApplyPort {
  return {
    async applyRemoteUpdate(applyInput) {
      const doc = input.registry.getYDoc(applyInput.message.docId)
      if (doc === undefined) {
        throw new Error('remote-update-ydoc-not-loaded')
      }
      Y.applyUpdate(doc, applyInput.updateBytes, input.origin)
      return {
        docId: applyInput.message.docId,
        updateBytes: Y.encodeStateAsUpdate(doc),
        stateVectorBase64: encodeBase64Bytes(Y.encodeStateVector(doc)),
      }
    },
  }
}

/**
 * Plans the IndexedDB writes needed after applying one peer update to a local YDoc.
 *
 * @param input Guarded message, decoded update bytes, and applied local YDoc state.
 * @returns YDoc and remote cursor writes for one durable IndexedDB transaction.
 * @throws When the server did not provide a durable sequence.
 */
export function planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(
  input: SyncRuntimeWebSocketRemoteUpdateCommitInput,
): SyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction {
  const durableSeq = input.message.durableSeq
  if (durableSeq === undefined) {
    throw new Error('remote-update-durable-seq-missing')
  }
  return {
    kind: 'remote-update-apply',
    ydocWrite: remoteUpdateYDocWrite(input.appliedState),
    remoteCursorWrite: {
      kind: 'put',
      storeName: 'remote-cursors',
      key: remoteUpdateDocKey(input.message.docId),
      value: {
        docId: input.message.docId,
        remoteCursorSeq: durableSeq,
        stateVectorBase64: input.appliedState.stateVectorBase64,
      },
    },
  }
}

/**
 * Creates a remote update commit database port from a concrete IndexedDB database.
 *
 * @param database Open IndexedDB database containing YDoc and remote cursor stores.
 * @returns Database port that opens one readwrite transaction for peer update commits.
 */
export function createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort(
  database: IDBDatabase,
): SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort {
  return {
    openRemoteUpdateCommitTransaction() {
      const transaction = database.transaction(
        ['meta-ydoc', 'file-ydocs', 'remote-cursors'],
        'readwrite',
      )
      return {
        stores: {
          metaYDoc: transaction.objectStore('meta-ydoc'),
          fileYDocs: transaction.objectStore('file-ydocs'),
          remoteCursors: transaction.objectStore('remote-cursors'),
        },
        lifecycle: transaction,
      }
    },
  }
}

/**
 * Commits a peer update apply plan as one IndexedDB transaction.
 *
 * @param input Planned remote update transaction and database transaction opener.
 * @returns Resolves after YDoc state and remote cursor writes are durable.
 * @throws When a write request rejects or the IndexedDB transaction aborts/errors.
 */
export async function commitSyncRuntimeWebSocketRemoteUpdateIndexedDbTransaction(
  input: SyncRuntimeWebSocketRemoteUpdateIndexedDbCommitInput,
): Promise<void> {
  const transaction = input.database.openRemoteUpdateCommitTransaction()
  const ydocRequest = queueRemoteUpdateYDocWrite(transaction.stores, input.transaction.ydocWrite)
  const cursorRequest = transaction.stores.remoteCursors.put(
    input.transaction.remoteCursorWrite.value,
    input.transaction.remoteCursorWrite.key,
  )
  await Promise.all(
    [ydocRequest, cursorRequest].map((request) => waitForRemoteUpdateIndexedDbRequest(request)),
  )
  await waitForRemoteUpdateIndexedDbTransaction(transaction.lifecycle)
}

/**
 * Creates a durable commit port for peer updates backed by IndexedDB.
 *
 * @param database Database transaction opener for YDoc and remote cursor stores.
 * @returns Commit port compatible with the inbound remote update apply port.
 */
export function createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(
  database: SyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
): SyncRuntimeWebSocketRemoteUpdateCommitPort {
  return {
    async commitRemoteUpdate(input) {
      await commitSyncRuntimeWebSocketRemoteUpdateIndexedDbTransaction({
        database,
        transaction: planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction(input),
      })
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

function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function encodeBase64Bytes(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function remoteUpdateYDocWrite(
  appliedState: SyncRuntimeWebSocketAppliedYDocState,
): SyncRuntimeWebSocketRemoteUpdateYDocWrite {
  const value = {
    docId: appliedState.docId,
    updateBytes: appliedState.updateBytes,
  }
  if (appliedState.docId.kind === 'meta') {
    return { kind: 'put', storeName: 'meta-ydoc', key: 'meta', value }
  }
  return { kind: 'put', storeName: 'file-ydocs', key: appliedState.docId.ydocId, value }
}

function remoteUpdateDocKey(docId: DocId): string {
  if (docId.kind === 'meta') {
    return 'meta'
  }
  return `file:${docId.ydocId}`
}

function queueRemoteUpdateYDocWrite(
  stores: SyncRuntimeWebSocketRemoteUpdateIndexedDbObjectStorePorts,
  write: SyncRuntimeWebSocketRemoteUpdateYDocWrite,
): LocalStoreIndexedDbRequest<IDBValidKey> {
  if (write.storeName === 'meta-ydoc') {
    return stores.metaYDoc.put(write.value, write.key)
  }
  return stores.fileYDocs.put(write.value, write.key)
}

async function waitForRemoteUpdateIndexedDbRequest<Result>(
  request: LocalStoreIndexedDbRequest<Result>,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function waitForRemoteUpdateIndexedDbTransaction(
  transaction: LocalStoreIndexedDbTransactionLifecycle,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

function outboxCompletionCandidateMatches(
  record: LocalStoreOutboxRecord,
  message: Extract<ControlMessage, { readonly type: 'ack' | 'need-full-snapshot' }>,
): boolean {
  if (record.kind !== 'y-update') {
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

/**
 * Creates the concrete startup WebSocket step port used by the Obsidian runtime.
 *
 * @param input Trusted local setup metadata, access-token reader, and WebSocket factory.
 * @returns A startup step port that opens the socket and sends the client hello in separate steps.
 */
export function createSyncRuntimeWebSocketStartupStepPort(
  input: SyncRuntimeWebSocketStepPortInput,
): SyncRuntimeWebSocketStartupStepPort {
  let socket: SyncRuntimeWebSocketConnection | undefined
  let connectionUrl: string | undefined
  let hello: ClientHello | undefined
  let pendingHelloAdmission:
    | {
        readonly resolve: () => void
        readonly reject: (error: Error) => void
      }
    | undefined

  return {
    async openWebSocket() {
      const accessToken = await input.tokenReader.getAccessToken(
        input.metadata.accessTokenSecretKey,
      )
      if (accessToken === undefined) {
        throw new Error('websocket-access-token-missing')
      }

      const url = buildSyncRuntimeWebSocketUrl({
        endpoint: input.metadata.setup.endpoint,
        vaultId: input.metadata.setup.vaultId,
      })
      connectionUrl = redactWebSocketUrlToken(url)
      socket = input.webSocket.connect(url, [...buildSyncRuntimeWebSocketProtocols(accessToken)])
      input.session?.attach(socket)
      attachSyncRuntimeWebSocketInboundMessageHandler(socket, (message) => {
        if (pendingHelloAdmission !== undefined) {
          const admission = planSyncRuntimeWebSocketHelloAdmission({
            inbound: message,
            metadata: input.metadata.setup,
          })
          if (admission.action === 'accepted') {
            const pending = pendingHelloAdmission
            pendingHelloAdmission = undefined
            pending.resolve()
            return
          }
          const pending = pendingHelloAdmission
          pendingHelloAdmission = undefined
          pending.reject(new Error(`websocket-hello-admission:${admission.reason}`))
          return
        }
        input.onInboundMessage?.(message)
      })
      await waitForWebSocketOpen(socket)
    },
    async sendClientHello(effect) {
      if (socket === undefined || socket.readyState !== OPEN_READY_STATE) {
        throw new Error('websocket-not-open')
      }
      hello = clientHelloFromStartupEffect({
        effect,
        metadata: input.metadata.setup,
        capabilities: input.capabilities,
      })
      const admission = waitForHelloAccepted(
        socket,
        (pending) => {
          pendingHelloAdmission = pending
        },
        () => {
          pendingHelloAdmission = undefined
        },
      )
      socket.send(JSON.stringify(hello))
      await admission
    },
    snapshot() {
      return {
        connectionUrl,
        hello,
        socketReadyState: socket?.readyState,
      }
    },
  }
}

async function waitForHelloAccepted(
  socket: SyncRuntimeWebSocketConnection,
  install: (pending: {
    readonly resolve: () => void
    readonly reject: (error: Error) => void
  }) => void,
  clear: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    install({
      resolve() {
        clear()
        resolve()
      },
      reject(error) {
        clear()
        reject(error)
      },
    })
    socket.onerror = () => {
      clear()
      reject(new Error('websocket-hello-admission-failed'))
    }
    socket.onclose = () => {
      clear()
      reject(new Error('websocket-closed-before-hello-accepted'))
    }
  })
}

function redactWebSocketUrlToken(value: string): string {
  const url = new URL(value)
  if (url.searchParams.has('access_token')) {
    url.searchParams.set('access_token', '<redacted>')
  }
  return url.toString()
}

function clientHelloFromStartupEffect(input: {
  readonly effect: SyncRuntimeStartupStepEffect<'send-client-hello'>
  readonly metadata: LocalSetupMetadata
  readonly capabilities?: readonly ClientCapability[] | undefined
}): ClientHello {
  if (input.effect.vaultId !== input.metadata.vaultId) {
    throw new Error('websocket-hello-vault-mismatch')
  }
  return {
    type: 'hello',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: input.metadata.vaultId,
    deviceId: input.metadata.deviceId,
    yClientId: input.metadata.yClientId,
    capabilities: [...(input.capabilities ?? ['binary-v1'])],
  }
}

async function waitForWebSocketOpen(socket: SyncRuntimeWebSocketConnection): Promise<void> {
  if (socket.readyState === OPEN_READY_STATE) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      resolve()
    }
    socket.onerror = () => {
      reject(new Error('websocket-open-failed'))
    }
    socket.onclose = () => {
      reject(new Error('websocket-closed-before-open'))
    }
  })
}

class BrowserSyncRuntimeWebSocketConnection implements SyncRuntimeWebSocketConnection {
  private openHandler: ((event: Event) => void) | null = null
  private errorHandler: ((event: Event) => void) | null = null
  private closeHandler: ((event: CloseEvent) => void) | null = null
  private messageHandler: ((event: MessageEvent) => void) | null = null

  constructor(private readonly socket: WebSocket) {
    socket.onopen = (event) => {
      this.openHandler?.(event)
    }
    socket.onerror = (event) => {
      this.errorHandler?.(event)
    }
    socket.onclose = (event) => {
      this.closeHandler?.(event)
    }
    socket.onmessage = (event) => {
      this.messageHandler?.(event)
    }
  }

  get readyState(): number {
    return this.socket.readyState
  }

  get onopen(): ((event: Event) => void) | null {
    return this.openHandler
  }

  set onopen(handler: ((event: Event) => void) | null) {
    this.openHandler = handler
  }

  get onerror(): ((event: Event) => void) | null {
    return this.errorHandler
  }

  set onerror(handler: ((event: Event) => void) | null) {
    this.errorHandler = handler
  }

  get onclose(): ((event: CloseEvent) => void) | null {
    return this.closeHandler
  }

  set onclose(handler: ((event: CloseEvent) => void) | null) {
    this.closeHandler = handler
  }

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.messageHandler
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this.messageHandler = handler
  }

  send(data: string | ArrayBuffer): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }
}
