import {
  decideOutboxAckCompletion,
  decideOutboxAuthRefreshRequest,
  decideOutboxLeaseAcquire,
  decideOutboxLeaseRelease,
  decideOutboxLeaseRenew,
  decideOutboxQuarantinePause,
  planOutboxFullSnapshotRelease,
  planOutboxSchedulerTick,
  transitionOutboxFailure,
  type OutboxAckCompletionDecision,
  type OutboxAckCompletionPatch,
  type OutboxAuthRefreshRequestDecision,
  type OutboxAuthRefreshState,
  type OutboxDependencyBlockPatch,
  type OutboxDependencyDeadLetterPatch,
  type OutboxFailureTransition,
  type OutboxFailureTransitionInput,
  type OutboxLeaseReclaimPatch,
  type OutboxLeaseAcquireDecision,
  type OutboxLeaseReleaseDecision,
  type OutboxLeaseRenewDecision,
  type OutboxFullSnapshotPausedItem,
  type OutboxFullSnapshotReleasePlan,
  type OutboxQuarantinePauseDecision,
  type OutboxQuarantinePausePatch,
  type OutboxResumePatch,
  type OutboxPlanItemId,
  type OutboxItemStatus,
  type OutboxRetryKind,
  type OutboxRuntimeProfile,
  type OutboxRunError,
  type OutboxRunningLease,
  type OutboxSchedulerAuthGateInput,
  type OutboxSchedulerItem,
  type OutboxSchedulerStart,
  type OutboxSchedulerTickPlan,
  type OutboxResumeEvent,
} from '@kuroflare/core'
import {
  type Ack,
  type DeviceId,
  type DocId,
  type MessageId,
  type NeedFullSnapshot,
  type QuarantinedUpdateEntry,
  type VaultId,
} from '@kuroflare/core'

import type {
  OutboundQueuePersistPlan,
  OutboundQueueTickInput,
  OutboundQueueTickPlan,
  OutboundQueueLeaseAcquireInput,
  OutboundQueueLeaseWrite,
  OutboundQueueLeaseDelete,
  OutboundQueueLeaseAcquirePlan,
  OutboundQueueLeaseRenewInput,
  OutboundQueueLeaseRenewPlan,
  OutboundQueueLeaseReleaseInput,
  OutboundQueueLeaseReleasePlan,
  OutboundQueueAckCompletionInput,
  OutboundQueueAckCompletionPlan,
  OutboundQueueQuarantinePauseInput,
  OutboundQueueQuarantinePausePlan,
  OutboundQueueFailureCompletionInput,
  OutboundQueueSuccessCompletionInput,
  OutboundQueueSuccessCompletionPlan,
  OutboundQueueFailureCompletionPlan,
  OutboundQueueFullSnapshotReleaseInput,
  OutboundQueueFullSnapshotReleasePlan,
} from './outbound-queue-types'

export type {
  OutboundQueuePersistPlan,
  OutboundQueueTickInput,
  OutboundQueueTickPlan,
  OutboundQueueLeaseAcquireInput,
  OutboundQueueLeaseWrite,
  OutboundQueueLeaseDelete,
  OutboundQueueLeaseAcquirePlan,
  OutboundQueueLeaseRenewInput,
  OutboundQueueLeaseRenewPlan,
  OutboundQueueLeaseReleaseInput,
  OutboundQueueLeaseReleasePlan,
  OutboundQueueAckCompletionInput,
  OutboundQueueAckCompletionPlan,
  OutboundQueueQuarantinePauseInput,
  OutboundQueueQuarantinePausePlan,
  OutboundQueueFailureCompletionInput,
  OutboundQueueSuccessCompletionInput,
  OutboundQueueSuccessCompletionPlan,
  OutboundQueueFailureCompletionPlan,
  OutboundQueueFullSnapshotReleaseInput,
  OutboundQueueFullSnapshotReleasePlan,
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
