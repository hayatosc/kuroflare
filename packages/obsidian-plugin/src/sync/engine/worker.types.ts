import {
  type OutboxRunningLease,
  type OutboxRunError,
  type OutboxSchedulerStart,
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
  type LocalStoreDriverCommitPlan,
  type LocalStoreDriverReadSet,
  type LocalStoreDriverWriteOperation,
} from '../store/driver'
import {
  type LocalStoreIndexedDbReadOperation,
  type LocalStoreIndexedDbWriteOperation,
} from '../store/indexeddb'
import {
  type LocalStoreOutboxRecord,
  type LocalStoreTransactionApplyPlan,
  type LocalStoreTransactionOperation,
} from '../store/store'
import {
  type OutboundQueueAckCompletionPlan,
  type OutboundQueueFailureCompletionPlan,
  type OutboundQueueFullSnapshotReleasePlan,
  type OutboundQueueLeaseAcquirePlan,
  type OutboundQueueLeaseRenewPlan,
  type OutboundQueueQuarantinePausePlan,
  type OutboundQueueSuccessCompletionPlan,
  type OutboundQueueTickPlan,
} from '../engine/queue'

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
