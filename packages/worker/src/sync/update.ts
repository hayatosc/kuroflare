import { type Ack, type SyncUpdate, type SyncUpdateRejected } from '@kuroflare/core'
import * as v from 'valibot'

import type {
  SyncUpdateDuplicateEvidence,
  SyncUpdateDocClock,
  SyncUpdateQuarantineReason,
  SyncUpdateQuarantineDecisionInput,
  SyncUpdateQuarantineRow,
  SyncUpdateQuarantineDecision,
  SyncUpdateAppendDecisionInput,
  SyncUpdateOpLogAppend,
  SyncUpdateDocPatch,
  SyncUpdateAppendDecision,
} from './update-types'

export type {
  SyncUpdateDuplicateEvidence,
  SyncUpdateDocClock,
  SyncUpdateQuarantineReason,
  SyncUpdateQuarantineDecisionInput,
  SyncUpdateQuarantineRow,
  SyncUpdateQuarantineDecision,
  SyncUpdateAppendDecisionInput,
  SyncUpdateOpLogAppend,
  SyncUpdateDocPatch,
  SyncUpdateAppendDecision,
}

/** Builds the guarded control message sent before closing an oversized live update. */
export function makeSyncUpdateRejected(
  update: SyncUpdate,
  updateSha256: SyncUpdateRejected['updateSha256'],
  reason: SyncUpdateRejected['reason'],
): SyncUpdateRejected {
  return {
    type: 'sync-update-rejected',
    protocolVersion: update.protocolVersion,
    vaultId: update.vaultId,
    deviceId: update.deviceId,
    messageId: update.messageId,
    docId: update.docId,
    updateSha256,
    reason,
    retryable: false,
  }
}

/**
 * Decides whether an inbound update must be quarantined before append planning.
 */
export function decideSyncUpdateQuarantine(
  input: SyncUpdateQuarantineDecisionInput,
): SyncUpdateQuarantineDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-now' }
  }

  if (!isValidQuarantineId(input.quarantineId)) {
    return { action: 'reject', reason: 'invalid-quarantine-id' }
  }

  if (!Number.isSafeInteger(input.updateBytesLength) || input.updateBytesLength <= 0) {
    return { action: 'reject', reason: 'invalid-update-size' }
  }

  if (
    input.expectedUpdateSha256 !== undefined &&
    input.expectedUpdateSha256 !== input.actualUpdateSha256
  ) {
    return makeQuarantineDecision(input, 'hash-mismatch')
  }

  if (!input.yjsApplySucceeded) {
    return makeQuarantineDecision(input, 'yjs-apply-failed')
  }

  if (input.metaSchemaValid === false) {
    return makeQuarantineDecision(input, 'meta-schema-invalid')
  }

  return {
    action: 'accept',
    updateBytesLength: input.updateBytesLength,
    updateSha256: input.actualUpdateSha256,
  }
}

/**
 * Decides whether an inbound `sync-update` should append to op_log or take the snapshot escape path.
 */
export function decideSyncUpdateAppend(
  input: SyncUpdateAppendDecisionInput,
): SyncUpdateAppendDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-now' }
  }

  if (
    !Number.isSafeInteger(input.updateBytesLength) ||
    input.updateBytesLength <= 0 ||
    !Number.isSafeInteger(input.largeUpdateThresholdBytes) ||
    input.largeUpdateThresholdBytes <= 0
  ) {
    return { action: 'reject', reason: 'invalid-update-size' }
  }

  if (!input.doc) {
    return makeFirstAppendDecision(input)
  }

  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.doc.latestSeq)) {
    return { action: 'reject', reason: 'invalid-clock' }
  }

  if (input.duplicate) {
    if (
      !v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), input.duplicate.durableSeq) ||
      input.duplicate.durableSeq > input.doc.latestSeq
    ) {
      return { action: 'reject', reason: 'duplicate-ahead-of-doc' }
    }

    return {
      action: 'ack-duplicate',
      ack: makeAck(input.update, input.duplicate.durableSeq),
    }
  }

  return makeNewUpdateDecision(input, input.doc.latestSeq + 1)
}

function makeFirstAppendDecision(input: SyncUpdateAppendDecisionInput): SyncUpdateAppendDecision {
  if (input.duplicate) {
    return { action: 'reject', reason: 'duplicate-ahead-of-doc' }
  }

  return makeNewUpdateDecision(input, 1)
}

function makeNewUpdateDecision(
  input: SyncUpdateAppendDecisionInput,
  seq: number,
): SyncUpdateAppendDecision {
  if (input.updateBytesLength > input.largeUpdateThresholdBytes) {
    return {
      action: 'reject',
      reason: 'large-update-requires-snapshot-import',
    }
  }

  return {
    action: 'append-op',
    opLogAppend: {
      seq,
      messageId: input.update.messageId,
      deviceId: input.update.deviceId,
      docId: input.update.docId,
      updateSha256: input.updateSha256,
      createdAt: input.now,
    },
    docPatch: { latestSeq: seq, updatedAt: input.now },
    ack: makeAck(input.update, seq),
  }
}

function makeAck(update: SyncUpdate, durableSeq: number): Ack {
  return {
    type: 'ack',
    protocolVersion: update.protocolVersion,
    vaultId: update.vaultId,
    deviceId: update.deviceId,
    messageId: update.messageId,
    docId: update.docId,
    durableSeq,
  }
}

function makeQuarantineDecision(
  input: SyncUpdateQuarantineDecisionInput,
  reason: SyncUpdateQuarantineReason,
): SyncUpdateQuarantineDecision {
  return {
    action: 'quarantine',
    row: {
      id: input.quarantineId,
      docId: input.update.docId,
      messageId: input.update.messageId,
      deviceId: input.update.deviceId,
      reason,
      updateSha256: input.actualUpdateSha256,
      updateBytesLength: input.updateBytesLength,
      createdAt: input.now,
    },
  }
}

function isValidQuarantineId(value: string): boolean {
  return v.is(v.pipe(v.string(), v.minLength(1), v.maxLength(128)), value)
}
