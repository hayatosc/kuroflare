import assert from 'node:assert/strict'

import {
  hashBytesSha256,
  makeOutboxPlanItemId,
  type OutboxPlanItemId,
  type OutboxRunningLease,
} from '@kuroflare/core'
import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  parseControlMessage,
  type ClientHello,
  type DocId,
} from '@kuroflare/core'
import { test } from 'vitest'
import * as Y from 'yjs'

import { type LocalStoreOutboxRecord } from './local-store'
import {
  attachSyncRuntimeWebSocketInboundMessageHandler,
  buildSyncRuntimeWebSocketProtocols,
  buildSyncRuntimeWebSocketUrl,
  createSyncRuntimeWebSocketOutboxCompletionPort,
  createSyncRuntimeWebSocketOutboxSendPort,
  createSyncRuntimeWebSocketRemoteUpdateApplyPort,
  createSyncRuntimeWebSocketSession,
  createSyncRuntimeWebSocketStartupStepPort,
  createSyncRuntimeWebSocketSyncRequestAnswerPort,
  createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort,
  decodeSyncRuntimeWebSocketRemoteUpdate,
  dispatchSyncRuntimeWebSocketInboundMessage,
  parseSyncRuntimeWebSocketMessage,
  planSyncRuntimeWebSocketHelloAdmission,
  planSyncRuntimeWebSocketSyncRequestAnswer,
  planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction,
  planSyncRuntimeWebSocketOutboxCompletion,
  planSyncRuntimeWebSocketOutboxSend,
  planSyncRuntimeWebSocketInboundRoute,
  type SyncRuntimeWebSocketAccessTokenReaderPort,
  type SyncRuntimeWebSocketAppliedYDocState,
  type SyncRuntimeWebSocketConnection,
  type SyncRuntimeWebSocketFactoryPort,
  type SyncRuntimeWebSocketOutboxCompletionCommitPort,
  type SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort,
  type SyncRuntimeWebSocketRemoteUpdateApplyInput,
  type SyncRuntimeWebSocketRemoteUpdateCommitPort,
  type SyncRuntimeWebSocketRemoteUpdateRejectPort,
  type SyncRuntimeWebSocketRemoteUpdateYDocApplyPort,
  type SyncRuntimeWebSocketSyncRequestAnswerRejectPort,
  type SyncRuntimeWebSocketYDocRegistryPort,
  type SyncRuntimeWebSocketInboundRoutePorts,
} from './websocket-runtime'

const vaultId = makeVaultId('websocket-vault-1')
const deviceId = makeDeviceId('websocket-device-1')
const peerDeviceId = makeDeviceId('websocket-device-2')
const fileDocId = { kind: 'file', ydocId: makeYDocId('websocket-doc-1') } as const
const yUpdateId = outboxId('websocket-y-update-1')
const messageId = makeMessageId('websocket-y-update-message-1')
const updateHash = makeSha256Hex('a'.repeat(64))

const setup = {
  endpoint: 'https://worker.example/base/path',
  vaultId,
  deviceId,
  yClientId: 12,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
  tokenVersion: 3,
} as const

test('websocket runtime builds browser-compatible worker websocket URLs', () => {
  assert.equal(
    buildSyncRuntimeWebSocketUrl({
      endpoint: 'https://worker.example/setup/exchange',
      vaultId,
    }),
    'wss://worker.example/ws/websocket-vault-1',
  )
  assert.equal(
    buildSyncRuntimeWebSocketUrl({
      endpoint: 'http://127.0.0.1:8787',
      vaultId,
    }),
    'ws://127.0.0.1:8787/ws/websocket-vault-1',
  )
  assert.deepEqual(buildSyncRuntimeWebSocketProtocols('header.payload.sig'), [
    'kuroflare.v1',
    'kuroflare-token.header.payload.sig',
  ])
})

test('websocket runtime opens socket before sending client hello', async () => {
  const webSocket = new FakeWebSocketFactory()
  const tokenReader = new FakeAccessTokenReader([['access-token-key', 'header.payload.sig']])
  const session = createSyncRuntimeWebSocketSession()
  const port = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'access-token-key' },
    tokenReader,
    webSocket,
    capabilities: ['binary-v1', 'awareness'],
    session,
  })
  const open = port.openWebSocket({
    kind: 'run-startup-step',
    vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await Promise.resolve()

  assert.equal(webSocket.connections.length, 1)
  assert.equal(webSocket.connections[0]?.readyState, 0)
  assert.deepEqual(session.snapshot(), { hasConnection: true, readyState: 0 })
  webSocket.connections[0]?.open()
  await open
  assert.deepEqual(session.snapshot(), { hasConnection: true, readyState: 1 })

  const helloAdmission = port.sendClientHello({
    kind: 'run-startup-step',
    vaultId,
    step: 'send-client-hello',
    phase: 'websocket',
  })
  await Promise.resolve()

  const sent = parseControlMessage(webSocket.connections[0]?.sent[0] ?? '')
  assert.equal(sent?.type, 'hello')
  assert.deepEqual(sent, {
    type: 'hello',
    protocolVersion: 1,
    vaultId,
    deviceId,
    yClientId: 12,
    capabilities: ['binary-v1', 'awareness'],
  })
  assert.deepEqual(port.snapshot().hello, sent)
  assert.equal(port.snapshot().connectionUrl?.includes('header.payload.sig'), false)
  assert.equal(port.snapshot().connectionUrl, 'wss://worker.example/ws/websocket-vault-1')
  assert.equal(webSocket.connections[0]?.url.includes('access_token='), false)
  assert.deepEqual(webSocket.connections[0]?.protocols, [
    'kuroflare.v1',
    'kuroflare-token.header.payload.sig',
  ])
  webSocket.connections[0]?.message(
    JSON.stringify({
      type: 'hello-accepted',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      yClientId: 12,
    }),
  )
  await helloAdmission
})

test('websocket runtime rejects hello before open and missing access token', async () => {
  const webSocket = new FakeWebSocketFactory()
  const missingTokenPort = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'missing-token-key' },
    tokenReader: new FakeAccessTokenReader([]),
    webSocket,
  })

  await assert.rejects(
    async () =>
      await missingTokenPort.openWebSocket({
        kind: 'run-startup-step',
        vaultId,
        step: 'open-websocket',
        phase: 'websocket',
      }),
    /websocket-access-token-missing/,
  )

  const unopenedPort = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'access-token-key' },
    tokenReader: new FakeAccessTokenReader([['access-token-key', 'token']]),
    webSocket,
  })

  await assert.rejects(
    async () =>
      await unopenedPort.sendClientHello({
        kind: 'run-startup-step',
        vaultId,
        step: 'send-client-hello',
        phase: 'websocket',
      }),
    /websocket-not-open/,
  )
})

test('websocket runtime parses inbound control messages at the trust boundary', () => {
  const message = {
    type: 'ack',
    protocolVersion: 1,
    vaultId,
    deviceId,
    messageId: 'websocket-message-1',
    docId: { kind: 'meta', ydocId: 'websocket-meta-doc-1' },
    durableSeq: 42,
  }

  assert.deepEqual(
    parseSyncRuntimeWebSocketMessage(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    ),
    { ok: true, message: { ...message, docId: { kind: 'meta' } } },
  )
  assert.deepEqual(parseSyncRuntimeWebSocketMessage(new MessageEvent('message', { data: '{' })), {
    ok: false,
    reason: 'invalid-control-message',
  })
  assert.deepEqual(
    parseSyncRuntimeWebSocketMessage(new MessageEvent('message', { data: new ArrayBuffer(1) })),
    { ok: false, reason: 'unsupported-binary-message' },
  )
})

test('websocket runtime waits for server hello admission before completing hello', async () => {
  const webSocket = new FakeWebSocketFactory()
  const port = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'access-token-key' },
    tokenReader: new FakeAccessTokenReader([['access-token-key', 'token']]),
    webSocket,
  })
  const open = port.openWebSocket({
    kind: 'run-startup-step',
    vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await Promise.resolve()
  const connection = webSocket.connections[0]
  assert.notEqual(connection, undefined)
  connection?.open()
  await open

  const admitted = port.sendClientHello({
    kind: 'run-startup-step',
    vaultId,
    step: 'send-client-hello',
    phase: 'websocket',
  })
  await Promise.resolve()
  assert.equal(connection?.sent.length, 1)
  connection?.message(
    JSON.stringify({
      type: 'hello-accepted',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      yClientId: 12,
    }),
  )

  await admitted
})

test('websocket runtime rejects hello admission close and identity mismatch', async () => {
  const wrongDeviceAdmission = {
    ok: true,
    message: {
      type: 'hello-accepted',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId: peerDeviceId,
      yClientId: 12,
    },
  } as const
  assert.deepEqual(
    planSyncRuntimeWebSocketHelloAdmission({
      inbound: wrongDeviceAdmission,
      metadata: setup,
    }),
    { action: 'reject', reason: 'device-mismatch' },
  )

  const webSocket = new FakeWebSocketFactory()
  const port = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'access-token-key' },
    tokenReader: new FakeAccessTokenReader([['access-token-key', 'token']]),
    webSocket,
  })
  const open = port.openWebSocket({
    kind: 'run-startup-step',
    vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await Promise.resolve()
  const connection = webSocket.connections[0]
  connection?.open()
  await open

  const admitted = port.sendClientHello({
    kind: 'run-startup-step',
    vaultId,
    step: 'send-client-hello',
    phase: 'websocket',
  })
  await Promise.resolve()
  connection?.close()

  await assert.rejects(async () => await admitted, /websocket-closed-before-hello-accepted/)
})

test('websocket runtime attaches inbound parser to opened connections', async () => {
  const webSocket = new FakeWebSocketFactory()
  const inboundMessages: ReturnType<typeof parseSyncRuntimeWebSocketMessage>[] = []
  const port = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'access-token-key' },
    tokenReader: new FakeAccessTokenReader([['access-token-key', 'token']]),
    webSocket,
    onInboundMessage(message) {
      inboundMessages.push(message)
    },
  })
  const open = port.openWebSocket({
    kind: 'run-startup-step',
    vaultId,
    step: 'open-websocket',
    phase: 'websocket',
  })
  await Promise.resolve()

  const connection = webSocket.connections[0]
  assert.notEqual(connection, undefined)
  connection?.message(
    JSON.stringify({
      type: 'need-full-snapshot',
      protocolVersion: 1,
      vaultId,
      deviceId,
      docId: { kind: 'meta' },
      reason: 'missing-log',
    }),
  )
  connection?.message('{')
  connection?.open()
  await open

  assert.deepEqual(inboundMessages, [
    {
      ok: true,
      message: {
        type: 'need-full-snapshot',
        protocolVersion: 1,
        vaultId,
        deviceId,
        docId: { kind: 'meta' },
        reason: 'missing-log',
      },
    },
    { ok: false, reason: 'invalid-control-message' },
  ])
})

test('websocket runtime can attach inbound parser to an existing connection', () => {
  const inboundMessages: ReturnType<typeof parseSyncRuntimeWebSocketMessage>[] = []
  const connection = new FakeWebSocketConnection('wss://worker.example/ws/vault')

  attachSyncRuntimeWebSocketInboundMessageHandler(connection, (message) => {
    inboundMessages.push(message)
  })
  connection.message(new ArrayBuffer(1))

  assert.deepEqual(inboundMessages, [{ ok: false, reason: 'unsupported-binary-message' }])
})

test('websocket runtime routes inbound ack and full snapshot messages to outbox completion', () => {
  const ack = {
    type: 'ack',
    protocolVersion: 1,
    vaultId,
    deviceId,
    messageId: makeMessageId('websocket-ack-message-1'),
    docId: fileDocId,
    durableSeq: 7,
  } as const
  const needFullSnapshot = {
    type: 'need-full-snapshot',
    protocolVersion: 1,
    vaultId,
    deviceId,
    docId: fileDocId,
    reason: 'missing-log',
  } as const

  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: ack },
      vaultId,
      deviceId,
    }),
    { action: 'outbox-completion', message: ack },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: needFullSnapshot },
      vaultId,
      deviceId,
    }),
    { action: 'outbox-completion', message: needFullSnapshot },
  )
})

test('websocket runtime routes peer sync messages to local sync handlers', () => {
  const syncUpdate = {
    type: 'sync-update',
    protocolVersion: 1,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-update-message-1'),
    docId: fileDocId,
    update: 'AQID',
  } as const
  const syncRequest = {
    type: 'sync-request',
    protocolVersion: 1,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-request-message-1'),
    docId: fileDocId,
    stateVector: 'BAUG',
  } as const

  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: syncUpdate },
      vaultId,
      deviceId,
    }),
    { action: 'apply-remote-update', message: syncUpdate },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: syncRequest },
      vaultId,
      deviceId,
    }),
    { action: 'answer-sync-request', message: syncRequest },
  )
})

test('websocket runtime drops unsafe inbound control messages before local side effects', () => {
  const selfBroadcast = {
    type: 'sync-update',
    protocolVersion: 1,
    vaultId,
    deviceId,
    messageId: makeMessageId('websocket-self-message-1'),
    docId: fileDocId,
    update: 'AQID',
  } as const
  const wrongVault = {
    ...selfBroadcast,
    vaultId: makeVaultId('websocket-other-vault'),
  }
  const peerAck = {
    type: 'ack',
    protocolVersion: 1,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-peer-ack-message-1'),
    docId: fileDocId,
    durableSeq: 8,
  } as const
  const hello: ClientHello = {
    type: 'hello',
    protocolVersion: 1,
    vaultId,
    deviceId,
    yClientId: 12,
    capabilities: ['binary-v1'],
  }

  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: false, reason: 'invalid-control-message' },
      vaultId,
      deviceId,
    }),
    { action: 'drop', reason: 'invalid-control-message' },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: wrongVault },
      vaultId,
      deviceId,
    }),
    { action: 'drop', reason: 'vault-mismatch' },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: peerAck },
      vaultId,
      deviceId,
    }),
    { action: 'drop', reason: 'device-mismatch' },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: selfBroadcast },
      vaultId,
      deviceId,
    }),
    { action: 'drop', reason: 'self-broadcast' },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: { ok: true, message: hello },
      vaultId,
      deviceId,
    }),
    { action: 'drop', reason: 'unexpected-server-hello' },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketInboundRoute({
      inbound: {
        ok: true,
        message: {
          type: 'hello-accepted',
          protocolVersion: 1,
          vaultId,
          deviceId,
          yClientId: 12,
        },
      },
      vaultId,
      deviceId,
    }),
    { action: 'drop', reason: 'unexpected-hello-accepted' },
  )
})

test('websocket runtime dispatches inbound routes to exactly one runtime port', async () => {
  const ports = new FakeInboundRoutePorts()
  const ack = {
    type: 'ack',
    protocolVersion: 1,
    vaultId,
    deviceId,
    messageId: makeMessageId('websocket-dispatch-ack-1'),
    docId: fileDocId,
    durableSeq: 9,
  } as const
  const update = {
    type: 'sync-update',
    protocolVersion: 1,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-dispatch-update-1'),
    docId: fileDocId,
    update: 'AQID',
  } as const
  const request = {
    type: 'sync-request',
    protocolVersion: 1,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-dispatch-request-1'),
    docId: fileDocId,
    stateVector: 'BAUG',
  } as const

  assert.deepEqual(
    await dispatchSyncRuntimeWebSocketInboundMessage({
      inbound: { ok: true, message: ack },
      vaultId,
      deviceId,
      ports,
    }),
    { route: { action: 'outbox-completion', message: ack } },
  )
  assert.deepEqual(
    await dispatchSyncRuntimeWebSocketInboundMessage({
      inbound: { ok: true, message: update },
      vaultId,
      deviceId,
      ports,
    }),
    { route: { action: 'apply-remote-update', message: update } },
  )
  assert.deepEqual(
    await dispatchSyncRuntimeWebSocketInboundMessage({
      inbound: { ok: true, message: request },
      vaultId,
      deviceId,
      ports,
    }),
    { route: { action: 'answer-sync-request', message: request } },
  )

  assert.deepEqual(ports.calls, [
    { action: 'outbox-completion', type: 'ack' },
    { action: 'apply-remote-update', type: 'sync-update' },
    { action: 'answer-sync-request', type: 'sync-request' },
  ])
})

test('websocket runtime dispatches dropped inbound messages without side effects', async () => {
  const ports = new FakeInboundRoutePorts()

  assert.deepEqual(
    await dispatchSyncRuntimeWebSocketInboundMessage({
      inbound: { ok: false, reason: 'unsupported-binary-message' },
      vaultId,
      deviceId,
      ports,
    }),
    { route: { action: 'drop', reason: 'unsupported-binary-message' } },
  )

  assert.deepEqual(ports.calls, [{ action: 'drop', reason: 'unsupported-binary-message' }])
})

test('websocket runtime plans and commits inbound outbox completions', async () => {
  const record = yUpdateRecord()
  const lease = runningLease()
  const message = {
    type: 'ack',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId,
    messageId,
    docId: fileDocId,
    durableSeq: 10,
  } as const
  const snapshot = { outboxRecords: [record], leaseRows: [lease] }

  const plan = planSyncRuntimeWebSocketOutboxCompletion({
    message,
    ownerId: 'worker-1',
    now: 1_000,
    snapshot,
  })
  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.record.id, yUpdateId)
    assert.equal(plan.completion.action, 'ack-completion')
    assert.deepEqual(plan.completion.nextOutboxRecords, [
      {
        ...record,
        status: 'done',
        nextAttemptAt: undefined,
        durableSeq: 10,
      },
    ])
  }

  const reader = new FakeOutboxCompletionSnapshotReader(snapshot)
  const commit = new FakeOutboxCompletionCommitPort()
  const port = createSyncRuntimeWebSocketOutboxCompletionPort({
    ownerId: 'worker-1',
    now: () => 1_000,
    snapshot: reader,
    commit,
  })
  await port.completeOutbox(message)

  assert.equal(reader.reads, 1)
  assert.equal(commit.plans.length, 1)
  assert.equal(commit.plans[0]?.action, 'ack-completion')
})

test('websocket runtime ignores unmatched or ambiguous inbound outbox completions', async () => {
  const record = yUpdateRecord()
  const lease = runningLease()
  const wrongMessage = {
    type: 'ack',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId,
    messageId: makeMessageId('websocket-unmatched-message'),
    docId: fileDocId,
    durableSeq: 11,
  } as const
  const fullSnapshot = {
    type: 'need-full-snapshot',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId,
    docId: fileDocId,
    reason: 'missing-log',
  } as const

  assert.deepEqual(
    planSyncRuntimeWebSocketOutboxCompletion({
      message: wrongMessage,
      ownerId: 'worker-1',
      now: 1_000,
      snapshot: { outboxRecords: [record], leaseRows: [lease] },
    }),
    { ok: false, reason: 'matching-outbox-record-not-found', candidates: [] },
  )

  const ambiguous = planSyncRuntimeWebSocketOutboxCompletion({
    message: fullSnapshot,
    ownerId: 'worker-1',
    now: 1_000,
    snapshot: {
      outboxRecords: [record, { ...record, id: outboxId('websocket-y-update-2') }],
      leaseRows: [lease],
    },
  })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, 'ambiguous-matching-outbox-record')

  const commit = new FakeOutboxCompletionCommitPort()
  const port = createSyncRuntimeWebSocketOutboxCompletionPort({
    ownerId: 'worker-1',
    now: () => 1_000,
    snapshot: new FakeOutboxCompletionSnapshotReader({
      outboxRecords: [record],
      leaseRows: [lease],
    }),
    commit,
  })
  await port.completeOutbox(wrongMessage)

  assert.deepEqual(commit.plans, [])
})

test('websocket runtime sends outbound outbox updates through the active session', async () => {
  const record = { ...yUpdateRecord(), updateSha256: updateHash, updateBytesBase64: 'AQID' }
  const plan = planSyncRuntimeWebSocketOutboxSend({ record, vaultId, deviceId })
  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.deepEqual(plan.message, {
      type: 'sync-update',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId,
      messageId,
      docId: fileDocId,
      update: 'AQID',
      updateSha256: updateHash,
    })
  }

  const connection = new FakeWebSocketConnection('wss://worker.example/ws/vault')
  const session = createSyncRuntimeWebSocketSession()
  session.attach(connection)
  connection.open()

  const port = createSyncRuntimeWebSocketOutboxSendPort({ session })
  const sent = await port.sendSyncUpdate({ record, vaultId, deviceId })
  assert.equal(sent.ok, true)
  assert.equal(connection.sent.length, 1)
  assert.deepEqual(parseControlMessage(connection.sent[0] ?? ''), plan.ok ? plan.message : null)
})

test('websocket runtime rejects outbound updates before touching the session', async () => {
  const session = createSyncRuntimeWebSocketSession()
  const connection = new FakeWebSocketConnection('wss://worker.example/ws/vault')
  session.attach(connection)
  connection.open()
  const port = createSyncRuntimeWebSocketOutboxSendPort({ session })

  assert.deepEqual(
    await port.sendSyncUpdate({
      record: { ...yUpdateRecord(), updateBytesBase64: undefined },
      vaultId,
      deviceId,
    }),
    { ok: false, reason: 'missing-update-bytes' },
  )
  assert.deepEqual(
    planSyncRuntimeWebSocketOutboxSend({
      record: { ...yUpdateRecord(), kind: 'blob-put' },
      vaultId,
      deviceId,
    }),
    { ok: false, reason: 'unsupported-kind' },
  )
  assert.deepEqual(connection.sent, [])
})

test('websocket runtime fails outbound send when the shared session is not open', async () => {
  const port = createSyncRuntimeWebSocketOutboxSendPort({
    session: createSyncRuntimeWebSocketSession(),
  })

  await assert.rejects(
    async () =>
      await port.sendSyncUpdate({
        record: { ...yUpdateRecord(), updateBytesBase64: 'AQID' },
        vaultId,
        deviceId,
      }),
    /websocket-session-missing/,
  )
})

test('websocket runtime verifies and applies peer remote updates before durable commit', async () => {
  const updateSha256 = makeSha256Hex(await hashBytesSha256(Uint8Array.from([1, 2, 3])))
  const message = {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-remote-update-apply-1'),
    docId: fileDocId,
    update: 'AQID',
    updateSha256,
    durableSeq: 12,
  } as const

  const decoded = await decodeSyncRuntimeWebSocketRemoteUpdate(message)
  assert.equal(decoded.ok, true)
  if (decoded.ok) {
    assert.deepEqual(decoded.apply.updateBytes, Uint8Array.from([1, 2, 3]))
    assert.equal(decoded.apply.actualUpdateSha256, updateSha256)
  }

  const ydoc = new FakeRemoteUpdateYDocApplyPort()
  const commit = new FakeRemoteUpdateCommitPort()
  const reject = new FakeRemoteUpdateRejectPort()
  const port = createSyncRuntimeWebSocketRemoteUpdateApplyPort({ ydoc, commit, reject })
  await port.applyRemoteUpdate(message)

  assert.deepEqual(
    ydoc.applied.map((entry) => entry.message.messageId),
    [message.messageId],
  )
  assert.deepEqual(
    commit.committed.map((entry) => entry.message.messageId),
    [message.messageId],
  )
  assert.deepEqual(reject.rejections, [])
  assert.equal(ydoc.applied[0]?.updateBytes.byteLength, 3)
})

test('websocket runtime rejects invalid peer remote updates before local mutation', async () => {
  const message = {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-remote-update-reject-1'),
    docId: fileDocId,
    update: 'AQID',
    updateSha256: makeSha256Hex('b'.repeat(64)),
    durableSeq: 13,
  } as const
  const ydoc = new FakeRemoteUpdateYDocApplyPort()
  const commit = new FakeRemoteUpdateCommitPort()
  const reject = new FakeRemoteUpdateRejectPort()
  const port = createSyncRuntimeWebSocketRemoteUpdateApplyPort({ ydoc, commit, reject })

  assert.deepEqual(await decodeSyncRuntimeWebSocketRemoteUpdate(message), {
    ok: false,
    reason: 'hash-mismatch',
  })
  await port.applyRemoteUpdate(message)

  assert.deepEqual(ydoc.applied, [])
  assert.deepEqual(commit.committed, [])
  assert.deepEqual(reject.rejections, [{ messageId: message.messageId, reason: 'hash-mismatch' }])
})

test('websocket runtime applies verified peer updates to loaded Yjs docs', async () => {
  const source = new Y.Doc()
  source.getText('body').insert(0, 'remote')
  const updateBytes = Y.encodeStateAsUpdate(source)
  const updateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  const target = new Y.Doc()
  const registry = new FakeYDocRegistry([[fileDocId, target]])
  const port = createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort({
    registry,
    origin: 'remote-websocket',
  })

  const applied = await port.applyRemoteUpdate({
    message: {
      type: 'sync-update',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId: peerDeviceId,
      messageId: makeMessageId('websocket-yjs-apply-1'),
      docId: fileDocId,
      update: 'unused-by-concrete-port',
      updateSha256,
      durableSeq: 14,
    },
    updateBytes,
    actualUpdateSha256: updateSha256,
  })

  assert.equal(target.getText('body').toJSON(), 'remote')
  assert.equal(applied.docId, fileDocId)
  assert.equal(applied.updateBytes.byteLength > 0, true)
  assert.equal(applied.stateVectorBase64.length > 0, true)
})

test('websocket runtime plans durable remote update IndexedDB writes', async () => {
  const updateBytes = Uint8Array.from([1, 2, 3])
  const stateBytes = Uint8Array.from([4, 5, 6])
  const updateSha256 = makeSha256Hex(await hashBytesSha256(updateBytes))
  const plan = planSyncRuntimeWebSocketRemoteUpdateIndexedDbWriteTransaction({
    message: {
      type: 'sync-update',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId,
      deviceId: peerDeviceId,
      messageId: makeMessageId('websocket-remote-update-commit-1'),
      docId: fileDocId,
      update: 'AQID',
      updateSha256,
      durableSeq: 15,
    },
    updateBytes,
    actualUpdateSha256: updateSha256,
    appliedState: {
      docId: fileDocId,
      updateBytes,
      stateVectorBase64: btoa(String.fromCharCode(...stateBytes)),
    },
  })

  assert.deepEqual(plan, {
    kind: 'remote-update-apply',
    ydocWrite: {
      kind: 'put',
      storeName: 'file-ydocs',
      key: fileDocId.ydocId,
      value: {
        docId: fileDocId,
        updateBytes,
      },
    },
    remoteCursorWrite: {
      kind: 'put',
      storeName: 'remote-cursors',
      key: `file:${fileDocId.ydocId}`,
      value: {
        docId: fileDocId,
        remoteCursorSeq: 15,
        stateVectorBase64: 'BAUG',
      },
    },
  })
})

test('websocket runtime answers peer sync requests from loaded Yjs docs', async () => {
  const source = new Y.Doc()
  source.getText('body').insert(0, 'local')
  const stateVectorBase64 = btoa(String.fromCharCode(...Y.encodeStateVector(new Y.Doc())))
  const registry = new FakeYDocRegistry([[fileDocId, source]])
  const request = {
    type: 'sync-request',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-answer-request-1'),
    docId: fileDocId,
    stateVector: stateVectorBase64,
  } as const

  const plan = await planSyncRuntimeWebSocketSyncRequestAnswer({
    request,
    deviceId,
    registry,
  })
  assert.equal(plan.ok, true)
  if (plan.ok) {
    assert.equal(plan.message.type, 'sync-update')
    assert.equal(plan.message.deviceId, deviceId)
    assert.equal(plan.message.messageId, request.messageId)
    assert.equal(plan.message.baseStateVector, stateVectorBase64)
    assert.equal(plan.message.durableSeq, undefined)
    assert.equal(plan.message.updateSha256 !== undefined, true)
  }

  const connection = new FakeWebSocketConnection('wss://worker.example/ws/vault')
  connection.open()
  const session = createSyncRuntimeWebSocketSession()
  session.attach(connection)
  const reject = new FakeSyncRequestAnswerRejectPort()
  const port = createSyncRuntimeWebSocketSyncRequestAnswerPort({
    deviceId,
    registry,
    session,
    reject,
  })
  await port.answerSyncRequest(request)

  assert.equal(connection.sent.length, 1)
  const sent = parseControlMessage(connection.sent[0] ?? '')
  assert.equal(sent?.type, 'sync-update')
  assert.deepEqual(reject.rejections, [])
})

test('websocket runtime rejects sync request answers before sending when the doc is not loaded', async () => {
  const connection = new FakeWebSocketConnection('wss://worker.example/ws/vault')
  connection.open()
  const session = createSyncRuntimeWebSocketSession()
  session.attach(connection)
  const reject = new FakeSyncRequestAnswerRejectPort()
  const request = {
    type: 'sync-request',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId,
    deviceId: peerDeviceId,
    messageId: makeMessageId('websocket-answer-request-missing-doc'),
    docId: fileDocId,
    stateVector: 'AQID',
  } as const
  const port = createSyncRuntimeWebSocketSyncRequestAnswerPort({
    deviceId,
    registry: new FakeYDocRegistry([]),
    session,
    reject,
  })

  await port.answerSyncRequest(request)

  assert.deepEqual(connection.sent, [])
  assert.deepEqual(reject.rejections, [{ messageId: request.messageId, reason: 'ydoc-not-loaded' }])
})

class FakeAccessTokenReader implements SyncRuntimeWebSocketAccessTokenReaderPort {
  private readonly values: Map<string, string>

  constructor(entries: readonly (readonly [string, string])[]) {
    this.values = new Map(entries)
  }

  async getAccessToken(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }
}

class FakeOutboxCompletionSnapshotReader implements SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort {
  reads = 0

  constructor(
    private readonly snapshot: {
      readonly outboxRecords: readonly LocalStoreOutboxRecord[]
      readonly leaseRows: readonly OutboxRunningLease[]
    },
  ) {}

  async read(): Promise<{
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  }> {
    this.reads += 1
    return this.snapshot
  }
}

class FakeOutboxCompletionCommitPort implements SyncRuntimeWebSocketOutboxCompletionCommitPort {
  readonly plans: Parameters<SyncRuntimeWebSocketOutboxCompletionCommitPort['commit']>[0][] = []

  async commit(
    plan: Parameters<SyncRuntimeWebSocketOutboxCompletionCommitPort['commit']>[0],
  ): Promise<void> {
    this.plans.push(plan)
  }
}

class FakeRemoteUpdateYDocApplyPort implements SyncRuntimeWebSocketRemoteUpdateYDocApplyPort {
  readonly applied: SyncRuntimeWebSocketRemoteUpdateApplyInput[] = []

  async applyRemoteUpdate(
    input: SyncRuntimeWebSocketRemoteUpdateApplyInput,
  ): Promise<SyncRuntimeWebSocketAppliedYDocState> {
    this.applied.push(input)
    return {
      docId: input.message.docId,
      updateBytes: input.updateBytes,
      stateVectorBase64: 'AQID',
    }
  }
}

class FakeRemoteUpdateCommitPort implements SyncRuntimeWebSocketRemoteUpdateCommitPort {
  readonly committed: Parameters<
    SyncRuntimeWebSocketRemoteUpdateCommitPort['commitRemoteUpdate']
  >[0][] = []

  async commitRemoteUpdate(
    input: Parameters<SyncRuntimeWebSocketRemoteUpdateCommitPort['commitRemoteUpdate']>[0],
  ): Promise<void> {
    this.committed.push(input)
  }
}

class FakeYDocRegistry implements SyncRuntimeWebSocketYDocRegistryPort {
  private readonly docs: { readonly docId: DocId; readonly doc: Y.Doc }[]

  constructor(entries: readonly (readonly [DocId, Y.Doc])[]) {
    this.docs = entries.map(([docId, doc]) => ({ docId, doc }))
  }

  getYDoc(docId: DocId): Y.Doc | undefined {
    return this.docs.find((entry) => sameDocId(entry.docId, docId))?.doc
  }
}

class FakeRemoteUpdateRejectPort implements SyncRuntimeWebSocketRemoteUpdateRejectPort {
  readonly rejections: { readonly messageId: string; readonly reason: string }[] = []

  async rejectRemoteUpdate(
    message: Parameters<SyncRuntimeWebSocketRemoteUpdateRejectPort['rejectRemoteUpdate']>[0],
    reason: Parameters<SyncRuntimeWebSocketRemoteUpdateRejectPort['rejectRemoteUpdate']>[1],
  ): Promise<void> {
    this.rejections.push({ messageId: message.messageId, reason })
  }
}

class FakeSyncRequestAnswerRejectPort implements SyncRuntimeWebSocketSyncRequestAnswerRejectPort {
  readonly rejections: { readonly messageId: string; readonly reason: string }[] = []

  async rejectSyncRequestAnswer(
    request: Parameters<
      SyncRuntimeWebSocketSyncRequestAnswerRejectPort['rejectSyncRequestAnswer']
    >[0],
    reason: Parameters<
      SyncRuntimeWebSocketSyncRequestAnswerRejectPort['rejectSyncRequestAnswer']
    >[1],
  ): Promise<void> {
    this.rejections.push({ messageId: request.messageId, reason })
  }
}

class FakeInboundRoutePorts implements SyncRuntimeWebSocketInboundRoutePorts {
  readonly calls: (
    | { readonly action: 'outbox-completion'; readonly type: 'ack' | 'need-full-snapshot' }
    | { readonly action: 'apply-remote-update'; readonly type: 'sync-update' }
    | { readonly action: 'answer-sync-request'; readonly type: 'sync-request' }
    | { readonly action: 'drop'; readonly reason: string }
  )[] = []

  async completeOutbox(
    message: Parameters<SyncRuntimeWebSocketInboundRoutePorts['completeOutbox']>[0],
  ): Promise<void> {
    this.calls.push({ action: 'outbox-completion', type: message.type })
  }

  async applyRemoteUpdate(
    message: Parameters<SyncRuntimeWebSocketInboundRoutePorts['applyRemoteUpdate']>[0],
  ): Promise<void> {
    this.calls.push({ action: 'apply-remote-update', type: message.type })
  }

  async answerSyncRequest(
    message: Parameters<SyncRuntimeWebSocketInboundRoutePorts['answerSyncRequest']>[0],
  ): Promise<void> {
    this.calls.push({ action: 'answer-sync-request', type: message.type })
  }

  async drop(route: Parameters<SyncRuntimeWebSocketInboundRoutePorts['drop']>[0]): Promise<void> {
    this.calls.push({ action: 'drop', reason: route.reason })
  }
}

function yUpdateRecord(): LocalStoreOutboxRecord {
  return {
    id: yUpdateId,
    kind: 'y-update',
    status: 'retrying',
    dependsOn: [],
    nextAttemptAt: undefined,
    docId: fileDocId,
    messageId,
    updateBytesBase64: 'AQID',
  }
}

function runningLease(): OutboxRunningLease {
  return {
    itemId: yUpdateId,
    kind: 'y-update',
    ownerId: 'worker-1',
    leaseExpiresAt: 30_000,
  }
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

function outboxId(value: string): OutboxPlanItemId {
  const id = makeOutboxPlanItemId(value)
  if (id === null) {
    throw new Error('invalid-outbox-id')
  }
  return id
}

class FakeWebSocketFactory implements SyncRuntimeWebSocketFactoryPort {
  readonly connections: FakeWebSocketConnection[] = []

  connect(url: string, protocols?: string | string[]): SyncRuntimeWebSocketConnection {
    const connection = new FakeWebSocketConnection(url, protocols)
    this.connections.push(connection)
    return connection
  }
}

class FakeWebSocketConnection implements SyncRuntimeWebSocketConnection {
  readyState = 0
  readonly sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  readonly protocols: readonly string[]

  constructor(
    readonly url: string,
    protocols?: string | string[],
  ) {
    this.protocols =
      protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      throw new Error('unexpected-binary-send')
    }
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  message(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}
