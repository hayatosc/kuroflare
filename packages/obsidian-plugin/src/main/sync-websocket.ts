import { makeSha256Hex, makeYDocId, type DocId } from '@kuroflare/core'
import * as Y from 'yjs'

import type { FileDocId } from '../main-types'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import {
  createSyncRuntimeWebSocketStartupStepPort,
  createBrowserSyncRuntimeWebSocketFactory,
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
import { planOutboxWorkerCompletionIndexedDbWriteTransaction } from '../sync/engine/worker'
import { type LocalStoreOutboxRecord } from '../sync/store/store'
import {
  currentSetupMetadata,
  requireSetupMetadata,
  nextWorkerMessageId,
  sha256Hex,
  readAccessToken,
} from './auth'
import { META_SYNC_DOC_ID, WORKER_ORIGIN } from './constants'
import { safeLogError, encodeBase64, accessTokenSecretKeyForSetup } from './helpers'
import { loadTextDoc } from './meta'
import {
  recoverLeasedOutboxAfterWebSocketFailure,
  runOutboxWorkerTick,
  scheduleOutboxWorkerTick,
} from './outbox'
import type KuroflareSpikePlugin from './plugin'
import {
  openLocalStoreDatabase,
  putOutboxRecord,
  readOutboxWorkerSnapshot,
  commitOutboxWorkerIndexedDbWriteTransaction,
} from './store'

export async function sendDocUpdateToWorker(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  update: Uint8Array,
  reason: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
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

export async function requestDocFromWorker(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  stateVector: Uint8Array,
  reason: string,
): Promise<void> {
  if (!plugin.startupSideEffectGate.canSendNetwork()) return
  if (
    !plugin.workerHelloAccepted ||
    plugin.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN
  ) {
    return
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
  readonly syncStoppedByAuth: string | null
  workerWebSocketOpenPromise: Promise<void> | null
  readonly workerWebSocketSession: SyncRuntimeWebSocketSessionPort
  workerWebSocketStartupPort: SyncRuntimeWebSocketStartupStepPort | null
  workerHelloAccepted: boolean
  readonly setup: LocalSetupMetadata
  readonly createStartupPort: () => SyncRuntimeWebSocketStartupStepPort
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
  const opening = openWorkerWebSocketOnce(runtime, sendHello)
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
    syncStoppedByAuth: plugin.syncStoppedByAuth,
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
    setup,
    createStartupPort: () => createWorkerWebSocketStartupPort(plugin),
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
  if (snapshot.readyState === WebSocket.OPEN) {
    if (!runtime.workerHelloAccepted) await sendHello()
    return
  }
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
            const transaction = planOutboxWorkerCompletionIndexedDbWriteTransaction(plan)
            await commitOutboxWorkerIndexedDbWriteTransaction(db, transaction)
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
      drop: async (route) => {
        if (route.reason === 'self-broadcast') return
        console.warn('[kuroflare] dropped worker ws message', route)
      },
    },
  })
  if (dispatched.route.action === 'apply-remote-update') {
    await plugin.handleWorkerSyncUpdate(dispatched.route.message)
  }
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
    capabilities: [],
    session: plugin.workerWebSocketSession,
    onConnectionIssue: (issue) => {
      void handleWorkerWebSocketIssue(plugin, issue)
    },
    onInboundMessage: (message) => {
      void handleWorkerInboundMessage(plugin, message)
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

  const opening = plugin.workerWebSocketOpenPromise
  if (opening !== null) {
    void opening
      .catch(() => undefined)
      .finally(() => {
        void handleWorkerWebSocketIssue(plugin, issue)
      })
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
