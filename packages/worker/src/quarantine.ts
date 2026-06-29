import type { DeviceId, DocId, MessageId, Sha256Hex } from '@kuroflare/protocol'
import * as v from 'valibot'

import type { YClientId } from './devices.js'
import type { SyncUpdateQuarantineReason } from './sync-update.js'

/** Durable quarantined update row available to admin repair flows. */
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

/** Admin operation requested for a quarantined update. */
export type QuarantinedUpdateAdminAction = 'inspect' | 'discard' | 'force-apply'

/** Input for deciding how an admin repair operation may handle a quarantined update. */
export interface QuarantinedUpdateAdminDecisionInput {
  readonly action: QuarantinedUpdateAdminAction
  readonly record: QuarantinedUpdateRecord | undefined
  readonly now: number
  readonly confirmationTokenValid: boolean
  readonly latestSeq: number | undefined
  readonly yClientId: YClientId | undefined
  readonly yjsApplySucceeded: boolean | undefined
  readonly metaSchemaValid: boolean | undefined
}

/** Patch for deleting a quarantined update row after an explicit admin decision. */
export interface QuarantinedUpdateDeletePatch {
  readonly id: string
  readonly deletedAt: number
  readonly reason: 'discarded-by-admin' | 'force-applied-by-admin'
}

/** Row the caller should append to op_log when a quarantined update is force-applied. */
export interface QuarantinedUpdateForceApplyOpLogAppend {
  readonly seq: number
  readonly docId: DocId
  readonly messageId: MessageId
  readonly deviceId: DeviceId
  readonly yClientId: YClientId
  readonly updateSha256: Sha256Hex
  readonly createdAt: number
}

/** Patch the caller should apply to docs after force-applying a quarantined update. */
export interface QuarantinedUpdateForceApplyDocPatch {
  readonly latestSeq: number
  readonly updatedAt: number
}

/** Admin repair decision for a quarantined update. */
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
        | 'missing-y-client-id'
        | 'revalidation-required'
        | 'revalidation-failed'
    }

/**
 * Decides how an admin repair operation may inspect, discard, or force-apply a quarantined update.
 *
 * @param input Requested action, durable quarantine row, confirmation state, and revalidation evidence.
 * @returns A read-only inspection, a delete patch, a force-apply plan, or a rejection.
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

  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), input.yClientId)) {
    return { action: 'reject', reason: 'missing-y-client-id' }
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
      yClientId: input.yClientId,
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
