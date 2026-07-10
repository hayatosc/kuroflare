import {
  type OutboxPlanItemId,
  type OutboxDependencyGraphItem,
  type OutboxDependencyBlockPlan,
  type OutboxDependencyBlockPatch,
  type OutboxDependencyDeadLetterPatch,
} from '../types'

interface DependencyFailureAncestors {
  readonly deadLetteredBy: readonly OutboxPlanItemId[]
  readonly blockedBy: readonly OutboxPlanItemId[]
}

function dependencyFailureAncestors(
  item: OutboxDependencyGraphItem,
  byId: ReadonlyMap<OutboxPlanItemId, OutboxDependencyGraphItem>,
  plannedDeadLetterIds: ReadonlySet<OutboxPlanItemId>,
  plannedBlockedIds: ReadonlySet<OutboxPlanItemId>,
  seen: Set<OutboxPlanItemId>,
): DependencyFailureAncestors {
  const deadLetteredBy: OutboxPlanItemId[] = []
  const blockedBy: OutboxPlanItemId[] = []
  for (const dependencyId of item.dependsOn) {
    if (seen.has(dependencyId)) {
      continue
    }
    seen.add(dependencyId)

    const dependency = byId.get(dependencyId)
    if (dependency === undefined) {
      continue
    }

    if (dependency.status === 'failed' || plannedDeadLetterIds.has(dependency.id)) {
      deadLetteredBy.push(dependency.id)
      continue
    }
    if (dependency.status === 'blocked' || plannedBlockedIds.has(dependency.id)) {
      blockedBy.push(dependency.id)
      continue
    }

    const nested = dependencyFailureAncestors(
      dependency,
      byId,
      plannedDeadLetterIds,
      plannedBlockedIds,
      seen,
    )
    deadLetteredBy.push(...nested.deadLetteredBy)
    blockedBy.push(...nested.blockedBy)
  }

  return {
    deadLetteredBy: [...new Set(deadLetteredBy)],
    blockedBy: [...new Set(blockedBy)],
  }
}

/**
 * Plans blocked status patches for items with failed or already blocked ancestors.
 */
export function planOutboxDependencyBlocks(
  items: readonly OutboxDependencyGraphItem[],
): OutboxDependencyBlockPlan {
  const byId = new Map<OutboxPlanItemId, OutboxDependencyGraphItem>()
  for (const item of items) {
    if (byId.has(item.id)) {
      return { ok: false, reason: 'duplicate-item-id', id: item.id }
    }
    byId.set(item.id, item)
  }

  for (const item of items) {
    for (const dependencyId of item.dependsOn) {
      if (!byId.has(dependencyId)) {
        return { ok: false, reason: 'missing-dependency', id: dependencyId }
      }
    }
  }

  const blockPatches: OutboxDependencyBlockPatch[] = []
  const deadLetterPatches: OutboxDependencyDeadLetterPatch[] = []
  const plannedDeadLetterIds = new Set<OutboxPlanItemId>()
  const plannedBlockedIds = new Set<OutboxPlanItemId>()

  for (const item of items) {
    if (item.status === 'done' || item.status === 'failed' || item.status === 'blocked') {
      continue
    }

    const dependencyFailures = dependencyFailureAncestors(
      item,
      byId,
      plannedDeadLetterIds,
      plannedBlockedIds,
      new Set<OutboxPlanItemId>(),
    )
    if (dependencyFailures.deadLetteredBy.length > 0) {
      deadLetterPatches.push({
        id: item.id,
        status: 'failed',
        reason: 'dead-letter',
        deadLetterReason: 'dependency-dead-letter',
        deadLetteredBy: dependencyFailures.deadLetteredBy,
      })
      plannedDeadLetterIds.add(item.id)
      continue
    }
    if (dependencyFailures.blockedBy.length > 0) {
      blockPatches.push({ id: item.id, status: 'blocked', blockedBy: dependencyFailures.blockedBy })
      plannedBlockedIds.add(item.id)
    }
  }

  return { ok: true, blockPatches, deadLetterPatches }
}
