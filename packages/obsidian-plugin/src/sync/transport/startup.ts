import {
  CURRENT_PROTOCOL_VERSION,
  type ClientCapability,
  type ClientHello,
  type HelloAccepted,
} from '@kuroflare/core'

import { type SyncRuntimeStartupStepEffect } from '../engine/actuation'
import { type SyncRuntimeWebSocketStepPort } from '../engine/actuation.types'
import { type LocalSetupMetadata } from '../engine/setup'
import {
  type SyncRuntimeWebSocketInboundMessageHandler,
  attachSyncRuntimeWebSocketInboundMessageHandler,
  planSyncRuntimeWebSocketHelloAdmission,
} from './inbound'
import {
  type SyncRuntimeWebSocketConnection,
  type SyncRuntimeWebSocketAccessTokenReaderPort,
  type SyncRuntimeWebSocketFactoryPort,
  type SyncRuntimeWebSocketSessionPort,
} from './socket'
import { buildSyncRuntimeWebSocketProtocols, buildSyncRuntimeWebSocketUrl } from './socket'

/** Trusted startup metadata needed to open the authenticated sync WebSocket. */
export interface SyncRuntimeWebSocketStartupMetadata {
  readonly setup: LocalSetupMetadata
  readonly accessTokenSecretKey: string
}

/** Input for creating the startup WebSocket step port. */
export interface SyncRuntimeWebSocketStepPortInput {
  readonly metadata: SyncRuntimeWebSocketStartupMetadata
  readonly tokenReader: SyncRuntimeWebSocketAccessTokenReaderPort
  readonly webSocket: SyncRuntimeWebSocketFactoryPort
  readonly capabilities?: readonly ClientCapability[] | undefined
  readonly onInboundMessage?: SyncRuntimeWebSocketInboundMessageHandler | undefined
  readonly onHelloAccepted?: ((message: HelloAccepted) => void) | undefined
  /** Notifies the host when an authenticated connection closes or errors. */
  readonly onConnectionIssue?:
    | ((issue: {
        readonly kind: 'close' | 'error'
        readonly code?: number | undefined
        readonly reason?: string | undefined
      }) => void)
    | undefined
  readonly session?: SyncRuntimeWebSocketSessionPort | undefined
}

/** Observable state captured by the WebSocket startup step port. */
export interface SyncRuntimeWebSocketStepPortState {
  readonly connectionUrl: string | undefined
  readonly hello: ClientHello | undefined
  readonly socketReadyState: number | undefined
}

/** WebSocket step port plus observable state for tests and lifecycle logging. */
export interface SyncRuntimeWebSocketStartupStepPort extends SyncRuntimeWebSocketStepPort {
  /** Returns current WebSocket startup state without exposing token material. */
  snapshot(): SyncRuntimeWebSocketStepPortState
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
  let inboundHandlers: Promise<void> | undefined
  let pendingInboundHandlers = 0

  const notifyConnectionIssue = (issue: {
    readonly kind: 'close' | 'error'
    readonly code?: number | undefined
    readonly reason?: string | undefined
  }): void => {
    const notify = (): void => {
      try {
        input.onConnectionIssue?.(issue)
      } catch (error: unknown) {
        console.warn('[kuroflare] websocket connection issue handler failed', { error })
      }
    }
    if (pendingInboundHandlers === 0) {
      notify()
      return
    }
    void inboundHandlers?.then(notify, notify)
  }

  const enqueueInboundMessage = (
    message: Parameters<NonNullable<typeof input.onInboundMessage>>[0],
  ): void => {
    pendingInboundHandlers += 1
    const logHandlerError = (error: unknown): void => {
      console.warn('[kuroflare] websocket inbound message handler failed', { error })
    }
    const complete = (): void => {
      pendingInboundHandlers -= 1
      if (pendingInboundHandlers === 0) {
        inboundHandlers = undefined
      }
    }
    const runQueued = (): Promise<void> => {
      try {
        return Promise.resolve(input.onInboundMessage?.(message)).catch(logHandlerError)
      } catch (error: unknown) {
        logHandlerError(error)
        return Promise.resolve()
      }
    }

    if (inboundHandlers !== undefined) {
      inboundHandlers = inboundHandlers.then(runQueued, runQueued).finally(complete)
      return
    }

    try {
      const result = input.onInboundMessage?.(message)
      if (result === undefined) {
        complete()
        return
      }
      inboundHandlers = Promise.resolve(result).catch(logHandlerError).finally(complete)
    } catch (error: unknown) {
      logHandlerError(error)
      complete()
    }
  }

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
        if (pendingHelloAdmission === undefined) {
          enqueueInboundMessage(message)
          return
        }
        const admission = planSyncRuntimeWebSocketHelloAdmission({
          inbound: message,
          metadata: input.metadata.setup,
        })
        if (admission.action === 'accepted') {
          input.onHelloAccepted?.(admission.message)
          const pending = pendingHelloAdmission
          pendingHelloAdmission = undefined
          pending.resolve()
          return
        }
        const pending = pendingHelloAdmission
        pendingHelloAdmission = undefined
        pending.reject(new Error(`websocket-hello-admission:${admission.reason}`))
      })
      await waitForWebSocketOpen(socket, notifyConnectionIssue)
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
        notifyConnectionIssue,
      )
      socket.send(JSON.stringify(hello))
      await admission
      installConnectionIssueHandlers(socket, notifyConnectionIssue)
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
      reject(new Error(`websocket-closed-before-hello-accepted:${event.code}:${event.reason}`))
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
