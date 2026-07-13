// @vitest-environment jsdom

import { makeDeviceId, makeVaultId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import {
  createBrowserSyncRuntimeWebSocketFactory,
  createSyncRuntimeWebSocketSession,
  createSyncRuntimeWebSocketStartupStepPort,
} from '../sync/engine/websocket'
import { openWorkerWebSocketRuntime } from './sync-websocket'

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
