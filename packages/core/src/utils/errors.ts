import * as v from 'valibot'

import { NonNegativeSafeIntegerSchema } from '../utils/shared'

export const ApiErrorCodeSchema = v.union([
  v.literal('auth/revoked'),
  v.literal('auth/expired'),
  v.literal('protocol/upgrade-required'),
  v.literal('rate-limited'),
  v.literal('blob/hash-mismatch'),
  v.literal('snapshot/not-found'),
  v.literal('server/degraded'),
])
export type ApiErrorCode = v.InferInput<typeof ApiErrorCodeSchema>

export const ApiErrorSchema = v.object({
  code: ApiErrorCodeSchema,
  retryable: v.boolean(),
  retryAfterMs: v.optional(NonNegativeSafeIntegerSchema),
  detail: v.optional(v.string()),
})
export type ApiError = v.InferInput<typeof ApiErrorSchema>

export const RetryableApiErrorSchema = v.intersect([
  ApiErrorSchema,
  v.object({ retryable: v.literal(true) }),
])
