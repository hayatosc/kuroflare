import { CURRENT_PROTOCOL_VERSION, type ClientCapability, type ClientHello } from '@kuroflare/core'

import { type SyncRuntimeStartupStepEffect } from '../../engine/actuation'
import { type LocalSetupMetadata } from '../../engine/setup'
import {
  type SyncRuntimeWebSocketConnection,
  type SyncRuntimeWebSocketStartupStepPort,
  type SyncRuntimeWebSocketStepPortInput,
} from '../../engine/websocket.types'
import {
  attachSyncRuntimeWebSocketInboundMessageHandler,
  planSyncRuntimeWebSocketHelloAdmission,
} from './inbound'
import { buildSyncRuntimeWebSocketProtocols, buildSyncRuntimeWebSocketUrl } from './url'

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
      await waitForWebSocketOpen(socket, (issue) => input.onConnectionIssue?.(issue))
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
        (issue) => input.onConnectionIssue?.(issue),
      )
      socket.send(JSON.stringify(hello))
      await admission
      installConnectionIssueHandlers(socket, (issue) => input.onConnectionIssue?.(issue))
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
  notify: (issue: {
    readonly kind: 'close' | 'error'
    readonly code?: number | undefined
    readonly reason?: string | undefined
  }) => void,
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
      notify({ kind: 'error' })
      clear()
      reject(new Error('websocket-hello-admission-failed'))
    }
    socket.onclose = (event) => {
      notify({ kind: 'close', code: event.code, reason: event.reason })
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

async function waitForWebSocketOpen(
  socket: SyncRuntimeWebSocketConnection,
  notify: (issue: {
    readonly kind: 'close' | 'error'
    readonly code?: number | undefined
    readonly reason?: string | undefined
  }) => void,
): Promise<void> {
  if (socket.readyState === OPEN_READY_STATE) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      resolve()
    }
    socket.onerror = () => {
      notify({ kind: 'error' })
      reject(new Error('websocket-open-failed'))
    }
    socket.onclose = (event) => {
      notify({ kind: 'close', code: event.code, reason: event.reason })
      reject(new Error('websocket-closed-before-open'))
    }
  })
}

function installConnectionIssueHandlers(
  socket: SyncRuntimeWebSocketConnection,
  notify: (issue: {
    readonly kind: 'close' | 'error'
    readonly code?: number | undefined
    readonly reason?: string | undefined
  }) => void,
): void {
  socket.onerror = () => notify({ kind: 'error' })
  socket.onclose = (event) => notify({ kind: 'close', code: event.code, reason: event.reason })
}

const OPEN_READY_STATE = 1
