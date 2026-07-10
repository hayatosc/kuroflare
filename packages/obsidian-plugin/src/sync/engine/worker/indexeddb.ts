import {
  type OutboxWorkerCompletionPlan,
  type OutboxWorkerFullSnapshotReleasePlan,
  type OutboxWorkerIndexedDbWriteTransaction,
  type OutboxWorkerLeaseRenewalPlan,
  type OutboxWorkerTickPlan,
} from '../../engine/worker.types'
import { isSuccessfulOutboxWorkerLeaseAttempt } from './side-effect-plan'

/**
 * Splits a successful worker tick into ordered concrete IndexedDB write transactions.
 *
 * @param plan Successful outbox worker tick plan.
 * @returns Scheduler persistence first, followed by one transaction per acquired lease.
 */
export function planOutboxWorkerTickIndexedDbWriteTransactions(
  plan: Extract<OutboxWorkerTickPlan, { readonly ok: true }>,
): readonly OutboxWorkerIndexedDbWriteTransaction[] {
  return [
    { kind: 'scheduler-persist', writes: plan.schedulerIndexedDbWrites },
    ...plan.leaseAttempts.filter(isSuccessfulOutboxWorkerLeaseAttempt).map(
      (attempt): OutboxWorkerIndexedDbWriteTransaction => ({
        kind: 'lease-acquire',
        start: attempt.start,
        writes: attempt.indexedDbWrites,
      }),
    ),
  ]
}

/**
 * Converts a successful completion plan into the single concrete IndexedDB write transaction.
 *
 * @param plan Successful side-effect completion plan.
 * @returns Completion persistence transaction containing item patch and lease release writes.
 */
export function planOutboxWorkerCompletionIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'completion-persist', action: plan.action, writes: plan.indexedDbWrites }
}

/**
 * Converts a successful lease renewal plan into the concrete IndexedDB write transaction.
 *
 * @param plan Successful renewal plan for one running side effect.
 * @returns Lease-renew persistence transaction containing the CAS lease put.
 */
export function planOutboxWorkerLeaseRenewalIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerLeaseRenewalPlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'lease-renew', writes: plan.indexedDbWrites }
}

/**
 * Converts a successful full snapshot release plan into the concrete IndexedDB write transaction.
 *
 * @param plan Successful release plan after applying a full snapshot.
 * @returns Full-snapshot release persistence transaction containing terminal outbox patches.
 */
export function planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'full-snapshot-release', writes: plan.indexedDbWrites }
}
