import { type OutboxRunError } from '@kuroflare/core'
import { TFolder } from 'obsidian'

import {
  type OutboxWorkerSideEffectResultEvidence,
  classifyOutboxWorkerSideEffectCompletionEvidence,
  planOutboxWorkerSuccessCompletion,
  planOutboxWorkerFailureCompletion,
  planOutboxWorkerCompletionIndexedDbWriteTransaction,
} from '../../sync/engine/worker'
import { type LocalStoreOutboxRecord } from '../../sync/store/store'
import { findActiveFileId } from '../auth'
import type KuroflareSpikePlugin from '../plugin'
import { readOutboxWorkerSnapshot, commitOutboxWorkerIndexedDbWriteTransaction } from '../store'
import { scheduleOutboxWorkerTick } from './tick'

export function isRepairConflictPathAvailable(plugin: KuroflareSpikePlugin, path: string): boolean {
  if (plugin.app.vault.getAbstractFileByPath(path) !== null || findActiveFileId(plugin, path)) {
    return false
  }
  const segments = path.split('/').slice(0, -1)
  let current = ''
  for (const segment of segments) {
    current = current.length === 0 ? segment : `${current}/${segment}`
    const existing = plugin.app.vault.getAbstractFileByPath(current)
    if (existing !== null && !(existing instanceof TFolder)) {
      return false
    }
  }
  return true
}

export async function completeNonAckSideEffect(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  record: LocalStoreOutboxRecord,
  result: OutboxWorkerSideEffectResultEvidence,
): Promise<void> {
  const snapshot = await readOutboxWorkerSnapshot(db)
  const currentRecord =
    snapshot.outboxRecords.find((candidate) => candidate.id === record.id) ?? record
  const evidence = classifyOutboxWorkerSideEffectCompletionEvidence({
    itemId: currentRecord.id,
    kind: currentRecord.kind,
    status: currentRecord.status,
    retryCount: currentRecord.retryCount ?? 0,
    result,
  })
  const plan = evidence.ok
    ? planOutboxWorkerSuccessCompletion({
        itemId: evidence.itemId,
        kind: evidence.kind,
        status: evidence.status,
        ownerId: plugin.outboxWorkerOwnerId,
        now: Date.now(),
        currentOutboxRecords: snapshot.outboxRecords,
        currentLeaseRows: snapshot.leaseRows,
      })
    : planOutboxWorkerFailureCompletion({
        itemId: evidence.itemId,
        kind: evidence.kind,
        retryCount: evidence.retryCount,
        error: evidence.error,
        ownerId: plugin.outboxWorkerOwnerId,
        now: Date.now(),
        currentOutboxRecords: snapshot.outboxRecords,
        currentLeaseRows: snapshot.leaseRows,
      })
  if (!plan.ok) {
    console.warn('[kuroflare] outbox side effect completion rejected', {
      itemId: currentRecord.id,
      reason: plan.reason,
    })
    return
  }
  await commitOutboxWorkerIndexedDbWriteTransaction(
    db,
    planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
  )
  if (plan.action === 'retry-after-failure') {
    scheduleOutboxWorkerTick(plugin, 1_000, 'side-effect-retry')
  } else if (plan.action === 'success-completion') {
    scheduleOutboxWorkerTick(plugin, 250, 'side-effect-complete')
  }
}

export async function completeLeasedOutboxFailure(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  record: LocalStoreOutboxRecord,
  error: OutboxRunError,
): Promise<void> {
  const snapshot = await readOutboxWorkerSnapshot(db)
  const currentRecord =
    snapshot.outboxRecords.find((candidate) => candidate.id === record.id) ?? record
  const plan = planOutboxWorkerFailureCompletion({
    itemId: currentRecord.id,
    kind: currentRecord.kind,
    retryCount: currentRecord.retryCount ?? 0,
    error,
    ownerId: plugin.outboxWorkerOwnerId,
    now: Date.now(),
    currentOutboxRecords: snapshot.outboxRecords,
    currentLeaseRows: snapshot.leaseRows,
  })
  if (!plan.ok) {
    console.warn('[kuroflare] outbox failure completion rejected', {
      itemId: currentRecord.id,
      reason: plan.reason,
    })
    return
  }
  await commitOutboxWorkerIndexedDbWriteTransaction(
    db,
    planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
  )
  if (plan.action === 'retry-after-failure') {
    scheduleOutboxWorkerTick(plugin, 1_000, 'side-effect-retry')
  }
}
