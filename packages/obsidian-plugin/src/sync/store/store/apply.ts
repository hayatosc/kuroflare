import {
  type LocalStoreTransactionApplyInput,
  type LocalStoreTransactionApplyPlan,
} from '../../store/store.types'
import { planLocalStoreTransactionCommit } from './commit'
import { applyLocalStoreOutboxPatch, localStoreOutboxPatchItemId } from './patch'

export function applyLocalStoreTransactionSnapshot(
  input: LocalStoreTransactionApplyInput,
): LocalStoreTransactionApplyPlan {
  const commit = planLocalStoreTransactionCommit({
    operations: input.operations,
    currentOutboxItemIds: input.currentOutboxRecords.map((record) => record.id),
    currentLeaseRows: input.currentLeaseRows,
  })
  if (!commit.ok) {
    return { ok: false, reason: commit.reason, itemId: commit.itemId, commit }
  }

  const recordsById = new Map(
    input.currentOutboxRecords.map((record) => [record.id, record] as const),
  )
  for (const operation of input.operations) {
    if (operation.kind === 'put-outbox') {
      recordsById.set(operation.put.record.id, operation.put.record)
      continue
    }
    if (operation.kind !== 'patch-outbox') {
      continue
    }
    const itemId = localStoreOutboxPatchItemId(operation.patch)
    const record = recordsById.get(itemId)
    if (record === undefined) {
      return { ok: false, reason: 'missing-outbox-item', itemId }
    }
    const applied = applyLocalStoreOutboxPatch(record, operation.patch)
    if (!applied.ok) {
      return { ok: false, reason: applied.reason, itemId: applied.itemId }
    }
    recordsById.set(itemId, applied.record)
  }

  return {
    ok: true,
    outboxRecords: [
      ...input.currentOutboxRecords.map((record) => recordsById.get(record.id) ?? record),
      ...commit.outboxPutRecords.map((record) => recordsById.get(record.id) ?? record),
    ],
    leaseRows: commit.nextLeaseRows,
    commit,
  }
}
