import * as v from 'valibot'

import { DeviceIdSchema, VaultIdSchema } from './ids'
import { ProtocolVersionSchema } from './version'

export const DEVICE_TOKEN_ISSUER = 'kuroflare-worker'

export const DeviceTokenScopeSchema = v.union([
  v.literal('sync:read'),
  v.literal('sync:write'),
  v.literal('blob:read'),
  v.literal('blob:write'),
])
export type DeviceTokenScope = v.InferInput<typeof DeviceTokenScopeSchema>

const DEVICE_TOKEN_SCOPE_COUNT = 4
const MAX_ACCESS_TOKEN_LENGTH = 16_384
const MAX_REFRESH_TOKEN_LENGTH = 4096

const NonNegativeSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0))
const PositiveSafeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1))

export const DeviceTokenClaimsSchema = v.pipe(
  v.object({
    iss: v.literal(DEVICE_TOKEN_ISSUER),
    aud: VaultIdSchema,
    sub: DeviceIdSchema,
    scope: v.pipe(
      v.array(DeviceTokenScopeSchema),
      v.minLength(1),
      v.maxLength(DEVICE_TOKEN_SCOPE_COUNT),
      v.check((arr) => new Set(arr).size === arr.length, 'Duplicate scopes'),
    ),
    iat: NonNegativeSafeIntegerSchema,
    exp: NonNegativeSafeIntegerSchema,
    tokenVersion: PositiveSafeIntegerSchema,
  }),
  v.check((val) => val.exp > val.iat, 'exp must be greater than iat'),
)
export type DeviceTokenClaims = v.InferInput<typeof DeviceTokenClaimsSchema>

export const DeviceTokenRefreshRequestSchema = v.object({
  vaultId: VaultIdSchema,
  deviceId: DeviceIdSchema,
  refreshToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REFRESH_TOKEN_LENGTH)),
  previousTokenVersion: PositiveSafeIntegerSchema,
})
export type DeviceTokenRefreshRequest = v.InferInput<typeof DeviceTokenRefreshRequestSchema>

export const DeviceTokenRefreshResponseSchema = v.object({
  accessToken: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ACCESS_TOKEN_LENGTH)),
  tokenVersion: PositiveSafeIntegerSchema,
  expiresAt: NonNegativeSafeIntegerSchema,
  protocolVersion: ProtocolVersionSchema,
  refreshToken: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_REFRESH_TOKEN_LENGTH)),
  ),
})
export type DeviceTokenRefreshResponse = v.InferInput<typeof DeviceTokenRefreshResponseSchema>
