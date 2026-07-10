import { type OutboxPlanItemId, type OutboxRetryKind } from './base'

/** Running side-effect lease persisted by the plugin queue. */
export interface OutboxRunningLease {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly leaseExpiresAt: number
}

/** Input for deciding whether a scheduler start may acquire a running lease. */
export interface OutboxLeaseAcquireInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Input for deciding whether a running lease may be released by a worker. */
export interface OutboxLeaseReleaseInput {
  readonly itemId: OutboxPlanItemId
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Input for deciding whether a running lease may be renewed by a worker. */
export interface OutboxLeaseRenewInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Persistable patch for an expired running lease. */
export interface OutboxLeaseReclaimPatch {
  readonly id: OutboxPlanItemId
  readonly previousOwnerId: string
  readonly status: 'retrying'
  readonly nextAttemptAt: undefined
}

/** Decision for acquiring a running lease before starting side effects. */
export type OutboxLeaseAcquireDecision =
  | {
      readonly action: 'acquire'
      readonly lease: OutboxRunningLease
      readonly previousOwnerId: undefined
    }
  | {
      readonly action: 'take-over-expired'
      readonly lease: OutboxRunningLease
      readonly previousOwnerId: string
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'active-lease-exists'
        | 'empty-owner'
        | 'invalid-clock'
        | 'invalid-lease-duration'
        | 'lease-item-mismatch'
        | 'lease-kind-mismatch'
    }

/** Decision for releasing a running lease after completion or failure handling. */
export type OutboxLeaseReleaseDecision =
  | { readonly action: 'release' }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'missing-lease'
        | 'owner-mismatch'
        | 'lease-item-mismatch'
        | 'empty-owner'
        | 'invalid-clock'
        | 'lease-expired'
    }

/** Decision for renewing a running lease before it expires. */
export type OutboxLeaseRenewDecision =
  | { readonly action: 'renew'; readonly lease: OutboxRunningLease }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'missing-lease'
        | 'owner-mismatch'
        | 'lease-item-mismatch'
        | 'lease-kind-mismatch'
        | 'empty-owner'
        | 'invalid-clock'
        | 'invalid-lease-duration'
        | 'lease-expired'
    }
