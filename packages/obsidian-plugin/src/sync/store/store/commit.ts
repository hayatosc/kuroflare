import { type OutboxPlanItemId, type OutboxRunningLease } from '@kuroflare/core'

import { type OutboundQueueLeaseDelete, type OutboundQueueLeaseWrite } from '../../engine/queue'
import {
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionCommitInput,
  type LocalStoreTransactionCommitPlan,
} from '../../store/store.types'
import { localStoreOutboxPatchItemId } from './patch'

export function planLocalStoreTransactionCommit(
  input: LocalStoreTransactionCommitInput,
): LocalStoreTransactionCommitPlan {
  const currentLeaseRows = new Map<OutboxPlanItemId, OutboxRunningLease>()
  for (const lease of input.currentLeaseRows) {
    if (currentLeaseRows.has(lease.itemId)) {
      return { ok: false, reason: 'duplicate-current-lease', itemId: lease.itemId }
    }
    currentLeaseRows.set(lease.itemId, lease)
  }

  const outboxItemIds = new Set<OutboxPlanItemId>()
  for (const itemId of input.currentOutboxItemIds) {
    if (outboxItemIds.has(itemId)) {
      return { ok: false, reason: 'duplicate-current-outbox-item', itemId }
    }
    outboxItemIds.add(itemId)
  }
  const patchedOutboxItemIds = new Set<OutboxPlanItemId>()
  const putOutboxItemIds = new Set<OutboxPlanItemId>()
  const outboxPutRecords: LocalStoreOutboxRecord[] = []
  const outboxPatchItemIds: OutboxPlanItemId[] = []
  const leaseWrites: OutboundQueueLeaseWrite[] = []
  const leaseDeletes: OutboundQueueLeaseDelete[] = []
  const nextLeaseRows = new Map(currentLeaseRows)

  for (const operation of input.operations) {
    if (operation.kind === 'put-outbox') {
      const record = operation.put.record
      if (putOutboxItemIds.has(record.id)) {
        return { ok: false, reason: 'duplicate-outbox-put', itemId: record.id }
      }
      if (outboxItemIds.has(record.id)) {
        return { ok: false, reason: 'existing-outbox-item', itemId: record.id }
      }
      putOutboxItemIds.add(record.id)
      outboxItemIds.add(record.id)
      outboxPutRecords.push(record)
      continue
    }

    if (operation.kind === 'patch-outbox') {
      const itemId = localStoreOutboxPatchItemId(operation.patch)
      if (!outboxItemIds.has(itemId)) {
        return { ok: false, reason: 'missing-outbox-item', itemId }
      }
      if (patchedOutboxItemIds.has(itemId)) {
        return { ok: false, reason: 'duplicate-outbox-patch', itemId }
      }
      patchedOutboxItemIds.add(itemId)
      outboxPatchItemIds.push(itemId)
      continue
    }

    const leaseOperation = operation.operation
    if (leaseOperation.kind === 'put-lease') {
      const write = leaseOperation.write
      if (
        write.nextLease.itemId !== write.itemId ||
        (write.expectedLease !== undefined && write.expectedLease.itemId !== write.itemId)
      ) {
        return { ok: false, reason: 'invalid-lease-operation', itemId: write.itemId }
      }
      if (!sameRunningLease(nextLeaseRows.get(write.itemId), write.expectedLease)) {
        return { ok: false, reason: 'lease-cas-mismatch', itemId: write.itemId }
      }
      nextLeaseRows.set(write.itemId, write.nextLease)
      leaseWrites.push(write)
      continue
    }

    const deletePlan = leaseOperation.delete
    if (deletePlan.expectedLease.itemId !== deletePlan.itemId) {
      return { ok: false, reason: 'invalid-lease-operation', itemId: deletePlan.itemId }
    }
    if (!sameRunningLease(nextLeaseRows.get(deletePlan.itemId), deletePlan.expectedLease)) {
      return { ok: false, reason: 'lease-cas-mismatch', itemId: deletePlan.itemId }
    }
    nextLeaseRows.delete(deletePlan.itemId)
    leaseDeletes.push(deletePlan)
  }

  return {
    ok: true,
    outboxPutRecords,
    outboxPatchItemIds,
    leaseWrites,
    leaseDeletes,
    nextLeaseRows: [...nextLeaseRows.values()],
  }
}

function sameRunningLease(
  left: OutboxRunningLease | undefined,
  right: OutboxRunningLease | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === undefined && right === undefined
  }
  return (
    left.itemId === right.itemId &&
    left.kind === right.kind &&
    left.ownerId === right.ownerId &&
    left.leaseExpiresAt === right.leaseExpiresAt
  )
}
