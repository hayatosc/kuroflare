/** Stable item ID assigned by the caller before persisting an outbox plan. */
export type OutboxPlanItemId = string

/** Outbox work item kind used for retry and backoff decisions. */
export type OutboxRetryKind =
  | 'y-update'
  | 'blob-put'
  | 'manifest-put'
  | 'blob-get'
  | 'meta-ref-update'
  | 'materialize'

/** Error observed while running an outbox item. */
export type OutboxRunError =
  | { readonly kind: 'network' | 'timeout' | 'offline' }
  | {
      readonly kind: 'api'
      readonly retryable: boolean
      readonly retryAfterMs?: number
      readonly code?: string
    }
  | {
      readonly kind: 'local-conflict' | 'invalid-payload' | 'auth' | 'metadata-migration-required'
    }

/** Retry timing policy for a class of outbox item. */
export interface OutboxRetryPolicy {
  readonly scheduleMs: readonly number[]
  readonly maxRetryCount?: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** Minimal status persisted for an outbox item. */
export type OutboxItemStatus = 'pending' | 'retrying' | 'paused' | 'done' | 'failed' | 'blocked'

/** Minimal dependency evidence needed by the outbox scheduler. */
export interface OutboxDependencyState {
  readonly status: OutboxItemStatus
}

/** Resume trigger recorded or observed by the plugin queue. */
export type OutboxResumeEvent = 'manual' | 'local-state-change' | 'auth-refresh'

/** Condition that lets a paused outbox item return to pending. */
export type OutboxResumeCondition = OutboxResumeEvent

/** Runtime profile used to size concurrent outbox work. */
export type OutboxRuntimeProfile = 'desktop' | 'mobile'

/** Coarse concurrency lane for an outbox item. */
export type OutboxConcurrencyLane = 'sync-control' | 'blob-transfer' | 'materialize'
