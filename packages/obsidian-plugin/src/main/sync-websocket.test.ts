// @vitest-environment jsdom

import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { assert, expect, test } from 'vitest'

import {
  createBrowserSyncRuntimeWebSocketFactory,
  createSyncRuntimeWebSocketSession,
  createSyncRuntimeWebSocketStartupStepPort,
} from '../sync/engine/websocket'
import {
  openWorkerWebSocketRuntime,
  isLegacyMetadataCapabilityError,
  requestDocFromWorker,
  routeWorkerInboundMessageForStartup,
  shouldRetryWithLegacyMetadataCapability,
  type WorkerWebSocketOpenRuntime,
} from './sync-websocket'

test('requestDocFromWorker reports a closed socket without leaving a pending request', async () => {
  const plugin = {
    startupSideEffectGate: { canSendNetwork: () => true },
    workerHelloAccepted: true,
    workerWebSocketSession: {
      attach: () => {},
      send: () => {},
      close: () => {},
      snapshot: () => ({ hasConnection: false, readyState: WebSocket.CLOSED }),
    },
    pendingSetupResponse: null,
    trustedSetupMetadata: null,
    kuroflareSettings: { setupMetadata: undefined, setupVaultId: '' },
    pendingSyncRequestMessageIds: new Set<string>(),
    workerMessageCounter: 0,
  }

  assert.equal(
    await requestDocFromWorker(
      plugin,
      { kind: 'file', ydocId: makeYDocId('closed-request') },
      new Uint8Array(),
      'closed-request-test',
    ),
    false,
  )
})

class FakeBrowserWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeBrowserWebSocket[] = []

  readyState = FakeBrowserWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closeCalls = 0

  constructor(
    readonly url: string | URL,
    _protocols?: string | string[],
  ) {
    FakeBrowserWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeBrowserWebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  send(_data: string | ArrayBuffer): void {}

  close(): void {
    this.closeCalls += 1
    this.readyState = FakeBrowserWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

class LegacyRejectingBrowserWebSocket extends FakeBrowserWebSocket {
  override send(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return
    const message: unknown = JSON.parse(data)
    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message) ||
      Reflect.get(message, 'type') !== 'hello'
    ) {
      return
    }
    const index = FakeBrowserWebSocket.instances.indexOf(this)
    if (index === 0) {
      this.readyState = FakeBrowserWebSocket.CLOSED
      this.onclose?.(new CloseEvent('close', { code: 1003, reason: 'invalid-control-message' }))
      return
    }
    this.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'hello-accepted',
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          vaultId: makeVaultId('legacy-runtime-vault'),
          deviceId: makeDeviceId('legacy-runtime-device'),
          yClientId: 1,
        }),
      }),
    )
  }
}

async function withFakeWebSocket<T>(run: () => Promise<T>): Promise<T> {
  const previousWebSocket = globalThis.WebSocket
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeBrowserWebSocket,
  })
  try {
    return await run()
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    })
  }
}

function createTestRuntime(
  ensureUsableAccessToken: () => Promise<boolean>,
  events: string[],
): WorkerWebSocketOpenRuntime {
  const setup = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('preflight-vault'),
    deviceId: makeDeviceId('preflight-device'),
    yClientId: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  } as const
  const session = createSyncRuntimeWebSocketSession()
  const runtime = {
    startupSideEffectGate: { canSendNetwork: () => true },
    syncStoppedByAuth: null,
    workerWebSocketOpenPromise: null,
    workerWebSocketSession: session,
    workerWebSocketStartupPort: null,
    workerHelloAccepted: false,
    setup,
    ensureUsableAccessToken,
    createStartupPort: () => {
      events.push('create-startup-port')
      return createSyncRuntimeWebSocketStartupStepPort({
        metadata: { setup, accessTokenSecretKey: 'access-token-key' },
        tokenReader: { getAccessToken: async () => 'access-token' },
        webSocket: createBrowserSyncRuntimeWebSocketFactory(FakeBrowserWebSocket),
        capabilities: [],
        session,
      })
    },
  }
  return runtime
}

test('concurrent worker websocket opens share one session and preserve the hello connection', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const previousWebSocket = globalThis.WebSocket
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeBrowserWebSocket,
  })

  const setup = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('concurrent-open-vault'),
    deviceId: makeDeviceId('concurrent-open-device'),
    yClientId: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  } as const
  const session = createSyncRuntimeWebSocketSession()
  const runtime = {
    startupSideEffectGate: { canSendNetwork: () => true },
    syncStoppedByAuth: null,
    workerWebSocketOpenPromise: null,
    workerWebSocketSession: session,
    workerWebSocketStartupPort: null,
    workerHelloAccepted: false,
    ensureUsableAccessToken: async () => true,
    setup,
    createStartupPort: () =>
      createSyncRuntimeWebSocketStartupStepPort({
        metadata: { setup, accessTokenSecretKey: 'access-token-key' },
        tokenReader: { getAccessToken: async () => 'access-token' },
        webSocket: createBrowserSyncRuntimeWebSocketFactory(FakeBrowserWebSocket),
        capabilities: [],
        session,
      }),
  }

  let helloCalls = 0
  const sendHello = async (): Promise<void> => {
    helloCalls += 1
    await Promise.resolve()
    runtime.workerHelloAccepted = true
  }

  try {
    await Promise.all([
      openWorkerWebSocketRuntime(runtime, sendHello),
      openWorkerWebSocketRuntime(runtime, sendHello),
    ])
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: previousWebSocket,
    })
  }

  assert.equal(FakeBrowserWebSocket.instances.length, 1)
  assert.equal(FakeBrowserWebSocket.instances[0]?.closeCalls, 0)
  assert.equal(runtime.workerWebSocketSession.snapshot().readyState, FakeBrowserWebSocket.OPEN)
  assert.equal(helloCalls, 1)
})

test('expired token refresh completes before startup port creation', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const events: string[] = []
  const runtime = createTestRuntime(async () => {
    events.push('refresh')
    await Promise.resolve()
    return true
  }, events)

  await withFakeWebSocket(async () => {
    await openWorkerWebSocketRuntime(runtime, async () => {
      events.push('hello')
      runtime.workerHelloAccepted = true
    })
  })

  assert.deepEqual(events, ['refresh', 'create-startup-port', 'hello'])
  assert.equal(FakeBrowserWebSocket.instances.length, 1)
})

test('fresh token opens without a refresh attempt', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const events: string[] = []
  let preflightCalls = 0
  const runtime = createTestRuntime(async () => {
    preflightCalls += 1
    events.push('fresh-token-check')
    return true
  }, events)

  await withFakeWebSocket(async () => {
    await openWorkerWebSocketRuntime(runtime, async () => {
      events.push('hello')
      runtime.workerHelloAccepted = true
    })
  })

  assert.equal(preflightCalls, 1)
  assert.deepEqual(events, ['fresh-token-check', 'create-startup-port', 'hello'])
  assert.equal(FakeBrowserWebSocket.instances.length, 1)
})

test('hello acceptance without metadata access defaults the client to read-only', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const setup = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('hello-compat-vault'),
    deviceId: makeDeviceId('hello-compat-device'),
    yClientId: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  } as const
  const session = createSyncRuntimeWebSocketSession()
  let metadataAccess: 'read-only' | 'read-write' = 'read-only'
  const port = createSyncRuntimeWebSocketStartupStepPort({
    metadata: { setup, accessTokenSecretKey: 'access-token-key' },
    tokenReader: { getAccessToken: async () => 'access-token' },
    webSocket: createBrowserSyncRuntimeWebSocketFactory(FakeBrowserWebSocket),
    capabilities: ['metadata-schema-v2'],
    onHelloAccepted: (message) => {
      metadataAccess = message.metadataAccess ?? 'read-only'
    },
    session,
  })

  await withFakeWebSocket(async () => {
    await port.openWebSocket({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'open-websocket',
      phase: 'websocket',
    })
    const admitted = port.sendClientHello({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'send-client-hello',
      phase: 'websocket',
    })
    const connection = FakeBrowserWebSocket.instances[0]
    assert(connection !== undefined)
    connection.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'hello-accepted',
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
          yClientId: setup.yClientId,
        }),
      }),
    )
    await admitted
  })

  assert.equal(metadataAccess, 'read-only')
})

test('invalid-control close triggers one legacy capability retry', () => {
  assert.equal(
    shouldRetryWithLegacyMetadataCapability(
      { metadataCapabilityAdvertised: true, metadataCapabilityFallbackAttempted: false },
      { kind: 'close', code: 1003, reason: 'invalid-control-message' },
    ),
    true,
  )
  assert.equal(
    shouldRetryWithLegacyMetadataCapability(
      { metadataCapabilityAdvertised: false, metadataCapabilityFallbackAttempted: false },
      { kind: 'close', code: 1003, reason: 'invalid-control-message' },
    ),
    false,
  )
})

test('worker websocket open retries legacy metadata capability within the original promise', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const setup = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('legacy-runtime-vault'),
    deviceId: makeDeviceId('legacy-runtime-device'),
    yClientId: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  } as const
  const session = createSyncRuntimeWebSocketSession()
  let advertised = true
  let fallbackAttempted = false
  const capabilities: string[][] = []
  const runtime: WorkerWebSocketOpenRuntime = {
    startupSideEffectGate: { canSendNetwork: () => true },
    syncStoppedByAuth: null,
    workerWebSocketOpenPromise: null,
    workerWebSocketSession: session,
    workerWebSocketStartupPort: null,
    workerHelloAccepted: false,
    setup,
    ensureUsableAccessToken: async () => true,
    createStartupPort: () =>
      createSyncRuntimeWebSocketStartupStepPort({
        metadata: { setup, accessTokenSecretKey: 'access-token-key' },
        tokenReader: { getAccessToken: async () => 'access-token' },
        webSocket: createBrowserSyncRuntimeWebSocketFactory(LegacyRejectingBrowserWebSocket),
        capabilities: advertised
          ? ['binary-v1', 'awareness', 'metadata-schema-v2']
          : ['binary-v1', 'awareness'],
        session,
      }),
    shouldRetryLegacyMetadataCapability: (error) =>
      !fallbackAttempted && advertised && isLegacyMetadataCapabilityError(error),
    onLegacyMetadataCapabilityFallback: () => {
      fallbackAttempted = true
      advertised = false
    },
  }

  await openWorkerWebSocketRuntime(runtime, async () => {
    const port = runtime.workerWebSocketStartupPort
    assert(port)
    const accepted = port.sendClientHello({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'send-client-hello',
      phase: 'websocket',
    })
    capabilities.push([...(port.snapshot().hello?.capabilities ?? [])])
    await accepted
    runtime.workerHelloAccepted = true
  })

  assert.equal(FakeBrowserWebSocket.instances.length, 2)
  assert.deepEqual(capabilities, [
    ['binary-v1', 'awareness', 'metadata-schema-v2'],
    ['binary-v1', 'awareness'],
  ])
  assert.equal(fallbackAttempted, true)
  assert.equal(runtime.workerHelloAccepted, true)
})

test('legacy capability retry sends a second hello without the v2 capability', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const setup = {
    endpoint: 'https://worker.example.test',
    vaultId: makeVaultId('legacy-retry-vault'),
    deviceId: makeDeviceId('legacy-retry-device'),
    yClientId: 1,
    protocolVersion: 1,
    bootstrapMode: 'new-vault',
    tokenVersion: 1,
  } as const
  const session = createSyncRuntimeWebSocketSession()
  const open = async (
    capabilities: readonly ('binary-v1' | 'awareness' | 'metadata-schema-v2')[],
  ) => {
    const port = createSyncRuntimeWebSocketStartupStepPort({
      metadata: { setup, accessTokenSecretKey: 'access-token-key' },
      tokenReader: { getAccessToken: async () => 'access-token' },
      webSocket: createBrowserSyncRuntimeWebSocketFactory(FakeBrowserWebSocket),
      capabilities,
      session,
    })
    await port.openWebSocket({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'open-websocket',
      phase: 'websocket',
    })
    const accepted = port.sendClientHello({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'send-client-hello',
      phase: 'websocket',
    })
    const connection = FakeBrowserWebSocket.instances.at(-1)
    assert(connection)
    connection.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'hello-accepted',
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
          yClientId: setup.yClientId,
        }),
      }),
    )
    await accepted
    return port.snapshot().hello?.capabilities
  }

  await withFakeWebSocket(async () => {
    const first = await open(['binary-v1', 'awareness', 'metadata-schema-v2'])
    const second = await open(['binary-v1', 'awareness'])
    assert.deepEqual(first, ['binary-v1', 'awareness', 'metadata-schema-v2'])
    assert.deepEqual(second, ['binary-v1', 'awareness'])
    assert.equal(FakeBrowserWebSocket.instances.length, 2)
  })
})

test('worker websocket close recovery waits only for guarded outbox completion handling', async () => {
  const run = async (data: string, waitsForInbound: boolean): Promise<void> => {
    FakeBrowserWebSocket.instances.length = 0
    const setup = {
      endpoint: 'https://worker.example.test',
      vaultId: makeVaultId(`completion-order-${waitsForInbound ? 'completion' : 'remote'}`),
      deviceId: makeDeviceId('completion-order-device'),
      yClientId: 1,
      protocolVersion: 1,
      bootstrapMode: 'new-vault',
      tokenVersion: 1,
    } as const
    const session = createSyncRuntimeWebSocketSession()
    const issues: string[] = []
    let releaseInbound!: () => void
    const inboundFinished = new Promise<void>((resolve) => {
      releaseInbound = resolve
    })
    let started = false
    const port = createSyncRuntimeWebSocketStartupStepPort({
      metadata: { setup, accessTokenSecretKey: 'access-token-key' },
      tokenReader: { getAccessToken: async () => 'access-token' },
      webSocket: createBrowserSyncRuntimeWebSocketFactory(FakeBrowserWebSocket),
      capabilities: [],
      session,
      onConnectionIssue: (issue) => issues.push(issue.kind),
      onInboundMessage: (message) =>
        routeWorkerInboundMessageForStartup(message, async () => {
          started = true
          await inboundFinished
        }),
    })

    await port.openWebSocket({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'open-websocket',
      phase: 'websocket',
    })
    const connection = FakeBrowserWebSocket.instances[0]
    assert(connection !== undefined)
    const admitted = port.sendClientHello({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'send-client-hello',
      phase: 'websocket',
    })
    connection.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'hello-accepted',
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
          yClientId: setup.yClientId,
        }),
      }),
    )
    await admitted

    connection.onmessage?.(new MessageEvent('message', { data }))
    await Promise.resolve()
    assert.equal(started, true)
    connection.close()
    if (waitsForInbound) {
      assert.deepEqual(issues, [])
    } else {
      assert.deepEqual(issues, ['close'])
    }

    releaseInbound()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (waitsForInbound) {
      assert.deepEqual(issues, ['close'])
    }
  }

  await run('{', false)
  await run(
    JSON.stringify({
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('completion-order-completion'),
      deviceId: makeDeviceId('completion-order-device'),
      messageId: makeMessageId('completion-order-message'),
      docId: { kind: 'file', ydocId: makeYDocId('completion-order-doc') },
      durableSeq: 1,
    }),
    true,
  )
})

test('failed token refresh blocks startup port and socket creation', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const events: string[] = []
  const runtime = createTestRuntime(async () => {
    events.push('refresh-failed')
    return false
  }, events)
  let helloCalls = 0

  await withFakeWebSocket(async () => {
    await expect(
      openWorkerWebSocketRuntime(runtime, async () => {
        helloCalls += 1
      }),
    ).rejects.toThrow('websocket-access-token-unusable')
  })

  assert.deepEqual(events, ['refresh-failed'])
  assert.equal(runtime.workerWebSocketStartupPort, null)
  assert.equal(FakeBrowserWebSocket.instances.length, 0)
  assert.equal(helloCalls, 0)
})

test('auth block committed during preflight prevents socket creation', async () => {
  FakeBrowserWebSocket.instances.length = 0
  const events: string[] = []
  let runtime: WorkerWebSocketOpenRuntime
  runtime = createTestRuntime(async () => {
    events.push('preflight')
    runtime.syncStoppedByAuth = 'revoked'
    return true
  }, events)
  let helloCalls = 0

  await withFakeWebSocket(async () => {
    await openWorkerWebSocketRuntime(runtime, async () => {
      helloCalls += 1
    })
  })

  assert.deepEqual(events, ['preflight'])
  assert.equal(runtime.workerWebSocketStartupPort, null)
  assert.equal(FakeBrowserWebSocket.instances.length, 0)
  assert.equal(helloCalls, 0)
})
