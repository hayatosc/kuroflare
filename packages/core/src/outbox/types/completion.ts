import { type QuarantinedUpdateEntry } from '../../http/admin'
import { type Ack, type NeedFullSnapshot } from '../../sync/messages'
import { type Sha256Hex } from '../../sync/meta'
import { type DeviceId, type DocId, type MessageId, type VaultId } from '../../utils/ids'
import { type OutboxAuthStartRefreshBlock } from './auth'
import {
  type OutboxPlanItemId,
  type OutboxRetryKind,
  type OutboxRunError,
  type OutboxItemStatus,
  type OutboxResumeCondition,
  type OutboxConcurrencyLane,
} from './base'
import { type OutboxLeaseReclaimPatch } from './lease'
import { type OutboxResumePatch } from './scheduler'
import {
  type OutboxDependencyBlockPatch,
  type OutboxDependencyDeadLetterPatch,
  type OutboxSchedulerStart,
} from './scheduler'

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
