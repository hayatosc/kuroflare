import { type OutboxPlanItemId, type OutboxRunningLease } from '@kuroflare/core'

import {
  applyLocalStoreTransactionSnapshot,
  localStoreOutboxPatchItemId,
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionApplyPlan,
  type LocalStoreTransactionOperation,
} from './local-store.js'

/** Snapshot rows an IndexedDB transaction must read before applying local-store operations. */
export interface LocalStoreDriverSnapshot {
  readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  readonly leaseRows: readonly OutboxRunningLease[]
}

/** Minimal object-store keys required to validate and apply a local-store transaction. */
export interface LocalStoreDriverReadSet {
  readonly outboxItemIds: readonly OutboxPlanItemId[]
  readonly leaseItemIds: readonly OutboxPlanItemId[]
}

/** One concrete object-store write a local-store IndexedDB transaction must perform. */
export type LocalStoreDriverWriteOperation =
  | { readonly kind: 'put-outbox-record'; readonly record: LocalStoreOutboxRecord }
  | { readonly kind: 'put-lease-row'; readonly lease: OutboxRunningLease }
  | {
      readonly kind: 'delete-lease-row'
      readonly itemId: OutboxPlanItemId
      readonly expectedLease: OutboxRunningLease
    }

/** Input for applying a local-store transaction through the driver boundary. */
export interface LocalStoreDriverCommitInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly snapshot: LocalStoreDriverSnapshot
}

/** Input for executing the full local-store driver transaction pipeline in memory. */
export interface LocalStoreDriverTransactionInput {
  readonly source: LocalStoreDriverSnapshot
  readonly operations: readonly LocalStoreTransactionOperation[]
}

/** Input for selecting the rows a local-store driver transaction must read. */
export interface LocalStoreDriverSnapshotSelectInput {
  readonly source: LocalStoreDriverSnapshot
  readonly readSet: LocalStoreDriverReadSet
}

/** Input for replaying concrete driver writes onto a local-store snapshot. */
export interface LocalStoreDriverWriteApplyInput {
  readonly snapshot: LocalStoreDriverSnapshot
  readonly writes: readonly LocalStoreDriverWriteOperation[]
}

/** Driver-level commit result after local-store transaction semantics have been applied. */
export type LocalStoreDriverCommitPlan =
  | {
      readonly ok: true
      readonly snapshot: LocalStoreDriverSnapshot
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>
    }

/** Result of applying concrete local-store driver writes to a snapshot. */
export type LocalStoreDriverWriteApplyPlan =
  | { readonly ok: true; readonly snapshot: LocalStoreDriverSnapshot }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate-lease-row'
        | 'duplicate-outbox-record'
        | 'lease-cas-mismatch'
        | 'missing-lease-row'
      readonly itemId: OutboxPlanItemId
    }

/** Result of selecting a transaction snapshot from the driver store snapshot. */
export type LocalStoreDriverSnapshotSelectPlan =
  | { readonly ok: true; readonly snapshot: LocalStoreDriverSnapshot }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate-lease-row'
        | 'duplicate-outbox-record'
        | 'duplicate-read-lease-item'
        | 'duplicate-read-outbox-item'
      readonly itemId: OutboxPlanItemId
    }

/** Result of the full read-set, commit, and write-replay local-store driver transaction pipeline. */
export type LocalStoreDriverTransactionPlan =
  | {
      readonly ok: true
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: true }>
      readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: true }>
      readonly writeApply: Extract<LocalStoreDriverWriteApplyPlan, { readonly ok: true }>
      readonly snapshot: LocalStoreDriverSnapshot
    }
  | {
      readonly ok: false
      readonly phase: 'select'
      readonly reason: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: false }>
    }
  | {
      readonly ok: false
      readonly phase: 'commit'
      readonly reason: Extract<LocalStoreDriverCommitPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: true }>
      readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: false }>
    }
  | {
      readonly ok: false
      readonly phase: 'write'
      readonly reason: Extract<LocalStoreDriverWriteApplyPlan, { readonly ok: false }>['reason']
      readonly itemId: OutboxPlanItemId
      readonly readSet: LocalStoreDriverReadSet
      readonly selection: Extract<LocalStoreDriverSnapshotSelectPlan, { readonly ok: true }>
      readonly commit: Extract<LocalStoreDriverCommitPlan, { readonly ok: true }>
      readonly writeApply: Extract<LocalStoreDriverWriteApplyPlan, { readonly ok: false }>
    }

/**
 * Derives the exact object-store keys that must be read before committing operations.
 *
 * @param operations Ordered local-store transaction operations.
 * @returns De-duplicated outbox and lease item IDs in first-use order.
 */
export function planLocalStoreDriverReadSet(
  operations: readonly LocalStoreTransactionOperation[],
): LocalStoreDriverReadSet {
  const outboxItemIds = new UniqueOutboxItemIds()
  const leaseItemIds = new UniqueOutboxItemIds()

  for (const operation of operations) {
    if (operation.kind === 'put-outbox') {
      outboxItemIds.add(operation.put.record.id)
      continue
    }

    if (operation.kind === 'patch-outbox') {
      outboxItemIds.add(localStoreOutboxPatchItemId(operation.patch))
      continue
    }

    const leaseOperation = operation.operation
    if (leaseOperation.kind === 'put-lease') {
      leaseItemIds.add(leaseOperation.write.itemId)
      continue
    }
    leaseItemIds.add(leaseOperation.delete.itemId)
  }

  return {
    outboxItemIds: outboxItemIds.values(),
    leaseItemIds: leaseItemIds.values(),
  }
}

/**
 * Applies local-store operations to rows read by the concrete IndexedDB transaction.
 *
 * @param input Ordered operations and the rows read from IndexedDB for their read set.
 * @returns The next driver snapshot, or the first local-store precondition failure.
 */
export function applyLocalStoreDriverCommit(
  input: LocalStoreDriverCommitInput,
): LocalStoreDriverCommitPlan {
  const apply = applyLocalStoreTransactionSnapshot({
    operations: input.operations,
    currentOutboxRecords: input.snapshot.outboxRecords,
    currentLeaseRows: input.snapshot.leaseRows,
  })

  if (!apply.ok) {
    return {
      ok: false,
      reason: apply.reason,
      itemId: apply.itemId,
      apply,
    }
  }

  return {
    ok: true,
    snapshot: {
      outboxRecords: apply.outboxRecords,
      leaseRows: apply.leaseRows,
    },
    writes: planLocalStoreDriverWrites(apply),
    apply,
  }
}

/**
 * Executes the local-store driver transaction pipeline against an in-memory store snapshot.
 *
 * @param input Source store snapshot and ordered local-store operations.
 * @returns The next full store snapshot, or the first select/commit/write failure.
 */
export function applyLocalStoreDriverTransaction(
  input: LocalStoreDriverTransactionInput,
): LocalStoreDriverTransactionPlan {
  const readSet = planLocalStoreDriverReadSet(input.operations)
  const selection = selectLocalStoreDriverSnapshot({
    source: input.source,
    readSet,
  })
  if (!selection.ok) {
    return {
      ok: false,
      phase: 'select',
      reason: selection.reason,
      itemId: selection.itemId,
      readSet,
      selection,
    }
  }

  const commit = applyLocalStoreDriverCommit({
    operations: input.operations,
    snapshot: selection.snapshot,
  })
  if (!commit.ok) {
    return {
      ok: false,
      phase: 'commit',
      reason: commit.reason,
      itemId: commit.itemId,
      readSet,
      selection,
      commit,
    }
  }

  const writeApply = applyLocalStoreDriverWrites({
    snapshot: input.source,
    writes: commit.writes,
  })
  if (!writeApply.ok) {
    return {
      ok: false,
      phase: 'write',
      reason: writeApply.reason,
      itemId: writeApply.itemId,
      readSet,
      selection,
      commit,
      writeApply,
    }
  }

  return {
    ok: true,
    readSet,
    selection,
    commit,
    writeApply,
    snapshot: writeApply.snapshot,
  }
}

/**
 * Selects the rows requested by a read set from a larger store snapshot.
 *
 * @param input Source store snapshot and de-duplicated read set for one transaction.
 * @returns A transaction snapshot in read-set order, or the first duplicate-row/read-key failure.
 */
export function selectLocalStoreDriverSnapshot(
  input: LocalStoreDriverSnapshotSelectInput,
): LocalStoreDriverSnapshotSelectPlan {
  const outboxRecords = new Map<OutboxPlanItemId, LocalStoreOutboxRecord>()
  for (const record of input.source.outboxRecords) {
    if (outboxRecords.has(record.id)) {
      return { ok: false, reason: 'duplicate-outbox-record', itemId: record.id }
    }
    outboxRecords.set(record.id, record)
  }

  const leaseRows = new Map<OutboxPlanItemId, OutboxRunningLease>()
  for (const lease of input.source.leaseRows) {
    if (leaseRows.has(lease.itemId)) {
      return { ok: false, reason: 'duplicate-lease-row', itemId: lease.itemId }
    }
    leaseRows.set(lease.itemId, lease)
  }

  const seenOutboxReads = new Set<OutboxPlanItemId>()
  const selectedOutboxRecords: LocalStoreOutboxRecord[] = []
  for (const itemId of input.readSet.outboxItemIds) {
    if (seenOutboxReads.has(itemId)) {
      return { ok: false, reason: 'duplicate-read-outbox-item', itemId }
    }
    seenOutboxReads.add(itemId)
    const record = outboxRecords.get(itemId)
    if (record !== undefined) {
      selectedOutboxRecords.push(record)
    }
  }

  const seenLeaseReads = new Set<OutboxPlanItemId>()
  const selectedLeaseRows: OutboxRunningLease[] = []
  for (const itemId of input.readSet.leaseItemIds) {
    if (seenLeaseReads.has(itemId)) {
      return { ok: false, reason: 'duplicate-read-lease-item', itemId }
    }
    seenLeaseReads.add(itemId)
    const lease = leaseRows.get(itemId)
    if (lease !== undefined) {
      selectedLeaseRows.push(lease)
    }
  }

  return {
    ok: true,
    snapshot: {
      outboxRecords: selectedOutboxRecords,
      leaseRows: selectedLeaseRows,
    },
  }
}

/**
 * Replays concrete driver writes onto a snapshot using the same row-level guards expected from IndexedDB.
 *
 * @param input Current snapshot and write operations returned by a successful driver commit plan.
 * @returns The snapshot after writes are applied, or the first row-level write failure.
 */
export function applyLocalStoreDriverWrites(
  input: LocalStoreDriverWriteApplyInput,
): LocalStoreDriverWriteApplyPlan {
  const outboxRecords = new Map<OutboxPlanItemId, LocalStoreOutboxRecord>()
  const outboxOrder: OutboxPlanItemId[] = []
  for (const record of input.snapshot.outboxRecords) {
    if (outboxRecords.has(record.id)) {
      return { ok: false, reason: 'duplicate-outbox-record', itemId: record.id }
    }
    outboxRecords.set(record.id, record)
    outboxOrder.push(record.id)
  }

  const leaseRows = new Map<OutboxPlanItemId, OutboxRunningLease>()
  const leaseOrder: OutboxPlanItemId[] = []
  for (const lease of input.snapshot.leaseRows) {
    if (leaseRows.has(lease.itemId)) {
      return { ok: false, reason: 'duplicate-lease-row', itemId: lease.itemId }
    }
    leaseRows.set(lease.itemId, lease)
    leaseOrder.push(lease.itemId)
  }

  for (const write of input.writes) {
    if (write.kind === 'put-outbox-record') {
      if (!outboxRecords.has(write.record.id)) {
        outboxOrder.push(write.record.id)
      }
      outboxRecords.set(write.record.id, write.record)
      continue
    }

    if (write.kind === 'put-lease-row') {
      if (!leaseRows.has(write.lease.itemId)) {
        leaseOrder.push(write.lease.itemId)
      }
      leaseRows.set(write.lease.itemId, write.lease)
      continue
    }

    const currentLease = leaseRows.get(write.itemId)
    if (currentLease === undefined) {
      return { ok: false, reason: 'missing-lease-row', itemId: write.itemId }
    }
    if (!sameRunningLease(currentLease, write.expectedLease)) {
      return { ok: false, reason: 'lease-cas-mismatch', itemId: write.itemId }
    }
    leaseRows.delete(write.itemId)
  }

  return {
    ok: true,
    snapshot: {
      outboxRecords: outboxOrder.flatMap((itemId) => {
        const record = outboxRecords.get(itemId)
        return record === undefined ? [] : [record]
      }),
      leaseRows: leaseOrder.flatMap((itemId) => {
        const lease = leaseRows.get(itemId)
        return lease === undefined ? [] : [lease]
      }),
    },
  }
}

function planLocalStoreDriverWrites(
  apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>,
): readonly LocalStoreDriverWriteOperation[] {
  const recordsById = new Map(apply.outboxRecords.map((record) => [record.id, record] as const))
  const writes: LocalStoreDriverWriteOperation[] = []

  for (const record of apply.commit.outboxPutRecords) {
    const latestRecord = recordsById.get(record.id)
    if (latestRecord !== undefined) {
      writes.push({ kind: 'put-outbox-record', record: latestRecord })
    }
  }
  for (const itemId of apply.commit.outboxPatchItemIds) {
    const record = recordsById.get(itemId)
    if (record !== undefined) {
      writes.push({ kind: 'put-outbox-record', record })
    }
  }
  for (const leaseWrite of apply.commit.leaseWrites) {
    writes.push({ kind: 'put-lease-row', lease: leaseWrite.nextLease })
  }
  for (const leaseDelete of apply.commit.leaseDeletes) {
    writes.push({
      kind: 'delete-lease-row',
      itemId: leaseDelete.itemId,
      expectedLease: leaseDelete.expectedLease,
    })
  }

  return writes
}

function sameRunningLease(left: OutboxRunningLease, right: OutboxRunningLease): boolean {
  return (
    left.itemId === right.itemId &&
    left.kind === right.kind &&
    left.ownerId === right.ownerId &&
    left.leaseExpiresAt === right.leaseExpiresAt
  )
}

class UniqueOutboxItemIds {
  readonly #ids = new Set<OutboxPlanItemId>()

  add(itemId: OutboxPlanItemId): void {
    this.#ids.add(itemId)
  }

  values(): readonly OutboxPlanItemId[] {
    return [...this.#ids]
  }
}
