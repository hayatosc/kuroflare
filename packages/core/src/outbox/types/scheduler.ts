import { type OutboxSchedulerAuthGateInput } from './auth'
import {
  type OutboxPlanItemId,
  type OutboxRetryKind,
  type OutboxRunError,
  type OutboxItemStatus,
  type OutboxDependencyState,
  type OutboxResumeCondition,
  type OutboxResumeEvent,
  type OutboxRuntimeProfile,
  type OutboxConcurrencyLane,
} from './base'
import { type OutboxRunningLease } from './lease'

/** Input for deciding what to do after an outbox item fails. */
export interface OutboxRetryDecisionInput {
  readonly kind: OutboxRetryKind
  readonly retryCount: number
  readonly error: OutboxRunError
}

/** Input for applying a failed attempt to an outbox item record. */
export interface OutboxFailureTransitionInput extends OutboxRetryDecisionInput {
  readonly now: number
  readonly retryJitterMs?: number
}

/** Input for deciding whether an outbox item may run now. */
export interface OutboxRunDecisionInput {
  readonly status: OutboxItemStatus
  readonly dependencies: readonly OutboxDependencyState[]
  readonly nextAttemptAt: number | undefined
  readonly now: number
}

/** Input for deciding whether a runnable item may start under concurrency limits. */
export interface OutboxConcurrencyDecisionInput {
  readonly kind: OutboxRetryKind
  readonly profile: OutboxRuntimeProfile
  readonly runningInLane: number
}

/** Input for deciding whether a paused item can be resumed by an event. */
export interface OutboxResumeDecisionInput {
  readonly status: OutboxItemStatus
  readonly resumeOn: OutboxResumeCondition | undefined
  readonly event: OutboxResumeEvent
}

/** Minimal outbox record needed to propagate dependency failures. */
export interface OutboxDependencyGraphItem {
  readonly id: OutboxPlanItemId
  readonly status: OutboxItemStatus
  readonly dependsOn: readonly OutboxPlanItemId[]
}

/** Minimal outbox record needed to plan a scheduler scan. */
export interface OutboxSchedulerItem extends OutboxDependencyGraphItem {
  readonly kind: OutboxRetryKind
  readonly nextAttemptAt: number | undefined
  readonly resumeOn?: OutboxResumeCondition | undefined
}

/** Input for planning a single outbound queue scheduler scan. */
export interface OutboxSchedulerTickInput {
  readonly items: readonly OutboxSchedulerItem[]
  readonly now: number
  readonly profile: OutboxRuntimeProfile
  readonly resumeEvents: readonly OutboxResumeEvent[]
  readonly leases: readonly OutboxRunningLease[]
  readonly maxStarts: number
  readonly auth?: OutboxSchedulerAuthGateInput | undefined
}

/** Persistable patch for a paused item resumed by an observed event. */
export interface OutboxResumePatch {
  readonly id: OutboxPlanItemId
  readonly status: 'pending'
  readonly nextAttemptAt: undefined
}

/** Persistable dependency block patch for an item whose ancestor failed. */
export interface OutboxDependencyBlockPatch {
  readonly id: OutboxPlanItemId
  readonly status: 'blocked'
  readonly blockedBy: readonly OutboxPlanItemId[]
}

/** Persistable terminal patch for an item whose dependency was dead-lettered. */
export interface OutboxDependencyDeadLetterPatch {
  readonly id: OutboxPlanItemId
  readonly status: 'failed'
  readonly reason: 'dead-letter'
  readonly deadLetterReason: 'dependency-dead-letter'
  readonly deadLetteredBy: readonly OutboxPlanItemId[]
}

/** Dependency block propagation result for a queue snapshot. */
export type OutboxDependencyBlockPlan =
  | {
      readonly ok: true
      readonly blockPatches: readonly OutboxDependencyBlockPatch[]
      readonly deadLetterPatches: readonly OutboxDependencyDeadLetterPatch[]
    }
  | {
      readonly ok: false
      readonly reason: 'duplicate-item-id' | 'missing-dependency'
      readonly id: OutboxPlanItemId
    }

/** Side-effecting item the scheduler may start after persisting block patches. */
export interface OutboxSchedulerStart {
  readonly id: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly lane: OutboxConcurrencyLane
}
