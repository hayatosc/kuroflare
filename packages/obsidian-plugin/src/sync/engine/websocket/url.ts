import {
  type SyncRuntimeBrowserWebSocketConstructor,
  type SyncRuntimeWebSocketConnection,
  type SyncRuntimeWebSocketFactoryPort,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketUrlInput,
} from '../../engine/websocket.types'

const OPEN_READY_STATE = 1

/**
 * Builds the browser-compatible worker WebSocket URL for one vault.
 *
 * @param input Worker HTTP endpoint and vault id.
 * @returns `ws:` or `wss:` URL under `/ws/:vaultId`.
 * @throws When the endpoint is not an HTTP(S) URL.
 */
export function buildSyncRuntimeWebSocketUrl(input: SyncRuntimeWebSocketUrlInput): string {
  const url = new URL(input.endpoint)
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else {
    throw new Error('websocket-endpoint-invalid')
  }
  url.pathname = `/ws/${encodeURIComponent(input.vaultId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Builds browser WebSocket subprotocols carrying the short-lived device access token.
 *
 * @param accessToken Compact JWT device access token.
 * @returns Protocol list accepted by the worker WebSocket upgrade path.
 */
export function buildSyncRuntimeWebSocketProtocols(accessToken: string): readonly string[] {
  return ['kuroflare.v1', `kuroflare-token.${accessToken}`]
}

/**
 * Creates a WebSocket factory backed by the browser runtime.
 *
 * @param WebSocketCtor Browser or Electron WebSocket constructor.
 * @returns Factory compatible with the startup WebSocket step port.
 */
export function createBrowserSyncRuntimeWebSocketFactory(
  WebSocketCtor: SyncRuntimeBrowserWebSocketConstructor,
): SyncRuntimeWebSocketFactoryPort {
  return {
    connect(url, protocols) {
      return new BrowserSyncRuntimeWebSocketConnection(new WebSocketCtor(url, protocols))
    },
  }
}

/**
 * Creates a shared active WebSocket session used by startup and background sync ports.
 *
 * @returns Mutable session boundary that hides the concrete socket from composition code.
 */
export function createSyncRuntimeWebSocketSession(): SyncRuntimeWebSocketSessionPort {
  let connection: SyncRuntimeWebSocketConnection | undefined

  return {
    attach(nextConnection) {
      connection = nextConnection
    },
    send(data) {
      if (connection === undefined) {
        throw new Error('websocket-session-missing')
      }
      if (connection.readyState !== OPEN_READY_STATE) {
        throw new Error('websocket-session-not-open')
      }
      connection.send(data)
    },
    close(code, reason) {
      connection?.close(code, reason)
      connection = undefined
    },
    snapshot() {
      return {
        hasConnection: connection !== undefined,
        readyState: connection?.readyState,
      }
    },
  }
}

class BrowserSyncRuntimeWebSocketConnection implements SyncRuntimeWebSocketConnection {
  private openHandler: ((event: Event) => void) | null = null
  private errorHandler: ((event: Event) => void) | null = null
  private closeHandler: ((event: CloseEvent) => void) | null = null
  private messageHandler: ((event: MessageEvent) => void) | null = null

  constructor(private readonly socket: WebSocket) {
    socket.onopen = (event) => {
      this.openHandler?.(event)
    }
    socket.onerror = (event) => {
      this.errorHandler?.(event)
    }
    socket.onclose = (event) => {
      this.closeHandler?.(event)
    }
    socket.onmessage = (event) => {
      this.messageHandler?.(event)
    }
  }

  get readyState(): number {
    return this.socket.readyState
  }

  get onopen(): ((event: Event) => void) | null {
    return this.openHandler
  }

  set onopen(handler: ((event: Event) => void) | null) {
    this.openHandler = handler
  }

  get onerror(): ((event: Event) => void) | null {
    return this.errorHandler
  }

  set onerror(handler: ((event: Event) => void) | null) {
    this.errorHandler = handler
  }

  get onclose(): ((event: CloseEvent) => void) | null {
    return this.closeHandler
  }

  set onclose(handler: ((event: CloseEvent) => void) | null) {
    this.closeHandler = handler
  }

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.messageHandler
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this.messageHandler = handler
  }

  send(data: string | ArrayBuffer): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }
}
