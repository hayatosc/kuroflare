import {
  planOutboundQueueFullSnapshotRelease,
  planOutboundQueueLeaseAcquire,
  planOutboundQueueLeaseRenew,
} from '../../engine/queue'
import {
  type OutboxWorkerFullSnapshotReleaseInput,
  type OutboxWorkerFullSnapshotReleasePlan,
  type OutboxWorkerLeaseAttempt,
  type OutboxWorkerLeaseRenewalInput,
  type OutboxWorkerLeaseRenewalPlan,
  type OutboxWorkerStartEffect,
  type OutboxWorkerTickInput,
  type OutboxWorkerTickPlan,
} from '../../engine/worker.types'
import { applyLocalStoreDriverCommit, planLocalStoreDriverReadSet } from '../../store/driver'
import { planLocalStoreIndexedDbReads, planLocalStoreIndexedDbWrites } from '../../store/indexeddb'
import {
  planLocalStoreFullSnapshotReleaseTransaction,
  planLocalStoreLeaseAcquireTransaction,
  planLocalStoreLeaseRenewTransaction,
  planLocalStoreOutboxSchedulerTransaction,
} from '../../store/store'

/**
 * Plans one outbox worker pass from scheduler result through persisted lease starts.
 *
 * @param input Scheduler tick, local-store snapshot, worker identity, clock, and lease duration.
 * @returns Persisted scheduler state, per-candidate lease attempts, and start effects for acquired leases.
 */
export function planOutboxWorkerTick(input: OutboxWorkerTickInput): OutboxWorkerTickPlan {
  if (!input.tick.ok) {
    return {
      ok: false,
      phase: 'scheduler',
      reason: input.tick.reason,
      tick: input.tick,
    }
  }

  const schedulerOperations = planLocalStoreOutboxSchedulerTransaction(input.tick)
  const schedulerReadSet = planLocalStoreDriverReadSet(schedulerOperations)
  const schedulerIndexedDbReads = planLocalStoreIndexedDbReads(schedulerReadSet)
  const schedulerDriverCommit = applyLocalStoreDriverCommit({
    operations: schedulerOperations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!schedulerDriverCommit.ok) {
    return {
      ok: false,
      phase: 'scheduler-persist',
      reason: schedulerDriverCommit.reason,
      schedulerReadSet,
      schedulerIndexedDbReads,
      schedulerDriverCommit,
      apply: schedulerDriverCommit.apply,
    }
  }

  const schedulerApply = schedulerDriverCommit.apply
  const schedulerIndexedDbWrites = planLocalStoreIndexedDbWrites(schedulerDriverCommit.writes)
  let nextOutboxRecords = schedulerDriverCommit.snapshot.outboxRecords
  let nextLeaseRows = schedulerDriverCommit.snapshot.leaseRows
  const leaseAttempts: OutboxWorkerLeaseAttempt[] = []
  const starts: OutboxWorkerStartEffect[] = []

  for (const start of input.tick.leaseCandidates) {
    const existingLease = nextLeaseRows.find((lease) => lease.itemId === start.id)
    const leaseAcquire = planOutboundQueueLeaseAcquire({
      start,
      ownerId: input.ownerId,
      now: input.now,
      leaseDurationMs: input.leaseDurationMs,
      existingLease,
    })
    if (!leaseAcquire.ok) {
      leaseAttempts.push({
        ok: false,
        start,
        reason: leaseAcquire.reason,
        leaseAcquire,
      })
      continue
    }

    const operations = planLocalStoreLeaseAcquireTransaction(leaseAcquire)
    const readSet = planLocalStoreDriverReadSet(operations)
    const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
    const driverCommit = applyLocalStoreDriverCommit({
      operations,
      snapshot: {
        outboxRecords: nextOutboxRecords,
        leaseRows: nextLeaseRows,
      },
    })
    if (!driverCommit.ok) {
      leaseAttempts.push({
        ok: false,
        start,
        reason: driverCommit.reason,
        readSet,
        driverCommit,
        apply: driverCommit.apply,
      })
      continue
    }

    const apply = driverCommit.apply
    nextOutboxRecords = driverCommit.snapshot.outboxRecords
    nextLeaseRows = driverCommit.snapshot.leaseRows
    leaseAttempts.push({
      ok: true,
      start,
      lease: leaseAcquire.write.nextLease,
      previousOwnerId: leaseAcquire.previousOwnerId,
      operations,
      readSet,
      writes: driverCommit.writes,
      indexedDbReads,
      indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
      driverCommit,
      apply,
    })
    starts.push({
      kind: 'start-side-effect',
      start,
      lease: leaseAcquire.write.nextLease,
    })
  }

  return {
    ok: true,
    schedulerOperations,
    schedulerReadSet,
    schedulerWrites: schedulerDriverCommit.writes,
    schedulerIndexedDbReads,
    schedulerIndexedDbWrites,
    schedulerDriverCommit,
    schedulerApply,
    leaseAttempts,
    starts,
    nextOutboxRecords,
    nextLeaseRows,
    authRefresh: input.tick.authRefresh,
  }
}

/**
 * Plans the transaction that renews a running side-effect lease before it expires.
 *
 * @param input Running item identity, owner evidence, lease duration, clock, and local-store snapshot.
 * @returns Atomic lease CAS write plan, or the reason the runner must stop reporting completion.
 */
export function planOutboxWorkerLeaseRenewal(
  input: OutboxWorkerLeaseRenewalInput,
): OutboxWorkerLeaseRenewalPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const renewal = planOutboundQueueLeaseRenew({
    itemId: input.itemId,
    kind: input.kind,
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    existingLease,
  })
  if (!renewal.ok) {
    return {
      ok: false,
      phase: 'renewal',
      reason: renewal.reason,
      renewal,
    }
  }

  const operations = planLocalStoreLeaseRenewTransaction(renewal)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'renewal-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    renewal,
  }
}

/**
 * Plans terminal patches for paused y-update items superseded by a full snapshot apply.
 *
 * @param input Applied document, snapshot sequence, and current local-store snapshot.
 * @returns Local-store transaction plan that closes only matching full-snapshot-required items.
 */
export function planOutboxWorkerFullSnapshotRelease(
  input: OutboxWorkerFullSnapshotReleaseInput,
): OutboxWorkerFullSnapshotReleasePlan {
  const release = planOutboundQueueFullSnapshotRelease({
    appliedDocId: input.appliedDocId,
    snapshotSeq: input.snapshotSeq,
    items: input.currentOutboxRecords,
  })
  if (!release.ok) {
    return {
      ok: false,
      phase: 'release',
      reason: release.reason,
      release,
    }
  }

  const operations = planLocalStoreFullSnapshotReleaseTransaction(release)
  const readSet = planLocalStoreDriverReadSet(operations)
  const indexedDbReads = planLocalStoreIndexedDbReads(readSet)
  const driverCommit = applyLocalStoreDriverCommit({
    operations,
    snapshot: {
      outboxRecords: input.currentOutboxRecords,
      leaseRows: input.currentLeaseRows,
    },
  })
  if (!driverCommit.ok) {
    return {
      ok: false,
      phase: 'release-persist',
      reason: driverCommit.reason,
      readSet,
      indexedDbReads,
      driverCommit,
      apply: driverCommit.apply,
    }
  }

  const apply = driverCommit.apply
  return {
    ok: true,
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    release,
  }
}
