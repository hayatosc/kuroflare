import {
  type OutboxAckCompletionPatch,
  type OutboxDependencyBlockPatch,
  type OutboxDependencyDeadLetterPatch,
  type OutboxFailureTransition,
  type OutboxFullSnapshotReleasePatch,
  type OutboxLeaseReclaimPatch,
  type LastMaterializedRecord,
  type OutboxPlanItemId,
  type OutboxQuarantinePausePatch,
  type OutboxRetryKind,
  type OutboxResumePatch,
  type OutboxResumeCondition,
  type OutboxRunningLease,
} from '@kuroflare/core'
import {
  type BlobManifest,
  type DocId,
  type FileId,
  type MessageId,
  type Sha256Hex,
} from '@kuroflare/protocol'

import {
  type OutboundQueueAckCompletionPlan,
  type OutboundQueueFullSnapshotReleasePlan,
  type OutboundQueueFailureCompletionPlan,
  type OutboundQueueLeaseAcquirePlan,
  type OutboundQueueLeaseDelete,
  type OutboundQueueLeaseReleasePlan,
  type OutboundQueueLeaseRenewPlan,
  type OutboundQueueLeaseWrite,
  type OutboundQueueQuarantinePausePlan,
  type OutboundQueueSuccessCompletionPlan,
  type OutboundQueueTickPlan,
} from './outbound-queue.js'

/** Successful outbound queue scheduler plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueTickPlan = Extract<OutboundQueueTickPlan, { readonly ok: true }>

/** Successful outbound queue lease acquire plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueLeaseAcquirePlan = Extract<
  OutboundQueueLeaseAcquirePlan,
  { readonly ok: true }
>

/** Successful outbound queue lease renew plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueLeaseRenewPlan = Extract<
  OutboundQueueLeaseRenewPlan,
  { readonly ok: true }
>

/** Successful outbound queue lease release plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueLeaseReleasePlan = Extract<
  OutboundQueueLeaseReleasePlan,
  { readonly ok: true }
>

/** Successful outbound queue ack completion plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueAckCompletionPlan = Extract<
  OutboundQueueAckCompletionPlan,
  { readonly ok: true }
>

/** Successful outbound queue quarantine pause plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueQuarantinePausePlan = Extract<
  OutboundQueueQuarantinePausePlan,
  { readonly ok: true }
>

/** Successful outbound queue full snapshot release plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueFullSnapshotReleasePlan = Extract<
  OutboundQueueFullSnapshotReleasePlan,
  { readonly ok: true }
>

/** Successful outbound queue failure completion plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueFailureCompletionPlan = Extract<
  OutboundQueueFailureCompletionPlan,
  { readonly ok: true }
>

/** Successful outbound queue success completion plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueSuccessCompletionPlan = Extract<
  OutboundQueueSuccessCompletionPlan,
  { readonly ok: true }
>

/** Outbox item patch operation to be applied inside one local store transaction. */
export type LocalStoreOutboxPatch =
  | { readonly kind: 'resume'; readonly patch: OutboxResumePatch }
  | { readonly kind: 'dependency-block'; readonly patch: OutboxDependencyBlockPatch }
  | { readonly kind: 'dependency-dead-letter'; readonly patch: OutboxDependencyDeadLetterPatch }
  | { readonly kind: 'lease-reclaim'; readonly patch: OutboxLeaseReclaimPatch }
  | {
      readonly kind: 'repair-import-resume'
      readonly itemId: OutboxPlanItemId
      readonly patch: {
        readonly status: 'pending'
        readonly nextAttemptAt: undefined
        readonly resumeReason: 'user-confirmed-repair-import'
      }
    }
  | {
      readonly kind: 'ack-completion'
      readonly itemId: OutboxPlanItemId
      readonly patch: OutboxAckCompletionPatch
    }
  | {
      readonly kind: 'quarantine-pause'
      readonly itemId: OutboxPlanItemId
      readonly patch: OutboxQuarantinePausePatch
    }
  | {
      readonly kind: 'failure-completion'
      readonly itemId: OutboxPlanItemId
      readonly patch: OutboxFailureTransition
    }
  | {
      readonly kind: 'success-completion'
      readonly itemId: OutboxPlanItemId
      readonly patch: {
        readonly status: 'done'
        readonly nextAttemptAt: undefined
      }
    }
  | { readonly kind: 'full-snapshot-release'; readonly patch: OutboxFullSnapshotReleasePatch }

/** Outbox running-lease operation to be applied with compare-and-set semantics. */
export type LocalStoreOutboxLeaseOperation =
  | { readonly kind: 'put-lease'; readonly write: OutboundQueueLeaseWrite }
  | { readonly kind: 'delete-lease'; readonly delete: OutboundQueueLeaseDelete }

/** Outbox row insert operation guarded by absence in the same local-store transaction. */
export interface LocalStoreOutboxPut {
  readonly record: LocalStoreOutboxRecord
}

/** One ordered operation for the future IndexedDB-backed local store transaction. */
export type LocalStoreTransactionOperation =
  | { readonly kind: 'put-outbox'; readonly put: LocalStoreOutboxPut }
  | { readonly kind: 'patch-outbox'; readonly patch: LocalStoreOutboxPatch }
  | { readonly kind: 'lease'; readonly operation: LocalStoreOutboxLeaseOperation }

/** Minimal outbox record shape the plugin local store driver must preserve while applying patches. */
export interface LocalStoreOutboxRecord {
  readonly id: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly status: 'pending' | 'retrying' | 'paused' | 'done' | 'failed' | 'blocked'
  readonly dependsOn: readonly OutboxPlanItemId[]
  readonly nextAttemptAt: number | undefined
  readonly resumeOn?: OutboxResumeCondition | undefined
  readonly reason?: string | undefined
  readonly blockedBy?: readonly OutboxPlanItemId[] | undefined
  readonly deadLetterReason?: string | undefined
  readonly deadLetteredBy?: readonly OutboxPlanItemId[] | undefined
  readonly previousOwnerId?: string | undefined
  readonly durableSeq?: number | undefined
  readonly retryCount?: number | undefined
  readonly lastError?: OutboxFailureTransition['lastError'] | undefined
  readonly snapshotReason?: string | undefined
  readonly docId?: DocId | undefined
  readonly messageId?: MessageId | undefined
  readonly updateSha256?: Sha256Hex | undefined
  readonly updateBytesBase64?: string | undefined
  readonly quarantineId?: string | undefined
  readonly quarantineReason?: string | undefined
  readonly completedBy?: 'full-snapshot-apply' | undefined
  readonly snapshotSeq?: number | undefined
  readonly createdAt?: number | undefined
  readonly fileId?: FileId | undefined
  readonly blobSha256?: Sha256Hex | undefined
  readonly blobManifestHash?: Sha256Hex | undefined
  readonly blobManifest?: BlobManifest | undefined
  readonly materializeChunks?:
    | readonly {
        readonly sha256: Sha256Hex
        readonly localCacheKey: string
        readonly size: number
      }[]
    | undefined
  readonly localCacheKey?: string | undefined
  readonly blobSize?: number | undefined
  readonly expectedHash?: Sha256Hex | undefined
  readonly targetPath?: string | undefined
  readonly lastMaterialized?: LastMaterializedRecord | undefined
}

/** Current local-store evidence needed before applying a transaction operation list. */
export interface LocalStoreTransactionCommitInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly currentOutboxItemIds: readonly OutboxPlanItemId[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Commit plan after local-store transaction preconditions and lease CAS checks pass. */
export type LocalStoreTransactionCommitPlan =
  | {
      readonly ok: true
      readonly outboxPutRecords: readonly LocalStoreOutboxRecord[]
      readonly outboxPatchItemIds: readonly OutboxPlanItemId[]
      readonly leaseWrites: readonly OutboundQueueLeaseWrite[]
      readonly leaseDeletes: readonly OutboundQueueLeaseDelete[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
    }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate-current-lease'
        | 'duplicate-current-outbox-item'
        | 'duplicate-outbox-put'
        | 'duplicate-outbox-patch'
        | 'existing-outbox-item'
        | 'invalid-lease-operation'
        | 'lease-cas-mismatch'
        | 'missing-outbox-item'
      readonly itemId: OutboxPlanItemId
    }

/** Result of applying a single local-store outbox patch to one record. */
export type LocalStoreOutboxPatchApplyPlan =
  | { readonly ok: true; readonly record: LocalStoreOutboxRecord }
  | {
      readonly ok: false
      readonly reason: 'patch-item-mismatch'
      readonly itemId: OutboxPlanItemId
    }

/** Input for applying an operation list to a local-store snapshot in driver order. */
export interface LocalStoreTransactionApplyInput {
  readonly operations: readonly LocalStoreTransactionOperation[]
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Local-store snapshot after all transaction operations were applied. */
export type LocalStoreTransactionApplyPlan =
  | {
      readonly ok: true
      readonly outboxRecords: readonly LocalStoreOutboxRecord[]
      readonly leaseRows: readonly OutboxRunningLease[]
      readonly commit: Extract<LocalStoreTransactionCommitPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly reason:
        | Extract<LocalStoreTransactionCommitPlan, { readonly ok: false }>['reason']
        | 'patch-item-mismatch'
      readonly itemId: OutboxPlanItemId
      readonly commit?: Extract<LocalStoreTransactionCommitPlan, { readonly ok: false }> | undefined
    }

/**
 * Converts scheduler persist patches into ordered local-store transaction operations.
 *
 * @param plan Successful outbound queue scheduler plan.
 * @returns Outbox patch operations that must be committed before leases are acquired.
 */
export function planLocalStoreOutboxSchedulerTransaction(
  plan: SuccessfulOutboundQueueTickPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    ...plan.persist.resumePatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'resume', patch },
      }),
    ),
    ...plan.persist.blockPatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'dependency-block', patch },
      }),
    ),
    ...plan.persist.deadLetterPatches.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'dependency-dead-letter', patch },
      }),
    ),
    ...plan.persist.leaseReclaims.map(
      (patch): LocalStoreTransactionOperation => ({
        kind: 'patch-outbox',
        patch: { kind: 'lease-reclaim', patch },
      }),
    ),
  ]
}

/**
 * Converts a lease-acquire plan into the local-store CAS write transaction operation.
 *
 * @param plan Successful lease acquire plan.
 * @returns A single put-lease operation.
 */
export function planLocalStoreLeaseAcquireTransaction(
  plan: SuccessfulOutboundQueueLeaseAcquirePlan,
): readonly LocalStoreTransactionOperation[] {
  return [putLeaseOperation(plan.write)]
}

/**
 * Converts a lease-renew plan into the local-store CAS write transaction operation.
 *
 * @param plan Successful lease renew plan.
 * @returns A single put-lease operation.
 */
export function planLocalStoreLeaseRenewTransaction(
  plan: SuccessfulOutboundQueueLeaseRenewPlan,
): readonly LocalStoreTransactionOperation[] {
  return [putLeaseOperation(plan.write)]
}

/**
 * Converts a lease-release plan into the local-store CAS delete transaction operation.
 *
 * @param plan Successful lease release plan.
 * @returns A single delete-lease operation.
 */
export function planLocalStoreLeaseReleaseTransaction(
  plan: SuccessfulOutboundQueueLeaseReleasePlan,
): readonly LocalStoreTransactionOperation[] {
  return [deleteLeaseOperation(plan.delete)]
}

/**
 * Converts an ack completion plan into an atomic item patch and lease release operation list.
 *
 * @param plan Successful ack completion plan.
 * @returns Ordered operations that patch the outbox item before releasing its lease.
 */
export function planLocalStoreAckCompletionTransaction(
  plan: SuccessfulOutboundQueueAckCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'ack-completion',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a quarantine pause plan into an atomic item patch and lease release operation list.
 *
 * @param plan Successful quarantine pause plan.
 * @returns Ordered operations that pause the outbox item before releasing its lease.
 */
export function planLocalStoreQuarantinePauseTransaction(
  plan: SuccessfulOutboundQueueQuarantinePausePlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'quarantine-pause',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a failed-attempt completion plan into an atomic item patch and lease release operation list.
 *
 * @param plan Successful failure completion plan.
 * @returns Ordered operations that transition the item before releasing its lease.
 */
export function planLocalStoreFailureCompletionTransaction(
  plan: SuccessfulOutboundQueueFailureCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'failure-completion',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a successful non-ack side effect into an atomic item patch and lease release operation list.
 *
 * @param plan Successful side-effect completion plan.
 * @returns Ordered operations that mark the item done before releasing its lease.
 */
export function planLocalStoreSuccessCompletionTransaction(
  plan: SuccessfulOutboundQueueSuccessCompletionPlan,
): readonly LocalStoreTransactionOperation[] {
  return [
    {
      kind: 'patch-outbox',
      patch: {
        kind: 'success-completion',
        itemId: plan.itemId,
        patch: plan.patch,
      },
    },
    deleteLeaseOperation(plan.leaseDelete),
  ]
}

/**
 * Converts a full-snapshot release plan into terminal outbox patch operations.
 *
 * @param plan Successful full snapshot release plan.
 * @returns Outbox terminal patches to apply with the snapshot transaction.
 */
export function planLocalStoreFullSnapshotReleaseTransaction(
  plan: SuccessfulOutboundQueueFullSnapshotReleasePlan,
): readonly LocalStoreTransactionOperation[] {
  return plan.releasePatches.map(
    (patch): LocalStoreTransactionOperation => ({
      kind: 'patch-outbox',
      patch: { kind: 'full-snapshot-release', patch },
    }),
  )
}

/**
 * Validates operation ordering preconditions and folds lease CAS effects for a local-store transaction.
 *
 * @param input Ordered operations plus the currently read outbox IDs and lease rows.
 * @returns A commit plan with next lease rows, or the first precondition failure.
 */
export function planLocalStoreTransactionCommit(
  input: LocalStoreTransactionCommitInput,
): LocalStoreTransactionCommitPlan {
  const currentLeaseRows = new Map<OutboxPlanItemId, OutboxRunningLease>()
  for (const lease of input.currentLeaseRows) {
    if (currentLeaseRows.has(lease.itemId)) {
      return { ok: false, reason: 'duplicate-current-lease', itemId: lease.itemId }
    }
    currentLeaseRows.set(lease.itemId, lease)
  }

  const outboxItemIds = new Set<OutboxPlanItemId>()
  for (const itemId of input.currentOutboxItemIds) {
    if (outboxItemIds.has(itemId)) {
      return { ok: false, reason: 'duplicate-current-outbox-item', itemId }
    }
    outboxItemIds.add(itemId)
  }
  const patchedOutboxItemIds = new Set<OutboxPlanItemId>()
  const putOutboxItemIds = new Set<OutboxPlanItemId>()
  const outboxPutRecords: LocalStoreOutboxRecord[] = []
  const outboxPatchItemIds: OutboxPlanItemId[] = []
  const leaseWrites: OutboundQueueLeaseWrite[] = []
  const leaseDeletes: OutboundQueueLeaseDelete[] = []
  const nextLeaseRows = new Map(currentLeaseRows)

  for (const operation of input.operations) {
    if (operation.kind === 'put-outbox') {
      const record = operation.put.record
      if (putOutboxItemIds.has(record.id)) {
        return { ok: false, reason: 'duplicate-outbox-put', itemId: record.id }
      }
      if (outboxItemIds.has(record.id)) {
        return { ok: false, reason: 'existing-outbox-item', itemId: record.id }
      }
      putOutboxItemIds.add(record.id)
      outboxItemIds.add(record.id)
      outboxPutRecords.push(record)
      continue
    }

    if (operation.kind === 'patch-outbox') {
      const itemId = localStoreOutboxPatchItemId(operation.patch)
      if (!outboxItemIds.has(itemId)) {
        return { ok: false, reason: 'missing-outbox-item', itemId }
      }
      if (patchedOutboxItemIds.has(itemId)) {
        return { ok: false, reason: 'duplicate-outbox-patch', itemId }
      }
      patchedOutboxItemIds.add(itemId)
      outboxPatchItemIds.push(itemId)
      continue
    }

    const leaseOperation = operation.operation
    if (leaseOperation.kind === 'put-lease') {
      const write = leaseOperation.write
      if (
        write.nextLease.itemId !== write.itemId ||
        (write.expectedLease !== undefined && write.expectedLease.itemId !== write.itemId)
      ) {
        return { ok: false, reason: 'invalid-lease-operation', itemId: write.itemId }
      }
      if (!sameRunningLease(nextLeaseRows.get(write.itemId), write.expectedLease)) {
        return { ok: false, reason: 'lease-cas-mismatch', itemId: write.itemId }
      }
      nextLeaseRows.set(write.itemId, write.nextLease)
      leaseWrites.push(write)
      continue
    }

    const deletePlan = leaseOperation.delete
    if (deletePlan.expectedLease.itemId !== deletePlan.itemId) {
      return { ok: false, reason: 'invalid-lease-operation', itemId: deletePlan.itemId }
    }
    if (!sameRunningLease(nextLeaseRows.get(deletePlan.itemId), deletePlan.expectedLease)) {
      return { ok: false, reason: 'lease-cas-mismatch', itemId: deletePlan.itemId }
    }
    nextLeaseRows.delete(deletePlan.itemId)
    leaseDeletes.push(deletePlan)
  }

  return {
    ok: true,
    outboxPutRecords,
    outboxPatchItemIds,
    leaseWrites,
    leaseDeletes,
    nextLeaseRows: [...nextLeaseRows.values()],
  }
}

/**
 * Applies one outbox patch to a local-store record using the plugin's canonical patch semantics.
 *
 * @param record Current outbox record read inside the transaction.
 * @param patch Patch operation to apply to that record.
 * @returns Updated record, or a mismatch when the patch targets a different item.
 */
export function applyLocalStoreOutboxPatch(
  record: LocalStoreOutboxRecord,
  patch: LocalStoreOutboxPatch,
): LocalStoreOutboxPatchApplyPlan {
  const itemId = localStoreOutboxPatchItemId(patch)
  if (record.id !== itemId) {
    return { ok: false, reason: 'patch-item-mismatch', itemId }
  }

  switch (patch.kind) {
    case 'resume':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          resumeOn: undefined,
          reason: undefined,
        },
      }
    case 'dependency-block':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          blockedBy: patch.patch.blockedBy,
        },
      }
    case 'dependency-dead-letter':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          reason: patch.patch.reason,
          deadLetterReason: patch.patch.deadLetterReason,
          deadLetteredBy: patch.patch.deadLetteredBy,
          nextAttemptAt: undefined,
        },
      }
    case 'lease-reclaim':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          previousOwnerId: patch.patch.previousOwnerId,
        },
      }
    case 'repair-import-resume':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          resumeOn: undefined,
          reason: undefined,
        },
      }
    case 'ack-completion':
      return applyAckCompletionPatch(record, patch.patch)
    case 'quarantine-pause':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          reason: patch.patch.reason,
          resumeOn: patch.patch.resumeOn,
          quarantineId: patch.patch.quarantineId,
          quarantineReason: patch.patch.quarantineReason,
          docId: patch.patch.docId,
        },
      }
    case 'failure-completion':
      return applyFailureCompletionPatch(record, patch.patch)
    case 'success-completion':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
        },
      }
    case 'full-snapshot-release':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          completedBy: patch.patch.completedBy,
          snapshotSeq: patch.patch.snapshotSeq,
        },
      }
  }
}

/**
 * Applies an ordered local-store transaction to a snapshot after validating commit preconditions.
 *
 * @param input Current records, current leases, and ordered operations.
 * @returns Updated records and leases, or the first commit/patch failure.
 */
export function applyLocalStoreTransactionSnapshot(
  input: LocalStoreTransactionApplyInput,
): LocalStoreTransactionApplyPlan {
  const commit = planLocalStoreTransactionCommit({
    operations: input.operations,
    currentOutboxItemIds: input.currentOutboxRecords.map((record) => record.id),
    currentLeaseRows: input.currentLeaseRows,
  })
  if (!commit.ok) {
    return { ok: false, reason: commit.reason, itemId: commit.itemId, commit }
  }

  const recordsById = new Map(
    input.currentOutboxRecords.map((record) => [record.id, record] as const),
  )
  for (const operation of input.operations) {
    if (operation.kind === 'put-outbox') {
      recordsById.set(operation.put.record.id, operation.put.record)
      continue
    }
    if (operation.kind !== 'patch-outbox') {
      continue
    }
    const itemId = localStoreOutboxPatchItemId(operation.patch)
    const record = recordsById.get(itemId)
    if (record === undefined) {
      return { ok: false, reason: 'missing-outbox-item', itemId }
    }
    const applied = applyLocalStoreOutboxPatch(record, operation.patch)
    if (!applied.ok) {
      return { ok: false, reason: applied.reason, itemId: applied.itemId }
    }
    recordsById.set(itemId, applied.record)
  }

  return {
    ok: true,
    outboxRecords: [
      ...input.currentOutboxRecords.map((record) => recordsById.get(record.id) ?? record),
      ...commit.outboxPutRecords.map((record) => recordsById.get(record.id) ?? record),
    ],
    leaseRows: commit.nextLeaseRows,
    commit,
  }
}

function applyFailureCompletionPatch(
  record: LocalStoreOutboxRecord,
  patch: OutboxFailureTransition,
): LocalStoreOutboxPatchApplyPlan {
  if (patch.status === 'retrying') {
    return {
      ok: true,
      record: {
        ...record,
        status: patch.status,
        retryCount: patch.retryCount,
        nextAttemptAt: patch.nextAttemptAt,
        lastError: patch.lastError,
      },
    }
  }
  if (patch.status === 'paused') {
    return {
      ok: true,
      record: {
        ...record,
        status: patch.status,
        retryCount: patch.retryCount,
        nextAttemptAt: patch.nextAttemptAt,
        lastError: patch.lastError,
        reason: patch.reason,
        resumeOn: patch.resumeOn,
      },
    }
  }
  return {
    ok: true,
    record: {
      ...record,
      status: patch.status,
      retryCount: patch.retryCount,
      nextAttemptAt: patch.nextAttemptAt,
      lastError: patch.lastError,
      reason: patch.reason,
      deadLetterReason: patch.deadLetterReason,
    },
  }
}

function putLeaseOperation(write: OutboundQueueLeaseWrite): LocalStoreTransactionOperation {
  return {
    kind: 'lease',
    operation: { kind: 'put-lease', write },
  }
}

function applyAckCompletionPatch(
  record: LocalStoreOutboxRecord,
  patch: OutboxAckCompletionPatch,
): LocalStoreOutboxPatchApplyPlan {
  if (patch.status === 'done') {
    return {
      ok: true,
      record: {
        ...record,
        status: patch.status,
        nextAttemptAt: patch.nextAttemptAt,
        durableSeq: patch.durableSeq,
      },
    }
  }
  return {
    ok: true,
    record: {
      ...record,
      status: patch.status,
      nextAttemptAt: patch.nextAttemptAt,
      reason: patch.reason,
      resumeOn: patch.resumeOn,
      snapshotReason: patch.snapshotReason,
      docId: patch.docId,
    },
  }
}

/**
 * Returns the outbox item targeted by a local-store patch operation.
 *
 * @param patch Patch operation produced for a local-store transaction.
 * @returns The outbox item ID that must be present in the transaction read set.
 */
export function localStoreOutboxPatchItemId(patch: LocalStoreOutboxPatch): OutboxPlanItemId {
  switch (patch.kind) {
    case 'resume':
    case 'dependency-block':
    case 'dependency-dead-letter':
    case 'lease-reclaim':
    case 'full-snapshot-release':
      return patch.patch.id
    case 'ack-completion':
    case 'quarantine-pause':
    case 'failure-completion':
    case 'success-completion':
    case 'repair-import-resume':
      return patch.itemId
  }
}

function sameRunningLease(
  left: OutboxRunningLease | undefined,
  right: OutboxRunningLease | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === undefined && right === undefined
  }
  return (
    left.itemId === right.itemId &&
    left.kind === right.kind &&
    left.ownerId === right.ownerId &&
    left.leaseExpiresAt === right.leaseExpiresAt
  )
}

function deleteLeaseOperation(
  deletePlan: OutboundQueueLeaseDelete,
): LocalStoreTransactionOperation {
  return {
    kind: 'lease',
    operation: { kind: 'delete-lease', delete: deletePlan },
  }
}
