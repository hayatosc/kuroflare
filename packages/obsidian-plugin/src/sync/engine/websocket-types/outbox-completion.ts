import { type ControlMessage, type OutboxRunningLease } from '@kuroflare/core'

import { type OutboxWorkerCompletionPlan } from '../../engine/worker'
import { type LocalStoreOutboxRecord } from '../../store/store'

/** Snapshot needed to commit one inbound WebSocket outbox completion. */
export interface SyncRuntimeWebSocketOutboxCompletionSnapshot {
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}

/** Port that reads the current local outbox state before committing an inbound ack. */
export interface SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort {
  /** Reads the current outbox records and running leases needed for completion planning. */
  read(): Promise<SyncRuntimeWebSocketOutboxCompletionSnapshot>
}

/** Port that durably commits a successful inbound outbox completion plan. */
export type SyncRuntimeWebSocketOutboxCompletionCommitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export interface SyncRuntimeWebSocketOutboxCompletionCommitPort {
  /** Commits a successful completion plan to the local store. */
  commit(
    plan: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>,
  ): Promise<void | SyncRuntimeWebSocketOutboxCompletionCommitResult>
}

/** Input for planning one inbound WebSocket outbox completion. */
export interface SyncRuntimeWebSocketOutboxCompletionInput {
  readonly message: Extract<
    ControlMessage,
    { readonly type: 'ack' | 'need-full-snapshot' | 'sync-update-rejected' }
  >
  readonly ownerId: string
  readonly now: number
  readonly snapshot: SyncRuntimeWebSocketOutboxCompletionSnapshot
  readonly minDurableSeqExclusive?: number | undefined
}

/** Result of matching and planning one inbound outbox completion. */
export type SyncRuntimeWebSocketOutboxCompletionPlan =
  | {
      readonly ok: true
      readonly record: LocalStoreOutboxRecord
      readonly completion: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason:
        | 'matching-outbox-record-not-found'
        | 'ambiguous-matching-outbox-record'
        | Extract<OutboxWorkerCompletionPlan, { readonly ok: false }>['reason']
      readonly candidates: readonly LocalStoreOutboxRecord[]
      readonly completion?: Extract<OutboxWorkerCompletionPlan, { readonly ok: false }> | undefined
    }

/** Input for creating the inbound outbox completion dispatch port. */
export interface SyncRuntimeWebSocketOutboxCompletionPortInput {
  readonly ownerId: string
  readonly now: () => number
  readonly snapshot: SyncRuntimeWebSocketOutboxCompletionSnapshotReaderPort
  readonly commit: SyncRuntimeWebSocketOutboxCompletionCommitPort
  readonly minDurableSeqExclusive?: number | undefined
}
