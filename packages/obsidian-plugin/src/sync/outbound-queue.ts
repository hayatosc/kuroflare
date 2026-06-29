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
} from '@kuroflare/protocol'

/** Persistable patches that must be committed before starting side effects. */
export interface OutboundQueuePersistPlan {
  readonly resumePatches: readonly OutboxResumePatch[]
  readonly blockPatches: readonly OutboxDependencyBlockPatch[]
  readonly deadLetterPatches: readonly OutboxDependencyDeadLetterPatch[]
  readonly leaseReclaims: readonly OutboxLeaseReclaimPatch[]
}

/** Input for one plugin outbound queue scheduler tick. */
export interface OutboundQueueTickInput {
  readonly items: readonly OutboxSchedulerItem[]
  readonly now: number
  readonly profile: OutboxRuntimeProfile
  readonly resumeEvents: readonly OutboxResumeEvent[]
  readonly leases: readonly OutboxRunningLease[]
  readonly maxStarts: number
  readonly auth?: OutboxSchedulerAuthGateInput | undefined
  readonly authRefreshState: OutboxAuthRefreshState
}

/** Plugin-level queue tick plan after pure scheduling decisions have run. */
export type OutboundQueueTickPlan =
  | {
      readonly ok: true
      readonly persist: OutboundQueuePersistPlan
      readonly leaseCandidates: readonly OutboxSchedulerStart[]
      readonly authRefresh: OutboxAuthRefreshRequestDecision
      readonly schedulerPlan: Extract<OutboxSchedulerTickPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason:
        | Extract<OutboxSchedulerTickPlan, { readonly ok: false }>['reason']
        | Extract<OutboxAuthRefreshRequestDecision, { readonly action: 'reject' }>['reason']
      readonly id?: string | undefined
      readonly schedulerPlan?: Extract<OutboxSchedulerTickPlan, { readonly ok: false }> | undefined
      readonly authRefresh?:
        | Extract<OutboxAuthRefreshRequestDecision, { readonly action: 'reject' }>
        | undefined
    }

/** Input for planning lease acquisition before starting one queued side effect. */
export interface OutboundQueueLeaseAcquireInput {
  readonly start: OutboxSchedulerStart
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Compare-and-set write expected before starting a queued side effect. */
export interface OutboundQueueLeaseWrite {
  readonly itemId: OutboxPlanItemId
  readonly expectedLease: OutboxRunningLease | undefined
  readonly nextLease: OutboxRunningLease
}

/** Compare-and-set delete expected after a queued side effect completes or fails. */
export interface OutboundQueueLeaseDelete {
  readonly itemId: OutboxPlanItemId
  readonly expectedLease: OutboxRunningLease
}

/** Plugin-level lease acquisition plan for one scheduler start. */
export type OutboundQueueLeaseAcquirePlan =
  | {
      readonly ok: true
      readonly action: Extract<
        OutboxLeaseAcquireDecision,
        { readonly action: 'acquire' | 'take-over-expired' }
      >['action']
      readonly write: OutboundQueueLeaseWrite
      readonly previousOwnerId: string | undefined
    }
  | {
      readonly ok: false
      readonly reason: Extract<OutboxLeaseAcquireDecision, { readonly action: 'reject' }>['reason']
    }

/** Input for planning lease renewal while a queued side effect is still running. */
export interface OutboundQueueLeaseRenewInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Plugin-level lease renewal plan for one running side effect. */
export type OutboundQueueLeaseRenewPlan =
  | {
      readonly ok: true
      readonly write: OutboundQueueLeaseWrite
    }
  | {
      readonly ok: false
      readonly reason: Extract<OutboxLeaseRenewDecision, { readonly action: 'reject' }>['reason']
    }

/** Input for planning lease release after a queued side effect finishes. */
export interface OutboundQueueLeaseReleaseInput {
  readonly itemId: OutboxPlanItemId
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Plugin-level lease release plan for one completed or failed side effect. */
export type OutboundQueueLeaseReleasePlan =
  | {
      readonly ok: true
      readonly delete: OutboundQueueLeaseDelete
    }
  | {
      readonly ok: false
      readonly reason: Extract<OutboxLeaseReleaseDecision, { readonly action: 'reject' }>['reason']
    }

/** Input for applying a server response to one running outbound Yjs update. */
export interface OutboundQueueAckCompletionInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly status: OutboxItemStatus
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly minDurableSeqExclusive?: number | undefined
  readonly message: Ack | NeedFullSnapshot
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Atomic transaction plan for server-response completion and lease release. */
export type OutboundQueueAckCompletionPlan =
  | {
      readonly ok: true
      readonly action: Extract<
        OutboxAckCompletionDecision,
        { readonly action: 'complete' | 'pause-for-full-snapshot' }
      >['action']
      readonly itemId: OutboxPlanItemId
      readonly patch: OutboxAckCompletionPatch
      readonly leaseDelete: OutboundQueueLeaseDelete
    }
  | {
      readonly ok: false
      readonly reason:
        | Extract<OutboxAckCompletionDecision, { readonly action: 'reject' }>['reason']
        | Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>['reason']
      readonly ackDecision?:
        | Extract<OutboxAckCompletionDecision, { readonly action: 'reject' }>
        | undefined
      readonly leaseRelease?:
        | Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>
        | undefined
    }

/** Input for applying server quarantine evidence to one running outbound Yjs update. */
export interface OutboundQueueQuarantinePauseInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly status: OutboxItemStatus
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: QuarantinedUpdateEntry['updateSha256'] | undefined
  readonly quarantine: QuarantinedUpdateEntry
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Atomic transaction plan for quarantine pause and lease release. */
export type OutboundQueueQuarantinePausePlan =
  | {
      readonly ok: true
      readonly itemId: OutboxPlanItemId
      readonly patch: OutboxQuarantinePausePatch
      readonly leaseDelete: OutboundQueueLeaseDelete
    }
  | {
      readonly ok: false
      readonly reason:
        | Extract<OutboxQuarantinePauseDecision, { readonly action: 'reject' }>['reason']
        | Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>['reason']
      readonly quarantineDecision?:
        | Extract<OutboxQuarantinePauseDecision, { readonly action: 'reject' }>
        | undefined
      readonly leaseRelease?:
        | Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>
        | undefined
    }

/** Input for applying a failed side-effect attempt to one running outbox item. */
export interface OutboundQueueFailureCompletionInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly retryCount: number
  readonly error: OutboxRunError
  readonly retryJitterMs?: number | undefined
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Input for marking a non-ack side effect as successfully completed. */
export interface OutboundQueueSuccessCompletionInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly status: OutboxItemStatus
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Atomic transaction plan for local/HTTP side-effect success and lease release. */
export type OutboundQueueSuccessCompletionPlan =
  | {
      readonly ok: true
      readonly itemId: OutboxPlanItemId
      readonly kind: Exclude<OutboxRetryKind, 'y-update' | 'meta-ref-update'>
      readonly patch: {
        readonly status: 'done'
        readonly nextAttemptAt: undefined
      }
      readonly leaseDelete: OutboundQueueLeaseDelete
    }
  | {
      readonly ok: false
      readonly reason:
        | 'unsupported-kind'
        | 'invalid-status'
        | Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>['reason']
      readonly leaseRelease?:
        | Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>
        | undefined
    }

/** Atomic transaction plan for failed-attempt transition and lease release. */
export type OutboundQueueFailureCompletionPlan =
  | {
      readonly ok: true
      readonly itemId: OutboxPlanItemId
      readonly patch: OutboxFailureTransition
      readonly leaseDelete: OutboundQueueLeaseDelete
    }
  | {
      readonly ok: false
      readonly reason: Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>['reason']
      readonly leaseRelease: Extract<OutboundQueueLeaseReleasePlan, { readonly ok: false }>
    }

/** Input for closing stale full-snapshot-paused updates after applying a snapshot. */
export interface OutboundQueueFullSnapshotReleaseInput {
  readonly appliedDocId: DocId
  readonly snapshotSeq: number
  readonly items: readonly OutboxFullSnapshotPausedItem[]
}

/** Plugin-level plan for terminal patches saved with full snapshot apply. */
export type OutboundQueueFullSnapshotReleasePlan = OutboxFullSnapshotReleasePlan

/**
 * Plans one outbound queue tick for the Obsidian plugin.
 *
 * @param input Queue snapshot, leases, auth evidence, runtime profile, and current clock.
 * @returns Persistable patches, start candidates needing leases, and auth refresh decision.
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
 *
 * @param input Start candidate, worker owner ID, lease duration, clock, and currently persisted lease.
 * @returns A CAS write plan or the reason the candidate must not start.
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
 *
 * @param input Running item identity, owner ID, lease duration, clock, and currently persisted lease.
 * @returns A CAS write plan or the reason the running worker must stop updating item state.
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
 *
 * @param input Finished item identity, owner ID, current clock, and currently persisted lease.
 * @returns A CAS delete plan or the reason the worker must not commit completion.
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
 *
 * @param input Outbox item identity, server response, lease owner, clock, and current lease evidence.
 * @returns A transaction plan that must be applied atomically, or the reason to ignore the response.
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
 *
 * @param input Outbox item identity, quarantine evidence, lease owner, clock, and current lease evidence.
 * @returns A transaction plan that must be applied atomically, or the reason to ignore the evidence.
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
 *
 * @param input Completed item identity, current item status, lease owner, clock, and lease evidence.
 * @returns A done patch plus lease CAS delete, or the reason completion must be ignored.
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
 *
 * @param input Outbox item identity, retry evidence, lease owner, clock, and current lease evidence.
 * @returns A transaction plan that must be applied atomically, or the reason to ignore stale completion.
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
 *
 * @param input Applied doc, snapshot sequence, and paused queue items visible in the same transaction.
 * @returns Terminal patches to persist with the snapshot apply transaction.
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
