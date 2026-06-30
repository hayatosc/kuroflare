import { type QuarantinedUpdateEntry } from '../http/admin'
import { type Ack, type NeedFullSnapshot } from '../sync/messages'
import { type Sha256Hex } from '../sync/meta'
import { type DeviceId, type DocId, type FileId, type MessageId, type VaultId } from '../utils/ids'

/** Stable item ID assigned by the caller before persisting an outbox plan. */
export type OutboxPlanItemId = string

/** Outbox work item kind used for retry and backoff decisions. */
export type OutboxRetryKind =
  | 'y-update'
  | 'blob-put'
  | 'manifest-put'
  | 'blob-get'
  | 'meta-ref-update'
  | 'materialize'

/** Error observed while running an outbox item. */
export type OutboxRunError =
  | { readonly kind: 'network' | 'timeout' | 'offline' }
  | {
      readonly kind: 'api'
      readonly retryable: boolean
      readonly retryAfterMs?: number
      readonly code?: string
    }
  | { readonly kind: 'local-conflict' | 'invalid-payload' | 'auth' }

/** Retry timing policy for a class of outbox item. */
export interface OutboxRetryPolicy {
  readonly scheduleMs: readonly number[]
  readonly maxRetryCount?: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** Minimal status persisted for an outbox item. */
export type OutboxItemStatus = 'pending' | 'retrying' | 'paused' | 'done' | 'failed' | 'blocked'

/** Minimal dependency evidence needed by the outbox scheduler. */
export interface OutboxDependencyState {
  readonly status: OutboxItemStatus
}

/** Resume trigger recorded or observed by the plugin queue. */
export type OutboxResumeEvent = 'manual' | 'local-state-change' | 'auth-refresh'

/** Condition that lets a paused outbox item return to pending. */
export type OutboxResumeCondition = OutboxResumeEvent

/** Runtime profile used to size concurrent outbox work. */
export type OutboxRuntimeProfile = 'desktop' | 'mobile'

/** Coarse concurrency lane for an outbox item. */
export type OutboxConcurrencyLane = 'sync-control' | 'blob-transfer' | 'materialize'

/** Blob PUT evidence needed to build a binary upload outbox plan. */
export interface BinaryUploadChunkInput {
  readonly id: OutboxPlanItemId
  readonly sha256: Sha256Hex
  readonly localCacheKey: string
  readonly size: number
}

/** Blob GET evidence needed to build a binary download outbox plan. */
export interface BinaryDownloadChunkInput {
  readonly id: OutboxPlanItemId
  readonly sha256: Sha256Hex
  readonly localCacheKey: string
  readonly size: number
}

/** Input for building a binary upload dependency graph. */
export interface BinaryUploadOutboxPlanInput {
  readonly fileId: FileId
  readonly blobManifestHash: Sha256Hex
  readonly chunks: readonly BinaryUploadChunkInput[]
  readonly manifestPutId: OutboxPlanItemId
  readonly metaRefUpdateId: OutboxPlanItemId
}

/** Input for building a binary download dependency graph. */
export interface BinaryDownloadOutboxPlanInput {
  readonly fileId: FileId
  readonly expectedHash: Sha256Hex
  readonly chunks: readonly BinaryDownloadChunkInput[]
  readonly materializeId: OutboxPlanItemId
}

/** Input for deciding what to do after an outbox item fails. */
export interface OutboxRetryDecisionInput {
  readonly kind: OutboxRetryKind
  readonly retryCount: number
  readonly error: OutboxRunError
}

/** Input for applying a failed attempt to an outbox item record. */
export interface OutboxFailureTransitionInput extends OutboxRetryDecisionInput {
  readonly now: number
  readonly retryJitterMs?: number
}

/** Input for deciding whether an outbox item may run now. */
export interface OutboxRunDecisionInput {
  readonly status: OutboxItemStatus
  readonly dependencies: readonly OutboxDependencyState[]
  readonly nextAttemptAt: number | undefined
  readonly now: number
}

/** Input for deciding whether a runnable item may start under concurrency limits. */
export interface OutboxConcurrencyDecisionInput {
  readonly kind: OutboxRetryKind
  readonly profile: OutboxRuntimeProfile
  readonly runningInLane: number
}

/** Input for deciding whether a paused item can be resumed by an event. */
export interface OutboxResumeDecisionInput {
  readonly status: OutboxItemStatus
  readonly resumeOn: OutboxResumeCondition | undefined
  readonly event: OutboxResumeEvent
}

/** Input for deciding whether a server response completes an outbound Yjs update item. */
export interface OutboxAckCompletionInput {
  readonly kind: OutboxRetryKind
  readonly status: OutboxItemStatus
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly minDurableSeqExclusive?: number | undefined
  readonly message: Ack | NeedFullSnapshot
}

/** Input for pausing an outbound Yjs update after the server exposes matching quarantine evidence. */
export interface OutboxQuarantinePauseInput {
  readonly kind: OutboxRetryKind
  readonly status: OutboxItemStatus
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: Sha256Hex | undefined
  readonly quarantine: QuarantinedUpdateEntry
}

/** Minimal paused outbox record needed after a full snapshot was applied. */
export interface OutboxFullSnapshotPausedItem {
  readonly id: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly status: OutboxItemStatus
  readonly docId?: DocId | undefined
  readonly reason?: string | undefined
}

/** Input for clearing stale outbox items after a full snapshot replaces a doc. */
export interface OutboxFullSnapshotReleaseInput {
  readonly items: readonly OutboxFullSnapshotPausedItem[]
  readonly appliedDocId: DocId
  readonly snapshotSeq: number
}

/** Minimal outbox record needed to propagate dependency failures. */
export interface OutboxDependencyGraphItem {
  readonly id: OutboxPlanItemId
  readonly status: OutboxItemStatus
  readonly dependsOn: readonly OutboxPlanItemId[]
}

/** Minimal outbox record needed to plan a scheduler scan. */
export interface OutboxSchedulerItem extends OutboxDependencyGraphItem {
  readonly kind: OutboxRetryKind
  readonly nextAttemptAt: number | undefined
  readonly resumeOn?: OutboxResumeCondition | undefined
}

/** Input for planning a single outbound queue scheduler scan. */
export interface OutboxSchedulerTickInput {
  readonly items: readonly OutboxSchedulerItem[]
  readonly now: number
  readonly profile: OutboxRuntimeProfile
  readonly resumeEvents: readonly OutboxResumeEvent[]
  readonly leases: readonly OutboxRunningLease[]
  readonly maxStarts: number
  readonly auth?: OutboxSchedulerAuthGateInput | undefined
}

/** Running side-effect lease persisted by the plugin queue. */
export interface OutboxRunningLease {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly leaseExpiresAt: number
}

/** Input for deciding whether a scheduler start may acquire a running lease. */
export interface OutboxLeaseAcquireInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Input for deciding whether a running lease may be released by a worker. */
export interface OutboxLeaseReleaseInput {
  readonly itemId: OutboxPlanItemId
  readonly ownerId: string
  readonly now: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Input for deciding whether a running lease may be renewed by a worker. */
export interface OutboxLeaseRenewInput {
  readonly itemId: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
  readonly existingLease: OutboxRunningLease | undefined
}

/** Persistable binary outbox item emitted by a plan builder. */
export type BinaryOutboxPlanItem =
  | {
      readonly kind: 'blob-put'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly sha256: Sha256Hex
      readonly localCacheKey: string
      readonly size: number
    }
  | {
      readonly kind: 'manifest-put'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly blobManifestHash: Sha256Hex
    }
  | {
      readonly kind: 'meta-ref-update'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly blobManifestHash: Sha256Hex
    }
  | {
      readonly kind: 'blob-get'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly sha256: Sha256Hex
      readonly localCacheKey: string
      readonly size: number
    }
  | {
      readonly kind: 'materialize'
      readonly id: OutboxPlanItemId
      readonly dependsOn: readonly OutboxPlanItemId[]
      readonly fileId: FileId
      readonly expectedHash: Sha256Hex
    }

/** Successful binary upload outbox dependency graph. */
export interface BinaryUploadOutboxPlan {
  readonly fileId: FileId
  readonly items: readonly BinaryOutboxPlanItem[]
  readonly chunkPuts: readonly OutboxPlanItemId[]
  readonly manifestPut: OutboxPlanItemId
  readonly metaRefUpdate: OutboxPlanItemId
}

/** Successful binary download outbox dependency graph. */
export interface BinaryDownloadOutboxPlan {
  readonly fileId: FileId
  readonly items: readonly BinaryOutboxPlanItem[]
  readonly chunkGets: readonly OutboxPlanItemId[]
  readonly materialize: OutboxPlanItemId
}

/** Failure reason for binary outbox plan construction. */
export type BinaryOutboxPlanBuildError =
  | 'duplicate-item-id'
  | 'invalid-blob-size'
  | 'empty-local-cache-key'

/** Binary upload plan construction result. */
export type BinaryUploadOutboxPlanBuildResult =
  | { readonly ok: true; readonly plan: BinaryUploadOutboxPlan }
  | { readonly ok: false; readonly reason: BinaryOutboxPlanBuildError }

/** Binary download plan construction result. */
export type BinaryDownloadOutboxPlanBuildResult =
  | { readonly ok: true; readonly plan: BinaryDownloadOutboxPlan }
  | { readonly ok: false; readonly reason: BinaryOutboxPlanBuildError }

/** Retry decision for a failed outbox item. */
export type OutboxRetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number; readonly jitterRatio: number }
  | {
      readonly action: 'pause'
      readonly reason:
        | 'manual-intervention-required'
        | 'dependency-or-local-state'
        | 'auth-required'
      readonly resumeOn: OutboxResumeCondition
    }
  | {
      readonly action: 'dead-letter'
      readonly reason: 'non-retryable-api-error' | 'invalid-payload'
    }

/** Scheduler decision for an outbox item before execution. */
export type OutboxRunDecision =
  | { readonly action: 'run' }
  | {
      readonly action: 'wait'
      readonly reason:
        | 'not-due'
        | 'dependency-pending'
        | 'already-complete'
        | 'paused'
        | 'invalid-clock'
    }
  | { readonly action: 'block'; readonly reason: 'dependency-failed' }
  | { readonly action: 'skip'; readonly reason: 'failed-or-blocked' }

/** Concurrency decision for starting a runnable outbox item. */
export type OutboxConcurrencyDecision =
  | { readonly action: 'start'; readonly lane: OutboxConcurrencyLane; readonly limit: number }
  | {
      readonly action: 'wait'
      readonly reason: 'concurrency-limit-reached' | 'invalid-running-count'
      readonly lane: OutboxConcurrencyLane
      readonly limit: number
    }

/** Persistable patch for an outbox item after a failed attempt. */
export type OutboxFailureTransition =
  | {
      readonly status: 'retrying'
      readonly retryCount: number
      readonly nextAttemptAt: number
      readonly lastError: OutboxRunError
    }
  | {
      readonly status: 'paused'
      readonly retryCount: number
      readonly nextAttemptAt: undefined
      readonly lastError: OutboxRunError
      readonly reason:
        | 'manual-intervention-required'
        | 'dependency-or-local-state'
        | 'auth-required'
      readonly resumeOn: OutboxResumeCondition
    }
  | {
      readonly status: 'failed'
      readonly retryCount: number
      readonly nextAttemptAt: undefined
      readonly lastError: OutboxRunError
      readonly reason: 'dead-letter'
      readonly deadLetterReason: 'non-retryable-api-error' | 'invalid-payload'
    }

/** Decision for a paused item after a resume trigger is observed. */
export type OutboxResumeDecision =
  | { readonly action: 'resume'; readonly status: 'pending'; readonly nextAttemptAt: undefined }
  | {
      readonly action: 'wait'
      readonly reason: 'not-paused' | 'resume-condition-not-met' | 'missing-resume-condition'
    }

/** Persistable patch after a server response proves the fate of an outbound Yjs update. */
export type OutboxAckCompletionPatch =
  | {
      readonly status: 'done'
      readonly nextAttemptAt: undefined
      readonly durableSeq: number
    }
  | {
      readonly status: 'paused'
      readonly nextAttemptAt: undefined
      readonly reason: 'full-snapshot-required'
      readonly resumeOn: 'manual'
      readonly snapshotReason: NeedFullSnapshot['reason']
      readonly docId: DocId
    }

/** Decision for applying an ack-like server response to a Yjs update outbox item. */
export type OutboxAckCompletionDecision =
  | {
      readonly action: 'complete'
      readonly patch: Extract<OutboxAckCompletionPatch, { readonly status: 'done' }>
    }
  | {
      readonly action: 'pause-for-full-snapshot'
      readonly patch: Extract<OutboxAckCompletionPatch, { readonly status: 'paused' }>
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'unsupported-kind'
        | 'not-runnable-status'
        | 'vault-mismatch'
        | 'device-mismatch'
        | 'doc-mismatch'
        | 'message-mismatch'
        | 'invalid-durable-seq'
        | 'stale-durable-seq'
    }

/** Persistable patch for an outbox item paused because the server quarantined its update. */
export interface OutboxQuarantinePausePatch {
  readonly status: 'paused'
  readonly nextAttemptAt: undefined
  readonly reason: 'server-quarantine'
  readonly resumeOn: 'manual'
  readonly quarantineId: string
  readonly quarantineReason: QuarantinedUpdateEntry['reason']
  readonly docId: DocId
}

/** Decision for pausing a Yjs update outbox item based on server quarantine evidence. */
export type OutboxQuarantinePauseDecision =
  | { readonly action: 'pause-for-quarantine'; readonly patch: OutboxQuarantinePausePatch }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'unsupported-kind'
        | 'not-runnable-status'
        | 'device-mismatch'
        | 'doc-mismatch'
        | 'message-mismatch'
        | 'hash-mismatch'
    }

/** Persistable patch for an outbox item superseded by a full snapshot apply. */
export interface OutboxFullSnapshotReleasePatch {
  readonly id: OutboxPlanItemId
  readonly status: 'done'
  readonly nextAttemptAt: undefined
  readonly completedBy: 'full-snapshot-apply'
  readonly snapshotSeq: number
}

/** Plan for closing stale paused items after a full snapshot apply. */
export type OutboxFullSnapshotReleasePlan =
  | { readonly ok: true; readonly releasePatches: readonly OutboxFullSnapshotReleasePatch[] }
  | { readonly ok: false; readonly reason: 'invalid-snapshot-seq' }

/** Persistable patch for a paused item resumed by an observed event. */
export interface OutboxResumePatch {
  readonly id: OutboxPlanItemId
  readonly status: 'pending'
  readonly nextAttemptAt: undefined
}

/** Persistable dependency block patch for an item whose ancestor failed. */
export interface OutboxDependencyBlockPatch {
  readonly id: OutboxPlanItemId
  readonly status: 'blocked'
  readonly blockedBy: readonly OutboxPlanItemId[]
}

/** Persistable terminal patch for an item whose dependency was dead-lettered. */
export interface OutboxDependencyDeadLetterPatch {
  readonly id: OutboxPlanItemId
  readonly status: 'failed'
  readonly reason: 'dead-letter'
  readonly deadLetterReason: 'dependency-dead-letter'
  readonly deadLetteredBy: readonly OutboxPlanItemId[]
}

/** Dependency block propagation result for a queue snapshot. */
export type OutboxDependencyBlockPlan =
  | {
      readonly ok: true
      readonly blockPatches: readonly OutboxDependencyBlockPatch[]
      readonly deadLetterPatches: readonly OutboxDependencyDeadLetterPatch[]
    }
  | {
      readonly ok: false
      readonly reason: 'duplicate-item-id' | 'missing-dependency'
      readonly id: OutboxPlanItemId
    }

/** Side-effecting item the scheduler may start after persisting block patches. */
export interface OutboxSchedulerStart {
  readonly id: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly lane: OutboxConcurrencyLane
}

/** Expected duration evidence for one auth-protected start candidate. */
export interface OutboxAuthStartEstimate {
  readonly id: OutboxPlanItemId
  readonly estimatedDurationMs: number
}

/** Token lifetime evidence used while selecting scheduler starts. */
export interface OutboxSchedulerAuthGateInput {
  readonly tokenExpiresAt: number
  readonly refreshMarginMs: number
  readonly estimates?: readonly OutboxAuthStartEstimate[] | undefined
  readonly defaultEstimatedDurationMs?: number | undefined
}

/** Start candidate that must wait for token refresh before a lease is acquired. */
export interface OutboxAuthStartRefreshBlock {
  readonly id: OutboxPlanItemId
  readonly kind: OutboxRetryKind
  readonly lane: OutboxConcurrencyLane
  readonly reason: 'token-expired' | 'token-expiring-soon'
  readonly remainingMs: number
  readonly requiredRemainingMs: number
}

/** Current client-side token refresh worker state known to the scheduler caller. */
export type OutboxAuthRefreshState =
  | { readonly status: 'idle' }
  | { readonly status: 'refreshing' }
  | { readonly status: 'backing-off'; readonly nextAllowedRefreshAt: number }

/** Input for deciding whether auth-blocked starts should trigger token refresh. */
export interface OutboxAuthRefreshRequestInput {
  readonly refreshBlocks: readonly OutboxAuthStartRefreshBlock[] | undefined
  readonly refreshState: OutboxAuthRefreshState
  readonly now: number
}

/** Decision for scheduling token refresh after auth start gating blocks work. */
export type OutboxAuthRefreshRequestDecision =
  | {
      readonly action: 'request-refresh'
      readonly reason: 'token-expired' | 'token-expiring-soon'
      readonly requestedAt: number
      readonly blockedItemIds: readonly OutboxPlanItemId[]
    }
  | {
      readonly action: 'wait'
      readonly reason: 'refresh-already-running' | 'refresh-backoff'
      readonly nextAllowedRefreshAt?: number | undefined
      readonly blockedItemIds: readonly OutboxPlanItemId[]
    }
  | { readonly action: 'noop'; readonly reason: 'no-auth-blocks' }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'invalid-clock'
        | 'invalid-refresh-backoff'
        | 'invalid-refresh-block'
        | 'duplicate-refresh-block'
      readonly id?: OutboxPlanItemId
    }

/** Persistable patch for an expired running lease. */
export interface OutboxLeaseReclaimPatch {
  readonly id: OutboxPlanItemId
  readonly previousOwnerId: string
  readonly status: 'retrying'
  readonly nextAttemptAt: undefined
}

/** Decision for acquiring a running lease before starting side effects. */
export type OutboxLeaseAcquireDecision =
  | {
      readonly action: 'acquire'
      readonly lease: OutboxRunningLease
      readonly previousOwnerId: undefined
    }
  | {
      readonly action: 'take-over-expired'
      readonly lease: OutboxRunningLease
      readonly previousOwnerId: string
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'active-lease-exists'
        | 'empty-owner'
        | 'invalid-clock'
        | 'invalid-lease-duration'
        | 'lease-item-mismatch'
        | 'lease-kind-mismatch'
    }

/** Decision for releasing a running lease after completion or failure handling. */
export type OutboxLeaseReleaseDecision =
  | { readonly action: 'release' }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'missing-lease'
        | 'owner-mismatch'
        | 'lease-item-mismatch'
        | 'empty-owner'
        | 'invalid-clock'
        | 'lease-expired'
    }

/** Decision for renewing a running lease before it expires. */
export type OutboxLeaseRenewDecision =
  | { readonly action: 'renew'; readonly lease: OutboxRunningLease }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'missing-lease'
        | 'owner-mismatch'
        | 'lease-item-mismatch'
        | 'lease-kind-mismatch'
        | 'empty-owner'
        | 'invalid-clock'
        | 'invalid-lease-duration'
        | 'lease-expired'
    }

/** Scheduler scan plan for one transaction snapshot. */
export type OutboxSchedulerTickPlan =
  | {
      readonly ok: true
      readonly resumePatches: readonly OutboxResumePatch[]
      readonly blockPatches: readonly OutboxDependencyBlockPatch[]
      readonly deadLetterPatches: readonly OutboxDependencyDeadLetterPatch[]
      readonly leaseReclaims: readonly OutboxLeaseReclaimPatch[]
      readonly starts: readonly OutboxSchedulerStart[]
      readonly authRefreshBlocks?: readonly OutboxAuthStartRefreshBlock[] | undefined
    }
  | {
      readonly ok: false
      readonly reason:
        | 'duplicate-item-id'
        | 'duplicate-lease'
        | 'duplicate-auth-estimate'
        | 'empty-lease-owner'
        | 'missing-dependency'
        | 'missing-lease-item'
        | 'invalid-clock'
        | 'invalid-lease-expiry'
        | 'invalid-token-expiry'
        | 'invalid-refresh-margin'
        | 'invalid-estimated-duration'
        | 'invalid-max-starts'
      readonly id?: OutboxPlanItemId
    }

export const Y_UPDATE_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [250, 1_000, 5_000, 30_000],
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
}

export const BLOB_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [1_000, 5_000, 30_000, 300_000],
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
}

export const MATERIALIZE_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [0, 0, 0],
  maxRetryCount: 3,
  maxDelayMs: 0,
  jitterRatio: 0,
}
