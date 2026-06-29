import * as v from 'valibot'

import { DeviceIdSchema, DocIdSchema, MessageIdSchema } from './ids.js'
import { Sha256HexSchema } from './meta.js'

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
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

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

const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))
const PositiveSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1))

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
  entries: v.pipe(
    v.array(QuarantinedUpdateEntrySchema),
    v.maxLength(MAX_QUARANTINED_UPDATE_ENTRIES),
  ),
})
export type QuarantinedUpdateListResponse = v.InferInput<typeof QuarantinedUpdateListResponseSchema>

const Base64Schema = v.pipe(v.string(), v.minLength(1), v.regex(BASE64_PATTERN, 'Invalid base64'))

export const QuarantinedUpdateDetailResponseSchema = v.object({
  entry: QuarantinedUpdateEntrySchema,
  updateBytesBase64: v.optional(Base64Schema),
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
