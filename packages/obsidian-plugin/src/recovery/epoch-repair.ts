import type { OutboxRunningLease, DocId } from '@kuroflare/core'
import * as Y from 'yjs'

import { WORKER_ORIGIN } from '../main/constants'
import { encodeBase64, waitForIndexedDbRequest, waitForIndexedDbTransaction } from '../main/helpers'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import { documentEpochMetadataKey, type DocumentEpochRecord } from './epoch'
import { createYDocFromSnapshot } from './epoch'

export interface DocumentRecoveryCommitInput {
  readonly db: IDBDatabase
  readonly docId: DocId
  readonly updateBytes: Uint8Array
  readonly snapshotSeq: number
  readonly epoch: DocumentEpochRecord
  readonly includedOutboxIds: readonly string[]
  readonly leaseRows: readonly OutboxRunningLease[]
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
}

function stableRecoveryValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value)
  if (Array.isArray(value)) return value.map(stableRecoveryValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableRecoveryValue(entry)]),
  )
}

function sameRecoveryValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableRecoveryValue(left)) === JSON.stringify(stableRecoveryValue(right))
}

/** Commits the ready epoch, provider base, cursor, outbox completion, and lease release atomically. */
export async function commitDocumentRecoveryTransaction(
  input: DocumentRecoveryCommitInput,
): Promise<void> {
  const transaction = input.db.transaction(
    ['metadata', 'meta-ydoc', 'file-ydocs', 'remote-cursors', 'outbox', 'running-leases'],
    'readwrite',
  )
  const outboxStore = transaction.objectStore('outbox')
  const leaseStore = transaction.objectStore('running-leases')
  const includedRows = input.includedOutboxIds.map((id) => {
    const row = input.outboxRecords.find((candidate) => candidate.id === id)
    if (row === undefined) throw new Error(`document-recovery-outbox-row-missing:${id}`)
    return row
  })
  const currentRowRequests = includedRows.map((row) => outboxStore.get(row.id))
  const currentLeaseRequests = includedRows.map((row) => leaseStore.get(row.id))
  const [currentRows, currentLeases] =
    includedRows.length === 0
      ? [[], []]
      : await Promise.all([
          Promise.all(currentRowRequests.map(waitForIndexedDbRequest)),
          Promise.all(currentLeaseRequests.map(waitForIndexedDbRequest)),
        ])
  for (const [index, row] of includedRows.entries()) {
    if (!sameRecoveryValue(currentRows[index], row)) {
      transaction.abort()
      throw new Error(`document-recovery-outbox-cas-mismatch:${row.id}`)
    }
    const expectedLease = input.leaseRows.find((candidate) => candidate.itemId === row.id)
    if (!sameRecoveryValue(currentLeases[index], expectedLease)) {
      transaction.abort()
      throw new Error(`document-recovery-lease-cas-mismatch:${row.id}`)
    }
  }
  const epochRequest = transaction
    .objectStore('metadata')
    .put(input.epoch, documentEpochMetadataKey(input.docId))
  const ydocStore = transaction.objectStore(
    input.docId.kind === 'meta' ? 'meta-ydoc' : 'file-ydocs',
  )
  const ydocKey = input.docId.kind === 'meta' ? 'meta' : input.docId.ydocId
  const ydocRequest = ydocStore.put(
    { docId: input.docId, updateBytes: input.updateBytes, snapshotSeq: input.snapshotSeq },
    ydocKey,
  )
  const candidateDoc = createYDocFromSnapshot(input.updateBytes, WORKER_ORIGIN)
  const cursorRequest = transaction.objectStore('remote-cursors').put(
    {
      docId: input.docId,
      snapshotSeq: input.snapshotSeq,
      remoteCursorSeq: input.snapshotSeq,
      stateVectorBase64: encodeBase64(Y.encodeStateVector(candidateDoc)),
    },
    input.docId.kind === 'meta' ? 'meta' : `file:${input.docId.ydocId}`,
  )
  candidateDoc.destroy()
  for (const id of input.includedOutboxIds) {
    const row = input.outboxRecords.find((candidate) => candidate.id === id)
    if (row === undefined) continue
    outboxStore.put(
      {
        ...row,
        status: 'done',
        nextAttemptAt: undefined,
        completedBy: 'full-snapshot-apply',
        snapshotSeq: input.snapshotSeq,
      },
      row.id,
    )
    const lease = input.leaseRows.find((candidate) => candidate.itemId === id)
    if (lease !== undefined) leaseStore.delete(id)
  }
  await Promise.all([epochRequest, ydocRequest, cursorRequest].map(waitForIndexedDbRequest))
  await waitForIndexedDbTransaction(transaction)
}
