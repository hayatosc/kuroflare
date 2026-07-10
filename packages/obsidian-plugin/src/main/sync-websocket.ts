import { makeSha256Hex, makeYDocId, type DocId } from '@kuroflare/core'
import * as Y from 'yjs'

import type { FileDocId } from '../main-types'
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
import { runOutboxWorkerTick } from './outbox'
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
  void runOutboxWorkerTick(plugin, reason)
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

export async function openWorkerWebSocket(plugin: KuroflareSpikePlugin): Promise<void> {
  if (plugin.syncStoppedByAuth !== null) return
  const snapshot = plugin.workerWebSocketSession.snapshot()
  if (snapshot.readyState === WebSocket.OPEN) {
    if (!plugin.workerHelloAccepted) await sendWorkerHello(plugin)
    return
  }
  plugin.workerHelloAccepted = false
  plugin.workerWebSocketSession.close(1000, 'reconnect')
  plugin.workerWebSocketStartupPort = createWorkerWebSocketStartupPort(plugin)
  await plugin.workerWebSocketStartupPort.openWebSocket({
    kind: 'run-startup-step',
    vaultId: requireSetupMetadata(plugin).vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await sendWorkerHello(plugin)
}

export async function sendWorkerHello(plugin: KuroflareSpikePlugin): Promise<void> {
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
  void runOutboxWorkerTick(plugin, 'hello-accepted')
}

export async function handleWorkerInboundMessage(
  plugin: KuroflareSpikePlugin,
  message: SyncRuntimeWebSocketInboundMessage,
): Promise<void> {
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
  await dispatchSyncRuntimeWebSocketInboundMessage({
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
    onInboundMessage: (message) => {
      void handleWorkerInboundMessage(plugin, message)
    },
  })
}
