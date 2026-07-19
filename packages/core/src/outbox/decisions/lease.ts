import * as v from 'valibot'

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
import {
  OutboxLeaseAcquirePrimitivesSchema,
  OutboxLeaseExpirySchema,
  OutboxLeaseOwnerSchema,
  OutboxLeaseReleasePrimitivesSchema,
  OutboxLeaseRenewPrimitivesSchema,
} from '../validation'

/**
 * Decides whether a scheduler start can acquire or take over a running lease.
 */
export function decideOutboxLeaseAcquire(
  input: OutboxLeaseAcquireInput,
): OutboxLeaseAcquireDecision {
  const result = v.safeParse(OutboxLeaseAcquirePrimitivesSchema, {
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
  })
  if (!result.success) {
    const path = result.issues[0]?.path ?? []
    const field = path[path.length - 1]?.key
    if (path.length === 1 && field === 'ownerId') return { action: 'reject', reason: 'empty-owner' }
    if (path.length === 1 && field === 'now') return { action: 'reject', reason: 'invalid-clock' }
    if (path.length === 1 && field === 'leaseDurationMs') {
      return { action: 'reject', reason: 'invalid-lease-duration' }
    }
    return { action: 'reject', reason: 'active-lease-exists' }
  }
  const { ownerId, now, leaseDurationMs } = result.output

  const nextLease: OutboxRunningLease = {
    itemId: input.itemId,
    kind: input.kind,
    ownerId,
    leaseExpiresAt: now + leaseDurationMs,
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
  const expiryResult = v.safeParse(OutboxLeaseExpirySchema, {
    leaseExpiresAt: input.existingLease.leaseExpiresAt,
  })
  if (!expiryResult.success || expiryResult.output.leaseExpiresAt > now) {
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
  const result = v.safeParse(OutboxLeaseReleasePrimitivesSchema, {
    ownerId: input.ownerId,
    now: input.now,
  })
  if (!result.success) {
    const path = result.issues[0]?.path ?? []
    const field = path[path.length - 1]?.key
    if (path.length === 1 && field === 'ownerId') return { action: 'reject', reason: 'empty-owner' }
    if (path.length === 1 && field === 'now') return { action: 'reject', reason: 'invalid-clock' }
    return { action: 'reject', reason: 'invalid-clock' }
  }
  const { ownerId, now } = result.output
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.ownerId !== ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  const expiryResult = v.safeParse(OutboxLeaseExpirySchema, {
    leaseExpiresAt: input.existingLease.leaseExpiresAt,
  })
  if (!expiryResult.success || expiryResult.output.leaseExpiresAt <= now) {
    return { action: 'reject', reason: 'lease-expired' }
  }
  return { action: 'release' }
}

/**
 * Decides whether a worker may extend a running lease it owns.
 */
export function decideOutboxLeaseRenew(input: OutboxLeaseRenewInput): OutboxLeaseRenewDecision {
  const result = v.safeParse(OutboxLeaseRenewPrimitivesSchema, {
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
  })
  if (!result.success) {
    const path = result.issues[0]?.path ?? []
    const field = path[path.length - 1]?.key
    if (path.length === 1 && field === 'ownerId') return { action: 'reject', reason: 'empty-owner' }
    if (path.length === 1 && field === 'now') return { action: 'reject', reason: 'invalid-clock' }
    if (path.length === 1 && field === 'leaseDurationMs') {
      return { action: 'reject', reason: 'invalid-lease-duration' }
    }
    return { action: 'reject', reason: 'invalid-clock' }
  }
  const { ownerId, now, leaseDurationMs } = result.output
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.kind !== input.kind) {
    return { action: 'reject', reason: 'lease-kind-mismatch' }
  }
  if (input.existingLease.ownerId !== ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  const expiryResult = v.safeParse(OutboxLeaseExpirySchema, {
    leaseExpiresAt: input.existingLease.leaseExpiresAt,
  })
  if (!expiryResult.success || expiryResult.output.leaseExpiresAt <= now) {
    return { action: 'reject', reason: 'lease-expired' }
  }

  return {
    action: 'renew',
    lease: {
      itemId: input.itemId,
      kind: input.kind,
      ownerId,
      leaseExpiresAt: now + leaseDurationMs,
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
    const ownerResult = v.safeParse(OutboxLeaseOwnerSchema, {
      ownerId: lease.ownerId,
    })
    if (!ownerResult.success) {
      return { ok: false, reason: 'empty-lease-owner', id: lease.itemId }
    }
    const expiryResult = v.safeParse(OutboxLeaseExpirySchema, {
      leaseExpiresAt: lease.leaseExpiresAt,
    })
    if (!expiryResult.success) {
      return { ok: false, reason: 'invalid-lease-expiry', id: lease.itemId }
    }
    if (expiryResult.output.leaseExpiresAt <= now) {
      reclaimPatches.push({
        id: lease.itemId,
        previousOwnerId: ownerResult.output.ownerId,
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
