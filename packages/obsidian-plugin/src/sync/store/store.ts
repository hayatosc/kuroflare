import {
  type OutboxAckCompletionPatch,
  
  
  type OutboxFailureTransition,
  
  
  
  type OutboxPlanItemId,
  
  
  
  
  type OutboxRunningLease} from '@kuroflare/core'
import {
  
  
  
  
  type OutboundQueueLeaseDelete,
  
  
  type OutboundQueueLeaseWrite} from '../engine/queue'

import type {
  LocalStoreOutboxPatch,
  LocalStoreOutboxLeaseOperation,
  LocalStoreOutboxPut,
  LocalStoreTransactionOperation,
  LocalStoreOutboxRecord,
  LocalStoreTransactionCommitInput,
  LocalStoreTransactionCommitPlan,
  LocalStoreOutboxPatchApplyPlan,
  LocalStoreTransactionApplyInput,
  LocalStoreTransactionApplyPlan,
  SuccessfulOutboundQueueTickPlan,
  SuccessfulOutboundQueueLeaseAcquirePlan,
  SuccessfulOutboundQueueLeaseRenewPlan,
  SuccessfulOutboundQueueLeaseReleasePlan,
  SuccessfulOutboundQueueAckCompletionPlan,
  SuccessfulOutboundQueueQuarantinePausePlan,
  SuccessfulOutboundQueueFullSnapshotReleasePlan,
  SuccessfulOutboundQueueFailureCompletionPlan,
  SuccessfulOutboundQueueSuccessCompletionPlan} from '../store/store.types'

export type {
  LocalStoreOutboxPatch,
  LocalStoreOutboxLeaseOperation,
  LocalStoreOutboxPut,
  LocalStoreTransactionOperation,
  LocalStoreOutboxRecord,
  LocalStoreTransactionCommitInput,
  LocalStoreTransactionCommitPlan,
  LocalStoreOutboxPatchApplyPlan,
  LocalStoreTransactionApplyInput,
  LocalStoreTransactionApplyPlan,
  SuccessfulOutboundQueueTickPlan,
  SuccessfulOutboundQueueLeaseAcquirePlan,
  SuccessfulOutboundQueueLeaseRenewPlan,
  SuccessfulOutboundQueueLeaseReleasePlan,
  SuccessfulOutboundQueueAckCompletionPlan,
  SuccessfulOutboundQueueQuarantinePausePlan,
  SuccessfulOutboundQueueFullSnapshotReleasePlan,
  SuccessfulOutboundQueueFailureCompletionPlan,
  SuccessfulOutboundQueueSuccessCompletionPlan}

/**
 * Converts scheduler persist patches into ordered local-store transaction operations.
 */
export function planLocalStoreOutboxSchedulerTransaction(
  plan: SuccessfulOutboundQueueTickPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    ...plan.persist.resumePatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'resume', patch }}),
    ),
    ...plan.persist.blockPatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'dependency-block', patch }}),
    ),
    ...plan.persist.deadLetterPatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'dependency-dead-letter', patch }}),
    ),
    ...plan.persist.leaseReclaims.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'lease-reclaim', patch }}),
    ),
  ]
}

/**
 * Converts a lease-acquire plan into the local-store CAS write transaction operation.
 */
export function planLocalStoreLeaseAcquireTransaction(
  plan: SuccessfulOutboundQueueLeaseAcquirePlan,
): readonly LocalStoreTransactionOperation[] {
  return [putLeaseOperation(plan.write)]
}

/**
 * Converts a lease-renew plan into the local-store CAS write transaction operation.
 */
export function planLocalStoreLeaseRenewTransaction(
  plan: SuccessfulOutboundQueueLeaseRenewPlan,
): readonly LocalStoreTransactionOperation[] {
  return [putLeaseOperation(plan.write)]
}

/**
 * Converts a lease-release plan into the local-store CAS delete transaction operation.
 */
export function planLocalStoreLeaseReleaseTransaction(
  plan: SuccessfulOutboundQueueLeaseReleasePlan,
): readonly LocalStoreTransactionOperation[] {
  return [deleteLeaseOperation(plan.delete)]
}

/**
 * Converts an ack completion plan into an atomic item patch and lease release operation list.
 */
export function planLocalStoreAckCompletionTransaction(
  plan: SuccessfulOutboundQueueAckCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'ack-completion',
        itemId: plan.itemId,
        patch: plan.patch}},
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a quarantine pause plan into an atomic item patch and lease release operation list.
 */
export function planLocalStoreQuarantinePauseTransaction(
  plan: SuccessfulOutboundQueueQuarantinePausePlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'quarantine-pause',
        itemId: plan.itemId,
        patch: plan.patch}},
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a failed-attempt completion plan into an atomic item patch and lease release operation list.
 */
export function planLocalStoreFailureCompletionTransaction(
  plan: SuccessfulOutboundQueueFailureCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'failure-completion',
        itemId: plan.itemId,
        patch: plan.patch}},
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a successful non-ack side effect into an atomic item patch and lease release operation list.
 */
export function planLocalStoreSuccessCompletionTransaction(
  plan: SuccessfulOutboundQueueSuccessCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'success-completion',
        itemId: plan.itemId,
        patch: plan.patch}},
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a full-snapshot release plan into terminal outbox patch operations.
 */
export function planLocalStoreFullSnapshotReleaseTransaction(
  plan: SuccessfulOutboundQueueFullSnapshotReleasePlan,
): readonly LocalStoreTransactionOperation[] {
  return plan.releasePatches.map(
    (patch): LocalStoreTransactionOperation => ({
      kind: 'patch-outbox',
      patch: { kind: 'full-snapshot-release', patch }}),
  )
}

/**
 * Validates operation ordering preconditions and folds lease CAS effects for a local-store transaction.
 */
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
    nextLeaseRows: [...nextLeaseRows.values()]}
}

/**
 * Applies one outbox patch to a local-store record using the plugin's canonical patch semantics.
 */
export function applyLocalStoreOutboxPatch(
  record: LocalStoreOutboxRecord,
  patch: LocalStoreOutboxPatch,
): LocalStoreOutboxPatchApplyPlan {
  const itemId = localStoreOutboxPatchItemId(patch)
  if (record.id !== itemId) {
    return { ok: false, reason: 'patch-item-mismatch', itemId }
  }

  switch (patch.kind) {
    case 'resume':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          resumeOn: undefined,
          reason: undefined}}
    case 'dependency-block':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          blockedBy: patch.patch.blockedBy}}
    case 'dependency-dead-letter':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          reason: patch.patch.reason,
          deadLetterReason: patch.patch.deadLetterReason,
          deadLetteredBy: patch.patch.deadLetteredBy,
          nextAttemptAt: undefined}}
    case 'lease-reclaim':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          previousOwnerId: patch.patch.previousOwnerId}}
    case 'repair-import-resume':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          resumeOn: undefined,
          reason: undefined}}
    case 'ack-completion':
      return applyAckCompletionPatch(record, patch.patch)
    case 'quarantine-pause':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          reason: patch.patch.reason,
          resumeOn: patch.patch.resumeOn,
          quarantineId: patch.patch.quarantineId,
          quarantineReason: patch.patch.quarantineReason,
          docId: patch.patch.docId}}
    case 'failure-completion':
      return applyFailureCompletionPatch(record, patch.patch)
    case 'success-completion':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt}}
    case 'full-snapshot-release':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          completedBy: patch.patch.completedBy,
          snapshotSeq: patch.patch.snapshotSeq}}
  }
}

/**
 * Applies an ordered local-store transaction to a snapshot after validating commit preconditions.
 */
export function applyLocalStoreTransactionSnapshot(
  input: LocalStoreTransactionApplyInput,
): LocalStoreTransactionApplyPlan {
  const commit = planLocalStoreTransactionCommit({
    operations: input.operations,
    currentOutboxItemIds: input.currentOutboxRecords.map((record) => record.id),
    currentLeaseRows: input.currentLeaseRows})
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
    commit}
}

function applyFailureCompletionPatch(
  record: LocalStoreOutboxRecord,
  patch: OutboxFailureTransition,
): LocalStoreOutboxPatchApplyPlan {
  if (patch.status === 'retrying') {
    return {
      ok: true,
      record: {
        ...record,
        status: patch.status,
        retryCount: patch.retryCount,
        nextAttemptAt: patch.nextAttemptAt,
        lastError: patch.lastError}}
  }
  if (patch.status === 'paused') {
    return {
      ok: true,
      record: {
        ...record,
        status: patch.status,
        retryCount: patch.retryCount,
        nextAttemptAt: patch.nextAttemptAt,
        lastError: patch.lastError,
        reason: patch.reason,
        resumeOn: patch.resumeOn}}
  }
  return {
    ok: true,
    record: {
      ...record,
      status: patch.status,
      retryCount: patch.retryCount,
      nextAttemptAt: patch.nextAttemptAt,
      lastError: patch.lastError,
      reason: patch.reason,
      deadLetterReason: patch.deadLetterReason}}
}

function putLeaseOperation(write: OutboundQueueLeaseWrite): LocalStoreTransactionOperation {
  return {
    kind: 'lease',
    operation: { kind: 'put-lease', write }}
}

function applyAckCompletionPatch(
  record: LocalStoreOutboxRecord,
  patch: OutboxAckCompletionPatch,
): LocalStoreOutboxPatchApplyPlan {
  if (patch.status === 'done') {
    return {
      ok: true,
      record: {
        ...record,
        status: patch.status,
        nextAttemptAt: patch.nextAttemptAt,
        durableSeq: patch.durableSeq}}
  }
  return {
    ok: true,
    record: {
      ...record,
      status: patch.status,
      nextAttemptAt: patch.nextAttemptAt,
      reason: patch.reason,
      resumeOn: patch.resumeOn,
      snapshotReason: patch.snapshotReason,
      docId: patch.docId}}
}

/**
 * Returns the outbox item targeted by a local-store patch operation.
 */
export function localStoreOutboxPatchItemId(patch: LocalStoreOutboxPatch): OutboxPlanItemId {
  switch (patch.kind) {
    case 'resume':
    case 'dependency-block':
    case 'dependency-dead-letter':
    case 'lease-reclaim':
    case 'full-snapshot-release':
      return patch.patch.id
    case 'ack-completion':
    case 'quarantine-pause':
    case 'failure-completion':
    case 'success-completion':
    case 'repair-import-resume':
      return patch.itemId
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

function deleteLeaseOperation(
  deletePlan: OutboundQueueLeaseDelete,
): LocalStoreTransactionOperation {
  return {
    kind: 'lease',
    operation: { kind: 'delete-lease', delete: deletePlan }}
}
