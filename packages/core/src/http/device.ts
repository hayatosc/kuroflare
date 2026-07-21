import * as v from 'valibot'

import { DeviceIdSchema, VaultIdSchema } from '../utils/ids'
import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'

const MAX_REVOKE_REASON_LENGTH = 1024

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

const MAX_DEVICE_SETUP_TOKEN_EXPIRES_IN_MS = 86_400_000

/** Device-authenticated invite request. Carries no `vaultId`: the server derives the vault from the caller's token claims. */
export const DeviceSetupTokenIssueRequestSchema = v.object({
  expiresInMs: v.optional(
    v.pipe(
      v.number(),
      v.safeInteger(),
      v.minValue(1),
      v.maxValue(MAX_DEVICE_SETUP_TOKEN_EXPIRES_IN_MS),
    ),
  ),
})
export type DeviceSetupTokenIssueRequest = v.InferInput<typeof DeviceSetupTokenIssueRequestSchema>

export const DeviceSetupTokenIssueResponseSchema = v.object({
  setupToken: v.pipe(v.string(), v.minLength(1)),
  vaultId: VaultIdSchema,
  expiresAt: PositiveSafeIntegerSchema,
})
export type DeviceSetupTokenIssueResponse = v.InferInput<typeof DeviceSetupTokenIssueResponseSchema>
