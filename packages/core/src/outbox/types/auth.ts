import { type OutboxPlanItemId, type OutboxRetryKind, type OutboxConcurrencyLane } from './base'

/** Expected duration evidence for one auth-protected start candidate. */
export interface OutboxAuthStartEstimate {
  readonly id: OutboxPlanItemId
  readonly estimatedDurationMs: number
}

/** Token lifetime evidence used while selecting scheduler starts. */
export interface OutboxSchedulerAuthGateInput {
  readonly tokenExpiresAt: number
  readonly refreshMarginMs: number
  readonly estimates?: readonly OutboxAuthStartEstimate[] | undefined
  readonly defaultEstimatedDurationMs?: number | undefined
}

/** Start candidate that must wait for token refresh before a lease is acquired. */
export interface OutboxAuthStartRefreshBlock {
  readonly id: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly lane: OutboxConcurrencyLane
  readonly reason: 'token-expired' | 'token-expiring-soon'
  readonly remainingMs: number
  readonly requiredRemainingMs: number
}

/** Current client-side token refresh worker state known to the scheduler caller. */
export type OutboxAuthRefreshState =
  | { readonly status: 'idle' }
  | { readonly status: 'refreshing' }
  | { readonly status: 'backing-off'; readonly nextAllowedRefreshAt: number }

/** Input for deciding whether auth-blocked starts should trigger token refresh. */
export interface OutboxAuthRefreshRequestInput {
  readonly refreshBlocks: readonly OutboxAuthStartRefreshBlock[] | undefined
  readonly refreshState: OutboxAuthRefreshState
  readonly now: number
}

/** Decision for scheduling token refresh after auth start gating blocks work. */
export type OutboxAuthRefreshRequestDecision =
  | {
      readonly action: 'request-refresh'
      readonly reason: 'token-expired' | 'token-expiring-soon'
      readonly requestedAt: number
      readonly blockedItemIds: readonly OutboxPlanItemId[]
    }
  | {
      readonly action: 'wait'
      readonly reason: 'refresh-already-running' | 'refresh-backoff'
      readonly nextAllowedRefreshAt?: number | undefined
      readonly blockedItemIds: readonly OutboxPlanItemId[]
    }
  | { readonly action: 'noop'; readonly reason: 'no-auth-blocks' }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-clock'
        | 'invalid-refresh-backoff'
        | 'invalid-refresh-block'
        | 'duplicate-refresh-block'
      readonly id?: OutboxPlanItemId
    }
