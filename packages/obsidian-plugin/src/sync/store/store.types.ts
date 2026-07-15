import type {
  BlobManifest,
  DocId,
  FileId,
  LastMaterializedRecord,
  MessageId,
  OutboxAckCompletionPatch,
  OutboxDependencyBlockPatch,
  OutboxDependencyDeadLetterPatch,
  OutboxFailureTransition,
  OutboxFullSnapshotReleasePatch,
  OutboxLeaseReclaimPatch,
  OutboxPlanItemId,
  OutboxQuarantinePausePatch,
  OutboxSyncUpdateRejectedPausePatch,
  OutboxSyncUpdateRejectedRepairPatch,
  OutboxResumeCondition,
  OutboxResumePatch,
  OutboxRetryKind,
  OutboxRunningLease,
  Sha256Hex,
} from '@kuroflare/core'

import type {
  OutboundQueueAckCompletionPlan,
  OutboundQueueFailureCompletionPlan,
  OutboundQueueFullSnapshotReleasePlan,
  OutboundQueueLeaseAcquirePlan,
  OutboundQueueLeaseDelete,
  OutboundQueueLeaseReleasePlan,
  OutboundQueueLeaseRenewPlan,
  OutboundQueueLeaseWrite,
  OutboundQueueQuarantinePausePlan,
  OutboundQueueSyncUpdateRejectedPausePlan,
  OutboundQueueSyncUpdateRejectedRepairPlan,
  OutboundQueueSuccessCompletionPlan,
  OutboundQueueTickPlan,
} from '../engine/queue'

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

/** Successful guarded rejection pause plan accepted by local store transaction planning. */
export type SuccessfulOutboundQueueSyncUpdateRejectedPausePlan = Extract<
  OutboundQueueSyncUpdateRejectedPausePlan,
  { readonly ok: true }
>

/** Successful exact-evidence rejection repair plan accepted by local-store transaction planning. */
export type SuccessfulOutboundQueueSyncUpdateRejectedRepairPlan = Extract<
  OutboundQueueSyncUpdateRejectedRepairPlan,
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
      readonly kind: 'sync-update-rejected-pause'
      readonly itemId: OutboxPlanItemId
      readonly expected: {
        readonly status: 'pending' | 'retrying'
        readonly messageId: MessageId
        readonly docId: DocId
        readonly updateSha256: Sha256Hex
      }
      readonly patch: OutboxSyncUpdateRejectedPausePatch
    }
  | {
      readonly kind: 'sync-update-rejected-repair'
      readonly itemId: OutboxPlanItemId
      readonly expected: {
        readonly status: 'paused'
        readonly reason: 'sync-update-rejected'
        readonly kind: Extract<OutboxRetryKind, 'y-update' | 'meta-ref-update'>
        readonly docId: DocId
        readonly messageId: MessageId
        readonly updateSha256: Sha256Hex
        readonly rejectionUpdateSha256: Sha256Hex
        readonly rejectionReason: 'large-update-requires-snapshot-import'
        readonly rejectionRetryable: false
        readonly updateBytesBase64: string
      }
      readonly patch: OutboxSyncUpdateRejectedRepairPatch
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
  /** Explicit evidence that a metadata update uses the grouped v2 schema. */
  readonly metadataSchemaVersion?: 2 | undefined
  readonly quarantineId?: string | undefined
  readonly quarantineReason?: string | undefined
  readonly rejectionReason?: string | undefined
  readonly rejectionRetryable?: false | undefined
  readonly rejectionUpdateSha256?: Sha256Hex | undefined
  readonly completedBy?: 'full-snapshot-apply' | 'sync-update-rejected-repair' | undefined
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
      readonly reason: 'patch-item-mismatch' | 'patch-evidence-mismatch'
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
        | 'patch-evidence-mismatch'
      readonly itemId: OutboxPlanItemId
      readonly commit?: Extract<LocalStoreTransactionCommitPlan, { readonly ok: false }> | undefined
    }
