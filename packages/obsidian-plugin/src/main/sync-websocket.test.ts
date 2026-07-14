// @vitest-environment jsdom

import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import { assert, expect, test } from 'vitest'

import {
  createBrowserSyncRuntimeWebSocketFactory,
  createSyncRuntimeWebSocketSession,
  createSyncRuntimeWebSocketStartupStepPort,
} from '../sync/engine/websocket'
import { openWorkerWebSocketRuntime, type WorkerWebSocketOpenRuntime } from './sync-websocket'

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

  send(): void {}

  close(): void {
    this.closeCalls += 1
    this.readyState = FakeBrowserWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
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
