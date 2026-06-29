import { type OutboxPlanItemId, type OutboxRunningLease } from '@kuroflare/core'
import {
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionApplyPlan,
  type LocalStoreTransactionOperation,
} from './local-store'

/** Snapshot rows an IndexedDB transaction must read before applying local-store operations. */
export interface LocalStoreDriverSnapshot {
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}

/** Minimal object-store keys required to validate and apply a local-store transaction. */
export interface LocalStoreDriverReadSet {
  readonly outboxItemIds: readonly OutboxPlanItemId[]
  readonly leaseItemIds: readonly OutboxPlanItemId[]
}

/** One concrete object-store write a local-store IndexedDB transaction must perform. */
export type LocalStoreDriverWriteOperation =
  | { readonly kind: 'put-outbox-record'; readonly record: LocalStoreOutboxRecord }
  | { readonly kind: 'put-lease-row'; readonly lease: OutboxRunningLease }
  | {
      readonly kind: 'delete-lease-row'
      readonly itemId: OutboxPlanItemId
      readonly expectedLease: OutboxRunningLease
    }

/** Input for applying a local-store transaction through the driver boundary. */
export interface LocalStoreDriverCommitInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly snapshot: LocalStoreDriverSnapshot
}

/** Input for executing the full local-store driver transaction pipeline in memory. */
export interface LocalStoreDriverTransactionInput {
  readonly source: LocalStoreDriverSnapshot
  readonly operations: readonly LocalStoreTransactionOperation[]
}

/** Input for selecting the rows a local-store driver transaction must read. */
export interface LocalStoreDriverSnapshotSelectInput {
  readonly source: LocalStoreDriverSnapshot
  readonly readSet: LocalStoreDriverReadSet
}

/** Input for replaying concrete driver writes onto a local-store snapshot. */
export interface LocalStoreDriverWriteApplyInput {
  readonly snapshot: LocalStoreDriverSnapshot
  readonly writes: readonly LocalStoreDriverWriteOperation[]
}

/** Driver-level commit result after local-store transaction semantics have been applied. */
export type LocalStoreDriverCommitPlan =
  | {
      readonly ok: true
      readonly snapshot: LocalStoreDriverSnapshot
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>
    }

/** Result of applying concrete local-store driver writes to a snapshot. */
export type LocalStoreDriverWriteApplyPlan =
  | { readonly ok: true; readonly snapshot: LocalStoreDriverSnapshot }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate-lease-row'
        | 'duplicate-outbox-record'
        | 'lease-cas-mismatch'
        | 'missing-lease-row'
      readonly itemId: OutboxPlanItemId
    }

/** Result of selecting a transaction snapshot from the driver store snapshot. */
export type LocalStoreDriverSnapshotSelectPlan =
  | { readonly ok: true; readonly snapshot: LocalStoreDriverSnapshot }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate-lease-row'
        | 'duplicate-outbox-record'
        | 'duplicate-read-lease-item'
        | 'duplicate-read-outbox-item'
      readonly itemId: OutboxPlanItemId
    }

/** Result of the full read-set, commit, and write-replay local-store driver transaction pipeline. */
export type LocalStoreDriverTransactionPlan =
  | {
      readonly ok: true
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: true }>
      readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: true }>
      readonly writeApply: Extract<LocalStoreDriverWriteApplyPlan, { readonly ok: true }>
      readonly snapshot: LocalStoreDriverSnapshot
    }
  | {
      readonly ok: false
      readonly phase: 'select'
      readonly reason: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: false }>
    }
  | {
      readonly ok: false
      readonly phase: 'commit'
      readonly reason: Extract<LocalStoreDriverCommitPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: true }>
      readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: false }>
    }
  | {
      readonly ok: false
      readonly phase: 'write'
      readonly reason: Extract<LocalStoreDriverWriteApplyPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: true }>
      readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: true }>
      readonly writeApply: Extract<LocalStoreDriverWriteApplyPlan, { readonly ok: false }>
    }
