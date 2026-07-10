import { applyLocalStoreDriverCommit, planLocalStoreDriverReadSet } from '../../store/driver'
import {
  type LocalStoreIndexedDbConcreteWriteTransactionInput,
  type LocalStoreIndexedDbDatabaseTransactionInput,
  type LocalStoreIndexedDbQueuedTransactionInput,
  type LocalStoreIndexedDbRequest,
  type LocalStoreIndexedDbTransactionInput,
  type LocalStoreIndexedDbTransactionPlan,
} from '../../store/ports'
import {
  applyLocalStoreIndexedDbConcreteWrites,
  localStoreIndexedDbSnapshotFromQueuedReads,
  queueLocalStoreIndexedDbConcreteReads,
  queueLocalStoreIndexedDbConcreteWrites,
} from './concrete'
import { planLocalStoreIndexedDbReads, planLocalStoreIndexedDbWrites } from './plans'
import { applyLocalStoreIndexedDbWrites, readLocalStoreIndexedDbSnapshot } from './snapshot'
import { waitForIndexedDbTransaction } from './utils'

export async function commitLocalStoreIndexedDbTransaction(
  input: LocalStoreIndexedDbTransactionInput,
): Promise<LocalStoreIndexedDbTransactionPlan> {
  const readSet = planLocalStoreDriverReadSet(input.operations)
  const reads = planLocalStoreIndexedDbReads(readSet)
  const snapshot = await readLocalStoreIndexedDbSnapshot(input.port, reads)
  const commit = applyLocalStoreDriverCommit({
    operations: input.operations,
    snapshot,
  })

  if (!commit.ok) {
    return {
      ok: false,
      phase: 'commit',
      reason: commit.reason,
      itemId: commit.itemId,
      readSet,
      reads,
      snapshot,
      commit,
    }
  }

  const writes = planLocalStoreIndexedDbWrites(commit.writes)
  await applyLocalStoreIndexedDbWrites(input.port, writes)

  return {
    ok: true,
    readSet,
    reads,
    snapshot,
    commit,
    writes,
  }
}

export async function commitLocalStoreIndexedDbQueuedTransaction(
  input: LocalStoreIndexedDbQueuedTransactionInput,
): Promise<LocalStoreIndexedDbTransactionPlan> {
  const readSet = planLocalStoreDriverReadSet(input.operations)
  const reads = planLocalStoreIndexedDbReads(readSet)
  const queuedReads = queueLocalStoreIndexedDbConcreteReads(input.transaction.stores, reads)

  return await new Promise<LocalStoreIndexedDbTransactionPlan>((resolve, reject) => {
    let readSuccessCount = 0
    let plan: LocalStoreIndexedDbTransactionPlan | undefined
    let settled = false

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    const requestFailed = (request: LocalStoreIndexedDbRequest<unknown>): void => {
      rejectOnce(request.error ?? new Error('IndexedDB request failed'))
    }

    const queueCommitWrites = (): void => {
      const snapshot = localStoreIndexedDbSnapshotFromQueuedReads(queuedReads)
      const commit = applyLocalStoreDriverCommit({
        operations: input.operations,
        snapshot,
      })

      if (!commit.ok) {
        plan = {
          ok: false,
          phase: 'commit',
          reason: commit.reason,
          itemId: commit.itemId,
          readSet,
          reads,
          snapshot,
          commit,
        }
        return
      }

      const writes = planLocalStoreIndexedDbWrites(commit.writes)
      const queuedWrites = queueLocalStoreIndexedDbConcreteWrites(input.transaction.stores, writes)
      for (const request of queuedWrites) {
        request.onerror = () => {
          requestFailed(request)
        }
      }
      plan = {
        ok: true,
        readSet,
        reads,
        snapshot,
        commit,
        writes,
      }
    }

    input.transaction.lifecycle.oncomplete = () => {
      if (settled) {
        return
      }
      if (plan === undefined) {
        rejectOnce(
          new Error('IndexedDB transaction completed before local-store commit was planned'),
        )
        return
      }
      settled = true
      resolve(plan)
    }
    input.transaction.lifecycle.onabort = () => {
      rejectOnce(input.transaction.lifecycle.error ?? new Error('IndexedDB transaction aborted'))
    }
    input.transaction.lifecycle.onerror = () => {
      rejectOnce(input.transaction.lifecycle.error ?? new Error('IndexedDB transaction failed'))
    }

    if (queuedReads.length === 0) {
      queueCommitWrites()
      return
    }

    for (const queuedRead of queuedReads) {
      queuedRead.request.onerror = () => {
        requestFailed(queuedRead.request)
      }
      queuedRead.request.onsuccess = () => {
        readSuccessCount += 1
        if (readSuccessCount === queuedReads.length) {
          queueCommitWrites()
        }
      }
    }
  })
}

export async function commitLocalStoreIndexedDbDatabaseTransaction(
  input: LocalStoreIndexedDbDatabaseTransactionInput,
): Promise<LocalStoreIndexedDbTransactionPlan> {
  const transaction = input.database.openOutboxTransaction()
  return await commitLocalStoreIndexedDbQueuedTransaction({
    operations: input.operations,
    transaction,
  })
}

export async function commitLocalStoreIndexedDbConcreteWriteTransaction(
  input: LocalStoreIndexedDbConcreteWriteTransactionInput,
): Promise<void> {
  const transaction = input.database.openOutboxTransaction()
  await applyLocalStoreIndexedDbConcreteWrites(transaction.stores, input.writes)
  await waitForIndexedDbTransaction(transaction.lifecycle)
}
