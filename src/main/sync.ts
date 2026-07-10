import { Y } from 'yjs'

import { createSyncRuntimeObsidianResumePort } from '@packages/obsidian-plugin/sync/obsidian/lifecycle'
import type { LocalStoreOutboxRecord } from '@packages/obsidian-plugin/sync/store/store'
import type KuroflareSpikePlugin from './plugin'

export function createSyncRuntime(plugin: KuroflareSpikePlugin): SyncRuntimeObsidianComposition {
  const settingsReader = {
    readSettings: async () => ({
      endpoint: plugin.kuroflareSettings.endpoint,
      setupVaultId: plugin.kuroflareSettings.setupVaultId,
      setupToken: plugin.kuroflareSettings.setupToken,
      requestedDeviceName: plugin.kuroflareSettings.requestedDeviceName,
      setupBootstrapMode: plugin.kuroflareSettings.setupBootstrapMode,
      existingDeviceId: plugin.currentSetupDeviceId(),
    }),
  }
  const setupEvidenceReader = createSyncRuntimeObsidianSetupExchangeEvidenceReader({
    readSettings: (_effect: SetupExchangeStartupEffect) => ({
      endpoint: plugin.kuroflareSettings.endpoint,
      setupVaultId: plugin.kuroflareSettings.setupVaultId,
      setupToken: plugin.kuroflareSettings.setupToken,
      requestedDeviceName: plugin.kuroflareSettings.requestedDeviceName,
      setupBootstrapMode: plugin.kuroflareSettings.setupBootstrapMode,
      existingDeviceId: plugin.currentSetupDeviceId(),
    }),
  })
  const setupExchange = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
    fetch: (input, init) => fetch(input, init),
    readEvidence: (effect) => setupEvidenceReader.readEvidence(effect),
    scheduleReplan: async (request) => {
      plugin.pendingSetupResponse = request.response
      await plugin.updateSettings({
        endpoint: request.response.endpoint,
        setupVaultId: request.response.vaultId,
        setupToken: '',
        setupMetadata: localSetupMetadataFromSetupResponse(request.response),
      })
    },
  })

  return createSyncRuntimeObsidianComposition({
    settings: settingsReader,
    local: {
      readLocalEvidence: async () => ({
        metadataSnapshot: await plugin.readLocalSetupMetadataSnapshot(),
        hasMetaYDoc: plugin.metaMap.size > 0,
        hasLocalVaultFiles: plugin.app.vault.getMarkdownFiles().length > 0,
        setupResponse: plugin.pendingSetupResponse ?? undefined,
      }),
    },
    setupExchange,
    localStore: createSyncRuntimeIndexedDbLocalStoreEffectPort({
      indexedDb: createBrowserLocalStoreIndexedDbFactoryPort(indexedDB),
    }),
    localStoreRebuild: createSyncRuntimeLocalStoreRebuildReplanPort({
      scheduleReplan: async () => {
        await plugin.runSyncStartupTick('local-store-rebuild')
      },
    }),
    startupStep: plugin.createStartupStepPort(),
    resume: createSyncRuntimeObsidianResumePort({
      isDocumentHidden: () => document.hidden,
      isSyncBlocked: () => plugin.syncStoppedByAuth !== null,
      runForegroundResume: async (reason) => {
        await plugin.handleForegroundResume(reason)
      },
      scheduleOutboxTick: (reason) => {
        void plugin.runOutboxWorkerTick(reason)
      },
    }),
    ui: {
      setStatusText: (text) => {
        plugin.syncStatusEl?.setText(text)
      },
      showNotice: (text) => {
        new Notice(text)
      },
      setRepairEntries: (entries) => {
        plugin.syncRepairEntries = [...entries]
      },
      setRetryEnabled: (enabled) => {
        plugin.syncRetryEnabled = enabled
      },
    },
  })
}

export function createStartupStepPort(
  plugin: KuroflareSpikePlugin,
): SyncRuntimeStartupStepEffectPort {
  const logStep = (step: string, phase: string, vaultId: string) => {
    console.info('[kuroflare] startup step', { step, phase, vaultId })
  }
  return createSyncRuntimeStartupStepEffectPort({
    setup: {
      persistSetupResponse: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.persistPendingSetupResponse()
      },
    },
    localScan: {
      scanLocalVault: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        plugin.scanLocalVaultForStartup()
      },
      createLocalMetaYDoc: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.createLocalMetaYDocFromStartupScan(`startup:${effect.step}`)
      },
      adoptLocalFilesAfterRemoteMeta: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.adoptLocalFilesAfterRemoteMeta()
      },
    },
    snapshot: {
      publishLocalMetaSnapshot: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.publishLocalMetaSnapshot(`startup:${effect.step}`)
      },
      publishInitialFileSnapshots: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.publishInitialFileSnapshots(`startup:${effect.step}`)
      },
      fetchRemoteMetaSnapshot: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        plugin.pendingRemoteMetaSnapshot = await plugin.fetchLatestSnapshotPayload(
          META_SYNC_DOC_ID,
          `startup:${effect.step}`,
        )
      },
      applyRemoteMetaSnapshot: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        if (plugin.pendingRemoteMetaSnapshot === null) {
          return
        }
        await plugin.applyLatestSnapshot(
          META_SYNC_DOC_ID,
          plugin.pendingRemoteMetaSnapshot,
          `startup:${effect.step}`,
        )
        plugin.pendingRemoteMetaSnapshot = null
      },
      syncMetaStateVector: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.requestMetaDocFromWorker(`startup:${effect.step}`)
      },
      syncActiveFileStateVector: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.requestActiveFileFromWorker(`startup:${effect.step}`)
      },
    },
    localStore: {
      loadIndexedDbYDocs: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.loadIndexedDbYDocs()
      },
    },
    websocket: {
      openWebSocket: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.openWorkerWebSocket()
      },
      sendClientHello: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.sendWorkerHello()
      },
    },
    outbox: {
      sendMetaUpdate: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.sendMetaDocToWorker(`startup:${effect.step}`)
      },
      enqueueMissingDownloads: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.enqueueMissingDownloads()
      },
      resumeBackgroundQueues: async (effect) => {
        logStep(effect.step, effect.phase, effect.vaultId)
        await plugin.runOutboxWorkerTick(`startup:${effect.step}`)
      },
    },
  })
}

export async function runSyncStartupTick(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const runtime = plugin.syncRuntime
  if (runtime === null) {
    return
  }

  const result = await runtime.lifecycle.runStartupTick()
  console.info('[kuroflare] sync startup tick', {
    reason,
    status: result.driver.state.shell.status,
    repairEntries: plugin.syncRepairEntries,
    retryEnabled: plugin.syncRetryEnabled,
    setupExchangeCompleted: result.driver.setupExchangeReplan !== undefined,
    completedEffects: result.driver.state.shell.completedEffects.length,
  })
}

export async function handleLifecycleResume(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const runtime = plugin.syncRuntime
  if (runtime === null) {
    return
  }
  const result = await runtime.lifecycle.runResumeTick(reason)
  console.info('[kuroflare] sync lifecycle resume tick', {
    reason,
    action: result.action,
    completedEffects:
      result.action === 'ran'
        ? result.startup.driver.state.shell.completedEffects.length
        : undefined,
  })
}

export async function openWorkerWebSocket(plugin: KuroflareSpikePlugin): Promise<void> {
  if (plugin.syncStoppedByAuth !== null) {
    return
  }
  const snapshot = plugin.workerWebSocketSession.snapshot()
  if (snapshot.readyState === WebSocket.OPEN) {
    if (!plugin.workerHelloAccepted) {
      await plugin.sendWorkerHello()
    }
    return
  }
  plugin.workerHelloAccepted = false
  plugin.workerWebSocketSession.close(1000, 'reconnect')
  plugin.workerWebSocketStartupPort = plugin.createWorkerWebSocketStartupPort()
  await plugin.workerWebSocketStartupPort.openWebSocket({
    kind: 'run-startup-step',
    vaultId: plugin.requireSetupMetadata().vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await plugin.sendWorkerHello()
}

export async function sendWorkerHello(plugin: KuroflareSpikePlugin): Promise<void> {
  if (plugin.workerHelloAccepted) {
    return
  }
  const setup = plugin.requireSetupMetadata()
  const port = plugin.workerWebSocketStartupPort ?? plugin.createWorkerWebSocketStartupPort()
  plugin.workerWebSocketStartupPort = port
  await port.sendClientHello({
    kind: 'run-startup-step',
    vaultId: setup.vaultId,
    step: 'send-client-hello',
    phase: 'websocket',
  })
  plugin.workerHelloAccepted = true
  plugin.syncStatusEl?.setText(`Kuroflare sync: connected ${setup.vaultId}`)
  await plugin.requestMetaDocFromWorker('hello-accepted')
  await plugin.requestActiveFileFromWorker('hello-accepted')
  await plugin.requestPendingRemoteTextFilesFromWorker('hello-accepted')
  void plugin.runOutboxWorkerTick('hello-accepted')
}

export function createWorkerWebSocketStartupPort(
  plugin: KuroflareSpikePlugin,
): SyncRuntimeWebSocketStartupStepPort {
  const setup = plugin.requireSetupMetadata()
  return createSyncRuntimeWebSocketStartupStepPort({
    metadata: {
      setup,
      accessTokenSecretKey: accessTokenSecretKeyForSetup(setup),
    },
    tokenReader: {
      getAccessToken: async (key) => {
        return await plugin.readAccessToken(key)
      },
    },
    webSocket: createBrowserSyncRuntimeWebSocketFactory(WebSocket),
    capabilities: [],
    session: plugin.workerWebSocketSession,
    onInboundMessage: (message) => {
      void plugin.handleWorkerInboundMessage(message)
    },
  })
}

export async function sendCurrentYDocToWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const loaded = plugin.activeTextDoc
  if (loaded === null) {
    return
  }
  await plugin.sendDocUpdateToWorker(loaded.docId, Y.encodeStateAsUpdate(loaded.doc), reason)
}

export async function publishInitialFileSnapshots(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  for (const loaded of plugin.loadedTextDocs.values()) {
    await plugin.importLocalSnapshot(loaded.docId, Y.encodeStateAsUpdate(loaded.doc), reason)
  }
  console.info('[kuroflare] initial file snapshots imported', {
    reason,
    files: plugin.loadedTextDocs.size,
  })
}

export async function sendMetaDocToWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  await plugin.sendDocUpdateToWorker(
    META_SYNC_DOC_ID,
    Y.encodeStateAsUpdate(plugin.metaDoc),
    reason,
  )
}

export async function requestActiveFileFromWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const loaded = plugin.activeTextDoc
  if (loaded === null) {
    return
  }
  await plugin.requestDocFromWorker(loaded.docId, Y.encodeStateVector(loaded.doc), reason)
}

export async function requestMetaDocFromWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  await plugin.requestDocFromWorker(META_SYNC_DOC_ID, Y.encodeStateVector(plugin.metaDoc), reason)
}

export async function requestPendingRemoteTextFilesFromWorker(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  for (const ydocId of plugin.pendingRemoteTextFiles.keys()) {
    const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(ydocId) }
    const loaded = await plugin.loadTextDoc(docId)
    await plugin.requestDocFromWorker(docId, Y.encodeStateVector(loaded.doc), reason)
  }
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
  const setup = plugin.requireSetupMetadata()
  const sender = createSyncRuntimeWebSocketSyncRequestSendPort({
    session: plugin.workerWebSocketSession,
  })
  const sent = await sender.sendSyncRequest({
    vaultId: setup.vaultId,
    deviceId: setup.deviceId,
    messageId: plugin.nextWorkerMessageId(),
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

export async function sendYjsUpdateToWorker(
  plugin: KuroflareSpikePlugin,
  update: Uint8Array,
  reason: string,
): Promise<void> {
  const loaded = plugin.activeTextDoc
  if (loaded === null) {
    return
  }
  await plugin.sendDocUpdateToWorker(loaded.docId, update, reason)
}

export async function sendDocUpdateToWorker(
  plugin: KuroflareSpikePlugin,
  docId: DocId,
  update: Uint8Array,
  reason: string,
): Promise<void> {
  // Edits before device setup are local-only; there is no outbox to enqueue into yet.
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    return
  }
  const messageId = plugin.nextWorkerMessageId()
  const updateSha256 = makeSha256Hex(await plugin.sha256Hex(update))
  const updateBytesBase64 = encodeBase64(update)
  try {
    await plugin.persistOutboundYUpdate({
      vaultId: setup.vaultId,
      docId,
      messageId,
      updateSha256,
      updateBytesBase64,
    })
  } catch (error: unknown) {
    console.error('[kuroflare] failed to persist outbound update before send', {
      reason,
      docId,
      messageId,
      error: safeLogError(error),
    })
    return
  }
  void plugin.runOutboxWorkerTick(reason)
  console.info('[kuroflare] enqueued worker sync update', {
    reason,
    messageId,
    docId,
    bytes: update.byteLength,
  })
}

export async function persistOutboundYUpdate(
  plugin: KuroflareSpikePlugin,
  input: {
    readonly vaultId: LocalSetupMetadata['vaultId']
    readonly docId: DocId
    readonly messageId: SyncUpdate['messageId']
    readonly updateSha256: NonNullable<SyncUpdate['updateSha256']>
    readonly updateBytesBase64: string
  },
): Promise<void> {
  const record: LocalStoreOutboxRecord = {
    id: input.messageId,
    kind: 'y-update',
    status: 'pending',
    dependsOn: [],
    nextAttemptAt: undefined,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    updateBytesBase64: input.updateBytesBase64,
    createdAt: Date.now(),
  }
  const db = await plugin.openLocalStoreDatabase(input.vaultId)
  await plugin.putOutboxRecord(db, record)
}

export async function completeOutboundYUpdateFromWorker(
  plugin: KuroflareSpikePlugin,
  message: Ack | NeedFullSnapshot,
): Promise<void> {
  const setup = plugin.requireSetupMetadata()
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const port = createSyncRuntimeWebSocketOutboxCompletionPort({
    ownerId: plugin.outboxWorkerOwnerId,
    now: () => Date.now(),
    snapshot: {
      read: async () => await plugin.readOutboxWorkerSnapshot(db),
    },
    commit: {
      commit: async (plan) => {
        await plugin.commitOutboxWorkerIndexedDbWriteTransaction(
          db,
          planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
        )
      },
    },
  })
  await port.completeOutbox(message)
}

export async function handleWorkerInboundMessage(
  plugin: KuroflareSpikePlugin,
  inbound: SyncRuntimeWebSocketInboundMessage,
): Promise<void> {
  const setup = plugin.requireSetupMetadata()
  await dispatchSyncRuntimeWebSocketInboundMessage({
    inbound,
    vaultId: setup.vaultId,
    deviceId: setup.deviceId,
    pendingSyncRequestMessageIds: plugin.pendingSyncRequestMessageIds,
    ports: {
      completeOutbox: async (message) => {
        if (message.type === 'need-full-snapshot') {
          await plugin.completeOutboundYUpdateFromWorker(message).catch((error: unknown) => {
            console.error('[kuroflare] failed to pause outbound update for full snapshot', {
              docId: message.docId,
              error: safeLogError(error),
            })
          })
          await plugin.fetchAndApplyFullSnapshot(message)
          return
        }
        console.info('[kuroflare] worker ack', {
          messageId: message.messageId,
          durableSeq: message.durableSeq,
        })
        await plugin.completeOutboundYUpdateFromWorker(message).catch((error: unknown) => {
          console.error('[kuroflare] failed to mark outbound update acked', {
            messageId: message.messageId,
            error: safeLogError(error),
          })
        })
        void plugin.runOutboxWorkerTick('ack')
        plugin.syncStatusEl?.setText(`Kuroflare sync: ack ${message.durableSeq}`)
      },
      applyRemoteUpdate: async (message) => {
        plugin.pendingSyncRequestMessageIds.delete(message.messageId)
        await plugin.applyWorkerSyncUpdate(message)
      },
      answerSyncRequest: async (message) => {
        await plugin.answerWorkerSyncRequest(message)
      },
      drop: async (route) => {
        console.warn('[kuroflare] dropped worker websocket message', { reason: route.reason })
      },
    },
  })
}
