import { type OutboxRunningLease } from '@kuroflare/core'

import { type LocalStoreDriverSnapshot } from '../../store/driver'
import {
  type LocalStoreIndexedDbObjectStorePorts,
  type LocalStoreIndexedDbQueuedReadRequest,
  type LocalStoreIndexedDbReadOperation,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbWriteOperation,
} from '../../store/ports'
import { type LocalStoreOutboxRecord } from '../../store/store'

export async function applyLocalStoreIndexedDbConcreteWrites(
  stores: LocalStoreIndexedDbObjectStorePorts,
  writes: readonly LocalStoreIndexedDbWriteOperation[],
): Promise<void> {
  const requests = queueLocalStoreIndexedDbConcreteWrites(stores, writes)
  await Promise.all(requests.map((request) => waitForIndexedDbRequest(request)))
}

export function queueLocalStoreIndexedDbConcreteReads(
  stores: LocalStoreIndexedDbObjectStorePorts,
  reads: readonly LocalStoreIndexedDbReadOperation[],
): readonly LocalStoreIndexedDbQueuedReadRequest[] {
  return reads.map((operation): LocalStoreIndexedDbQueuedReadRequest => {
    if (operation.storeName === 'outbox') {
      return { operation, request: stores.outbox.get(operation.key) }
    }
    return { operation, request: stores.runningLeases.get(operation.key) }
  })
}

export function localStoreIndexedDbSnapshotFromQueuedReads(
  queuedReads: readonly LocalStoreIndexedDbQueuedReadRequest[],
): LocalStoreDriverSnapshot {
  const outboxRecords: LocalStoreOutboxRecord[] = []
  const leaseRows: OutboxRunningLease[] = []

  for (const queuedRead of queuedReads) {
    if (isQueuedOutboxReadRequest(queuedRead)) {
      const row = queuedRead.request.result
      if (row !== undefined) {
        outboxRecords.push(row)
      }
      continue
    }
    const row = queuedRead.request.result
    if (row !== undefined) {
      leaseRows.push(row)
    }
  }

  return { outboxRecords, leaseRows }
}

export function queueLocalStoreIndexedDbConcreteWrites(
  stores: LocalStoreIndexedDbObjectStorePorts,
  writes: readonly LocalStoreIndexedDbWriteOperation[],
): readonly LocalStoreIndexedDbRequest<unknown>[] {
  return writes.map((write): LocalStoreIndexedDbRequest<unknown> => {
    if (write.storeName === 'outbox') {
      return stores.outbox.put(write.value, write.key)
    }
    if (write.kind === 'put') {
      return stores.runningLeases.put(write.value, write.key)
    }
    return stores.runningLeases.delete(write.key)
  })
}

function isQueuedOutboxReadRequest(
  queuedRead: LocalStoreIndexedDbQueuedReadRequest,
): queuedRead is Extract<
  LocalStoreIndexedDbQueuedReadRequest,
  { readonly operation: { readonly storeName: 'outbox' } }
> {
  return queuedRead.operation.storeName === 'outbox'
}

async function waitForIndexedDbRequest<Result>(
  request: LocalStoreIndexedDbRequest<Result>,
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}
