import {
  type Ack,
  type DeviceId,
  type DocId,
  type MessageId,
  type NeedFullSnapshot,
  type SyncUpdateRejected,
  type OutboxRunError,
  type OutboxRunningLease,
  type QuarantinedUpdateEntry,
  type VaultId,
} from '@kuroflare/core'

import { type OutboundQueueTickPlan } from '../../engine/queue'
import { type LocalStoreOutboxRecord } from '../../store/store'
import {
  type OutboxWorkerSideEffectResultEvidence,
  type OutboxWorkerStartEffect,
} from './side-effect'

/** Input for turning one successful scheduler tick into persisted work starts. */
export interface OutboxWorkerTickInput {
  readonly tick: OutboundQueueTickPlan
  readonly currentOutboxRecords: readonly LocalStoreOutboxRecord[]
  readonly currentLeaseRows: readonly OutboxRunningLease[]
  readonly ownerId: string
  readonly now: number
  readonly leaseDurationMs: number
}

/** Input for planning the concrete side effect attached to a persisted lease. */
export interface OutboxWorkerSideEffectPlanInput {
  readonly effect: OutboxWorkerStartEffect
  readonly record: LocalStoreOutboxRecord | undefined
  readonly endpoint: string
  readonly accessToken: string | undefined
}

/** Evidence for one y-update or meta-ref-update side effect result received from the server. */
export interface OutboxWorkerAckCompletionInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly kind: LocalStoreOutboxRecord['kind']
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

/** Evidence for one y-update side effect matched to a guarded worker rejection. */
export interface OutboxWorkerSyncUpdateRejectedCompletionInput {
  readonly itemId: LocalStoreOutboxRecord['id']
  readonly kind: LocalStoreOutboxRecord['kind']
  readonly status: LocalStoreOutboxRecord['status']
  readonly vaultId: VaultId
  readonly deviceId: DeviceId
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: SyncUpdateRejected['updateSha256'] | undefined
  readonly rejection: SyncUpdateRejected
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
