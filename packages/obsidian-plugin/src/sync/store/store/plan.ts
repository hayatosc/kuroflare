import { type OutboundQueueLeaseDelete, type OutboundQueueLeaseWrite } from '../../engine/queue'
import {
  type LocalStoreTransactionOperation,
  type SuccessfulOutboundQueueAckCompletionPlan,
  type SuccessfulOutboundQueueFailureCompletionPlan,
  type SuccessfulOutboundQueueFullSnapshotReleasePlan,
  type SuccessfulOutboundQueueLeaseAcquirePlan,
  type SuccessfulOutboundQueueLeaseReleasePlan,
  type SuccessfulOutboundQueueLeaseRenewPlan,
  type SuccessfulOutboundQueueQuarantinePausePlan,
  type SuccessfulOutboundQueueSuccessCompletionPlan,
  type SuccessfulOutboundQueueTickPlan,
} from '../../store/store.types'

export function planLocalStoreOutboxSchedulerTransaction(
  plan: SuccessfulOutboundQueueTickPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    ...plan.persist.resumePatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'resume', patch },
      }),
    ),
    ...plan.persist.blockPatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'dependency-block', patch },
      }),
    ),
    ...plan.persist.deadLetterPatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'dependency-dead-letter', patch },
      }),
    ),
    ...plan.persist.leaseReclaims.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'lease-reclaim', patch },
      }),
    ),
  ]
}

export function planLocalStoreLeaseAcquireTransaction(
  plan: SuccessfulOutboundQueueLeaseAcquirePlan,
): readonly LocalStoreTransactionOperation[] {
  return [putLeaseOperation(plan.write)]
}

export function planLocalStoreLeaseRenewTransaction(
  plan: SuccessfulOutboundQueueLeaseRenewPlan,
): readonly LocalStoreTransactionOperation[] {
  return [putLeaseOperation(plan.write)]
}

export function planLocalStoreLeaseReleaseTransaction(
  plan: SuccessfulOutboundQueueLeaseReleasePlan,
): readonly LocalStoreTransactionOperation[] {
  return [deleteLeaseOperation(plan.delete)]
}

export function planLocalStoreAckCompletionTransaction(
  plan: SuccessfulOutboundQueueAckCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'ack-completion',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

export function planLocalStoreQuarantinePauseTransaction(
  plan: SuccessfulOutboundQueueQuarantinePausePlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'quarantine-pause',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

export function planLocalStoreFailureCompletionTransaction(
  plan: SuccessfulOutboundQueueFailureCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'failure-completion',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

export function planLocalStoreSuccessCompletionTransaction(
  plan: SuccessfulOutboundQueueSuccessCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'success-completion',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

export function planLocalStoreFullSnapshotReleaseTransaction(
  plan: SuccessfulOutboundQueueFullSnapshotReleasePlan,
): readonly LocalStoreTransactionOperation[] {
  return plan.releasePatches.map(
    (patch): LocalStoreTransactionOperation => ({
      kind: 'patch-outbox',
      patch: { kind: 'full-snapshot-release', patch },
    }),
  )
}

function putLeaseOperation(write: OutboundQueueLeaseWrite): LocalStoreTransactionOperation {
  return {
    kind: 'lease',
    operation: { kind: 'put-lease', write },
  }
}

function deleteLeaseOperation(
  deletePlan: OutboundQueueLeaseDelete,
): LocalStoreTransactionOperation {
  return {
    kind: 'lease',
    operation: { kind: 'delete-lease', delete: deletePlan },
  }
}
