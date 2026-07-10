import { type LocalSetupMetadataPutOperation } from '../../engine/setup'
import {
  type LocalStoreDriverReadSet,
  type LocalStoreDriverWriteOperation,
} from '../../store/driver'
import {
  type LocalStoreIndexedDbMetadataWriteOperation,
  type LocalStoreIndexedDbReadOperation,
  type LocalStoreIndexedDbWriteOperation,
} from '../../store/ports'

export function planLocalStoreIndexedDbReads(
  readSet: LocalStoreDriverReadSet,
): readonly LocalStoreIndexedDbReadOperation[] {
  return [
    ...readSet.outboxItemIds.map(
      (key): LocalStoreIndexedDbReadOperation => ({ kind: 'get', storeName: 'outbox', key }),
    ),
    ...readSet.leaseItemIds.map(
      (key): LocalStoreIndexedDbReadOperation => ({
        kind: 'get',
        storeName: 'running-leases',
        key,
      }),
    ),
  ]
}

export function planLocalStoreIndexedDbWrites(
  writes: readonly LocalStoreDriverWriteOperation[],
): readonly LocalStoreIndexedDbWriteOperation[] {
  return writes.map((write): LocalStoreIndexedDbWriteOperation => {
    if (write.kind === 'put-outbox-record') {
      return {
        kind: 'put',
        storeName: 'outbox',
        key: write.record.id,
        value: write.record,
      }
    }
    if (write.kind === 'put-lease-row') {
      return {
        kind: 'put',
        storeName: 'running-leases',
        key: write.lease.itemId,
        value: write.lease,
      }
    }
    return {
      kind: 'delete',
      storeName: 'running-leases',
      key: write.itemId,
      expectedLease: write.expectedLease,
    }
  })
}

export function planLocalStoreIndexedDbMetadataWrites(
  writes: readonly LocalSetupMetadataPutOperation[],
): readonly LocalStoreIndexedDbMetadataWriteOperation[] {
  return writes.map(
    (write): LocalStoreIndexedDbMetadataWriteOperation => ({
      kind: 'put',
      storeName: 'metadata',
      key: write.key,
      value: write.value,
    }),
  )
}
