import { type OutboxRunningLease, type OutboxSchedulerStart } from '@kuroflare/core'

import {
  type OutboundQueueAckCompletionPlan,
  type OutboundQueueFailureCompletionPlan,
  type OutboundQueueFullSnapshotReleasePlan,
  type OutboundQueueLeaseAcquirePlan,
  type OutboundQueueLeaseRenewPlan,
  type OutboundQueueQuarantinePausePlan,
  type OutboundQueueSyncUpdateRejectedPausePlan,
  type OutboundQueueSuccessCompletionPlan,
  type OutboundQueueTickPlan,
} from '../../engine/queue'
import {
  type LocalStoreDriverReadSet,
  type LocalStoreDriverWriteOperation,
} from '../../store/driver'
import {
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionApplyPlan,
  type LocalStoreTransactionOperation,
} from '../../store/store'
import {
  type FailedLocalStoreDriverCommitPlan,
  type OutboxWorkerIndexedDbReadOperation,
  type OutboxWorkerIndexedDbWriteOperation,
  type SuccessfulLocalStoreDriverCommitPlan,
} from './base'
import { type OutboxWorkerStartEffect } from './side-effect'

/** Lease acquisition result for one scheduler start candidate. */
export type OutboxWorkerLeaseAttempt =
  | {
      readonly ok: true
      readonly start: OutboxSchedulerStart
      readonly lease: OutboxRunningLease
      readonly previousOwnerId: string | undefined
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly start: OutboxSchedulerStart
      readonly reason:
        | Extract<OutboundQueueLeaseAcquirePlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly leaseAcquire?:
        | Extract<OutboundQueueLeaseAcquirePlan, { readonly ok: false }>
        | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for one outbox worker tick, including persistence and lease acquisition. */
export type OutboxWorkerTickPlan =
  | {
      readonly ok: true
      readonly schedulerOperations: readonly LocalStoreTransactionOperation[]
      readonly schedulerReadSet: LocalStoreDriverReadSet
      readonly schedulerWrites: readonly LocalStoreDriverWriteOperation[]
      readonly schedulerIndexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly schedulerIndexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly schedulerDriverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly schedulerApply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly leaseAttempts: readonly OutboxWorkerLeaseAttempt[]
      readonly starts: readonly OutboxWorkerStartEffect[]
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly authRefresh: Extract<OutboundQueueTickPlan, { readonly ok: true }>['authRefresh']
    }
  | {
      readonly ok: false
      readonly phase: 'scheduler' | 'scheduler-persist'
      readonly reason:
        | Extract<OutboundQueueTickPlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly tick?: Extract<OutboundQueueTickPlan, { readonly ok: false }> | undefined
      readonly schedulerReadSet?: LocalStoreDriverReadSet | undefined
      readonly schedulerIndexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly schedulerDriverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for committing one completed y-update side effect result. */
export type OutboxWorkerCompletionPlan =
  | {
      readonly ok: true
      readonly action:
        | 'ack-completion'
        | 'pause-for-full-snapshot'
        | 'pause-for-quarantine'
        | 'pause-for-sync-update-rejected'
        | 'success-completion'
        | 'retry-after-failure'
        | 'pause-after-failure'
        | 'dead-letter-after-failure'
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly completion: Extract<
        | OutboundQueueAckCompletionPlan
        | OutboundQueueQuarantinePausePlan
        | OutboundQueueSyncUpdateRejectedPausePlan
        | OutboundQueueSuccessCompletionPlan
        | OutboundQueueFailureCompletionPlan,
        { readonly ok: true }
      >
    }
  | {
      readonly ok: false
      readonly phase: 'completion' | 'completion-persist'
      readonly reason:
        | Extract<OutboundQueueAckCompletionPlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueQuarantinePausePlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueSyncUpdateRejectedPausePlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueSuccessCompletionPlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueFailureCompletionPlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly completion?:
        | Extract<
            | OutboundQueueAckCompletionPlan
            | OutboundQueueQuarantinePausePlan
            | OutboundQueueSyncUpdateRejectedPausePlan
            | OutboundQueueSuccessCompletionPlan
            | OutboundQueueFailureCompletionPlan,
            { readonly ok: false }
          >
        | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly indexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for renewing a running outbox worker lease. */
export type OutboxWorkerLeaseRenewalPlan =
  | {
      readonly ok: true
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly renewal: Extract<OutboundQueueLeaseRenewPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly phase: 'renewal' | 'renewal-persist'
      readonly reason:
        | Extract<OutboundQueueLeaseRenewPlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly renewal?: Extract<OutboundQueueLeaseRenewPlan, { readonly ok: false }> | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly indexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for closing outbox y-updates superseded by a full snapshot apply. */
export type OutboxWorkerFullSnapshotReleasePlan =
  | {
      readonly ok: true
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly release: Extract<OutboundQueueFullSnapshotReleasePlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly phase: 'release' | 'release-persist'
      readonly reason:
        | Extract<OutboundQueueFullSnapshotReleasePlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly release?:
        | Extract<OutboundQueueFullSnapshotReleasePlan, { readonly ok: false }>
        | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly indexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** One concrete IndexedDB write transaction the runtime must commit before side effects start. */
export type OutboxWorkerIndexedDbWriteTransaction =
  | {
      readonly kind: 'scheduler-persist'
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'lease-acquire'
      readonly start: OutboxSchedulerStart
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'completion-persist'
      readonly action: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>['action']
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'lease-renew'
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'full-snapshot-release'
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
