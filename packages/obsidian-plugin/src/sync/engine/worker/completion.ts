import { type OutboxFailureTransition, type OutboxRunError } from '@kuroflare/core'

import {
  planOutboundQueueAckCompletion,
  planOutboundQueueFailureCompletion,
  planOutboundQueueQuarantinePause,
  planOutboundQueueSyncUpdateRejectedPause,
  planOutboundQueueSuccessCompletion,
} from '../../engine/queue'
import {
  type OutboxWorkerAckCompletionInput,
  type OutboxWorkerCompletionPlan,
  type OutboxWorkerFailureCompletionInput,
  type OutboxWorkerQuarantineCompletionInput,
  type OutboxWorkerSyncUpdateRejectedCompletionInput,
  type OutboxWorkerSideEffectCompletionEvidence,
  type OutboxWorkerSideEffectCompletionEvidenceInput,
  type OutboxWorkerSideEffectResultEvidence,
  type OutboxWorkerSuccessCompletionInput,
} from '../../engine/worker.types'
import { applyLocalStoreDriverCommit, planLocalStoreDriverReadSet } from '../../store/driver'
import { planLocalStoreIndexedDbReads, planLocalStoreIndexedDbWrites } from '../../store/indexeddb'
import {
  planLocalStoreAckCompletionTransaction,
  planLocalStoreFailureCompletionTransaction,
  planLocalStoreQuarantinePauseTransaction,
  planLocalStoreSyncUpdateRejectedPauseTransaction,
  planLocalStoreSuccessCompletionTransaction,
} from '../../store/store'

/**
 * Classifies a concrete non-ack side-effect runner result for completion planning.
 *
 * @param input Item identity, retry evidence, and runner result.
 * @returns Success completion evidence or a normalized failure error for retry policy.
 */
export function classifyOutboxWorkerSideEffectCompletionEvidence(
  input: OutboxWorkerSideEffectCompletionEvidenceInput,
): OutboxWorkerSideEffectCompletionEvidence {
  if (input.result.kind !== 'success') {
    return {
      ok: false,
      itemId: input.itemId,
      kind: input.kind,
      retryCount: input.retryCount,
      error: outboxRunErrorFromSideEffectResult(input.result),
    }
  }

  if (input.kind === 'y-update' || input.kind === 'meta-ref-update') {
    return {
      ok: false,
      itemId: input.itemId,
      kind: input.kind,
      retryCount: input.retryCount,
      error: { kind: 'invalid-payload' },
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
  }
}

function outboxRunErrorFromSideEffectResult(
  result: Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>,
): OutboxRunError {
  switch (result.kind) {
    case 'network-error':
      return { kind: 'network' }
    case 'timeout':
      return { kind: 'timeout' }
    case 'offline':
      return { kind: 'offline' }
    case 'local-conflict':
      return { kind: 'local-conflict' }
    case 'invalid-payload':
      return { kind: 'invalid-payload' }
    case 'http-response':
      return outboxRunErrorFromHttpStatus(result)
  }
}

function outboxRunErrorFromHttpStatus(
  response: Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>,
): OutboxRunError {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'auth' }
  }
  if (response.status === 408) {
    return { kind: 'timeout' }
  }
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
    return outboxApiRunError({
      retryable: true,
      retryAfterMs: response.retryAfterMs,
      code: response.code,
    })
  }
  return outboxApiRunError({ retryable: false, code: response.code })
}

function outboxApiRunError(input: {
  readonly retryable: boolean
  readonly retryAfterMs?: number | undefined
  readonly code?: string | undefined
}): OutboxRunError {
  const error: { kind: 'api'; retryable: boolean; retryAfterMs?: number; code?: string } = {
    kind: 'api',
    retryable: input.retryable,
  }
  if (input.retryAfterMs !== undefined) {
    error.retryAfterMs = input.retryAfterMs
  }
  if (input.code !== undefined) {
    error.code = input.code
  }
  return error
}

/**
 * Plans the transaction that commits an Ack or NeedFullSnapshot returned by a running y-update side effect.
 *
 * @param input Server response, current outbox record status, lease owner evidence, and local-store snapshot.
 * @returns Atomic item patch plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerAckCompletion(
  input: OutboxWorkerAckCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueAckCompletion({
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreAckCompletionTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: completion.action === 'complete' ? 'ack-completion' : 'pause-for-full-snapshot',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that pauses a running y-update after matching server quarantine evidence.
 *
 * @param input Server quarantine evidence, current item status, lease owner evidence, and local-store snapshot.
 * @returns Atomic quarantine pause plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerQuarantineCompletion(
  input: OutboxWorkerQuarantineCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueQuarantinePause({
    itemId: input.itemId,
    kind: 'y-update',
    status: input.status,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    quarantine: input.quarantine,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreQuarantinePauseTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: 'pause-for-quarantine',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/** Plans the transaction that pauses an update after matching guarded rejection evidence. */
export function planOutboxWorkerSyncUpdateRejectedCompletion(
  input: OutboxWorkerSyncUpdateRejectedCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueSyncUpdateRejectedPause({
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    rejection: input.rejection,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreSyncUpdateRejectedPauseTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  return {
    ok: true,
    action: 'pause-for-sync-update-rejected',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply: driverCommit.apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that marks a non-ack side effect done and releases its lease.
 *
 * @param input Success evidence, current item status, lease owner evidence, and local-store snapshot.
 * @returns Atomic done patch plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerSuccessCompletion(
  input: OutboxWorkerSuccessCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreSuccessCompletionTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: 'success-completion',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that commits a failed side-effect attempt and releases its lease.
 *
 * @param input Failure evidence, retry count, lease owner evidence, and local-store snapshot.
 * @returns Atomic retry/pause/dead-letter patch plus lease release, or a stale completion rejection.
 */
export function planOutboxWorkerFailureCompletion(
  input: OutboxWorkerFailureCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueFailureCompletion({
    itemId: input.itemId,
    kind: input.kind,
    retryCount: input.retryCount,
    error: input.error,
    retryJitterMs: input.retryJitterMs,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreFailureCompletionTransaction(completion)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'completion-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    action: outboxFailureCompletionAction(completion.patch.status),
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

function outboxFailureCompletionAction(
  status: OutboxFailureTransition['status'],
): 'retry-after-failure' | 'pause-after-failure' | 'dead-letter-after-failure' {
  switch (status) {
    case 'retrying':
      return 'retry-after-failure'
    case 'paused':
      return 'pause-after-failure'
    case 'failed':
      return 'dead-letter-after-failure'
  }
}
