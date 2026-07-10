import {
  type OutboxPlanItemId,
  type OutboxRunningLease,
  type OutboxLeaseAcquireInput,
  type OutboxLeaseReleaseInput,
  type OutboxLeaseRenewInput,
  type OutboxLeaseAcquireDecision,
  type OutboxLeaseReleaseDecision,
  type OutboxLeaseRenewDecision,
  type OutboxLeaseReclaimPatch,
  type OutboxSchedulerTickPlan,
  type OutboxSchedulerItem,
} from '../types'
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../validation'

/**
 * Decides whether a scheduler start can acquire or take over a running lease.
 */
export function decideOutboxLeaseAcquire(
  input: OutboxLeaseAcquireInput,
): OutboxLeaseAcquireDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.leaseDurationMs)) {
    return { action: 'reject', reason: 'invalid-lease-duration' }
  }

  const nextLease: OutboxRunningLease = {
    itemId: input.itemId,
    kind: input.kind,
    ownerId: input.ownerId,
    leaseExpiresAt: input.now + input.leaseDurationMs,
  }

  if (input.existingLease === undefined) {
    return { action: 'acquire', lease: nextLease, previousOwnerId: undefined }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.kind !== input.kind) {
    return { action: 'reject', reason: 'lease-kind-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt > input.now
  ) {
    return { action: 'reject', reason: 'active-lease-exists' }
  }

  return {
    action: 'take-over-expired',
    lease: nextLease,
    previousOwnerId: input.existingLease.ownerId,
  }
}

/**
 * Decides whether a worker may release a running lease it owns.
 */
export function decideOutboxLeaseRelease(
  input: OutboxLeaseReleaseInput,
): OutboxLeaseReleaseDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.ownerId !== input.ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'lease-expired' }
  }
  return { action: 'release' }
}

/**
 * Decides whether a worker may extend a running lease it owns.
 */
export function decideOutboxLeaseRenew(input: OutboxLeaseRenewInput): OutboxLeaseRenewDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.leaseDurationMs)) {
    return { action: 'reject', reason: 'invalid-lease-duration' }
  }
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.kind !== input.kind) {
    return { action: 'reject', reason: 'lease-kind-mismatch' }
  }
  if (input.existingLease.ownerId !== input.ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'lease-expired' }
  }

  return {
    action: 'renew',
    lease: {
      itemId: input.itemId,
      kind: input.kind,
      ownerId: input.ownerId,
      leaseExpiresAt: input.now + input.leaseDurationMs,
    },
  }
}

type EffectiveLeasePlan =
  | {
      readonly ok: true
      readonly activeLeases: readonly OutboxRunningLease[]
      readonly activeLeaseIds: ReadonlySet<OutboxPlanItemId>
      readonly reclaimPatches: readonly OutboxLeaseReclaimPatch[]
    }
  | Extract<OutboxSchedulerTickPlan, { readonly ok: false }>

export function planEffectiveLeases(
  leases: readonly OutboxRunningLease[],
  items: ReadonlyMap<OutboxPlanItemId, OutboxSchedulerItem>,
  now: number,
): EffectiveLeasePlan {
  const seen = new Set<OutboxPlanItemId>()
  const activeLeases: OutboxRunningLease[] = []
  const activeLeaseIds = new Set<OutboxPlanItemId>()
  const reclaimPatches: OutboxLeaseReclaimPatch[] = []

  for (const lease of leases) {
    if (seen.has(lease.itemId)) {
      return { ok: false, reason: 'duplicate-lease', id: lease.itemId }
    }
    seen.add(lease.itemId)

    if (!items.has(lease.itemId)) {
      return { ok: false, reason: 'missing-lease-item', id: lease.itemId }
    }
    if (lease.ownerId.length === 0) {
      return { ok: false, reason: 'empty-lease-owner', id: lease.itemId }
    }
    if (!isNonNegativeSafeInteger(lease.leaseExpiresAt)) {
      return { ok: false, reason: 'invalid-lease-expiry', id: lease.itemId }
    }

    if (lease.leaseExpiresAt <= now) {
      reclaimPatches.push({
        id: lease.itemId,
        previousOwnerId: lease.ownerId,
        status: 'retrying',
        nextAttemptAt: undefined,
      })
      continue
    }

    activeLeases.push(lease)
    activeLeaseIds.add(lease.itemId)
  }

  return { ok: true, activeLeases, activeLeaseIds, reclaimPatches }
}
