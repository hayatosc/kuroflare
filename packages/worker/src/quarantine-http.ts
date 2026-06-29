import type {
  AdminOperationEffect,
  QuarantinedUpdateActionRequest,
  QuarantinedUpdateActionResponse,
  QuarantinedUpdateDetailResponse,
  QuarantinedUpdateEntry,
  QuarantinedUpdateListResponse,
} from '@kuroflare/protocol'
import * as v from 'valibot'

import type { YClientId } from './devices.js'
import {
  decideQuarantinedUpdateAdmin,
  type QuarantinedUpdateAdminDecision,
  type QuarantinedUpdateRecord,
} from './quarantine.js'

/** Stored confirmation-token evidence after the caller verifies the submitted token hash. */
export interface QuarantineConfirmationEvidence {
  readonly subject: string
  readonly expiresAt: number
  readonly tokenHashMatches: boolean
}

/** Input for checking a quarantine action confirmation token. */
export interface QuarantineConfirmationDecisionInput {
  readonly action: QuarantinedUpdateActionRequest['action']
  readonly quarantineId: string
  readonly now: number
  readonly evidence: QuarantineConfirmationEvidence | undefined
}

/** Confirmation-token validation result for a destructive quarantine action. */
export type QuarantineConfirmationDecision =
  | { readonly valid: true }
  | {
      readonly valid: false
      readonly reason:
        | 'missing-token'
        | 'invalid-now'
        | 'token-mismatch'
        | 'subject-mismatch'
        | 'token-expired'
    }

/** Rejection reason for a quarantine admin action HTTP plan. */
export type QuarantinedUpdateActionHttpRejectReason =
  | Extract<QuarantineConfirmationDecision, { readonly valid: false }>['reason']
  | Extract<QuarantinedUpdateAdminDecision, { readonly action: 'reject' }>['reason']

/** Input for planning a quarantine admin action HTTP response. */
export interface QuarantinedUpdateActionHttpPlanInput {
  readonly request: QuarantinedUpdateActionRequest
  readonly record: QuarantinedUpdateRecord | undefined
  readonly now: number
  readonly confirmation: QuarantineConfirmationEvidence | undefined
  readonly latestSeq: number | undefined
  readonly yClientId: YClientId | undefined
  readonly yjsApplySucceeded: boolean | undefined
  readonly metaSchemaValid: boolean | undefined
}

/** HTTP-facing plan for a quarantine admin action. */
export type QuarantinedUpdateActionHttpPlan =
  | {
      readonly action: 'respond'
      readonly adminDecision: Extract<
        QuarantinedUpdateAdminDecision,
        { readonly action: 'discard' | 'force-apply' }
      >
      readonly response: QuarantinedUpdateActionResponse
    }
  | {
      readonly action: 'reject'
      readonly reason: QuarantinedUpdateActionHttpRejectReason
    }

/**
 * Builds the deterministic confirmation-token subject for a quarantine action.
 *
 * @param action Destructive quarantine action.
 * @param quarantineId Target quarantine row ID.
 * @returns A subject string that must be bound into the stored token evidence.
 */
export function quarantineConfirmationSubject(
  action: QuarantinedUpdateActionRequest['action'],
  quarantineId: string,
): string {
  return `quarantine:${action}:${quarantineId}`
}

/**
 * Builds a quarantine list response without including update bytes.
 *
 * @param records Quarantine rows from storage.
 * @returns Protocol response for the list endpoint.
 */
export function buildQuarantinedUpdateListResponse(
  records: readonly QuarantinedUpdateRecord[],
): QuarantinedUpdateListResponse {
  return { entries: records.map(quarantinedUpdateEntryFromRecord) }
}

/**
 * Builds a quarantine detail response with optional base64 update bytes.
 *
 * @param record Quarantine row from storage.
 * @param updateBytesBase64 Optional update bytes for explicit detail inspection.
 * @returns Protocol response for the detail endpoint.
 */
export function buildQuarantinedUpdateDetailResponse(
  record: QuarantinedUpdateRecord,
  updateBytesBase64: string | undefined,
): QuarantinedUpdateDetailResponse {
  const entry = quarantinedUpdateEntryFromRecord(record)
  return updateBytesBase64 === undefined ? { entry } : { entry, updateBytesBase64 }
}

/**
 * Checks whether a submitted quarantine action token matches the action and target row.
 *
 * @param input Action, row ID, current time, and caller-verified token evidence.
 * @returns Whether the token may authorize the destructive action.
 */
export function decideQuarantineConfirmation(
  input: QuarantineConfirmationDecisionInput,
): QuarantineConfirmationDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { valid: false, reason: 'invalid-now' }
  }

  if (!input.evidence) {
    return { valid: false, reason: 'missing-token' }
  }

  if (!input.evidence.tokenHashMatches) {
    return { valid: false, reason: 'token-mismatch' }
  }

  if (input.evidence.subject !== quarantineConfirmationSubject(input.action, input.quarantineId)) {
    return { valid: false, reason: 'subject-mismatch' }
  }

  if (
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.evidence.expiresAt) ||
    input.now >= input.evidence.expiresAt
  ) {
    return { valid: false, reason: 'token-expired' }
  }

  return { valid: true }
}

/**
 * Plans a quarantine admin action HTTP response after protocol request validation.
 *
 * @param input Request body, target row, confirmation evidence, and force-apply revalidation evidence.
 * @returns A response plan with admin patches or a rejection reason.
 */
export function planQuarantinedUpdateActionHttp(
  input: QuarantinedUpdateActionHttpPlanInput,
): QuarantinedUpdateActionHttpPlan {
  if (!input.record) {
    return { action: 'reject', reason: 'unknown-quarantine' }
  }

  const confirmation = decideQuarantineConfirmation({
    action: input.request.action,
    quarantineId: input.record.id,
    now: input.now,
    evidence: input.confirmation,
  })
  if (!confirmation.valid) {
    return { action: 'reject', reason: confirmation.reason }
  }

  const adminDecision = decideQuarantinedUpdateAdmin({
    action: input.request.action,
    record: input.record,
    now: input.now,
    confirmationTokenValid: true,
    latestSeq: input.latestSeq,
    yClientId: input.yClientId,
    yjsApplySucceeded: input.yjsApplySucceeded,
    metaSchemaValid: input.metaSchemaValid,
  })

  if (adminDecision.action === 'reject' || adminDecision.action === 'inspect') {
    return {
      action: 'reject',
      reason: adminDecision.action === 'inspect' ? 'unknown-quarantine' : adminDecision.reason,
    }
  }

  return {
    action: 'respond',
    adminDecision,
    response: {
      action: input.request.action,
      id: input.record.id,
      applied: true,
      effects: [effectFromAdminDecision(adminDecision)],
    },
  }
}

function quarantinedUpdateEntryFromRecord(record: QuarantinedUpdateRecord): QuarantinedUpdateEntry {
  return {
    id: record.id,
    docId: record.docId,
    messageId: record.messageId,
    deviceId: record.deviceId,
    reason: record.reason,
    updateSha256: record.updateSha256,
    updateBytesLength: record.updateBytesLength,
    createdAt: record.createdAt,
  }
}

function effectFromAdminDecision(
  decision: Extract<QuarantinedUpdateAdminDecision, { readonly action: 'discard' | 'force-apply' }>,
): AdminOperationEffect {
  if (decision.action === 'discard') {
    return {
      kind: 'quarantine-discard',
      count: 1,
      detail: decision.deletePatch.id,
    }
  }

  return {
    kind: 'quarantine-force-apply',
    count: 1,
    detail: `seq=${decision.opLogAppend.seq}`,
  }
}
