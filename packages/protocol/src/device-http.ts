import * as v from 'valibot'

import { DeviceIdSchema } from './ids.js'

const MAX_REVOKE_REASON_LENGTH = 1024
const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))
const PositiveSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1))

export const RevokeDeviceRequestSchema = v.object({
  reason: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REVOKE_REASON_LENGTH))),
})
export type RevokeDeviceRequest = v.InferInput<typeof RevokeDeviceRequestSchema>

export const RevokeDeviceResponseSchema = v.object({
  deviceId: DeviceIdSchema,
  status: v.union([v.literal('revoked'), v.literal('already-revoked')]),
  revokedAt: NonNegativeSafeIntegerSchema,
  tokenVersion: PositiveSafeIntegerSchema,
})
export type RevokeDeviceResponse = v.InferInput<typeof RevokeDeviceResponseSchema>
