import * as v from 'valibot'

import {
  type OutboxAckCompletionInput,
  type OutboxAckCompletionDecision,
  type OutboxQuarantinePauseInput,
  type OutboxQuarantinePauseDecision,
  type OutboxSyncUpdateRejectedPauseInput,
  type OutboxSyncUpdateRejectedPauseDecision,
  type OutboxFullSnapshotReleaseInput,
  type OutboxFullSnapshotReleasePlan,
  type OutboxFullSnapshotReleasePatch,
  type OutboxSyncUpdateRejectedRepairInput,
  type OutboxSyncUpdateRejectedRepairDecision,
} from '../types'
import {
  OutboxAckSequenceEvidenceSchema,
  OutboxFullSnapshotReleaseEvidenceSchema,
  OutboxSyncUpdateRejectedRepairEvidenceSchema,
  sameDocId,
} from '../validation'

/**
 * Decides whether a server ack-like message can complete an outbound Yjs update item.
 * Both `y-update` (ad-hoc doc deltas) and `meta-ref-update` (the DAG-scheduled meta
 * write that follows a binary upload's blob-put/manifest-put chain) are sent over the
 * same sync-update WebSocket control frame and acked identically by the worker.
 */
export function decideOutboxAckCompletion(
  input: OutboxAckCompletionInput,
): OutboxAckCompletionDecision {
  if (input.kind !== 'y-update' && input.kind !== 'meta-ref-update') {
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
  const sequenceResult = v.safeParse(OutboxAckSequenceEvidenceSchema, {
    durableSeq: input.message.durableSeq,
    minDurableSeqExclusive: input.minDurableSeqExclusive,
  })
  if (!sequenceResult.success) {
    const field = sequenceResult.issues[0]?.path?.at(-1)?.key
    return {
      action: 'reject',
      reason: field === 'minDurableSeqExclusive' ? 'stale-durable-seq' : 'invalid-durable-seq',
    }
  }
  const { durableSeq, minDurableSeqExclusive } = sequenceResult.output
  if (minDurableSeqExclusive !== undefined && durableSeq <= minDurableSeqExclusive) {
    return { action: 'reject', reason: 'stale-durable-seq' }
  }

  return {
    action: 'complete',
    patch: {
      status: 'done',
      nextAttemptAt: undefined,
      durableSeq,
    },
  }
}

/**
 * Decides whether server quarantine evidence should pause an outbound Yjs update item.
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

/** Decides whether guarded rejection evidence can pause an exact outbound Yjs update item. */
export function decideOutboxSyncUpdateRejectedPause(
  input: OutboxSyncUpdateRejectedPauseInput,
): OutboxSyncUpdateRejectedPauseDecision {
  if (input.kind !== 'y-update' && input.kind !== 'meta-ref-update') {
    return { action: 'reject', reason: 'unsupported-kind' }
  }
  if (input.status !== 'pending' && input.status !== 'retrying') {
    return { action: 'reject', reason: 'not-runnable-status' }
  }
  if (input.rejection.vaultId !== input.vaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }
  if (input.rejection.deviceId !== input.deviceId) {
    return { action: 'reject', reason: 'device-mismatch' }
  }
  if (!sameDocId(input.rejection.docId, input.docId)) {
    return { action: 'reject', reason: 'doc-mismatch' }
  }
  if (input.rejection.messageId !== input.messageId) {
    return { action: 'reject', reason: 'message-mismatch' }
  }
  if (input.updateSha256 === undefined || input.rejection.updateSha256 !== input.updateSha256) {
    return { action: 'reject', reason: 'hash-mismatch' }
  }

  return {
    action: 'pause-for-sync-update-rejected',
    patch: {
      status: 'paused',
      nextAttemptAt: undefined,
      reason: 'sync-update-rejected',
      resumeOn: 'manual',
      rejectionReason: input.rejection.reason,
      rejectionRetryable: false,
      rejectionUpdateSha256: input.rejection.updateSha256,
      docId: input.rejection.docId,
    },
  }
}

/** Decides whether one exact paused rejection item can be completed after import. */
export function decideOutboxSyncUpdateRejectedRepair(
  input: OutboxSyncUpdateRejectedRepairInput,
): OutboxSyncUpdateRejectedRepairDecision {
  if (input.status !== 'paused') return { action: 'reject', reason: 'not-paused' }
  if (input.reason !== 'sync-update-rejected') {
    return { action: 'reject', reason: 'wrong-reason' }
  }
  if (input.kind === undefined) return { action: 'reject', reason: 'missing-kind' }
  if (input.kind !== 'y-update' && input.kind !== 'meta-ref-update') {
    return { action: 'reject', reason: 'unsupported-kind' }
  }
  if (input.rejectionReason === undefined) {
    return { action: 'reject', reason: 'missing-rejection-reason' }
  }
  if (input.rejectionReason !== 'large-update-requires-snapshot-import') {
    return { action: 'reject', reason: 'wrong-rejection-reason' }
  }
  if (input.rejectionRetryable === undefined) {
    return { action: 'reject', reason: 'missing-retryable-evidence' }
  }
  if (input.rejectionRetryable !== false) {
    return { action: 'reject', reason: 'retryable-rejection' }
  }
  if (input.docId === undefined) return { action: 'reject', reason: 'missing-doc-id' }
  if (input.messageId === undefined) return { action: 'reject', reason: 'missing-message-id' }
  if (input.updateSha256 === undefined) return { action: 'reject', reason: 'missing-update-hash' }
  if (input.rejectionUpdateSha256 === undefined) {
    return { action: 'reject', reason: 'missing-rejection-hash' }
  }
  if (input.updateSha256 !== input.rejectionUpdateSha256) {
    return { action: 'reject', reason: 'hash-mismatch' }
  }
  if (input.updateBytesBase64 === undefined) {
    return { action: 'reject', reason: 'missing-update-bytes' }
  }
  const repairEvidenceResult = v.safeParse(OutboxSyncUpdateRejectedRepairEvidenceSchema, {
    updateBytesBase64: input.updateBytesBase64,
    importedSnapshotSeq: input.importedSnapshotSeq,
  })
  if (!repairEvidenceResult.success) {
    const field = repairEvidenceResult.issues[0]?.path?.at(-1)?.key
    return {
      action: 'reject',
      reason: field === 'updateBytesBase64' ? 'missing-update-bytes' : 'invalid-snapshot-seq',
    }
  }

  return {
    action: 'complete',
    patch: {
      id: input.itemId,
      status: 'done',
      nextAttemptAt: undefined,
      completedBy: 'sync-update-rejected-repair',
      snapshotSeq: repairEvidenceResult.output.importedSnapshotSeq,
    },
  }
}

/**
 * Plans terminal patches for outbox items superseded by an applied full snapshot.
 * `meta-ref-update` items are released alongside `y-update`, matching how they share
 * the same sync-update wire frame and the same ack/need-full-snapshot completion path.
 */
export function planOutboxFullSnapshotRelease(
  input: OutboxFullSnapshotReleaseInput,
): OutboxFullSnapshotReleasePlan {
  const sequenceResult = v.safeParse(OutboxFullSnapshotReleaseEvidenceSchema, {
    snapshotSeq: input.snapshotSeq,
  })
  if (!sequenceResult.success) {
    return { ok: false, reason: 'invalid-snapshot-seq' }
  }

  const releasePatches: OutboxFullSnapshotReleasePatch[] = []
  for (const item of input.items) {
    if (
      (item.kind !== 'y-update' && item.kind !== 'meta-ref-update') ||
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
      snapshotSeq: sequenceResult.output.snapshotSeq,
    })
  }

  return { ok: true, releasePatches }
}
