import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { DeviceIdSchema, DocIdSchema, MessageIdSchema } from '../utils/ids'
import {
  NonEmptyBase64Schema,
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
} from '../utils/shared'

export const AdminOperationSchema = v.union([
  v.literal('gc'),
  v.literal('force-local'),
  v.literal('force-remote'),
  v.literal('rebuild'),
])
export type AdminOperation = v.InferInput<typeof AdminOperationSchema>

const MAX_CONFIRMATION_TOKEN_LENGTH = 4096
const MAX_ADMIN_REASON_LENGTH = 1024
const MAX_ADMIN_DETAIL_LENGTH = 2048
const MAX_ADMIN_EFFECTS = 1024
const MAX_QUARANTINED_UPDATE_ID_LENGTH = 128
const MAX_QUARANTINED_UPDATE_ENTRIES = 1024

export const AdminOperationRequestSchema = v.union([
  v.object({
    operation: AdminOperationSchema,
    mode: v.literal('dry-run'),
    reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADMIN_REASON_LENGTH))),
    confirmationToken: v.optional(v.never()),
  }),
  v.object({
    operation: AdminOperationSchema,
    mode: v.literal('execute'),
    confirmationToken: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_CONFIRMATION_TOKEN_LENGTH),
    ),
    reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADMIN_REASON_LENGTH))),
  }),
])
export type AdminOperationRequest = v.InferInput<typeof AdminOperationRequestSchema>

export const AdminOperationEffectSchema = v.object({
  kind: v.union([
    v.literal('delete-blob'),
    v.literal('delete-snapshot'),
    v.literal('rewrite-meta'),
    v.literal('materialize'),
    v.literal('rebuild-index'),
    v.literal('revoke-device'),
    v.literal('quarantine-discard'),
    v.literal('quarantine-force-apply'),
  ]),
  count: NonNegativeSafeIntegerSchema,
  detail: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADMIN_DETAIL_LENGTH))),
})
export type AdminOperationEffect = v.InferInput<typeof AdminOperationEffectSchema>

export const AdminDryRunResponseSchema = v.object({
  operation: AdminOperationSchema,
  mode: v.literal('dry-run'),
  confirmationRequired: v.literal(true),
  confirmationToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_CONFIRMATION_TOKEN_LENGTH)),
  effects: v.pipe(v.array(AdminOperationEffectSchema), v.maxLength(MAX_ADMIN_EFFECTS)),
})
export type AdminDryRunResponse = v.InferInput<typeof AdminDryRunResponseSchema>

export const AdminExecuteResponseSchema = v.object({
  operation: AdminOperationSchema,
  mode: v.literal('execute'),
  confirmationRequired: v.literal(false),
  confirmationToken: v.optional(v.never()),
  effects: v.pipe(v.array(AdminOperationEffectSchema), v.maxLength(MAX_ADMIN_EFFECTS)),
})
export type AdminExecuteResponse = v.InferInput<typeof AdminExecuteResponseSchema>

export const AdminOperationResponseSchema = v.union([
  AdminDryRunResponseSchema,
  AdminExecuteResponseSchema,
])
export type AdminOperationResponse = v.InferInput<typeof AdminOperationResponseSchema>

export const QuarantinedUpdateReasonSchema = v.union([
  v.literal('hash-mismatch'),
  v.literal('yjs-apply-failed'),
  v.literal('meta-schema-invalid'),
])
export type QuarantinedUpdateReason = v.InferInput<typeof QuarantinedUpdateReasonSchema>

export const QuarantinedUpdateEntrySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_QUARANTINED_UPDATE_ID_LENGTH)),
  docId: DocIdSchema,
  messageId: MessageIdSchema,
  deviceId: DeviceIdSchema,
  reason: QuarantinedUpdateReasonSchema,
  updateSha256: Sha256HexSchema,
  updateBytesLength: PositiveSafeIntegerSchema,
  createdAt: NonNegativeSafeIntegerSchema,
})
export type QuarantinedUpdateEntry = v.InferInput<typeof QuarantinedUpdateEntrySchema>

export const QuarantinedUpdateListResponseSchema = v.object({
  items: v.pipe(v.array(QuarantinedUpdateEntrySchema), v.maxLength(MAX_QUARANTINED_UPDATE_ENTRIES)),
  nextCursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})
export type QuarantinedUpdateListResponse = v.InferInput<typeof QuarantinedUpdateListResponseSchema>

export const QuarantinedUpdateDetailResponseSchema = v.object({
  entry: QuarantinedUpdateEntrySchema,
  updateBytesBase64: v.optional(NonEmptyBase64Schema),
})
export type QuarantinedUpdateDetailResponse = v.InferInput<
  typeof QuarantinedUpdateDetailResponseSchema
>

export const QuarantinedUpdateActionRequestSchema = v.object({
  action: v.union([v.literal('discard'), v.literal('force-apply')]),
  confirmationToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_CONFIRMATION_TOKEN_LENGTH)),
  reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADMIN_REASON_LENGTH))),
})
export type QuarantinedUpdateActionRequest = v.InferInput<
  typeof QuarantinedUpdateActionRequestSchema
>

export const QuarantinedUpdateActionHttpRequestSchema = v.union([
  v.object({
    mode: v.literal('dry-run'),
    confirmationToken: v.optional(v.never()),
    reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADMIN_REASON_LENGTH))),
  }),
  v.object({
    mode: v.literal('execute'),
    confirmationToken: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_CONFIRMATION_TOKEN_LENGTH),
    ),
    reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ADMIN_REASON_LENGTH))),
  }),
])
export type QuarantinedUpdateActionHttpRequest = v.InferInput<
  typeof QuarantinedUpdateActionHttpRequestSchema
>

export const QuarantinedUpdateActionDryRunResponseSchema = v.object({
  action: v.union([v.literal('discard'), v.literal('force-apply')]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_QUARANTINED_UPDATE_ID_LENGTH)),
  mode: v.literal('dry-run'),
  confirmationRequired: v.literal(true),
  confirmationToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_CONFIRMATION_TOKEN_LENGTH)),
  effects: v.pipe(
    v.array(AdminOperationEffectSchema),
    v.minLength(1),
    v.maxLength(MAX_ADMIN_EFFECTS),
  ),
})
export type QuarantinedUpdateActionDryRunResponse = v.InferInput<
  typeof QuarantinedUpdateActionDryRunResponseSchema
>

export const QuarantinedUpdateActionResponseSchema = v.object({
  action: v.union([v.literal('discard'), v.literal('force-apply')]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_QUARANTINED_UPDATE_ID_LENGTH)),
  applied: v.literal(true),
  effects: v.pipe(
    v.array(AdminOperationEffectSchema),
    v.minLength(1),
    v.maxLength(MAX_ADMIN_EFFECTS),
  ),
})
export type QuarantinedUpdateActionResponse = v.InferInput<
  typeof QuarantinedUpdateActionResponseSchema
>

export const QuarantinedUpdateActionHttpResponseSchema = v.union([
  QuarantinedUpdateActionDryRunResponseSchema,
  QuarantinedUpdateActionResponseSchema,
])
export type QuarantinedUpdateActionHttpResponse = v.InferInput<
  typeof QuarantinedUpdateActionHttpResponseSchema
>

/** Terminal disposition recorded once an operator resolves a quarantined update. */
export const QuarantineAuditActionSchema = v.union([
  v.literal('discarded-by-admin'),
  v.literal('force-applied-by-admin'),
])
export type QuarantineAuditAction = v.InferInput<typeof QuarantineAuditActionSchema>

/** User-facing audit-trail row for one resolved quarantine action. */
export const QuarantineAuditEntrySchema = v.object({
  quarantineId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_QUARANTINED_UPDATE_ID_LENGTH)),
  docId: DocIdSchema,
  messageId: MessageIdSchema,
  deviceId: DeviceIdSchema,
  reason: QuarantinedUpdateReasonSchema,
  action: QuarantineAuditActionSchema,
  actor: DeviceIdSchema,
  appliedSeq: v.optional(PositiveSafeIntegerSchema),
  quarantinedAt: NonNegativeSafeIntegerSchema,
  resolvedAt: NonNegativeSafeIntegerSchema,
})
export type QuarantineAuditEntry = v.InferInput<typeof QuarantineAuditEntrySchema>

export const QuarantineAuditListResponseSchema = v.object({
  items: v.pipe(v.array(QuarantineAuditEntrySchema), v.maxLength(MAX_QUARANTINED_UPDATE_ENTRIES)),
  nextCursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})
export type QuarantineAuditListResponse = v.InferInput<typeof QuarantineAuditListResponseSchema>
