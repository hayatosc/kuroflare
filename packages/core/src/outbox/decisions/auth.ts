import {
  type OutboxPlanItemId,
  type OutboxAuthRefreshRequestInput,
  type OutboxAuthRefreshRequestDecision,
} from '../types'
import { isNonNegativeSafeInteger } from '../validation'

/**
 * Decides whether auth-blocked scheduler starts should trigger a token refresh attempt.
 */
export function decideOutboxAuthRefreshRequest(
  input: OutboxAuthRefreshRequestInput,
): OutboxAuthRefreshRequestDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (
    input.refreshState.status === 'backing-off' &&
    !isNonNegativeSafeInteger(input.refreshState.nextAllowedRefreshAt)
  ) {
    return { action: 'reject', reason: 'invalid-refresh-backoff' }
  }

  const refreshBlocks = input.refreshBlocks ?? []
  if (refreshBlocks.length === 0) {
    return { action: 'noop', reason: 'no-auth-blocks' }
  }

  const seen = new Set<OutboxPlanItemId>()
  let strongestReason: 'token-expired' | 'token-expiring-soon' = 'token-expiring-soon'
  for (const block of refreshBlocks) {
    if (seen.has(block.id)) {
      return { action: 'reject', reason: 'duplicate-refresh-block', id: block.id }
    }
    seen.add(block.id)
    if (
      !isNonNegativeSafeInteger(block.requiredRemainingMs) ||
      !Number.isSafeInteger(block.remainingMs) ||
      (block.reason === 'token-expired' && block.remainingMs > 0) ||
      (block.reason === 'token-expiring-soon' && block.remainingMs <= 0)
    ) {
      return { action: 'reject', reason: 'invalid-refresh-block', id: block.id }
    }
    if (block.reason === 'token-expired') {
      strongestReason = 'token-expired'
    }
  }

  const blockedItemIds = refreshBlocks.map((block) => block.id)
  if (input.refreshState.status === 'refreshing') {
    return {
      action: 'wait',
      reason: 'refresh-already-running',
      blockedItemIds,
    }
  }
  if (
    input.refreshState.status === 'backing-off' &&
    input.now < input.refreshState.nextAllowedRefreshAt
  ) {
    return {
      action: 'wait',
      reason: 'refresh-backoff',
      nextAllowedRefreshAt: input.refreshState.nextAllowedRefreshAt,
      blockedItemIds,
    }
  }

  return {
    action: 'request-refresh',
    reason: strongestReason,
    requestedAt: input.now,
    blockedItemIds,
  }
}
