import type {
  Ack,
  DeviceId,
  DocId,
  MessageId,
  NeedFullSnapshot,
  OutboxAckCompletionDecision,
  OutboxAckCompletionPatch,
  OutboxAuthRefreshRequestDecision,
  OutboxAuthRefreshState,
  OutboxDependencyBlockPatch,
  OutboxDependencyDeadLetterPatch,
  OutboxFailureTransition,
  OutboxFullSnapshotPausedItem,
  OutboxFullSnapshotReleasePlan,
  OutboxItemStatus,
  OutboxLeaseAcquireDecision,
  OutboxLeaseReclaimPatch,
  OutboxLeaseReleaseDecision,
  OutboxLeaseRenewDecision,
  OutboxPlanItemId,
  OutboxQuarantinePauseDecision,
  OutboxQuarantinePausePatch,
  OutboxResumeEvent,
  OutboxResumePatch,
  OutboxRetryKind,
  OutboxRunError,
  OutboxRunningLease,
  OutboxRuntimeProfile,
  OutboxSchedulerAuthGateInput,
  OutboxSchedulerItem,
  OutboxSchedulerStart,
  OutboxSchedulerTickPlan,
  QuarantinedUpdateEntry,
  VaultId,
} from '@kuroflare/core'

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
