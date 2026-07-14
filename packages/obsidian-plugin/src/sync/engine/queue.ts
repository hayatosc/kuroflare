import {
  decideOutboxAckCompletion,
  decideOutboxAuthRefreshRequest,
  decideOutboxLeaseAcquire,
  decideOutboxLeaseRelease,
  decideOutboxLeaseRenew,
  decideOutboxQuarantinePause,
  decideOutboxSyncUpdateRejectedPause,
  decideOutboxSyncUpdateRejectedRepair,
  planOutboxFullSnapshotRelease,
  planOutboxSchedulerTick,
  transitionOutboxFailure,
  type OutboxFailureTransitionInput,
} from '@kuroflare/core'

import type {
  OutboundQueueAckCompletionInput,
  OutboundQueueAckCompletionPlan,
  OutboundQueueFailureCompletionInput,
  OutboundQueueFailureCompletionPlan,
  OutboundQueueFullSnapshotReleaseInput,
  OutboundQueueFullSnapshotReleasePlan,
  OutboundQueueLeaseAcquireInput,
  OutboundQueueLeaseAcquirePlan,
  OutboundQueueLeaseDelete,
  OutboundQueueLeaseReleaseInput,
  OutboundQueueLeaseReleasePlan,
  OutboundQueueLeaseRenewInput,
  OutboundQueueLeaseRenewPlan,
  OutboundQueueLeaseWrite,
  OutboundQueuePersistPlan,
  OutboundQueueQuarantinePauseInput,
  OutboundQueueQuarantinePausePlan,
  OutboundQueueSyncUpdateRejectedPauseInput,
  OutboundQueueSyncUpdateRejectedPausePlan,
  OutboundQueueSyncUpdateRejectedRepairInput,
  OutboundQueueSyncUpdateRejectedRepairPlan,
  OutboundQueueSuccessCompletionInput,
  OutboundQueueSuccessCompletionPlan,
  OutboundQueueTickInput,
  OutboundQueueTickPlan,
} from '../engine/queue.types'

export type {
  OutboundQueueAckCompletionInput,
  OutboundQueueAckCompletionPlan,
  OutboundQueueFailureCompletionInput,
  OutboundQueueFailureCompletionPlan,
  OutboundQueueFullSnapshotReleaseInput,
  OutboundQueueFullSnapshotReleasePlan,
  OutboundQueueLeaseAcquireInput,
  OutboundQueueLeaseAcquirePlan,
  OutboundQueueLeaseDelete,
  OutboundQueueLeaseReleaseInput,
  OutboundQueueLeaseReleasePlan,
  OutboundQueueLeaseRenewInput,
  OutboundQueueLeaseRenewPlan,
  OutboundQueueLeaseWrite,
  OutboundQueuePersistPlan,
  OutboundQueueQuarantinePauseInput,
  OutboundQueueQuarantinePausePlan,
  OutboundQueueSyncUpdateRejectedPauseInput,
  OutboundQueueSyncUpdateRejectedPausePlan,
  OutboundQueueSyncUpdateRejectedRepairInput,
  OutboundQueueSyncUpdateRejectedRepairPlan,
  OutboundQueueSuccessCompletionInput,
  OutboundQueueSuccessCompletionPlan,
  OutboundQueueTickInput,
  OutboundQueueTickPlan,
}

/**
 * Plans one outbound queue tick for the Obsidian plugin.
 */
export function planOutboundQueueTick(input: OutboundQueueTickInput): OutboundQueueTickPlan {
  const schedulerPlan = planOutboxSchedulerTick({
    items: input.items,
    now: input.now,
    profile: input.profile,
    resumeEvents: input.resumeEvents,
    leases: input.leases,
    maxStarts: input.maxStarts,
    auth: input.auth,
  })

  if (!schedulerPlan.ok) {
    return {
      ok: false,
      reason: schedulerPlan.reason,
      id: schedulerPlan.id,
      schedulerPlan,
    }
  }

  const authRefresh = decideOutboxAuthRefreshRequest({
    refreshBlocks: schedulerPlan.authRefreshBlocks,
    refreshState: input.authRefreshState,
    now: input.now,
  })

  if (authRefresh.action === 'reject') {
    return {
      ok: false,
      reason: authRefresh.reason,
      id: authRefresh.id,
      authRefresh,
    }
  }

  return {
    ok: true,
    persist: {
      resumePatches: schedulerPlan.resumePatches,
      blockPatches: schedulerPlan.blockPatches,
      deadLetterPatches: schedulerPlan.deadLetterPatches,
      leaseReclaims: schedulerPlan.leaseReclaims,
    },
    leaseCandidates: schedulerPlan.starts,
    authRefresh,
    schedulerPlan,
  }
}

/**
 * Plans the compare-and-set lease write required before starting a queue item.
 */
export function planOutboundQueueLeaseAcquire(
  input: OutboundQueueLeaseAcquireInput,
): OutboundQueueLeaseAcquirePlan {
  const decision = decideOutboxLeaseAcquire({
    itemId: input.start.id,
    kind: input.start.kind,
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    existingLease: input.existingLease,
  })

  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason }
  }

  return {
    ok: true,
    action: decision.action,
    write: {
      itemId: input.start.id,
      expectedLease: input.existingLease,
      nextLease: decision.lease,
    },
    previousOwnerId: decision.previousOwnerId,
  }
}

/**
 * Plans the compare-and-set lease write required to keep a long side effect running.
 */
export function planOutboundQueueLeaseRenew(
  input: OutboundQueueLeaseRenewInput,
): OutboundQueueLeaseRenewPlan {
  const decision = decideOutboxLeaseRenew({
    itemId: input.itemId,
    kind: input.kind,
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    existingLease: input.existingLease,
  })

  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason }
  }

  return {
    ok: true,
    write: {
      itemId: input.itemId,
      expectedLease: input.existingLease,
      nextLease: decision.lease,
    },
  }
}

/**
 * Plans the compare-and-set lease delete after success or failure handling.
 */
export function planOutboundQueueLeaseRelease(
  input: OutboundQueueLeaseReleaseInput,
): OutboundQueueLeaseReleasePlan {
  const existingLease = input.existingLease
  const decision = decideOutboxLeaseRelease({
    itemId: input.itemId,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })

  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason }
  }
  if (existingLease === undefined) {
    return { ok: false, reason: 'missing-lease' }
  }

  return {
    ok: true,
    delete: {
      itemId: input.itemId,
      expectedLease: existingLease,
    },
  }
}

/**
 * Plans an atomic item completion/full-snapshot pause and lease release.
 */
export function planOutboundQueueAckCompletion(
  input: OutboundQueueAckCompletionInput,
): OutboundQueueAckCompletionPlan {
  const ackDecision = decideOutboxAckCompletion({
    kind: input.kind,
    status: input.status,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
  })

  if (ackDecision.action === 'reject') {
    return {
      ok: false,
      reason: ackDecision.reason,
      ackDecision,
    }
  }

  const leaseRelease = planOutboundQueueLeaseRelease({
    itemId: input.itemId,
    ownerId: input.ownerId,
    now: input.now,
    existingLease: input.existingLease,
  })
  if (!leaseRelease.ok) {
    return {
      ok: false,
      reason: leaseRelease.reason,
      leaseRelease,
    }
  }
  return {
    ok: true,
    action: ackDecision.action,
    itemId: input.itemId,
    patch: ackDecision.patch,
    leaseDelete: leaseRelease.delete,
  }
}

/**
 * Plans an atomic server-quarantine pause and lease release.
 */
export function planOutboundQueueQuarantinePause(
  input: OutboundQueueQuarantinePauseInput,
): OutboundQueueQuarantinePausePlan {
  const quarantineDecision = decideOutboxQuarantinePause({
    kind: input.kind,
    status: input.status,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    quarantine: input.quarantine,
  })

  if (quarantineDecision.action === 'reject') {
    return {
      ok: false,
      reason: quarantineDecision.reason,
      quarantineDecision,
    }
  }

  const leaseRelease = planOutboundQueueLeaseRelease({
    itemId: input.itemId,
    ownerId: input.ownerId,
    now: input.now,
    existingLease: input.existingLease,
  })
  if (!leaseRelease.ok) {
    return {
      ok: false,
      reason: leaseRelease.reason,
      leaseRelease,
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    patch: quarantineDecision.patch,
    leaseDelete: leaseRelease.delete,
  }
}

/** Plans an atomic guarded rejection pause and lease release. */
export function planOutboundQueueSyncUpdateRejectedPause(
  input: OutboundQueueSyncUpdateRejectedPauseInput,
): OutboundQueueSyncUpdateRejectedPausePlan {
  const rejectionDecision = decideOutboxSyncUpdateRejectedPause({
    kind: input.kind,
    status: input.status,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    rejection: input.rejection,
  })

  if (rejectionDecision.action === 'reject') {
    return {
      ok: false,
      reason: rejectionDecision.reason,
      rejectionDecision,
    }
  }

  const leaseRelease = planOutboundQueueLeaseRelease({
    itemId: input.itemId,
    ownerId: input.ownerId,
    now: input.now,
    existingLease: input.existingLease,
  })
  if (!leaseRelease.ok) {
    return {
      ok: false,
      reason: leaseRelease.reason,
      leaseRelease,
    }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return {
      ok: false,
      reason: 'not-runnable-status',
    }
  }
  if (input.updateSha256 === undefined) {
    return {
      ok: false,
      reason: 'hash-mismatch',
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    expectedStatus: input.status,
    expectedMessageId: input.messageId,
    expectedDocId: input.docId,
    expectedUpdateSha256: input.updateSha256,
    patch: rejectionDecision.patch,
    leaseDelete: leaseRelease.delete,
  }
}

/** Plans an exact guarded completion for one paused rejection after snapshot import. */
export function planOutboundQueueSyncUpdateRejectedRepair(
  input: OutboundQueueSyncUpdateRejectedRepairInput,
): OutboundQueueSyncUpdateRejectedRepairPlan {
  const decision = decideOutboxSyncUpdateRejectedRepair(input)
  if (decision.action === 'reject') {
    return { ok: false, reason: decision.reason, decision }
  }
  const kind = input.kind
  if (kind !== 'y-update' && kind !== 'meta-ref-update') {
    return {
      ok: false,
      reason: 'unsupported-kind',
      decision: { action: 'reject', reason: 'unsupported-kind' },
    }
  }
  if (input.rejectionReason !== 'large-update-requires-snapshot-import') {
    return {
      ok: false,
      reason: 'wrong-rejection-reason',
      decision: { action: 'reject', reason: 'wrong-rejection-reason' },
    }
  }
  if (input.rejectionRetryable !== false) {
    return {
      ok: false,
      reason:
        input.rejectionRetryable === undefined
          ? 'missing-retryable-evidence'
          : 'retryable-rejection',
      decision: {
        action: 'reject',
        reason:
          input.rejectionRetryable === undefined
            ? 'missing-retryable-evidence'
            : 'retryable-rejection',
      },
    }
  }
  if (
    input.docId === undefined ||
    input.messageId === undefined ||
    input.updateSha256 === undefined ||
    input.rejectionUpdateSha256 === undefined ||
    input.updateBytesBase64 === undefined
  ) {
    return {
      ok: false,
      reason: 'missing-update-bytes',
      decision: { action: 'reject', reason: 'missing-update-bytes' },
    }
  }
  return {
    ok: true,
    itemId: input.itemId,
    expected: {
      status: 'paused',
      reason: 'sync-update-rejected',
      kind,
      docId: input.docId,
      messageId: input.messageId,
      updateSha256: input.updateSha256,
      rejectionUpdateSha256: input.rejectionUpdateSha256,
      rejectionReason: input.rejectionReason,
      rejectionRetryable: false,
      updateBytesBase64: input.updateBytesBase64,
    },
    patch: decision.patch,
  }
}

/**
 * Plans an atomic success patch and lease release for side effects that do not wait for a server Ack.
 */
export function planOutboundQueueSuccessCompletion(
  input: OutboundQueueSuccessCompletionInput,
): OutboundQueueSuccessCompletionPlan {
  if (input.kind === 'y-update' || input.kind === 'meta-ref-update') {
    return { ok: false, reason: 'unsupported-kind' }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return { ok: false, reason: 'invalid-status' }
  }

  const leaseRelease = planOutboundQueueLeaseRelease({
    itemId: input.itemId,
    ownerId: input.ownerId,
    now: input.now,
    existingLease: input.existingLease,
  })
  if (!leaseRelease.ok) {
    return {
      ok: false,
      reason: leaseRelease.reason,
      leaseRelease,
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    kind: input.kind,
    patch: {
      status: 'done',
      nextAttemptAt: undefined,
    },
    leaseDelete: leaseRelease.delete,
  }
}

/**
 * Plans an atomic failed-attempt transition and lease release.
 */
export function planOutboundQueueFailureCompletion(
  input: OutboundQueueFailureCompletionInput,
): OutboundQueueFailureCompletionPlan {
  const failureInput: OutboxFailureTransitionInput = {
    kind: input.kind,
    retryCount: input.retryCount,
    error: input.error,
    now: input.now,
    ...(input.retryJitterMs === undefined ? {} : { retryJitterMs: input.retryJitterMs }),
  }
  const patch = transitionOutboxFailure(failureInput)
  const leaseRelease = planOutboundQueueLeaseRelease({
    itemId: input.itemId,
    ownerId: input.ownerId,
    now: input.now,
    existingLease: input.existingLease,
  })
  if (!leaseRelease.ok) {
    return {
      ok: false,
      reason: leaseRelease.reason,
      leaseRelease,
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    patch,
    leaseDelete: leaseRelease.delete,
  }
}

/**
 * Plans terminal patches for updates superseded by an applied full snapshot.
 */
export function planOutboundQueueFullSnapshotRelease(
  input: OutboundQueueFullSnapshotReleaseInput,
): OutboundQueueFullSnapshotReleasePlan {
  return planOutboxFullSnapshotRelease({
    appliedDocId: input.appliedDocId,
    snapshotSeq: input.snapshotSeq,
    items: input.items,
  })
}
