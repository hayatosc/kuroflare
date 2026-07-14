import {
  type OutboxAckCompletionPatch,
  type OutboxFailureTransition,
  type OutboxPlanItemId,
  type DocId,
} from '@kuroflare/core'

import {
  type LocalStoreOutboxPatch,
  type LocalStoreOutboxPatchApplyPlan,
  type LocalStoreOutboxRecord,
} from '../../store/store.types'

export function applyLocalStoreOutboxPatch(
  record: LocalStoreOutboxRecord,
  patch: LocalStoreOutboxPatch,
): LocalStoreOutboxPatchApplyPlan {
  const itemId = localStoreOutboxPatchItemId(patch)
  if (record.id !== itemId) {
    return { ok: false, reason: 'patch-item-mismatch', itemId }
  }

  if (patch.kind === 'sync-update-rejected-pause') {
    if (
      record.status !== patch.expected.status ||
      record.messageId !== patch.expected.messageId ||
      record.updateSha256 !== patch.expected.updateSha256 ||
      record.docId === undefined ||
      !sameDocId(record.docId, patch.expected.docId)
    ) {
      return { ok: false, reason: 'patch-evidence-mismatch', itemId }
    }
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
    case 'sync-update-rejected-pause':
      return {
        ok: true,
        record: {
          ...record,
          status: patch.patch.status,
          nextAttemptAt: patch.patch.nextAttemptAt,
          reason: patch.patch.reason,
          resumeOn: patch.patch.resumeOn,
          rejectionReason: patch.patch.rejectionReason,
          rejectionRetryable: patch.patch.rejectionRetryable,
          rejectionUpdateSha256: patch.patch.rejectionUpdateSha256,
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

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'meta' || right.kind === 'meta') return true
  return left.ydocId === right.ydocId
}

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
    case 'sync-update-rejected-pause':
    case 'failure-completion':
    case 'success-completion':
    case 'repair-import-resume':
      return patch.itemId
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
