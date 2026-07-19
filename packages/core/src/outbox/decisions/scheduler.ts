import * as v from 'valibot'

import { decideClientAuthStart } from '../../auth'
import {
  type OutboxSchedulerItem,
  type OutboxSchedulerTickInput,
  type OutboxSchedulerTickPlan,
  type OutboxConcurrencyLane,
  type OutboxDependencyState,
  type OutboxAuthStartRefreshBlock,
  type OutboxSchedulerStart,
} from '../types'
import {
  OutboxSchedulerTickInputSchema,
  validateOutboxSchedulerAuthGate,
  mapAuthStartRejectReason,
} from '../validation'
import { planOutboxDependencyBlocks } from './dependency'
import { planEffectiveLeases } from './lease'
import { planOutboxResumePatches } from './resume'
import {
  outboxConcurrencyLane,
  decideOutboxRun,
  decideOutboxConcurrency,
  outboxKindRequiresAuth,
} from './retry'

/**
 * Plans one outbound queue scan without performing side effects.
 */
export function planOutboxSchedulerTick(input: OutboxSchedulerTickInput): OutboxSchedulerTickPlan {
  const inputResult = v.safeParse(OutboxSchedulerTickInputSchema, {
    now: input.now,
    maxStarts: input.maxStarts,
  })
  if (!inputResult.success) {
    const field = inputResult.issues[0]?.path?.at(-1)?.key
    return field === 'maxStarts'
      ? { ok: false, reason: 'invalid-max-starts' }
      : { ok: false, reason: 'invalid-clock' }
  }
  const { now, maxStarts } = inputResult.output
  const authGate = validateOutboxSchedulerAuthGate(input.auth, now)
  if (!authGate.ok) {
    return authGate
  }

  const resumePatches = planOutboxResumePatches(input.items, input.resumeEvents)
  const resumedIds = new Set(resumePatches.map((patch) => patch.id))
  const resumedItems = input.items.map(
    (item): OutboxSchedulerItem =>
      resumedIds.has(item.id) ? { ...item, status: 'pending', nextAttemptAt: undefined } : item,
  )

  const blockPlan = planOutboxDependencyBlocks(resumedItems)
  if (!blockPlan.ok) {
    return { ok: false, reason: blockPlan.reason, id: blockPlan.id }
  }

  const byId = new Map(resumedItems.map((item) => [item.id, item]))
  const leasePlan = planEffectiveLeases(input.leases, byId, now)
  if (!leasePlan.ok) {
    return leasePlan
  }

  const effectiveStatus = new Map(resumedItems.map((item) => [item.id, item.status]))
  for (const patch of blockPlan.blockPatches) {
    effectiveStatus.set(patch.id, 'blocked')
  }
  for (const patch of blockPlan.deadLetterPatches) {
    effectiveStatus.set(patch.id, 'failed')
  }

  const running = new Map<OutboxConcurrencyLane, number>([
    ['sync-control', 0],
    ['blob-transfer', 0],
    ['materialize', 0],
  ])
  for (const lease of leasePlan.activeLeases) {
    const lane = outboxConcurrencyLane(lease.kind)
    running.set(lane, (running.get(lane) ?? 0) + 1)
  }

  const starts: OutboxSchedulerStart[] = []
  const authRefreshBlocks: OutboxAuthStartRefreshBlock[] = []

  for (const item of resumedItems) {
    if (starts.length >= maxStarts) {
      break
    }

    if (leasePlan.activeLeaseIds.has(item.id)) {
      continue
    }

    const status = effectiveStatus.get(item.id) ?? item.status
    const dependencies = item.dependsOn.map((dependencyId): OutboxDependencyState => {
      const dependency = byId.get(dependencyId)
      return { status: effectiveStatus.get(dependencyId) ?? dependency?.status ?? 'blocked' }
    })
    const runDecision = decideOutboxRun({
      status,
      dependencies,
      nextAttemptAt: item.nextAttemptAt,
      now,
    })
    if (runDecision.action !== 'run') {
      continue
    }

    const lane = outboxConcurrencyLane(item.kind)
    const runningInLane = running.get(lane) ?? 0
    const concurrencyDecision = decideOutboxConcurrency({
      kind: item.kind,
      profile: input.profile,
      runningInLane,
    })
    if (concurrencyDecision.action !== 'start') {
      continue
    }

    if (outboxKindRequiresAuth(item.kind) && authGate.auth !== undefined) {
      const authDecision = decideClientAuthStart({
        now,
        tokenExpiresAt: authGate.auth.tokenExpiresAt,
        refreshMarginMs: authGate.auth.refreshMarginMs,
        estimatedDurationMs:
          authGate.estimateById.get(item.id) ?? authGate.auth.defaultEstimatedDurationMs,
      })
      if (authDecision.action === 'reject') {
        return {
          ok: false,
          reason: mapAuthStartRejectReason(authDecision.reason),
          id: item.id,
        }
      }
      if (authDecision.action === 'refresh-first') {
        authRefreshBlocks.push({
          id: item.id,
          kind: item.kind,
          lane,
          reason: authDecision.reason,
          remainingMs: authDecision.remainingMs,
          requiredRemainingMs: authDecision.requiredRemainingMs,
        })
        continue
      }
    }

    starts.push({ id: item.id, kind: item.kind, lane })
    running.set(lane, runningInLane + 1)
  }

  const basePlan = {
    ok: true,
    resumePatches,
    blockPatches: blockPlan.blockPatches,
    deadLetterPatches: blockPlan.deadLetterPatches,
    leaseReclaims: leasePlan.reclaimPatches,
    starts,
  } satisfies Extract<OutboxSchedulerTickPlan, { readonly ok: true }>
  if (authRefreshBlocks.length > 0) {
    return { ...basePlan, authRefreshBlocks }
  }
  return {
    ...basePlan,
  }
}
