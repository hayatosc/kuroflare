import * as v from 'valibot'

import { NonNegativeSafeIntegerSchema } from '../utils/shared'

export const ApiErrorCodeSchema = v.union([
  v.literal('auth/revoked'),
  v.literal('auth/expired'),
  // Any other authentication or authorization rejection (missing/invalid token,
  // missing scope, vault mismatch, unknown or mismatched device).
  v.literal('auth/rejected'),
  v.literal('protocol/upgrade-required'),
  v.literal('rate-limited'),
  v.literal('blob/hash-mismatch'),
  v.literal('snapshot/not-found'),
  v.literal('server/degraded'),
  // Unexpected internal failure; distinct from the planned-unavailability of server/degraded.
  v.literal('server/error'),
  // Malformed or out-of-policy request body, params, or payload size.
  v.literal('request/invalid'),
  // Requested resource does not exist; used for everything except the
  // snapshot-generation lookups covered by the more specific snapshot/not-found.
  v.literal('request/not-found'),
  // Request conflicts with the server's current authoritative state.
  v.literal('request/conflict'),
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
