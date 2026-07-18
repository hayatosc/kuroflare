import { makeSha256Hex, makeYDocId, type DocId, type MessageId } from '@kuroflare/core'
import * as Y from 'yjs'

import type { FileDocId } from '../main-types'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import {
  createSyncRuntimeWebSocketStartupStepPort,
  createBrowserSyncRuntimeWebSocketFactory,
  createSyncRuntimeWebSocketAwarenessApplyPort,
  createSyncRuntimeWebSocketAwarenessSendPort,
  createSyncRuntimeWebSocketSyncRequestSendPort,
  createSyncRuntimeWebSocketOutboxCompletionPort,
  createSyncRuntimeWebSocketRemoteUpdateApplyPort,
  createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort,
  createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort,
  createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
  createSyncRuntimeWebSocketSyncRequestAnswerPort,
  dispatchSyncRuntimeWebSocketInboundMessage,
  type SyncRuntimeWebSocketStartupStepPort,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketInboundMessage,
} from '../sync/engine/websocket'
import {
  commitLocalStoreIndexedDbDatabaseTransaction,
  createLocalStoreIndexedDbDatabasePort,
} from '../sync/store/indexeddb'
import { type LocalStoreOutboxRecord } from '../sync/store/store'
import {
  currentSetupMetadata,
  ensureUsableAccessToken,
  requireSetupMetadata,
  nextWorkerMessageId,
  sha256Hex,
  readAccessToken,
} from './auth'
import type { SetupMetadataSource } from './auth'
import { META_SYNC_DOC_ID, WORKER_ORIGIN } from './constants'
import { safeLogError, encodeBase64, accessTokenSecretKeyForSetup } from './helpers'
import { loadTextDoc, metaDocWritable, metadataWritesEnabled } from './meta'
import {
  recoverLeasedOutboxAfterWebSocketFailure,
  runOutboxWorkerTick,
  scheduleOutboxWorkerTick,
} from './outbox'
import type KuroflareSpikePlugin from './plugin'
import { openLocalStoreDatabase, putOutboxRecord, readOutboxWorkerSnapshot } from './store'

export async function sendDocUpdateToWorker(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  update: Uint8Array,
  reason: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  if (docId.kind === 'meta' && !metadataWritesEnabled(plugin)) return
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) {
    return
  }
  const messageId = nextWorkerMessageId(plugin)
  const updateSha256 = makeSha256Hex(await sha256Hex(plugin, update))
  const updateBytesBase64 = encodeBase64(update)

  const record: LocalStoreOutboxRecord = {
    id: messageId,
    kind: 'y-update',
    status: 'pending',
    dependsOn: [],
    nextAttemptAt: undefined,
    docId,
    messageId,
    updateSha256,
    updateBytesBase64,
    ...(docId.kind === 'meta' ? { metadataSchemaVersion: 2 as const } : {}),
    createdAt: Date.now(),
  } as LocalStoreOutboxRecord
  try {
    const db = await openLocalStoreDatabase(plugin, setup.vaultId)
    await putOutboxRecord(db, record)
  } catch (error: unknown) {
    console.error('[kuroflare] failed to persist outbound update before send', {
      reason,
      docId,
      messageId,
      error: safeLogError(error),
    })
    return
  }
  const socketState = plugin.workerWebSocketSession.snapshot().readyState
  if (socketState !== WebSocket.OPEN && socketState !== WebSocket.CONNECTING) {
    try {
      await openWorkerWebSocket(plugin)
    } catch (error: unknown) {
      console.warn('[kuroflare] failed to reconnect worker websocket for queued update', {
        reason,
        error: safeLogError(error),
      })
    }
  }
  void runOutboxWorkerTick(plugin, reason)
  scheduleOutboxWorkerTick(plugin, 250, `queued:${reason}`)
  console.info('[kuroflare] enqueued worker sync update', {
    reason,
    messageId,
    docId,
    bytes: update.byteLength,
  })
}

export async function sendCurrentYDocToWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const loaded = plugin.activeTextDoc
  if (loaded === null) return
  await sendDocUpdateToWorker(plugin, loaded.docId, Y.encodeStateAsUpdate(loaded.doc), reason)
}

export async function sendMetaDocToWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  await sendDocUpdateToWorker(
    plugin,
    META_SYNC_DOC_ID,
    Y.encodeStateAsUpdate(plugin.metaDoc),
    reason,
  )
}

/**
 * Broadcasts one local awareness state change over the worker WebSocket.
 *
 * Silently does nothing without an accepted hello or open connection: presence is
 * loss-tolerant ephemeral data, so a missed broadcast is never queued for retry.
 */
export function sendLocalAwarenessUpdate(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  clientId: number,
  state: Record<string, unknown> | null,
): void {
  if (!plugin.startupSideEffectGate.canSendNetwork() || !plugin.workerHelloAccepted) return
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) return
  createSyncRuntimeWebSocketAwarenessSendPort({
    session: plugin.workerWebSocketSession,
  }).sendAwarenessUpdate({
    vaultId: setup.vaultId,
    deviceId: setup.deviceId,
    docId,
    clientId,
    state,
  })
}

/**
 * Connects local awareness changes to the worker WebSocket for the plugin's lifetime.
 *
 * Presence is scoped to whichever document is active when the local state changes;
 * changes with no active file (e.g. before any editor is open) are dropped.
 */
export function wireLocalAwarenessBroadcast(plugin: KuroflareSpikePlugin): void {
  plugin.awareness.on('change', (change) => {
    const localId = plugin.awareness.doc.clientID
    if (
      !change.added.includes(localId) &&
      !change.updated.includes(localId) &&
      !change.removed.includes(localId)
    ) {
      return
    }
    const docId = plugin.activeTextDoc?.docId
    if (docId === undefined) return
    sendLocalAwarenessUpdate(plugin, docId, localId, plugin.awareness.getLocalState())
  })
}

interface WorkerDocRequestPlugin extends SetupMetadataSource {
  readonly startupSideEffectGate: {
    readonly canSendNetwork: () => boolean
  }
  readonly workerHelloAccepted: boolean
  readonly workerWebSocketSession: SyncRuntimeWebSocketSessionPort
  readonly pendingSyncRequestMessageIds: Set<MessageId>
  workerMessageCounter: number
}

export async function requestDocFromWorker(
  plugin: WorkerDocRequestPlugin,
  docId: DocId,
  stateVector: Uint8Array,
  reason: string,
): Promise<boolean> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return false
  if (
    !plugin.workerHelloAccepted ||
    plugin.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN
  ) {
    return false
  }
  const setup = requireSetupMetadata(plugin)
  const sender = createSyncRuntimeWebSocketSyncRequestSendPort({
    session: plugin.workerWebSocketSession,
  })
  const sent = await sender.sendSyncRequest({
    vaultId: setup.vaultId,
    deviceId: setup.deviceId,
    messageId: nextWorkerMessageId(plugin),
    docId,
    stateVector,
  })
  plugin.pendingSyncRequestMessageIds.add(sent.message.messageId)
  console.info('[kuroflare] requested worker sync state', {
    reason,
    messageId: sent.message.messageId,
    docId,
  })
  return true
}

export async function requestActiveFileFromWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const loaded = plugin.activeTextDoc
  if (loaded === null) return
  await requestDocFromWorker(plugin, loaded.docId, Y.encodeStateVector(loaded.doc), reason)
}

export async function requestMetaDocFromWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  await requestDocFromWorker(plugin, META_SYNC_DOC_ID, Y.encodeStateVector(plugin.metaDoc), reason)
}

export async function requestPendingRemoteTextFilesFromWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  for (const ydocId of plugin.pendingRemoteTextFiles.keys()) {
    const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(ydocId) }
    const loaded = await loadTextDoc(plugin, docId)
    await requestDocFromWorker(plugin, docId, Y.encodeStateVector(loaded.doc), reason)
  }
}

/** Runtime state needed to serialize one worker WebSocket open and hello sequence. */
export interface WorkerWebSocketOpenRuntime {
  readonly startupSideEffectGate: {
    readonly canSendNetwork: () => boolean
  }
  syncStoppedByAuth: string | null
  workerWebSocketOpenPromise: Promise<void> | null
  readonly workerWebSocketSession: SyncRuntimeWebSocketSessionPort
  workerWebSocketStartupPort: SyncRuntimeWebSocketStartupStepPort | null
  workerHelloAccepted: boolean
  metadataAccess: 'read-only' | 'read-write'
  readonly setup: LocalSetupMetadata
  readonly ensureUsableAccessToken: () => Promise<boolean>
  readonly createStartupPort: () => SyncRuntimeWebSocketStartupStepPort
  readonly shouldRetryLegacyMetadataCapability?: ((error: unknown) => boolean) | undefined
  readonly onLegacyMetadataCapabilityFallback?: (() => void) | undefined
}

/** Serializes a worker WebSocket open and hello sequence for a mutable runtime state. */
export async function openWorkerWebSocketRuntime(
  runtime: WorkerWebSocketOpenRuntime,
  sendHello: () => Promise<void>,
): Promise<void> {
  const inFlight = runtime.workerWebSocketOpenPromise
  if (inFlight !== null) {
    await inFlight
    return
  }
  const opening = (async () => {
    let fallbackAttempted = false
    while (true) {
      try {
        await openWorkerWebSocketOnce(runtime, sendHello)
        return
      } catch (error: unknown) {
        if (!fallbackAttempted && runtime.shouldRetryLegacyMetadataCapability?.(error) === true) {
          fallbackAttempted = true
          runtime.onLegacyMetadataCapabilityFallback?.()
          continue
        }
        throw error
      }
    }
  })()
  runtime.workerWebSocketOpenPromise = opening
  try {
    await opening
  } finally {
    if (runtime.workerWebSocketOpenPromise === opening) {
      runtime.workerWebSocketOpenPromise = null
    }
  }
}

export async function openWorkerWebSocket(
  plugin: KuroflareSpikePlugin,
  sendHello: (plugin: KuroflareSpikePlugin) => Promise<void> = sendWorkerHello,
): Promise<void> {
  const setup = requireSetupMetadata(plugin)
  const runtime: WorkerWebSocketOpenRuntime = {
    startupSideEffectGate: plugin.startupSideEffectGate,
    get syncStoppedByAuth() {
      return plugin.syncStoppedByAuth
    },
    get workerWebSocketOpenPromise() {
      return plugin.workerWebSocketOpenPromise
    },
    set workerWebSocketOpenPromise(value) {
      plugin.workerWebSocketOpenPromise = value
    },
    workerWebSocketSession: plugin.workerWebSocketSession,
    get workerWebSocketStartupPort() {
      return plugin.workerWebSocketStartupPort
    },
    set workerWebSocketStartupPort(value) {
      plugin.workerWebSocketStartupPort = value
    },
    get workerHelloAccepted() {
      return plugin.workerHelloAccepted
    },
    set workerHelloAccepted(value) {
      plugin.workerHelloAccepted = value
    },
    get metadataAccess() {
      return plugin.metadataAccess
    },
    set metadataAccess(value) {
      plugin.metadataAccess = value
    },
    setup,
    ensureUsableAccessToken: async () =>
      await ensureUsableAccessToken(plugin, async () => await openWorkerWebSocket(plugin)),
    createStartupPort: () => createWorkerWebSocketStartupPort(plugin),
    shouldRetryLegacyMetadataCapability: (error) =>
      isLegacyMetadataCapabilityError(error) &&
      plugin.metadataCapabilityAdvertised &&
      !plugin.metadataCapabilityFallbackAttempted,
    onLegacyMetadataCapabilityFallback: () => {
      plugin.metadataCapabilityFallbackAttempted = true
      plugin.metadataCapabilityAdvertised = false
      plugin.metadataAccess = 'read-only'
    },
  }
  await openWorkerWebSocketRuntime(runtime, async () => await sendHello(plugin))
}

async function openWorkerWebSocketOnce(
  runtime: WorkerWebSocketOpenRuntime,
  sendHello: () => Promise<void>,
): Promise<void> {
  if (!runtime.startupSideEffectGate.canSendNetwork()) return
  if (runtime.syncStoppedByAuth !== null) return
  const snapshot = runtime.workerWebSocketSession.snapshot()
  if (snapshot.readyState === WebSocket.OPEN && runtime.workerHelloAccepted) return
  runtime.metadataAccess = 'read-only'
  const usable = await runtime.ensureUsableAccessToken()
  if (!usable) {
    throw new Error('websocket-access-token-unusable')
  }
  if (!runtime.startupSideEffectGate.canSendNetwork()) return
  if (runtime.syncStoppedByAuth !== null) return
  runtime.workerHelloAccepted = false
  runtime.workerWebSocketSession.close(1000, 'reconnect')
  runtime.workerWebSocketStartupPort = runtime.createStartupPort()
  await runtime.workerWebSocketStartupPort.openWebSocket({
    kind: 'run-startup-step',
    vaultId: runtime.setup.vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await sendHello()
}

export async function sendWorkerHello(plugin: KuroflareSpikePlugin): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  if (plugin.workerHelloAccepted) return
  const setup = requireSetupMetadata(plugin)
  const port = plugin.workerWebSocketStartupPort ?? createWorkerWebSocketStartupPort(plugin)
  plugin.workerWebSocketStartupPort = port
  await port.sendClientHello({
    kind: 'run-startup-step',
    vaultId: setup.vaultId,
    step: 'send-client-hello',
    phase: 'websocket',
  })
  await plugin.metadataMigrationPromise
  plugin.workerHelloAccepted = true
  plugin.syncStatusEl?.setText(`Kuroflare sync: connected ${setup.vaultId}`)
  await requestMetaDocFromWorker(plugin, 'hello-accepted')
  await requestActiveFileFromWorker(plugin, 'hello-accepted')
  await requestPendingRemoteTextFilesFromWorker(plugin, 'hello-accepted')
  await runOutboxWorkerTick(plugin, 'hello-accepted')
  await waitForOutboundUpdates(plugin)
  scheduleOutboxWorkerTick(plugin, 250, 'hello-accepted-follow-up')
}

export async function waitForOutboundUpdates(
  plugin: KuroflareSpikePlugin,
  timeoutMs = 5_000,
): Promise<void> {
  const setup = currentSetupMetadata(plugin)
  if (setup === undefined) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await readOutboxWorkerSnapshot(
      await openLocalStoreDatabase(plugin, setup.vaultId),
    )
    const pending = snapshot.outboxRecords.some(
      (record) =>
        (record.kind === 'y-update' || record.kind === 'meta-ref-update') &&
        (record.status === 'pending' || record.status === 'retrying'),
    )
    if (!pending) return
    await runOutboxWorkerTick(plugin, 'hello-accepted-drain')
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
  }
  console.warn('[kuroflare] outbound update drain timed out')
}

export async function handleWorkerInboundMessage(
  plugin: KuroflareSpikePlugin,
  message: SyncRuntimeWebSocketInboundMessage,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  const setup = requireSetupMetadata(plugin)
  const vaultId = setup.vaultId
  const db = await openLocalStoreDatabase(plugin, vaultId)
  const registry = {
    getYDoc: (docId: DocId) => {
      if (docId.kind === 'meta') return plugin.metaDoc
      if (docId.kind !== 'file') return undefined
      if (docId.ydocId === undefined) return undefined
      return plugin.loadedTextDocs.get(docId.ydocId)?.doc
    },
  }
  const dispatched = await dispatchSyncRuntimeWebSocketInboundMessage({
    inbound: message,
    vaultId,
    deviceId: setup.deviceId,
    pendingSyncRequestMessageIds: plugin.pendingSyncRequestMessageIds,
    ports: {
      completeOutbox: createSyncRuntimeWebSocketOutboxCompletionPort({
        ownerId: plugin.outboxWorkerOwnerId,
        now: () => Date.now(),
        snapshot: {
          read: () => readOutboxWorkerSnapshot(db),
        },
        commit: {
          async commit(plan) {
            const committed = await commitLocalStoreIndexedDbDatabaseTransaction({
              operations: plan.operations,
              database: createLocalStoreIndexedDbDatabasePort(db),
            })
            if (!committed.ok) {
              console.warn('[kuroflare] inbound outbox completion persistence rejected', {
                reason: committed.reason,
                itemId: committed.itemId,
              })
              return { ok: false, reason: committed.reason }
            }
            return { ok: true }
          },
        },
      }).completeOutbox,
      applyRemoteUpdate: createSyncRuntimeWebSocketRemoteUpdateApplyPort({
        ydoc: createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort({
          registry,
          origin: WORKER_ORIGIN,
        }),
        commit: createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(
          createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort(db),
        ),
      }).applyRemoteUpdate,
      answerSyncRequest: createSyncRuntimeWebSocketSyncRequestAnswerPort({
        deviceId: setup.deviceId,
        registry,
        session: plugin.workerWebSocketSession,
      }).answerSyncRequest,
      applyRemoteAwareness: createSyncRuntimeWebSocketAwarenessApplyPort({
        awareness: plugin.awareness,
      }).applyRemoteAwareness,
      drop: async (route) => {
        if (route.reason === 'self-broadcast') return
        console.warn('[kuroflare] dropped worker ws message', route)
      },
    },
  })
  if (dispatched.route.action === 'apply-remote-update') {
    await plugin.handleWorkerSyncUpdate(dispatched.route.message)
  } else if (
    dispatched.route.action === 'outbox-completion' &&
    dispatched.route.message.type === 'need-full-snapshot'
  ) {
    // Fire-and-forget: fetch+apply retries run in the background so this doesn't block
    // dispatch of subsequent inbound messages (see recoverFromNeedFullSnapshot).
    void plugin.recoverFromNeedFullSnapshot(
      dispatched.route.message.docId,
      dispatched.route.message.reason,
    )
  }
}

/**
 * Keeps close recovery independent from remote-update and drop handling while
 * preserving completion ordering for guarded local outbox evidence.
 */
export function routeWorkerInboundMessageForStartup(
  message: SyncRuntimeWebSocketInboundMessage,
  handle: (message: SyncRuntimeWebSocketInboundMessage) => Promise<void>,
): void | Promise<void> {
  if (
    message.ok &&
    (message.message.type === 'ack' ||
      message.message.type === 'need-full-snapshot' ||
      message.message.type === 'sync-update-rejected')
  ) {
    return handle(message)
  }
  void handle(message).catch((error: unknown) => {
    console.warn('[kuroflare] asynchronous worker inbound handling failed', { error })
  })
}

function createWorkerWebSocketStartupPort(
  plugin: KuroflareSpikePlugin,
): SyncRuntimeWebSocketStartupStepPort {
  const setup = requireSetupMetadata(plugin)
  return createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: accessTokenSecretKeyForSetup(setup) },
    tokenReader: {
      getAccessToken: async (key) => await readAccessToken(plugin, key),
    },
    webSocket: createBrowserSyncRuntimeWebSocketFactory(WebSocket),
    capabilities: plugin.metadataCapabilityAdvertised
      ? ['binary-v1', 'awareness', 'metadata-schema-v2']
      : ['binary-v1', 'awareness'],
    onHelloAccepted: (message) => {
      plugin.metadataAccess = message.metadataAccess ?? 'read-only'
      plugin.metadataMigrationPending =
        plugin.metaDoc.getMap<unknown>('meta').size === 0 || !metaDocWritable(plugin.metaDoc)
      void plugin.startMetadataMigrationAfterHello()
    },
    session: plugin.workerWebSocketSession,
    onConnectionIssue: (issue) => {
      void handleWorkerWebSocketIssue(plugin, issue)
    },
    onInboundMessage: (message) => {
      return routeWorkerInboundMessageForStartup(message, async (inbound) => {
        await handleWorkerInboundMessage(plugin, inbound)
      })
    },
  })
}

async function handleWorkerWebSocketIssue(
  plugin: KuroflareSpikePlugin,
  issue: {
    readonly kind: 'close' | 'error'
    readonly code?: number | undefined
    readonly reason?: string | undefined
  },
): Promise<void> {
  if (
    issue.reason === 'reconnect' ||
    issue.reason === 'plugin-unload' ||
    !plugin.startupSideEffectGate.canSendNetwork() ||
    plugin.syncStoppedByAuth !== null
  ) {
    return
  }
  if (
    issue.kind === 'close' &&
    issue.code === 1003 &&
    issue.reason === 'invalid-control-message' &&
    plugin.metadataCapabilityFallbackAttempted
  ) {
    return
  }

  const opening = plugin.workerWebSocketOpenPromise
  if (opening !== null) {
    void opening
      .catch(() => undefined)
      .finally(() => {
        void handleWorkerWebSocketIssue(plugin, issue)
      })
    return
  }
  if (shouldRetryWithLegacyMetadataCapability(plugin, issue)) {
    plugin.metadataCapabilityFallbackAttempted = true
    plugin.metadataCapabilityAdvertised = false
    plugin.metadataAccess = 'read-only'
    await openWorkerWebSocket(plugin)
    return
  }
  if (plugin.workerWebSocketRecoveryPromise !== null) return

  const recovery = (async () => {
    await recoverLeasedOutboxAfterWebSocketFailure(plugin)
    await openWorkerWebSocket(plugin)
    await runOutboxWorkerTick(plugin, `websocket-${issue.kind}-reconnect`)
  })()
  plugin.workerWebSocketRecoveryPromise = recovery
  try {
    await recovery
  } catch (error: unknown) {
    console.warn('[kuroflare] worker websocket recovery failed', { issue, error })
    scheduleOutboxWorkerTick(plugin, 1_000, `websocket-${issue.kind}-retry`)
  } finally {
    if (plugin.workerWebSocketRecoveryPromise === recovery) {
      plugin.workerWebSocketRecoveryPromise = null
    }
  }
}

export function shouldRetryWithLegacyMetadataCapability(
  plugin: Pick<
    KuroflareSpikePlugin,
    'metadataCapabilityAdvertised' | 'metadataCapabilityFallbackAttempted'
  >,
  issue: {
    readonly kind: 'close' | 'error'
    readonly code?: number | undefined
    readonly reason?: string | undefined
  },
): boolean {
  return (
    issue.kind === 'close' &&
    issue.code === 1003 &&
    issue.reason === 'invalid-control-message' &&
    plugin.metadataCapabilityAdvertised &&
    !plugin.metadataCapabilityFallbackAttempted
  )
}

export function isLegacyMetadataCapabilityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('websocket-closed-before-hello-accepted:1003:invalid-control-message')
  )
}
