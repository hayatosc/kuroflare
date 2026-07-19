import * as v from 'valibot'

import {
  type OutboxPlanItemId,
  type OutboxAuthRefreshRequestInput,
  type OutboxAuthRefreshRequestDecision,
} from '../types'
import {
  OutboxAuthRefreshBackoffSchema,
  OutboxAuthRefreshBlockEvidenceSchema,
  OutboxAuthRefreshRequestPrimitivesSchema,
} from '../validation'

/**
 * Decides whether auth-blocked scheduler starts should trigger a token refresh attempt.
 */
export function decideOutboxAuthRefreshRequest(
  input: OutboxAuthRefreshRequestInput,
): OutboxAuthRefreshRequestDecision {
  const result = v.safeParse(OutboxAuthRefreshRequestPrimitivesSchema, {
    now: input.now,
  })
  if (!result.success) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  const { now } = result.output
  let nextAllowedRefreshAt: number | undefined
  if (input.refreshState.status === 'backing-off') {
    const backoffResult = v.safeParse(OutboxAuthRefreshBackoffSchema, input.refreshState)
    if (!backoffResult.success) {
      return { action: 'reject', reason: 'invalid-refresh-backoff' }
    }
    nextAllowedRefreshAt = backoffResult.output.nextAllowedRefreshAt
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
    const blockResult = v.safeParse(OutboxAuthRefreshBlockEvidenceSchema, block)
    if (!blockResult.success) {
      return { action: 'reject', reason: 'invalid-refresh-block', id: block.id }
    }
    const validatedBlock = blockResult.output
    if (
      (block.reason === 'token-expired' && validatedBlock.remainingMs > 0) ||
      (block.reason === 'token-expiring-soon' && validatedBlock.remainingMs <= 0)
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
    nextAllowedRefreshAt !== undefined &&
    now < nextAllowedRefreshAt
  ) {
    return {
      action: 'wait',
      reason: 'refresh-backoff',
      nextAllowedRefreshAt,
      blockedItemIds,
    }
  }

  return {
    action: 'request-refresh',
    reason: strongestReason,
    requestedAt: now,
    blockedItemIds,
  }
}
