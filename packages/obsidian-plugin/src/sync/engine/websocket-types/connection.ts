import { type ClientCapability, type ClientHello } from '@kuroflare/core'

import { type LocalSetupMetadata } from '../../engine/setup'
import { type SyncRuntimeWebSocketInboundMessageHandler } from './route'
import { type SyncRuntimeWebSocketSessionPort } from './session'

/** Minimal WebSocket surface needed by startup transport steps. */
export interface SyncRuntimeWebSocketConnection {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  /** Sends one control or binary frame to the worker. */
  send(data: string | ArrayBuffer): void
  /** Closes the socket when startup is torn down or retried. */
  close(code?: number, reason?: string): void
}

/** Factory for browser or fake WebSocket connections. */
export interface SyncRuntimeWebSocketFactoryPort {
  /**
   * Opens a WebSocket for the given URL.
   *
   * @param url Browser-compatible WebSocket URL.
   * @param protocols Optional WebSocket subprotocols sent during upgrade.
   * @returns A connection whose open/error events can be observed by the runtime.
   */
  connect(url: string, protocols?: string | string[]): SyncRuntimeWebSocketConnection
}

/** Browser WebSocket constructor accepted by the concrete runtime factory. */
export interface SyncRuntimeBrowserWebSocketConstructor {
  /** Creates a browser WebSocket for the given URL. */
  new (url: string, protocols?: string | string[]): SyncRuntimeWebSocketConnection
}

/** SecretStorage reader used to obtain the current access token without exposing refresh tokens. */
export interface SyncRuntimeWebSocketAccessTokenReaderPort {
  /**
   * Reads the current device access token.
   *
   * @param key SecretStorage key from trusted auth metadata.
   * @returns The access token, or undefined when local auth metadata is stale.
   */
  getAccessToken(key: string): Promise<string | undefined>
}

/** Trusted startup metadata needed to open the authenticated sync WebSocket. */
export interface SyncRuntimeWebSocketStartupMetadata {
  readonly setup: LocalSetupMetadata
  readonly accessTokenSecretKey: string
}

/** Input for building a browser-compatible worker WebSocket URL. */
export interface SyncRuntimeWebSocketUrlInput {
  readonly endpoint: string
  readonly vaultId: LocalSetupMetadata['vaultId']
}

/** Input for creating the startup WebSocket step port. */
export interface SyncRuntimeWebSocketStepPortInput {
  readonly metadata: SyncRuntimeWebSocketStartupMetadata
  readonly tokenReader: SyncRuntimeWebSocketAccessTokenReaderPort
  readonly webSocket: SyncRuntimeWebSocketFactoryPort
  readonly capabilities?: readonly ClientCapability[] | undefined
  readonly onInboundMessage?: SyncRuntimeWebSocketInboundMessageHandler | undefined
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
