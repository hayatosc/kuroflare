import {
  type ClientHello,
  type DocId,
  type VaultId,
  type Sha256Hex,
} from '@kuroflare/core'
import { VaultIdSchema, DocIdSchema } from '@kuroflare/core'
import * as v from 'valibot'
import { type CheckpointRunStatus } from '../checkpoint/checkpoint'
import { type YClientId } from '../devices'

/** Environment bindings required by the Worker entrypoint. */
export interface WorkerEnv {
  readonly VAULT_ROOM: DurableObjectNamespaceBinding
  readonly SNAPSHOT_BUCKET?: R2BucketBinding
  readonly DEVICE_TOKEN_SECRET?: string
  readonly E2E_SETUP_TOKEN_SECRET?: string
}

/** Minimal Durable Object namespace surface used by the Worker shell. */
export interface DurableObjectNamespaceBinding {
  idFromName(name: string): DurableObjectIdBinding
  get(id: DurableObjectIdBinding): DurableObjectStubBinding
}

/** Opaque Durable Object id returned by the runtime. */
export interface DurableObjectIdBinding {
  readonly toString?: () => string
}

/** Minimal Durable Object stub surface used by the Worker shell. */
export interface DurableObjectStubBinding {
  fetch(request: Request): Response | Promise<Response>
}

/** Minimal Durable Object state surface used by `VaultRoom`. */
export interface DurableObjectStateBinding {
  readonly storage: DurableObjectStorageBinding
  acceptWebSocket(webSocket: RuntimeWebSocket): void
  getWebSockets?(): readonly RuntimeWebSocket[]
}

/** Minimal Durable Object storage surface reserved for op-log wiring. */
export interface DurableObjectStorageBinding {
  readonly sql?: DurableObjectSqlStorageBinding
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  setAlarm?(scheduledTime: number | Date): Promise<void>
  transactionSync?<T>(closure: () => T): T
}

/** Minimal SQLite surface used by the Durable Object runtime shell. */
export interface DurableObjectSqlStorageBinding {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: readonly unknown[]
  ): Iterable<T>
}

/** Minimal R2 bucket surface used by cold-start snapshot hydration. */
export interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBodyBinding | null>
  head(key: string): Promise<R2ObjectMetadataBinding | null>
  list(options: R2ListOptionsBinding): Promise<R2ObjectsBinding>
  put(key: string, value: Uint8Array): Promise<void>
}

/** Minimal R2 object metadata used by blob HEAD planning. */
export interface R2ObjectMetadataBinding {
  readonly size: number
}

/** Minimal R2 object body surface used by cold-start snapshot hydration. */
export interface R2ObjectBodyBinding {
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Minimal R2 list options used by cold-start snapshot fallback. */
export interface R2ListOptionsBinding {
  readonly prefix: string
}

/** Minimal R2 list result used by cold-start snapshot fallback. */
export interface R2ObjectsBinding {
  readonly objects: readonly R2ObjectBinding[]
}

/** Minimal R2 listed object metadata used by cold-start snapshot fallback. */
export interface R2ObjectBinding {
  readonly key: string
}

/** WebSocket methods used by the Worker shell and tests. */
export interface RuntimeWebSocket {
  accept?: () => void
  send(message: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  serializeAttachment?: (attachment: unknown) => void
  deserializeAttachment?: () => unknown
}

export interface RuntimeWebSocketPair {
  readonly 0: RuntimeWebSocket
  readonly 1: RuntimeWebSocket
}

export interface RuntimeWebSocketPairConstructor {
  new (): RuntimeWebSocketPair
}

export interface SessionState {
  readonly vaultId: VaultId
  readonly deviceId: ClientHello['deviceId']
  readonly yClientId: YClientId
}

export interface WebSocketAttachment {
  readonly authToken?: string
  readonly session?: SessionState
}

export interface WebSocketResponseInit extends ResponseInit {
  readonly webSocket: RuntimeWebSocket
}

export interface RuntimeDocClockRecord {
  readonly latestSeq: number
  readonly updatedAt: number
}

export interface RuntimeSnapshotPointerRecord {
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string
}

export interface RuntimeCheckpointRunRecord {
  readonly runId: string
  readonly docId: DocId
  readonly status: CheckpointRunStatus
  readonly upperSeq: number
  readonly snapshotKey: string | undefined
}

export interface RuntimeCheckpointDocRecoveryRecord {
  readonly latestSnapshotSeq: number
  readonly latestSnapshotKey: string | undefined
}

export interface RuntimeCheckpointSnapshotEvidence {
  readonly exists: boolean
  readonly verified: boolean
  readonly stateVector: Uint8Array | undefined
}

/** Result of attempting to checkpoint one active document. */
export type RuntimeCheckpointResult =
  | {
      readonly action: 'checkpointed'
      readonly snapshotKey: string
      readonly upperSeq: number
      readonly compactedSeq: number | undefined
    }
  | {
      readonly action: 'skipped'
      readonly reason:
        | 'runtime-unavailable'
        | 'doc-unavailable'
        | 'invalid-clock'
        | 'no-new-ops'
        | 'hydrate-failed'
    }

export const PosIntSchema = v.pipe(v.number(), v.integer(), v.minValue(1))
export const NonNegIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0))

export const E2eSetupTokenSeedRequestSchema = v.object({
  vaultId: VaultIdSchema,
  setupToken: v.pipe(v.string(), v.minLength(1)),
  expiresInMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400_000))),
})

export const E2eSnapshotSeedRequestSchema = v.object({
  vaultId: VaultIdSchema,
  docId: DocIdSchema,
  update: v.pipe(v.string(), v.minLength(1)),
  latestSeq: v.optional(PosIntSchema),
})
