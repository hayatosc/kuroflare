import {
  type OutboxRunningLease,
  type OutboxRunError,
  type OutboxSchedulerStart,
  type OutboxFailureTransition,
  type LastMaterializedRecord,
} from '@kuroflare/core'
import {
  type BlobManifest,
  type DeviceId,
  type DocId,
  type MessageId,
  type QuarantinedUpdateEntry,
  type VaultId,
  type Ack,
  type NeedFullSnapshot,
} from '@kuroflare/core'

import {
  applyLocalStoreDriverCommit,
  planLocalStoreDriverReadSet,
  type LocalStoreDriverCommitPlan,
  type LocalStoreDriverReadSet,
  type LocalStoreDriverWriteOperation,
} from './local-store-driver'
import {
  planLocalStoreIndexedDbReads,
  planLocalStoreIndexedDbWrites,
  type LocalStoreIndexedDbReadOperation,
  type LocalStoreIndexedDbWriteOperation,
} from './local-store-indexeddb'
import {
  planLocalStoreFailureCompletionTransaction,
  planLocalStoreAckCompletionTransaction,
  planLocalStoreLeaseAcquireTransaction,
  planLocalStoreLeaseRenewTransaction,
  planLocalStoreFullSnapshotReleaseTransaction,
  planLocalStoreOutboxSchedulerTransaction,
  planLocalStoreQuarantinePauseTransaction,
  planLocalStoreSuccessCompletionTransaction,
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionApplyPlan,
  type LocalStoreTransactionOperation,
} from './local-store'
import {
  planOutboundQueueLeaseAcquire,
  planOutboundQueueLeaseRenew,
  planOutboundQueueAckCompletion,
  planOutboundQueueFullSnapshotRelease,
  planOutboundQueueFailureCompletion,
  planOutboundQueueQuarantinePause,
  planOutboundQueueSuccessCompletion,
  type OutboundQueueAckCompletionPlan,
  type OutboundQueueFailureCompletionPlan,
  type OutboundQueueFullSnapshotReleasePlan,
  type OutboundQueueLeaseAcquirePlan,
  type OutboundQueueLeaseRenewPlan,
  type OutboundQueueQuarantinePausePlan,
  type OutboundQueueSuccessCompletionPlan,
  type OutboundQueueTickPlan,
} from './outbound-queue'

/** Successful local-store driver commit produced by outbox worker persistence planning. */
export type SuccessfulLocalStoreDriverCommitPlan = Extract<
  LocalStoreDriverCommitPlan,
  { readonly ok: true }
>

/** Failed local-store driver commit produced by outbox worker persistence planning. */
export type FailedLocalStoreDriverCommitPlan = Extract<
  LocalStoreDriverCommitPlan,
  { readonly ok: false }
>

/** Concrete IndexedDB reads emitted by outbox worker persistence planning. */
export type OutboxWorkerIndexedDbReadOperation = LocalStoreIndexedDbReadOperation

/** Concrete IndexedDB writes emitted by outbox worker persistence planning. */
export type OutboxWorkerIndexedDbWriteOperation = LocalStoreIndexedDbWriteOperation

/** Input for turning one successful scheduler tick into persisted work starts. */
export interface OutboxWorkerTickInput {
  readonly tick: OutboundQueueTickPlan
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
}

/** Lease acquisition result for one scheduler start candidate. */
export type OutboxWorkerLeaseAttempt =
  | {
      readonly ok: true
      readonly start: OutboxSchedulerStart
      readonly lease: OutboxRunningLease
      readonly previousOwnerId: string | undefined
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly start: OutboxSchedulerStart
      readonly reason:
        | Extract<OutboundQueueLeaseAcquirePlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly leaseAcquire?:
        | Extract<OutboundQueueLeaseAcquirePlan, { readonly ok: false }>
        | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Side effect that may be started after its lease was persisted. */
export interface OutboxWorkerStartEffect {
  readonly kind: 'start-side-effect'
  readonly start: OutboxSchedulerStart
  readonly lease: OutboxRunningLease
}

/** HTTP request plan used by the plugin side-effect runner. */
export interface OutboxWorkerHttpRequestPlan {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly bodyJson?: unknown
  readonly bodySource?: 'canonical-blob-manifest-json' | undefined
}

/** Local blob-cache read the side-effect runner must perform before uploading bytes. */
export interface OutboxWorkerBlobCacheReadPlan {
  readonly key: string
  readonly expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
  readonly expectedSize: number
}

/** Local blob-cache write the side-effect runner must perform after downloading bytes. */
export interface OutboxWorkerBlobCacheWritePlan {
  readonly key: string
  readonly expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
  readonly expectedSize: number
}

/** One local blob-cache chunk read needed to assemble a materialized binary file. */
export interface OutboxWorkerMaterializeChunkReadPlan {
  readonly sha256: BlobManifest['chunks'][number]['sha256']
  readonly key: string
  readonly expectedSize: number
}

/** Planned local materialize side effect after a lease has been persisted. */
export interface OutboxWorkerMaterializeSideEffectPlan {
  readonly ok: true
  readonly action: 'materialize'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly targetPath: string
  readonly expectedContentSha256: NonNullable<LocalStoreOutboxRecord['expectedHash']>
  readonly manifest: BlobManifest
  readonly readChunks: readonly OutboxWorkerMaterializeChunkReadPlan[]
  readonly assemble: {
    readonly expectedContentSha256: NonNullable<LocalStoreOutboxRecord['expectedHash']>
    readonly expectedSize: number
  }
  readonly diskCas: {
    readonly path: string
    readonly lastMaterialized: LastMaterializedRecord
  }
  readonly writeVaultFile: {
    readonly path: string
    readonly bodySource: 'assembled-blob'
  }
}

/** Planned blob PUT side effect after a lease has been persisted. */
export interface OutboxWorkerBlobPutSideEffectPlan {
  readonly ok: true
  readonly action: 'blob-put'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly blob: {
    readonly sha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
    readonly size: number
    readonly localCacheKey: string
  }
  readonly readLocalCache: OutboxWorkerBlobCacheReadPlan
  readonly headRequest: OutboxWorkerHttpRequestPlan
  readonly uploadUrlRequest: OutboxWorkerHttpRequestPlan
  readonly uploadPut: {
    readonly method: 'PUT'
    readonly urlSource: 'upload-url-response'
    readonly authorization: 'device-access-token'
    readonly bodySource: 'local-cache'
  }
}

/** Planned blob GET side effect after a lease has been persisted. */
export interface OutboxWorkerBlobGetSideEffectPlan {
  readonly ok: true
  readonly action: 'blob-get'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly blob: {
    readonly sha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>
    readonly size: number
    readonly localCacheKey: string
  }
  readonly downloadRequest: OutboxWorkerHttpRequestPlan
  readonly writeLocalCache: OutboxWorkerBlobCacheWritePlan
}

/** Planned manifest PUT side effect after all chunks have been uploaded. */
export interface OutboxWorkerManifestPutSideEffectPlan {
  readonly ok: true
  readonly action: 'manifest-put'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly manifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
  readonly manifest: BlobManifest
  readonly putManifestRequest: OutboxWorkerHttpRequestPlan
}

/** Planned meta reference update side effect after the manifest is durable. */
export interface OutboxWorkerMetaRefUpdateSideEffectPlan {
  readonly ok: true
  readonly action: 'meta-ref-update'
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly lease: OutboxRunningLease
  readonly fileId: NonNullable<LocalStoreOutboxRecord['fileId']>
  readonly binaryRef: {
    readonly blobManifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
    readonly blobChunks: readonly BlobManifest['chunks'][number]['sha256'][]
  }
  readonly sendSyncUpdate: {
    readonly transport: 'active-sync-websocket'
    readonly docId: NonNullable<LocalStoreOutboxRecord['docId']>
    readonly messageId: NonNullable<LocalStoreOutboxRecord['messageId']>
    readonly updateSha256: NonNullable<LocalStoreOutboxRecord['updateSha256']>
    readonly updateBytesBase64: string
  }
}

/** Rejection returned before starting an unsafe or underspecified side effect. */
export interface OutboxWorkerSideEffectRejectPlan {
  readonly ok: false
  readonly reason:
    | 'missing-record'
    | 'kind-mismatch'
    | 'unsupported-kind'
    | 'missing-access-token'
    | 'invalid-endpoint'
    | 'missing-doc-id'
    | 'missing-file-id'
    | 'missing-message-id'
    | 'missing-blob-sha256'
    | 'missing-blob-manifest-hash'
    | 'missing-blob-manifest'
    | 'missing-local-cache-key'
    | 'invalid-local-cache-key'
    | 'invalid-blob-size'
    | 'missing-update-sha256'
    | 'missing-update-bytes'
    | 'missing-expected-hash'
    | 'missing-target-path'
    | 'invalid-target-path'
    | 'missing-last-materialized'
    | 'manifest-file-mismatch'
    | 'manifest-content-mismatch'
    | 'manifest-chunk-key-mismatch'
}

/** Input for planning the concrete side effect attached to a persisted lease. */
export interface OutboxWorkerSideEffectPlanInput {
  readonly effect: OutboxWorkerStartEffect
  readonly record: LocalStoreOutboxRecord | undefined
  readonly endpoint: string
  readonly accessToken: string | undefined
}

/** Concrete side effect plan for a persisted outbox lease. */
export type OutboxWorkerSideEffectPlan =
  | OutboxWorkerBlobPutSideEffectPlan
  | OutboxWorkerBlobGetSideEffectPlan
  | OutboxWorkerManifestPutSideEffectPlan
  | OutboxWorkerMetaRefUpdateSideEffectPlan
  | OutboxWorkerMaterializeSideEffectPlan
  | OutboxWorkerSideEffectRejectPlan

/** Evidence returned by a concrete side-effect runner before local-store completion planning. */
export type OutboxWorkerSideEffectResultEvidence =
  | { readonly kind: 'success' }
  | { readonly kind: 'network-error' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'offline' }
  | {
      readonly kind: 'http-response'
      readonly status: number
      readonly retryAfterMs?: number | undefined
      readonly code?: string | undefined
    }
  | { readonly kind: 'local-conflict' }
  | { readonly kind: 'invalid-payload'; readonly code?: string | undefined }

/** Classified side-effect result used to choose success or failure completion planning. */
export type OutboxWorkerSideEffectCompletionEvidence =
  | {
      readonly ok: true
      readonly itemId: LocalStoreOutboxRecord['id']
      readonly kind: Exclude<LocalStoreOutboxRecord['kind'], 'y-update' | 'meta-ref-update'>
      readonly status: LocalStoreOutboxRecord['status']
    }
  | {
      readonly ok: false
      readonly itemId: LocalStoreOutboxRecord['id']
      readonly kind: LocalStoreOutboxRecord['kind']
      readonly retryCount: number
      readonly error: OutboxRunError
    }

/** Evidence for one y-update side effect result received from the server. */
export interface OutboxWorkerAckCompletionInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly status: LocalStoreOutboxRecord['status']
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly minDurableSeqExclusive?: number | undefined
  readonly message: Ack | NeedFullSnapshot
  readonly ownerId: string
  readonly now: number
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Evidence for one y-update side effect matched to server quarantine. */
export interface OutboxWorkerQuarantineCompletionInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly status: LocalStoreOutboxRecord['status']
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: QuarantinedUpdateEntry['updateSha256'] | undefined
  readonly quarantine: QuarantinedUpdateEntry
  readonly ownerId: string
  readonly now: number
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Evidence for one failed side-effect attempt. */
export interface OutboxWorkerFailureCompletionInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly kind: LocalStoreOutboxRecord['kind']
  readonly retryCount: number
  readonly error: OutboxRunError
  readonly retryJitterMs?: number | undefined
  readonly ownerId: string
  readonly now: number
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Evidence that one non-ack side effect finished successfully. */
export interface OutboxWorkerSuccessCompletionInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly kind: LocalStoreOutboxRecord['kind']
  readonly status: LocalStoreOutboxRecord['status']
  readonly ownerId: string
  readonly now: number
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Evidence that a long-running side effect wants to extend its persisted lease. */
export interface OutboxWorkerLeaseRenewalInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly kind: LocalStoreOutboxRecord['kind']
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Evidence that a full snapshot was applied and can supersede paused y-update items. */
export interface OutboxWorkerFullSnapshotReleaseInput {
  readonly appliedDocId: DocId
  readonly snapshotSeq: number
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
}

/** Input for classifying a completed non-ack side-effect runner result. */
export interface OutboxWorkerSideEffectCompletionEvidenceInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly kind: LocalStoreOutboxRecord['kind']
  readonly status: LocalStoreOutboxRecord['status']
  readonly retryCount: number
  readonly result: OutboxWorkerSideEffectResultEvidence
}

/** Plan for one outbox worker tick, including persistence and lease acquisition. */
export type OutboxWorkerTickPlan =
  | {
      readonly ok: true
      readonly schedulerOperations: readonly LocalStoreTransactionOperation[]
      readonly schedulerReadSet: LocalStoreDriverReadSet
      readonly schedulerWrites: readonly LocalStoreDriverWriteOperation[]
      readonly schedulerIndexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly schedulerIndexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly schedulerDriverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly schedulerApply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly leaseAttempts: readonly OutboxWorkerLeaseAttempt[]
      readonly starts: readonly OutboxWorkerStartEffect[]
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly authRefresh: Extract<OutboundQueueTickPlan, { readonly ok: true }>['authRefresh']
    }
  | {
      readonly ok: false
      readonly phase: 'scheduler' | 'scheduler-persist'
      readonly reason:
        | Extract<OutboundQueueTickPlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly tick?: Extract<OutboundQueueTickPlan, { readonly ok: false }> | undefined
      readonly schedulerReadSet?: LocalStoreDriverReadSet | undefined
      readonly schedulerIndexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly schedulerDriverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for committing one completed y-update side effect result. */
export type OutboxWorkerCompletionPlan =
  | {
      readonly ok: true
      readonly action:
        | 'ack-completion'
        | 'pause-for-full-snapshot'
        | 'pause-for-quarantine'
        | 'success-completion'
        | 'retry-after-failure'
        | 'pause-after-failure'
        | 'dead-letter-after-failure'
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly completion: Extract<
        | OutboundQueueAckCompletionPlan
        | OutboundQueueQuarantinePausePlan
        | OutboundQueueSuccessCompletionPlan
        | OutboundQueueFailureCompletionPlan,
        { readonly ok: true }
      >
    }
  | {
      readonly ok: false
      readonly phase: 'completion' | 'completion-persist'
      readonly reason:
        | Extract<OutboundQueueAckCompletionPlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueQuarantinePausePlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueSuccessCompletionPlan, { readonly ok: false }>['reason']
        | Extract<OutboundQueueFailureCompletionPlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly completion?:
        | Extract<
            | OutboundQueueAckCompletionPlan
            | OutboundQueueQuarantinePausePlan
            | OutboundQueueSuccessCompletionPlan
            | OutboundQueueFailureCompletionPlan,
            { readonly ok: false }
          >
        | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly indexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for renewing a running outbox worker lease. */
export type OutboxWorkerLeaseRenewalPlan =
  | {
      readonly ok: true
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly renewal: Extract<OutboundQueueLeaseRenewPlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly phase: 'renewal' | 'renewal-persist'
      readonly reason:
        | Extract<OutboundQueueLeaseRenewPlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly renewal?: Extract<OutboundQueueLeaseRenewPlan, { readonly ok: false }> | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly indexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** Plan for closing outbox y-updates superseded by a full snapshot apply. */
export type OutboxWorkerFullSnapshotReleasePlan =
  | {
      readonly ok: true
      readonly operations: readonly LocalStoreTransactionOperation[]
      readonly readSet: LocalStoreDriverReadSet
      readonly writes: readonly LocalStoreDriverWriteOperation[]
      readonly indexedDbReads: readonly OutboxWorkerIndexedDbReadOperation[]
      readonly indexedDbWrites: readonly OutboxWorkerIndexedDbWriteOperation[]
      readonly driverCommit: SuccessfulLocalStoreDriverCommitPlan
      readonly apply: Extract<LocalStoreTransactionApplyPlan, { readonly ok: true }>
      readonly nextOutboxRecords: readonly LocalStoreOutboxRecord[]
      readonly nextLeaseRows: readonly OutboxRunningLease[]
      readonly release: Extract<OutboundQueueFullSnapshotReleasePlan, { readonly ok: true }>
    }
  | {
      readonly ok: false
      readonly phase: 'release' | 'release-persist'
      readonly reason:
        | Extract<OutboundQueueFullSnapshotReleasePlan, { readonly ok: false }>['reason']
        | Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }>['reason']
      readonly release?:
        | Extract<OutboundQueueFullSnapshotReleasePlan, { readonly ok: false }>
        | undefined
      readonly readSet?: LocalStoreDriverReadSet | undefined
      readonly indexedDbReads?: readonly OutboxWorkerIndexedDbReadOperation[] | undefined
      readonly driverCommit?: FailedLocalStoreDriverCommitPlan | undefined
      readonly apply?: Extract<LocalStoreTransactionApplyPlan, { readonly ok: false }> | undefined
    }

/** One concrete IndexedDB write transaction the runtime must commit before side effects start. */
export type OutboxWorkerIndexedDbWriteTransaction =
  | {
      readonly kind: 'scheduler-persist'
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'lease-acquire'
      readonly start: OutboxSchedulerStart
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'completion-persist'
      readonly action: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>['action']
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'lease-renew'
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }
  | {
      readonly kind: 'full-snapshot-release'
      readonly writes: readonly OutboxWorkerIndexedDbWriteOperation[]
    }

/**
 * Splits a successful worker tick into ordered concrete IndexedDB write transactions.
 *
 * @param plan Successful outbox worker tick plan.
 * @returns Scheduler persistence first, followed by one transaction per acquired lease.
 */
export function planOutboxWorkerTickIndexedDbWriteTransactions(
  plan: Extract<OutboxWorkerTickPlan, { readonly ok: true }>,
): readonly OutboxWorkerIndexedDbWriteTransaction[] {
  return [
    { kind: 'scheduler-persist', writes: plan.schedulerIndexedDbWrites },
    ...plan.leaseAttempts.filter(isSuccessfulOutboxWorkerLeaseAttempt).map(
      (attempt): OutboxWorkerIndexedDbWriteTransaction => ({
        kind: 'lease-acquire',
        start: attempt.start,
        writes: attempt.indexedDbWrites,
      }),
    ),
  ]
}

/**
 * Converts a successful completion plan into the single concrete IndexedDB write transaction.
 *
 * @param plan Successful side-effect completion plan.
 * @returns Completion persistence transaction containing item patch and lease release writes.
 */
export function planOutboxWorkerCompletionIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerCompletionPlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'completion-persist', action: plan.action, writes: plan.indexedDbWrites }
}

/**
 * Converts a successful lease renewal plan into the concrete IndexedDB write transaction.
 *
 * @param plan Successful renewal plan for one running side effect.
 * @returns Lease-renew persistence transaction containing the CAS lease put.
 */
export function planOutboxWorkerLeaseRenewalIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerLeaseRenewalPlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'lease-renew', writes: plan.indexedDbWrites }
}

/**
 * Converts a successful full snapshot release plan into the concrete IndexedDB write transaction.
 *
 * @param plan Successful release plan after applying a full snapshot.
 * @returns Full-snapshot release persistence transaction containing terminal outbox patches.
 */
export function planOutboxWorkerFullSnapshotReleaseIndexedDbWriteTransaction(
  plan: Extract<OutboxWorkerFullSnapshotReleasePlan, { readonly ok: true }>,
): OutboxWorkerIndexedDbWriteTransaction {
  return { kind: 'full-snapshot-release', writes: plan.indexedDbWrites }
}

function isSuccessfulOutboxWorkerLeaseAttempt(
  attempt: OutboxWorkerLeaseAttempt,
): attempt is Extract<OutboxWorkerLeaseAttempt, { readonly ok: true }> {
  return attempt.ok
}

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
 * Builds the concrete side-effect plan for a persisted outbox lease.
 *
 * @param input Start effect, matching outbox record, sync endpoint, and current access token.
 * @returns A concrete local or network side-effect sequence, or the reason it must not start.
 */
export function planOutboxWorkerSideEffect(
  input: OutboxWorkerSideEffectPlanInput,
): OutboxWorkerSideEffectPlan {
  const record = input.record
  if (record === undefined || record.id !== input.effect.start.id) {
    return { ok: false, reason: 'missing-record' }
  }
  if (record.kind !== input.effect.start.kind) {
    return { ok: false, reason: 'kind-mismatch' }
  }

  if (record.kind === 'materialize') {
    return planOutboxWorkerMaterializeSideEffect(input.effect, record)
  }
  if (record.kind === 'meta-ref-update') {
    return planOutboxWorkerMetaRefUpdateSideEffect(input.effect, record)
  }

  if (record.kind !== 'blob-put' && record.kind !== 'blob-get' && record.kind !== 'manifest-put') {
    return { ok: false, reason: 'unsupported-kind' }
  }

  if (input.accessToken === undefined || input.accessToken.length === 0) {
    return { ok: false, reason: 'missing-access-token' }
  }

  const endpoint = normalizeHttpEndpoint(input.endpoint)
  if (endpoint === undefined) {
    return { ok: false, reason: 'invalid-endpoint' }
  }

  const headers = {
    authorization: `Bearer ${input.accessToken}`,
    'content-type': 'application/json',
  }
  if (record.kind === 'manifest-put') {
    return planOutboxWorkerManifestPutSideEffect(input.effect, record, endpoint, headers)
  }

  if (record.blobSha256 === undefined) {
    return { ok: false, reason: 'missing-blob-sha256' }
  }
  if (record.localCacheKey === undefined || record.localCacheKey.length === 0) {
    return { ok: false, reason: 'missing-local-cache-key' }
  }
  if (!isSafeLocalBlobCacheKey(record.localCacheKey)) {
    return { ok: false, reason: 'invalid-local-cache-key' }
  }
  if (
    record.blobSize === undefined ||
    !Number.isSafeInteger(record.blobSize) ||
    record.blobSize < 0
  ) {
    return { ok: false, reason: 'invalid-blob-size' }
  }

  if (record.kind === 'blob-get') {
    if (record.fileId === undefined) {
      return { ok: false, reason: 'missing-file-id' }
    }
    return {
      ok: true,
      action: 'blob-get',
      itemId: record.id,
      lease: input.effect.lease,
      fileId: record.fileId,
      blob: {
        sha256: record.blobSha256,
        size: record.blobSize,
        localCacheKey: record.localCacheKey,
      },
      downloadRequest: {
        method: 'GET',
        url: new URL(`/blobs/${record.blobSha256}`, endpoint).toString(),
        headers: { authorization: `Bearer ${input.accessToken}` },
      },
      writeLocalCache: {
        key: record.localCacheKey,
        expectedSha256: record.blobSha256,
        expectedSize: record.blobSize,
      },
    }
  }

  const headUrl = new URL('/blobs/head', endpoint).toString()
  const uploadUrl = new URL('/blobs/upload-url', endpoint).toString()
  return {
    ok: true,
    action: 'blob-put',
    itemId: record.id,
    lease: input.effect.lease,
    blob: {
      sha256: record.blobSha256,
      size: record.blobSize,
      localCacheKey: record.localCacheKey,
    },
    readLocalCache: {
      key: record.localCacheKey,
      expectedSha256: record.blobSha256,
      expectedSize: record.blobSize,
    },
    headRequest: {
      method: 'POST',
      url: headUrl,
      headers,
      bodyJson: { hashes: [record.blobSha256] },
    },
    uploadUrlRequest: {
      method: 'POST',
      url: uploadUrl,
      headers,
      bodyJson: { sha256: record.blobSha256, size: record.blobSize },
    },
    uploadPut: {
      method: 'PUT',
      urlSource: 'upload-url-response',
      authorization: 'device-access-token',
      bodySource: 'local-cache',
    },
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

function planOutboxWorkerManifestPutSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
  endpoint: string,
  headers: Readonly<Record<string, string>>,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.blobManifestHash === undefined) {
    return { ok: false, reason: 'missing-blob-manifest-hash' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }

  return {
    ok: true,
    action: 'manifest-put',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    manifestHash: record.blobManifestHash,
    manifest: record.blobManifest,
    putManifestRequest: {
      method: 'PUT',
      url: new URL(`/blob-manifests/${record.blobManifestHash}.json`, endpoint).toString(),
      headers,
      bodyJson: record.blobManifest,
      bodySource: 'canonical-blob-manifest-json',
    },
  }
}

function planOutboxWorkerMetaRefUpdateSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.blobManifestHash === undefined) {
    return { ok: false, reason: 'missing-blob-manifest-hash' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }
  if (record.docId === undefined) {
    return { ok: false, reason: 'missing-doc-id' }
  }
  if (record.messageId === undefined) {
    return { ok: false, reason: 'missing-message-id' }
  }
  if (record.updateSha256 === undefined) {
    return { ok: false, reason: 'missing-update-sha256' }
  }
  if (record.updateBytesBase64 === undefined || record.updateBytesBase64.length === 0) {
    return { ok: false, reason: 'missing-update-bytes' }
  }

  return {
    ok: true,
    action: 'meta-ref-update',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    binaryRef: {
      blobManifestHash: record.blobManifestHash,
      blobChunks: record.blobManifest.chunks.map((chunk) => chunk.sha256),
    },
    sendSyncUpdate: {
      transport: 'active-sync-websocket',
      docId: record.docId,
      messageId: record.messageId,
      updateSha256: record.updateSha256,
      updateBytesBase64: record.updateBytesBase64,
    },
  }
}

function planOutboxWorkerMaterializeSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.expectedHash === undefined) {
    return { ok: false, reason: 'missing-expected-hash' }
  }
  if (record.targetPath === undefined || record.targetPath.length === 0) {
    return { ok: false, reason: 'missing-target-path' }
  }
  if (!isSafeVaultRelativePath(record.targetPath)) {
    return { ok: false, reason: 'invalid-target-path' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.lastMaterialized === undefined) {
    return { ok: false, reason: 'missing-last-materialized' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }
  if (record.blobManifest.contentSha256 !== record.expectedHash) {
    return { ok: false, reason: 'manifest-content-mismatch' }
  }
  if (record.materializeChunks === undefined) {
    return { ok: false, reason: 'manifest-chunk-key-mismatch' }
  }
  if (record.materializeChunks.length !== record.blobManifest.chunks.length) {
    return { ok: false, reason: 'manifest-chunk-key-mismatch' }
  }

  const seenChunkHashes = new Set<BlobManifest['chunks'][number]['sha256']>()
  const readChunks: OutboxWorkerMaterializeChunkReadPlan[] = []
  for (const chunk of record.blobManifest.chunks) {
    if (seenChunkHashes.has(chunk.sha256)) {
      return { ok: false, reason: 'manifest-chunk-key-mismatch' }
    }
    seenChunkHashes.add(chunk.sha256)
    const cached = record.materializeChunks.find((candidate) => candidate.sha256 === chunk.sha256)
    if (cached === undefined || cached.localCacheKey.length === 0 || cached.size !== chunk.size) {
      return { ok: false, reason: 'manifest-chunk-key-mismatch' }
    }
    if (!isSafeLocalBlobCacheKey(cached.localCacheKey)) {
      return { ok: false, reason: 'invalid-local-cache-key' }
    }
    readChunks.push({
      sha256: chunk.sha256,
      key: cached.localCacheKey,
      expectedSize: chunk.size,
    })
  }

  return {
    ok: true,
    action: 'materialize',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    targetPath: record.targetPath,
    expectedContentSha256: record.expectedHash,
    manifest: record.blobManifest,
    readChunks,
    assemble: {
      expectedContentSha256: record.expectedHash,
      expectedSize: record.blobManifest.size,
    },
    diskCas: {
      path: record.targetPath,
      lastMaterialized: record.lastMaterialized,
    },
    writeVaultFile: {
      path: record.targetPath,
      bodySource: 'assembled-blob',
    },
  }
}

/**
 * Classifies a concrete non-ack side-effect runner result for completion planning.
 *
 * @param input Item identity, retry evidence, and runner result.
 * @returns Success completion evidence or a normalized failure error for retry policy.
 */
export function classifyOutboxWorkerSideEffectCompletionEvidence(
  input: OutboxWorkerSideEffectCompletionEvidenceInput,
): OutboxWorkerSideEffectCompletionEvidence {
  if (input.result.kind !== 'success') {
    return {
      ok: false,
      itemId: input.itemId,
      kind: input.kind,
      retryCount: input.retryCount,
      error: outboxRunErrorFromSideEffectResult(input.result),
    }
  }

  if (input.kind === 'y-update' || input.kind === 'meta-ref-update') {
    return {
      ok: false,
      itemId: input.itemId,
      kind: input.kind,
      retryCount: input.retryCount,
      error: { kind: 'invalid-payload' },
    }
  }

  return {
    ok: true,
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
  }
}

function outboxRunErrorFromSideEffectResult(
  result: Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>,
): OutboxRunError {
  switch (result.kind) {
    case 'network-error':
      return { kind: 'network' }
    case 'timeout':
      return { kind: 'timeout' }
    case 'offline':
      return { kind: 'offline' }
    case 'local-conflict':
      return { kind: 'local-conflict' }
    case 'invalid-payload':
      return { kind: 'invalid-payload' }
    case 'http-response':
      return outboxRunErrorFromHttpStatus(result)
  }
}

function outboxRunErrorFromHttpStatus(
  response: Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>,
): OutboxRunError {
  if (response.status === 401 || response.status === 403) {
    return { kind: 'auth' }
  }
  if (response.status === 408) {
    return { kind: 'timeout' }
  }
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
    return outboxApiRunError({
      retryable: true,
      retryAfterMs: response.retryAfterMs,
      code: response.code,
    })
  }
  return outboxApiRunError({ retryable: false, code: response.code })
}

function outboxApiRunError(input: {
  readonly retryable: boolean
  readonly retryAfterMs?: number | undefined
  readonly code?: string | undefined
}): OutboxRunError {
  const error: { kind: 'api'; retryable: boolean; retryAfterMs?: number; code?: string } = {
    kind: 'api',
    retryable: input.retryable,
  }
  if (input.retryAfterMs !== undefined) {
    error.retryAfterMs = input.retryAfterMs
  }
  if (input.code !== undefined) {
    error.code = input.code
  }
  return error
}

/**
 * Plans the transaction that commits an Ack or NeedFullSnapshot returned by a running y-update side effect.
 *
 * @param input Server response, current outbox record status, lease owner evidence, and local-store snapshot.
 * @returns Atomic item patch plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerAckCompletion(
  input: OutboxWorkerAckCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueAckCompletion({
    itemId: input.itemId,
    kind: 'y-update',
    status: input.status,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
    message: input.message,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreAckCompletionTransaction(completion)
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
      phase: 'completion-persist',
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
    action: completion.action === 'complete' ? 'ack-completion' : 'pause-for-full-snapshot',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that pauses a running y-update after matching server quarantine evidence.
 *
 * @param input Server quarantine evidence, current item status, lease owner evidence, and local-store snapshot.
 * @returns Atomic quarantine pause plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerQuarantineCompletion(
  input: OutboxWorkerQuarantineCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueQuarantinePause({
    itemId: input.itemId,
    kind: 'y-update',
    status: input.status,
    deviceId: input.deviceId,
    docId: input.docId,
    messageId: input.messageId,
    updateSha256: input.updateSha256,
    quarantine: input.quarantine,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreQuarantinePauseTransaction(completion)
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
      phase: 'completion-persist',
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
    action: 'pause-for-quarantine',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that marks a non-ack side effect done and releases its lease.
 *
 * @param input Success evidence, current item status, lease owner evidence, and local-store snapshot.
 * @returns Atomic done patch plus lease release, or a stale/mismatched completion rejection.
 */
export function planOutboxWorkerSuccessCompletion(
  input: OutboxWorkerSuccessCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueSuccessCompletion({
    itemId: input.itemId,
    kind: input.kind,
    status: input.status,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreSuccessCompletionTransaction(completion)
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
      phase: 'completion-persist',
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
    action: 'success-completion',
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

/**
 * Plans the transaction that commits a failed side-effect attempt and releases its lease.
 *
 * @param input Failure evidence, retry count, lease owner evidence, and local-store snapshot.
 * @returns Atomic retry/pause/dead-letter patch plus lease release, or a stale completion rejection.
 */
export function planOutboxWorkerFailureCompletion(
  input: OutboxWorkerFailureCompletionInput,
): OutboxWorkerCompletionPlan {
  const existingLease = input.currentLeaseRows.find((lease) => lease.itemId === input.itemId)
  const completion = planOutboundQueueFailureCompletion({
    itemId: input.itemId,
    kind: input.kind,
    retryCount: input.retryCount,
    error: input.error,
    retryJitterMs: input.retryJitterMs,
    ownerId: input.ownerId,
    now: input.now,
    existingLease,
  })
  if (!completion.ok) {
    return {
      ok: false,
      phase: 'completion',
      reason: completion.reason,
      completion,
    }
  }

  const operations = planLocalStoreFailureCompletionTransaction(completion)
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
      phase: 'completion-persist',
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
    action: outboxFailureCompletionAction(completion.patch.status),
    operations,
    readSet,
    writes: driverCommit.writes,
    indexedDbReads,
    indexedDbWrites: planLocalStoreIndexedDbWrites(driverCommit.writes),
    driverCommit,
    apply,
    nextOutboxRecords: driverCommit.snapshot.outboxRecords,
    nextLeaseRows: driverCommit.snapshot.leaseRows,
    completion,
  }
}

function outboxFailureCompletionAction(
  status: OutboxFailureTransition['status'],
): 'retry-after-failure' | 'pause-after-failure' | 'dead-letter-after-failure' {
  switch (status) {
    case 'retrying':
      return 'retry-after-failure'
    case 'paused':
      return 'pause-after-failure'
    case 'failed':
      return 'dead-letter-after-failure'
  }
}

/**
 * Checks whether a local blob-cache key is constrained to the plugin blob cache namespace.
 *
 * @param key Persisted cache key from an outbox row.
 * @returns True when the key is a safe vault-relative blob-cache path.
 */
export function isSafeLocalBlobCacheKey(key: string): boolean {
  return (
    key.startsWith('blob-cache/') &&
    key.length > 'blob-cache/'.length &&
    isSafeVaultRelativePath(key)
  )
}

/**
 * Checks whether a persisted path is a normalized vault-relative path.
 *
 * @param path Path persisted in local-store state.
 * @returns True when the path cannot escape the vault through absolute or parent segments.
 */
export function isSafeVaultRelativePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || path.includes('\\')) {
    return false
  }
  if (path.startsWith('/')) {
    return false
  }
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function normalizeHttpEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      return undefined
    }
    url.pathname = '/'
    url.search = ''
    return url.toString()
  } catch {
    return undefined
  }
}
