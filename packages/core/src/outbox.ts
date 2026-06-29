import {
  type Ack,
  type DeviceId,
  type DocId,
  type FileId,
  type MessageId,
  type NeedFullSnapshot,
  type QuarantinedUpdateEntry,
  type Sha256Hex,
  type VaultId,
} from '@kuroflare/protocol'

import { decideClientAuthStart } from './auth.js'

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

const Y_UPDATE_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [250, 1_000, 5_000, 30_000],
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
}

const BLOB_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [1_000, 5_000, 30_000, 300_000],
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
}

const MATERIALIZE_RETRY_POLICY: OutboxRetryPolicy = {
  scheduleMs: [0, 0, 0],
  maxRetryCount: 3,
  maxDelayMs: 0,
  jitterRatio: 0,
}

/**
 * Brands a caller-assigned outbox item ID after checking it is non-empty.
 *
 * @param value Stable item ID to store in IndexedDB.
 * @returns Branded item ID, or null when the value is empty.
 */
export function makeOutboxPlanItemId(value: string): OutboxPlanItemId | null {
  return value.length === 0 ? null : value
}

/**
 * Builds blob PUT, manifest PUT, and meta reference update items for binary upload.
 *
 * @param input File, manifest, chunk object evidence, and preallocated item IDs.
 * @returns Ordered outbox plan. The meta reference item depends on all chunk PUTs and the manifest PUT.
 */
export function buildBinaryUploadOutboxPlan(
  input: BinaryUploadOutboxPlanInput,
): BinaryUploadOutboxPlanBuildResult {
  const validationError = validateBinaryChunks(input.chunks)
  if (validationError !== undefined) {
    return { ok: false, reason: validationError }
  }

  const ids = [...input.chunks.map((chunk) => chunk.id), input.manifestPutId, input.metaRefUpdateId]
  if (hasDuplicateIds(ids)) {
    return { ok: false, reason: 'duplicate-item-id' }
  }

  const chunkPuts = input.chunks.map(
    (chunk): BinaryOutboxPlanItem => ({
      kind: 'blob-put',
      id: chunk.id,
      dependsOn: [],
      fileId: input.fileId,
      sha256: chunk.sha256,
      localCacheKey: chunk.localCacheKey,
      size: chunk.size,
    }),
  )
  const chunkPutIds = chunkPuts.map((item) => item.id)
  const manifestPut: BinaryOutboxPlanItem = {
    kind: 'manifest-put',
    id: input.manifestPutId,
    dependsOn: chunkPutIds,
    fileId: input.fileId,
    blobManifestHash: input.blobManifestHash,
  }
  const metaRefUpdate: BinaryOutboxPlanItem = {
    kind: 'meta-ref-update',
    id: input.metaRefUpdateId,
    dependsOn: [...chunkPutIds, input.manifestPutId],
    fileId: input.fileId,
    blobManifestHash: input.blobManifestHash,
  }

  return {
    ok: true,
    plan: {
      fileId: input.fileId,
      items: [...chunkPuts, manifestPut, metaRefUpdate],
      chunkPuts: chunkPutIds,
      manifestPut: input.manifestPutId,
      metaRefUpdate: input.metaRefUpdateId,
    },
  }
}

/**
 * Builds blob GET and dependent materialize items for binary download.
 *
 * @param input File, expected final content hash, chunk object evidence, and preallocated item IDs.
 * @returns Ordered outbox plan. Materialize depends on every blob GET.
 */
export function buildBinaryDownloadOutboxPlan(
  input: BinaryDownloadOutboxPlanInput,
): BinaryDownloadOutboxPlanBuildResult {
  const validationError = validateBinaryChunks(input.chunks)
  if (validationError !== undefined) {
    return { ok: false, reason: validationError }
  }

  const ids = [...input.chunks.map((chunk) => chunk.id), input.materializeId]
  if (hasDuplicateIds(ids)) {
    return { ok: false, reason: 'duplicate-item-id' }
  }

  const chunkGets = input.chunks.map(
    (chunk): BinaryOutboxPlanItem => ({
      kind: 'blob-get',
      id: chunk.id,
      dependsOn: [],
      fileId: input.fileId,
      sha256: chunk.sha256,
      localCacheKey: chunk.localCacheKey,
      size: chunk.size,
    }),
  )
  const chunkGetIds = chunkGets.map((item) => item.id)
  const materialize: BinaryOutboxPlanItem = {
    kind: 'materialize',
    id: input.materializeId,
    dependsOn: chunkGetIds,
    fileId: input.fileId,
    expectedHash: input.expectedHash,
  }

  return {
    ok: true,
    plan: {
      fileId: input.fileId,
      items: [...chunkGets, materialize],
      chunkGets: chunkGetIds,
      materialize: input.materializeId,
    },
  }
}

/**
 * Decides whether a paused outbox item may return to pending after a resume event.
 *
 * @param input Current status, persisted resume condition, and observed event.
 * @returns A persistable resume patch or the reason the item remains unchanged.
 */
export function decideOutboxResume(input: OutboxResumeDecisionInput): OutboxResumeDecision {
  if (input.status !== 'paused') {
    return { action: 'wait', reason: 'not-paused' }
  }
  if (input.resumeOn === undefined) {
    return { action: 'wait', reason: 'missing-resume-condition' }
  }
  if (input.event !== 'manual' && input.event !== input.resumeOn) {
    return { action: 'wait', reason: 'resume-condition-not-met' }
  }
  return { action: 'resume', status: 'pending', nextAttemptAt: undefined }
}

/**
 * Decides whether a server ack-like message can complete an outbound Yjs update item.
 *
 * @param input Expected item identity, current status, optional durable sequence floor, and server message.
 * @returns A persistable completion/full-snapshot patch, or the reason the message must be ignored.
 */
export function decideOutboxAckCompletion(
  input: OutboxAckCompletionInput,
): OutboxAckCompletionDecision {
  if (input.kind !== 'y-update') {
    return { action: 'reject', reason: 'unsupported-kind' }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return { action: 'reject', reason: 'not-runnable-status' }
  }
  if (input.message.vaultId !== input.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (input.message.deviceId !== input.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (!sameDocId(input.message.docId, input.docId)) {
    return { action: 'reject', reason: 'doc-mismatch' }
  }

  if (input.message.type === 'need-full-snapshot') {
    return {
      action: 'pause-for-full-snapshot',
      patch: {
        status: 'paused',
        nextAttemptAt: undefined,
        reason: 'full-snapshot-required',
        resumeOn: 'manual',
        snapshotReason: input.message.reason,
        docId: input.message.docId,
      },
    }
  }

  if (input.message.messageId !== input.messageId) {
    return { action: 'reject', reason: 'message-mismatch' }
  }
  if (!isNonNegativeSafeInteger(input.message.durableSeq)) {
    return { action: 'reject', reason: 'invalid-durable-seq' }
  }
  if (
    input.minDurableSeqExclusive !== undefined &&
    (!isNonNegativeSafeInteger(input.minDurableSeqExclusive) ||
      input.message.durableSeq <= input.minDurableSeqExclusive)
  ) {
    return { action: 'reject', reason: 'stale-durable-seq' }
  }

  return {
    action: 'complete',
    patch: {
      status: 'done',
      nextAttemptAt: undefined,
      durableSeq: input.message.durableSeq,
    },
  }
}

/**
 * Decides whether server quarantine evidence should pause an outbound Yjs update item.
 *
 * @param input Expected item identity, current status, optional update hash, and server quarantine entry.
 * @returns A manual pause patch linked to the quarantine row, or the reason the evidence is unrelated.
 */
export function decideOutboxQuarantinePause(
  input: OutboxQuarantinePauseInput,
): OutboxQuarantinePauseDecision {
  if (input.kind !== 'y-update') {
    return { action: 'reject', reason: 'unsupported-kind' }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return { action: 'reject', reason: 'not-runnable-status' }
  }
  if (input.quarantine.deviceId !== input.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (!sameDocId(input.quarantine.docId, input.docId)) {
    return { action: 'reject', reason: 'doc-mismatch' }
  }
  if (input.quarantine.messageId !== input.messageId) {
    return { action: 'reject', reason: 'message-mismatch' }
  }
  if (input.updateSha256 !== undefined && input.quarantine.updateSha256 !== input.updateSha256) {
    return { action: 'reject', reason: 'hash-mismatch' }
  }

  return {
    action: 'pause-for-quarantine',
    patch: {
      status: 'paused',
      nextAttemptAt: undefined,
      reason: 'server-quarantine',
      resumeOn: 'manual',
      quarantineId: input.quarantine.id,
      quarantineReason: input.quarantine.reason,
      docId: input.quarantine.docId,
    },
  }
}

/**
 * Plans terminal patches for outbox items superseded by an applied full snapshot.
 *
 * @param input Applied doc and paused queue items from the same IndexedDB transaction.
 * @returns Patches that close matching stale Yjs update items as done.
 */
export function planOutboxFullSnapshotRelease(
  input: OutboxFullSnapshotReleaseInput,
): OutboxFullSnapshotReleasePlan {
  if (!isNonNegativeSafeInteger(input.snapshotSeq)) {
    return { ok: false, reason: 'invalid-snapshot-seq' }
  }

  const releasePatches: OutboxFullSnapshotReleasePatch[] = []
  for (const item of input.items) {
    if (
      item.kind !== 'y-update' ||
      item.status !== 'paused' ||
      item.reason !== 'full-snapshot-required' ||
      item.docId === undefined ||
      !sameDocId(item.docId, input.appliedDocId)
    ) {
      continue
    }

    releasePatches.push({
      id: item.id,
      status: 'done',
      nextAttemptAt: undefined,
      completedBy: 'full-snapshot-apply',
      snapshotSeq: input.snapshotSeq,
    })
  }

  return { ok: true, releasePatches }
}

/**
 * Plans blocked status patches for items with failed or already blocked ancestors.
 *
 * @param items Queue records visible in the same transaction snapshot.
 * @returns Deterministic block patches, or an error when the graph cannot be trusted.
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

/**
 * Plans paused item resume patches for events observed since the previous scheduler tick.
 *
 * @param items Queue records visible in the same transaction snapshot.
 * @param events Resume events observed by the plugin.
 * @returns Persistable patches that move matching paused items back to pending.
 */
export function planOutboxResumePatches(
  items: readonly OutboxSchedulerItem[],
  events: readonly OutboxResumeEvent[],
): readonly OutboxResumePatch[] {
  if (events.length === 0) {
    return []
  }

  const patches: OutboxResumePatch[] = []
  for (const item of items) {
    for (const event of events) {
      const decision = decideOutboxResume({
        status: item.status,
        resumeOn: item.resumeOn,
        event,
      })
      if (decision.action === 'resume') {
        patches.push({
          id: item.id,
          status: decision.status,
          nextAttemptAt: decision.nextAttemptAt,
        })
        break
      }
    }
  }
  return patches
}

/**
 * Plans one outbound queue scan without performing side effects.
 *
 * @param input Queue snapshot, clock, runtime profile, resume events, current leases, and start budget.
 * @returns Patches to persist first, followed by item IDs that may be started in input order.
 */
export function planOutboxSchedulerTick(input: OutboxSchedulerTickInput): OutboxSchedulerTickPlan {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { ok: false, reason: 'invalid-clock' }
  }
  if (!isNonNegativeSafeInteger(input.maxStarts)) {
    return { ok: false, reason: 'invalid-max-starts' }
  }
  const authGate = validateOutboxSchedulerAuthGate(input.auth, input.now)
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
  const leasePlan = planEffectiveLeases(input.leases, byId, input.now)
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
    if (starts.length >= input.maxStarts) {
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
      now: input.now,
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
        now: input.now,
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

/**
 * Decides whether auth-blocked scheduler starts should trigger a token refresh attempt.
 *
 * @param input Auth refresh blocks returned by the scheduler, current refresh worker state, and clock.
 * @returns A refresh request, a wait decision, noop, or the reason the local evidence is invalid.
 */
export function decideOutboxAuthRefreshRequest(
  input: OutboxAuthRefreshRequestInput,
): OutboxAuthRefreshRequestDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (
    input.refreshState.status === 'backing-off' &&
    !isNonNegativeSafeInteger(input.refreshState.nextAllowedRefreshAt)
  ) {
    return { action: 'reject', reason: 'invalid-refresh-backoff' }
  }

  const refreshBlocks = input.refreshBlocks ?? []
  if (refreshBlocks.length === 0) {
    return { action: 'noop', reason: 'no-auth-blocks' }
  }

  const seen = new Set<OutboxPlanItemId>()
  let strongestReason: 'token-expired' | 'token-expiring-soon' = 'token-expiring-soon'
  for (const block of refreshBlocks) {
    if (seen.has(block.id)) {
      return { action: 'reject', reason: 'duplicate-refresh-block', id: block.id }
    }
    seen.add(block.id)
    if (
      !isNonNegativeSafeInteger(block.requiredRemainingMs) ||
      !Number.isSafeInteger(block.remainingMs) ||
      (block.reason === 'token-expired' && block.remainingMs > 0) ||
      (block.reason === 'token-expiring-soon' && block.remainingMs <= 0)
    ) {
      return { action: 'reject', reason: 'invalid-refresh-block', id: block.id }
    }
    if (block.reason === 'token-expired') {
      strongestReason = 'token-expired'
    }
  }

  const blockedItemIds = refreshBlocks.map((block) => block.id)
  if (input.refreshState.status === 'refreshing') {
    return {
      action: 'wait',
      reason: 'refresh-already-running',
      blockedItemIds,
    }
  }
  if (
    input.refreshState.status === 'backing-off' &&
    input.now < input.refreshState.nextAllowedRefreshAt
  ) {
    return {
      action: 'wait',
      reason: 'refresh-backoff',
      nextAllowedRefreshAt: input.refreshState.nextAllowedRefreshAt,
      blockedItemIds,
    }
  }

  return {
    action: 'request-refresh',
    reason: strongestReason,
    requestedAt: input.now,
    blockedItemIds,
  }
}

/**
 * Decides whether a scheduler start can acquire or take over a running lease.
 *
 * @param input Candidate item, owner, clock, requested duration, and current persisted lease.
 * @returns Lease write decision. Callers must apply it with compare-and-set semantics.
 */
export function decideOutboxLeaseAcquire(
  input: OutboxLeaseAcquireInput,
): OutboxLeaseAcquireDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.leaseDurationMs)) {
    return { action: 'reject', reason: 'invalid-lease-duration' }
  }

  const nextLease: OutboxRunningLease = {
    itemId: input.itemId,
    kind: input.kind,
    ownerId: input.ownerId,
    leaseExpiresAt: input.now + input.leaseDurationMs,
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
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt > input.now
  ) {
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
 *
 * @param input Item, owner, and current persisted lease.
 * @returns Release decision. Callers apply the release in the same transaction as success/failure state changes.
 */
export function decideOutboxLeaseRelease(
  input: OutboxLeaseReleaseInput,
): OutboxLeaseReleaseDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.ownerId !== input.ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'lease-expired' }
  }
  return { action: 'release' }
}

/**
 * Decides whether a worker may extend a running lease it owns.
 *
 * @param input Item, owner, clock, requested duration, and current persisted lease.
 * @returns Renew decision. Callers apply it with compare-and-set semantics on the current lease row.
 */
export function decideOutboxLeaseRenew(input: OutboxLeaseRenewInput): OutboxLeaseRenewDecision {
  if (input.ownerId.length === 0) {
    return { action: 'reject', reason: 'empty-owner' }
  }
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }
  if (!isPositiveSafeInteger(input.leaseDurationMs)) {
    return { action: 'reject', reason: 'invalid-lease-duration' }
  }
  if (input.existingLease === undefined) {
    return { action: 'reject', reason: 'missing-lease' }
  }
  if (input.existingLease.itemId !== input.itemId) {
    return { action: 'reject', reason: 'lease-item-mismatch' }
  }
  if (input.existingLease.kind !== input.kind) {
    return { action: 'reject', reason: 'lease-kind-mismatch' }
  }
  if (input.existingLease.ownerId !== input.ownerId) {
    return { action: 'reject', reason: 'owner-mismatch' }
  }
  if (
    !isNonNegativeSafeInteger(input.existingLease.leaseExpiresAt) ||
    input.existingLease.leaseExpiresAt <= input.now
  ) {
    return { action: 'reject', reason: 'lease-expired' }
  }

  return {
    action: 'renew',
    lease: {
      itemId: input.itemId,
      kind: input.kind,
      ownerId: input.ownerId,
      leaseExpiresAt: input.now + input.leaseDurationMs,
    },
  }
}

/**
 * Decides whether an outbox failure should retry, pause, or fail permanently.
 *
 * @param input Outbox kind, existing retry count before this failure, and observed error.
 * @returns Retry action for the caller to persist. The caller increments retryCount when scheduling a retry.
 */
export function decideOutboxRetry(input: OutboxRetryDecisionInput): OutboxRetryDecision {
  if (input.retryCount < 0 || !Number.isSafeInteger(input.retryCount)) {
    return { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' }
  }

  switch (input.error.kind) {
    case 'network':
    case 'timeout':
    case 'offline':
      return retryWithPolicy(input.kind, input.retryCount, undefined)
    case 'api':
      return input.error.retryable
        ? retryWithPolicy(input.kind, input.retryCount, input.error.retryAfterMs)
        : { action: 'dead-letter', reason: 'non-retryable-api-error' }
    case 'local-conflict':
      return {
        action: 'pause',
        reason: 'dependency-or-local-state',
        resumeOn: 'local-state-change',
      }
    case 'invalid-payload':
      return { action: 'dead-letter', reason: 'invalid-payload' }
    case 'auth':
      return { action: 'pause', reason: 'auth-required', resumeOn: 'auth-refresh' }
  }
}

/**
 * Builds the persistable item update after an outbox attempt fails.
 *
 * @param input Outbox kind, current retry count, failure reason, and current time.
 * @returns A status patch for the caller to write atomically with any side-effect evidence.
 */
export function transitionOutboxFailure(
  input: OutboxFailureTransitionInput,
): OutboxFailureTransition {
  if (!isNonNegativeSafeInteger(input.now)) {
    return {
      status: 'paused',
      retryCount: input.retryCount,
      nextAttemptAt: undefined,
      lastError: input.error,
      reason: 'manual-intervention-required',
      resumeOn: 'manual',
    }
  }

  const retryDecision = decideOutboxRetry(input)
  switch (retryDecision.action) {
    case 'retry':
      const retryJitterMs = selectedRetryJitterMs(input.retryJitterMs, retryDecision)
      return {
        status: 'retrying',
        retryCount: input.retryCount + 1,
        nextAttemptAt: input.now + retryDecision.delayMs + retryJitterMs,
        lastError: input.error,
      }
    case 'pause':
      return {
        status: 'paused',
        retryCount: input.retryCount,
        nextAttemptAt: undefined,
        lastError: input.error,
        reason: retryDecision.reason,
        resumeOn: retryDecision.resumeOn,
      }
    case 'dead-letter':
      return {
        status: 'failed',
        retryCount: input.retryCount,
        nextAttemptAt: undefined,
        lastError: input.error,
        reason: 'dead-letter',
        deadLetterReason: retryDecision.reason,
      }
  }
}

/**
 * Decides whether an outbox item may execute at the current time.
 *
 * @param input Item status, dependency statuses, next attempt timestamp, and current time.
 * @returns Scheduler action. Failed dependencies block dependents instead of retrying them.
 */
export function decideOutboxRun(input: OutboxRunDecisionInput): OutboxRunDecision {
  if (!isNonNegativeSafeInteger(input.now)) {
    return { action: 'wait', reason: 'invalid-clock' }
  }

  switch (input.status) {
    case 'done':
      return { action: 'wait', reason: 'already-complete' }
    case 'paused':
      return { action: 'wait', reason: 'paused' }
    case 'failed':
    case 'blocked':
      return { action: 'skip', reason: 'failed-or-blocked' }
    case 'pending':
    case 'retrying':
      break
  }

  if (
    input.nextAttemptAt !== undefined &&
    (!isNonNegativeSafeInteger(input.nextAttemptAt) || input.now < input.nextAttemptAt)
  ) {
    return { action: 'wait', reason: 'not-due' }
  }

  if (
    input.dependencies.some(
      (dependency) => dependency.status === 'failed' || dependency.status === 'blocked',
    )
  ) {
    return { action: 'block', reason: 'dependency-failed' }
  }

  if (!input.dependencies.every((dependency) => dependency.status === 'done')) {
    return { action: 'wait', reason: 'dependency-pending' }
  }

  return { action: 'run' }
}

/**
 * Decides whether a runnable outbox item may start under per-lane concurrency limits.
 *
 * @param input Item kind, runtime profile, and number of already running items in the same lane.
 * @returns Whether the caller may start one more side-effecting task.
 */
export function decideOutboxConcurrency(
  input: OutboxConcurrencyDecisionInput,
): OutboxConcurrencyDecision {
  const lane = outboxConcurrencyLane(input.kind)
  const limit = outboxConcurrencyLimit(input.kind, input.profile)
  if (!isNonNegativeSafeInteger(input.runningInLane)) {
    return { action: 'wait', reason: 'invalid-running-count', lane, limit }
  }

  return input.runningInLane < limit
    ? { action: 'start', lane, limit }
    : { action: 'wait', reason: 'concurrency-limit-reached', lane, limit }
}

/**
 * Returns the concurrency lane for an outbox item kind.
 *
 * @param kind Outbox item kind.
 * @returns The lane whose active count limits this item.
 */
export function outboxConcurrencyLane(kind: OutboxRetryKind): OutboxConcurrencyLane {
  switch (kind) {
    case 'y-update':
    case 'meta-ref-update':
      return 'sync-control'
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
      return 'blob-transfer'
    case 'materialize':
      return 'materialize'
  }
}

/**
 * Returns the runtime concurrency limit for an outbox item kind.
 *
 * @param kind Outbox item kind.
 * @param profile Desktop or mobile runtime profile.
 * @returns Maximum number of active items in this item's lane.
 */
export function outboxConcurrencyLimit(
  kind: OutboxRetryKind,
  profile: OutboxRuntimeProfile,
): number {
  switch (outboxConcurrencyLane(kind)) {
    case 'sync-control':
      return 1
    case 'blob-transfer':
      return profile === 'mobile' ? 2 : 4
    case 'materialize':
      return 1
  }
}

/**
 * Returns the retry policy for an outbox item kind.
 *
 * @param kind Outbox item kind.
 * @returns Timing policy used by `decideOutboxRetry`.
 */
export function outboxRetryPolicy(kind: OutboxRetryKind): OutboxRetryPolicy {
  switch (kind) {
    case 'y-update':
    case 'meta-ref-update':
      return Y_UPDATE_RETRY_POLICY
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
      return BLOB_RETRY_POLICY
    case 'materialize':
      return MATERIALIZE_RETRY_POLICY
  }
}

function retryWithPolicy(
  kind: OutboxRetryKind,
  retryCount: number,
  retryAfterMs: number | undefined,
): OutboxRetryDecision {
  const policy = outboxRetryPolicy(kind)
  if (policy.maxRetryCount !== undefined && retryCount >= policy.maxRetryCount) {
    return { action: 'pause', reason: 'manual-intervention-required', resumeOn: 'manual' }
  }

  const scheduledDelayMs =
    policy.scheduleMs[Math.min(retryCount, policy.scheduleMs.length - 1)] ?? policy.maxDelayMs
  const retryAfterDelayMs = isNonNegativeSafeInteger(retryAfterMs) ? retryAfterMs : 0
  return {
    action: 'retry',
    delayMs: Math.max(scheduledDelayMs, retryAfterDelayMs),
    jitterRatio: policy.jitterRatio,
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function selectedRetryJitterMs(
  requestedJitterMs: number | undefined,
  retryDecision: Extract<OutboxRetryDecision, { readonly action: 'retry' }>,
): number {
  if (!isNonNegativeSafeInteger(requestedJitterMs)) {
    return 0
  }

  const maxJitterMs = Math.ceil(retryDecision.delayMs * retryDecision.jitterRatio)
  return Math.min(requestedJitterMs, maxJitterMs)
}

function validateBinaryChunks(
  chunks: readonly (BinaryUploadChunkInput | BinaryDownloadChunkInput)[],
): BinaryOutboxPlanBuildError | undefined {
  for (const chunk of chunks) {
    if (!isNonNegativeSafeInteger(chunk.size)) {
      return 'invalid-blob-size'
    }
    if (chunk.localCacheKey.length === 0) {
      return 'empty-local-cache-key'
    }
  }
  return undefined
}

function hasDuplicateIds(ids: readonly OutboxPlanItemId[]): boolean {
  return new Set(ids).size !== ids.length
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta') {
    return true
  }
  return right.kind === 'file' && left.ydocId === right.ydocId
}

type ValidatedOutboxSchedulerAuthGate =
  | {
      readonly ok: true
      readonly auth: OutboxSchedulerAuthGateInput | undefined
      readonly estimateById: ReadonlyMap<OutboxPlanItemId, number>
    }
  | Extract<OutboxSchedulerTickPlan, { readonly ok: false }>

function validateOutboxSchedulerAuthGate(
  auth: OutboxSchedulerAuthGateInput | undefined,
  now: number,
): ValidatedOutboxSchedulerAuthGate {
  if (auth === undefined) {
    return { ok: true, auth: undefined, estimateById: new Map() }
  }

  const defaultValidation = decideClientAuthStart({
    now,
    tokenExpiresAt: auth.tokenExpiresAt,
    refreshMarginMs: auth.refreshMarginMs,
    estimatedDurationMs: auth.defaultEstimatedDurationMs ?? 0,
  })
  if (defaultValidation.action === 'reject') {
    return { ok: false, reason: mapAuthStartRejectReason(defaultValidation.reason) }
  }

  const estimateById = new Map<OutboxPlanItemId, number>()
  for (const estimate of auth.estimates ?? []) {
    if (estimateById.has(estimate.id)) {
      return { ok: false, reason: 'duplicate-auth-estimate', id: estimate.id }
    }
    const estimateValidation = decideClientAuthStart({
      now,
      tokenExpiresAt: auth.tokenExpiresAt,
      refreshMarginMs: auth.refreshMarginMs,
      estimatedDurationMs: estimate.estimatedDurationMs,
    })
    if (estimateValidation.action === 'reject') {
      return {
        ok: false,
        reason: mapAuthStartRejectReason(estimateValidation.reason),
        id: estimate.id,
      }
    }
    estimateById.set(estimate.id, estimate.estimatedDurationMs)
  }

  return { ok: true, auth, estimateById }
}

function outboxKindRequiresAuth(kind: OutboxRetryKind): boolean {
  switch (kind) {
    case 'y-update':
    case 'blob-put':
    case 'manifest-put':
    case 'blob-get':
    case 'meta-ref-update':
      return true
    case 'materialize':
      return false
  }
}

function mapAuthStartRejectReason(
  reason: Extract<
    ReturnType<typeof decideClientAuthStart>,
    { readonly action: 'reject' }
  >['reason'],
): Extract<OutboxSchedulerTickPlan, { readonly ok: false }>['reason'] {
  switch (reason) {
    case 'invalid-time':
      return 'invalid-clock'
    case 'invalid-token-expiry':
      return 'invalid-token-expiry'
    case 'invalid-refresh-margin':
      return 'invalid-refresh-margin'
    case 'invalid-estimated-duration':
      return 'invalid-estimated-duration'
  }
}

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

type EffectiveLeasePlan =
  | {
      readonly ok: true
      readonly activeLeases: readonly OutboxRunningLease[]
      readonly activeLeaseIds: ReadonlySet<OutboxPlanItemId>
      readonly reclaimPatches: readonly OutboxLeaseReclaimPatch[]
    }
  | Extract<OutboxSchedulerTickPlan, { readonly ok: false }>

function planEffectiveLeases(
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
    if (lease.ownerId.length === 0) {
      return { ok: false, reason: 'empty-lease-owner', id: lease.itemId }
    }
    if (!isNonNegativeSafeInteger(lease.leaseExpiresAt)) {
      return { ok: false, reason: 'invalid-lease-expiry', id: lease.itemId }
    }

    if (lease.leaseExpiresAt <= now) {
      reclaimPatches.push({
        id: lease.itemId,
        previousOwnerId: lease.ownerId,
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
