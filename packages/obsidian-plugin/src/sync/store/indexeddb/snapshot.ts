import { type OutboxRunningLease } from '@kuroflare/core'

import { type LocalStoreDriverSnapshot } from '../../store/driver'
import {
  type LocalStoreIndexedDbReadOperation,
  type LocalStoreIndexedDbTransactionPort,
  type LocalStoreIndexedDbWriteOperation,
} from '../../store/ports'
import { type LocalStoreOutboxRecord } from '../../store/store'

export async function readLocalStoreIndexedDbSnapshot(
  port: LocalStoreIndexedDbTransactionPort,
  reads: readonly LocalStoreIndexedDbReadOperation[],
): Promise<LocalStoreDriverSnapshot> {
  const outboxRecords: LocalStoreOutboxRecord[] = []
  const leaseRows: OutboxRunningLease[] = []

  for (const read of reads) {
    if (read.storeName === 'outbox') {
      const record = await port.getOutboxRecord(read.key)
      if (record !== undefined) {
        outboxRecords.push(record)
      }
      continue
    }

    const lease = await port.getRunningLease(read.key)
    if (lease !== undefined) {
      leaseRows.push(lease)
    }
  }

  return { outboxRecords, leaseRows }
}

export async function applyLocalStoreIndexedDbWrites(
  port: LocalStoreIndexedDbTransactionPort,
  writes: readonly LocalStoreIndexedDbWriteOperation[],
): Promise<void> {
  for (const write of writes) {
    if (write.storeName === 'outbox') {
      await port.putOutboxRecord(write.value)
      continue
    }
    if (write.kind === 'put') {
      await port.putRunningLease(write.value)
      continue
    }
    await port.deleteRunningLease(write.key, write.expectedLease)
  }
}
