import type { DeviceId, DocId, MessageId, Sha256Hex } from '@kuroflare/core'
import * as v from 'valibot'

import type { SyncUpdateQuarantineReason } from './sync/update'

/** Quarantined update data available for repair. */
export interface QuarantinedUpdateRecord {
  readonly id: string
  readonly docId: DocId
  readonly messageId: MessageId
  readonly deviceId: DeviceId
  readonly reason: SyncUpdateQuarantineReason
  readonly updateSha256: Sha256Hex
  readonly updateBytesLength: number
  readonly createdAt: number
}

/** Admin action for a quarantined update. */
export type QuarantinedUpdateAdminAction = 'inspect' | 'discard' | 'force-apply'

/** Input for deciding how to handle a quarantined update. */
export interface QuarantinedUpdateAdminDecisionInput {
  readonly action: QuarantinedUpdateAdminAction
  readonly record: QuarantinedUpdateRecord | undefined
  readonly now: number
  readonly confirmationTokenValid: boolean
  readonly latestSeq: number | undefined
  readonly yjsApplySucceeded: boolean | undefined
  readonly metaSchemaValid: boolean | undefined
}

/** Data patch for deleting a quarantine record. */
export interface QuarantinedUpdateDeletePatch {
  readonly id: string
  readonly deletedAt: number
  readonly reason: 'discarded-by-admin' | 'force-applied-by-admin'
}

/** Data to append to the log when force-applying an update. */
export interface QuarantinedUpdateForceApplyOpLogAppend {
  readonly seq: number
  readonly docId: DocId
  readonly messageId: MessageId
  readonly deviceId: DeviceId
  readonly updateSha256: Sha256Hex
  readonly createdAt: number
}

/** Patch to apply to documents when force-applying an update. */
export interface QuarantinedUpdateForceApplyDocPatch {
  readonly latestSeq: number
  readonly updatedAt: number
}

/** Decision outcome for a quarantined update. */
export type QuarantinedUpdateAdminDecision =
  | {
      readonly action: 'inspect'
      readonly record: QuarantinedUpdateRecord
    }
  | {
      readonly action: 'discard'
      readonly deletePatch: QuarantinedUpdateDeletePatch
    }
  | {
      readonly action: 'force-apply'
      readonly opLogAppend: QuarantinedUpdateForceApplyOpLogAppend
      readonly docPatch: QuarantinedUpdateForceApplyDocPatch
      readonly deletePatch: QuarantinedUpdateDeletePatch
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'unknown-quarantine'
        | 'invalid-now'
        | 'confirmation-required'
        | 'invalid-clock'
        | 'revalidation-required'
        | 'revalidation-failed'
    }

/**
 * Decides how to handle a quarantined update (inspect, discard, or force-apply).
 */
export function decideQuarantinedUpdateAdmin(
  input: QuarantinedUpdateAdminDecisionInput,
): QuarantinedUpdateAdminDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-now' }
  }

  if (!input.record) {
    return { action: 'reject', reason: 'unknown-quarantine' }
  }

  if (input.action === 'inspect') {
    return { action: 'inspect', record: input.record }
  }

  if (!input.confirmationTokenValid) {
    return { action: 'reject', reason: 'confirmation-required' }
  }

  if (input.action === 'discard') {
    return {
      action: 'discard',
      deletePatch: makeDeletePatch(input.record.id, input.now, 'discarded-by-admin'),
    }
  }

  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.latestSeq)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }

  if (input.yjsApplySucceeded === undefined || input.metaSchemaValid === undefined) {
    return { action: 'reject', reason: 'revalidation-required' }
  }

  if (!input.yjsApplySucceeded || input.metaSchemaValid === false) {
    return { action: 'reject', reason: 'revalidation-failed' }
  }

  const seq = input.latestSeq + 1
  return {
    action: 'force-apply',
    opLogAppend: {
      seq,
      docId: input.record.docId,
      messageId: input.record.messageId,
      deviceId: input.record.deviceId,
      updateSha256: input.record.updateSha256,
      createdAt: input.now,
    },
    docPatch: {
      latestSeq: seq,
      updatedAt: input.now,
    },
    deletePatch: makeDeletePatch(input.record.id, input.now, 'force-applied-by-admin'),
  }
}

function makeDeletePatch(
  id: string,
  deletedAt: number,
  reason: QuarantinedUpdateDeletePatch['reason'],
): QuarantinedUpdateDeletePatch {
  return { id, deletedAt, reason }
}
