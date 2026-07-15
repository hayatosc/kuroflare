import {
  type OutboxRetryKind,
  type OutboxRetryPolicy,
  type OutboxRetryDecision,
  type OutboxFailureTransition,
  type OutboxRunDecision,
  type OutboxConcurrencyDecision,
  type OutboxConcurrencyLane,
  type OutboxRuntimeProfile,
  type OutboxRetryDecisionInput,
  type OutboxFailureTransitionInput,
  type OutboxRunDecisionInput,
  type OutboxConcurrencyDecisionInput,
  Y_UPDATE_RETRY_POLICY,
  BLOB_RETRY_POLICY,
  MATERIALIZE_RETRY_POLICY,
} from '../types'
import { isNonNegativeSafeInteger } from '../validation'

/**
 * Decides whether an outbox failure should retry, pause, or fail permanently.
 */
export function decideOutboxRetry(input: OutboxRetryDecisionInput): OutboxRetryDecision {
  if (input.retryCount < 0 || !Number.isSafeInteger(input.retryCount)) {
    return { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' }
  }

  switch (input.error.kind) {
    case 'network':
    case 'timeout':
    case 'offline':
      return retryWithPolicy(input.kind, input.retryCount, undefined)
    case 'api':
      return input.error.retryable
        ? retryWithPolicy(input.kind, input.retryCount, input.error.retryAfterMs)
        : { action: 'dead-letter', reason: 'non-retryable-api-error' }
    case 'local-conflict':
      return {
        action: 'pause',
        reason: 'dependency-or-local-state',
        resumeOn: 'local-state-change',
      }
    case 'metadata-migration-required':
      return {
        action: 'pause',
        reason: 'metadata-schema-v2-migration-required',
        resumeOn: 'manual',
      }
    case 'invalid-payload':
      return { action: 'dead-letter', reason: 'invalid-payload' }
    case 'auth':
      return { action: 'pause', reason: 'auth-required', resumeOn: 'auth-refresh' }
  }
}

/**
 * Builds the persistable item update after an outbox attempt fails.
 */
export function transitionOutboxFailure(
  input: OutboxFailureTransitionInput,
): OutboxFailureTransition {
  if (!isNonNegativeSafeInteger(input.now)) {
    return {
      status: 'paused',
      retryCount: input.retryCount,
      nextAttemptAt: undefined,
      lastError: input.error,
      reason: 'manual-intervention-required',
      resumeOn: 'manual',
    }
  }

  const retryDecision = decideOutboxRetry(input)
  switch (retryDecision.action) {
    case 'retry':
      const retryJitterMs = selectedRetryJitterMs(input.retryJitterMs, retryDecision)
      return {
        status: 'retrying',
        retryCount: input.retryCount + 1,
        nextAttemptAt: input.now + retryDecision.delayMs + retryJitterMs,
        lastError: input.error,
      }
    case 'pause':
      return {
        status: 'paused',
        retryCount: input.retryCount,
        nextAttemptAt: undefined,
        lastError: input.error,
        reason: retryDecision.reason,
        resumeOn: retryDecision.resumeOn,
      }
    case 'dead-letter':
      return {
        status: 'failed',
        retryCount: input.retryCount,
        nextAttemptAt: undefined,
        lastError: input.error,
        reason: 'dead-letter',
        deadLetterReason: retryDecision.reason,
      }
  }
}

/**
 * Decides whether an outbox item may execute at the current time.
 */
export function decideOutboxRun(input: OutboxRunDecisionInput): OutboxRunDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'wait', reason: 'invalid-clock' }
  }

  switch (input.status) {
    case 'done':
      return { action: 'wait', reason: 'already-complete' }
    case 'paused':
      return { action: 'wait', reason: 'paused' }
    case 'failed':
    case 'blocked':
      return { action: 'skip', reason: 'failed-or-blocked' }
    case 'pending':
    case 'retrying':
      break
  }

  if (
    input.nextAttemptAt !== undefined &&
    (!isNonNegativeSafeInteger(input.nextAttemptAt) || input.now < input.nextAttemptAt)
  ) {
    return { action: 'wait', reason: 'not-due' }
  }

  if (
    input.dependencies.some(
      (dependency) => dependency.status === 'failed' || dependency.status === 'blocked',
    )
  ) {
    return { action: 'block', reason: 'dependency-failed' }
  }

  if (!input.dependencies.every((dependency) => dependency.status === 'done')) {
    return { action: 'wait', reason: 'dependency-pending' }
  }

  return { action: 'run' }
}

/**
 * Decides whether a runnable outbox item may start under per-lane concurrency limits.
 */
export function decideOutboxConcurrency(
  input: OutboxConcurrencyDecisionInput,
): OutboxConcurrencyDecision {
  const lane = outboxConcurrencyLane(input.kind)
  const limit = outboxConcurrencyLimit(input.kind, input.profile)
  if (!isNonNegativeSafeInteger(input.runningInLane)) {
    return { action: 'wait', reason: 'invalid-running-count', lane, limit }
  }

  return input.runningInLane < limit
    ? { action: 'start', lane, limit }
    : { action: 'wait', reason: 'concurrency-limit-reached', lane, limit }
}

/**
 * Returns the concurrency lane for an outbox item kind.
 */
export function outboxConcurrencyLane(kind: OutboxRetryKind): OutboxConcurrencyLane {
  switch (kind) {
    case 'y-update':
    case 'meta-ref-update':
      return 'sync-control'
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
      return 'blob-transfer'
    case 'materialize':
      return 'materialize'
  }
}

/**
 * Returns the runtime concurrency limit for an outbox item kind.
 */
export function outboxConcurrencyLimit(
  kind: OutboxRetryKind,
  profile: OutboxRuntimeProfile,
): number {
  switch (outboxConcurrencyLane(kind)) {
    case 'sync-control':
      return 1
    case 'blob-transfer':
      return profile === 'mobile' ? 2 : 4
    case 'materialize':
      return 1
  }
}

/**
 * Returns the retry policy for an outbox item kind.
 */
export function outboxRetryPolicy(kind: OutboxRetryKind): OutboxRetryPolicy {
  switch (kind) {
    case 'y-update':
    case 'meta-ref-update':
      return Y_UPDATE_RETRY_POLICY
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
      return BLOB_RETRY_POLICY
    case 'materialize':
      return MATERIALIZE_RETRY_POLICY
  }
}

function retryWithPolicy(
  kind: OutboxRetryKind,
  retryCount: number,
  retryAfterMs: number | undefined,
): OutboxRetryDecision {
  const policy = outboxRetryPolicy(kind)
  if (policy.maxRetryCount !== undefined && retryCount >= policy.maxRetryCount) {
    return { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' }
  }

  const scheduledDelayMs =
    policy.scheduleMs[Math.min(retryCount, policy.scheduleMs.length - 1)] ?? policy.maxDelayMs
  const retryAfterDelayMs = isNonNegativeSafeInteger(retryAfterMs) ? retryAfterMs : 0
  return {
    action: 'retry',
    delayMs: Math.max(scheduledDelayMs, retryAfterDelayMs),
    jitterRatio: policy.jitterRatio,
  }
}

function selectedRetryJitterMs(
  requestedJitterMs: number | undefined,
  retryDecision: Extract<OutboxRetryDecision, { readonly action: 'retry' }>,
): number {
  if (!isNonNegativeSafeInteger(requestedJitterMs)) {
    return 0
  }

  const maxJitterMs = Math.ceil(retryDecision.delayMs * retryDecision.jitterRatio)
  return Math.min(requestedJitterMs, maxJitterMs)
}

export function outboxKindRequiresAuth(kind: OutboxRetryKind): boolean {
  switch (kind) {
    case 'y-update':
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
    case 'meta-ref-update':
      return true
    case 'materialize':
      return false
  }
}
