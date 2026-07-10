import { type SyncRuntimeWebSocketConnection } from './connection'

/** Snapshot of the active WebSocket session shared by startup, outbox, and inbound runtime ports. */
export interface SyncRuntimeWebSocketSessionSnapshot {
  readonly hasConnection: boolean
  readonly readyState: number | undefined
}

/** Shared active WebSocket session boundary used after startup opens the transport. */
export interface SyncRuntimeWebSocketSessionPort {
  /** Attaches the current WebSocket connection to the shared sync session. */
  attach(connection: SyncRuntimeWebSocketConnection): void
  /** Sends one frame over the active sync WebSocket. */
  send(data: string | ArrayBuffer): void
  /** Closes the attached connection and clears the shared session. */
  close(code?: number, reason?: string): void
  /** Returns connection presence and readyState without exposing token material. */
  snapshot(): SyncRuntimeWebSocketSessionSnapshot
}
