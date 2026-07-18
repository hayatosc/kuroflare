import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'
export { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../utils/shared'
import * as v from 'valibot'

import { DeviceIdSchema } from '../utils/ids'
import type { ClientAuthMetadata } from './types'

export const ClientAuthMetadataSchema = v.object({
  deviceId: DeviceIdSchema,
  authState: v.union([v.literal('active'), v.literal('revoked'), v.literal('reauth-required')]),
  tokenVersion: PositiveSafeIntegerSchema,
  accessTokenExpiresAt: v.optional(NonNegativeSafeIntegerSchema),
  revokedAt: v.optional(NonNegativeSafeIntegerSchema),
  refreshState: v.union([v.literal('idle'), v.literal('refreshing'), v.literal('backing-off')]),
  refreshStartedAt: v.optional(NonNegativeSafeIntegerSchema),
  retryCount: NonNegativeSafeIntegerSchema,
  nextAllowedRefreshAt: v.optional(NonNegativeSafeIntegerSchema),
  accessTokenSecretKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  refreshTokenSecretKey: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
})

export function isClientAuthMetadata(value: unknown): value is ClientAuthMetadata {
  return v.is(ClientAuthMetadataSchema, value)
}

export function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export function isClientAuthState(value: unknown): value is ClientAuthMetadata['authState'] {
  return v.is(v.picklist(['active', 'revoked', 'reauth-required']), value)
}

export function isClientRefreshState(value: unknown): value is ClientAuthMetadata['refreshState'] {
  return v.is(v.picklist(['idle', 'refreshing', 'backing-off']), value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
