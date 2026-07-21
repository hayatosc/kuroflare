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

export const ClientAuthRefreshInputSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
  previousTokenVersion: v.optional(PositiveSafeIntegerSchema),
})

export const ClientAuthStartInputSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
  tokenExpiresAt: NonNegativeSafeIntegerSchema,
  refreshMarginMs: NonNegativeSafeIntegerSchema,
  estimatedDurationMs: v.optional(NonNegativeSafeIntegerSchema),
})

export const ClientAuthRefreshAttemptAcceptedSchema = v.object({
  status: v.literal('accepted'),
  patch: v.looseObject({
    tokenVersion: PositiveSafeIntegerSchema,
    expiresAt: NonNegativeSafeIntegerSchema,
  }),
})

export const ClientAuthRefreshAttemptInputSchema = v.object({
  now: NonNegativeSafeIntegerSchema,
  retryCount: NonNegativeSafeIntegerSchema,
  retryAfterMs: v.optional(NonNegativeSafeIntegerSchema),
  result: v.unknown(),
})

export const ClientAuthRefreshStartInputSchema = v.object({
  metadata: ClientAuthMetadataSchema,
  requestedAt: NonNegativeSafeIntegerSchema,
})

export const ClientAuthRefreshStaleStartRecoveryInputSchema = v.object({
  metadata: ClientAuthMetadataSchema,
  now: NonNegativeSafeIntegerSchema,
  staleAfterMs: PositiveSafeIntegerSchema,
})

export const SetupPersistInputSchema = v.object({
  response: v.looseObject({
    tokenVersion: PositiveSafeIntegerSchema,
  }),
  accessTokenExpiresAt: NonNegativeSafeIntegerSchema,
  accessTokenSecretKey: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  refreshTokenSecretKey: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
})

export const ClientDeviceRevokeEvidenceSchema = v.object({
  tokenVersion: PositiveSafeIntegerSchema,
  revokedAt: NonNegativeSafeIntegerSchema,
  previousTokenVersion: v.optional(PositiveSafeIntegerSchema),
})

export const ClientAuthMetadataRevokePatchSchema = v.object({
  metadata: ClientAuthMetadataSchema,
})

export const ClientAuthMetadataRefreshAttemptPatchSchema = v.object({
  metadata: ClientAuthMetadataSchema,
  decision: v.unknown(),
})

export function isClientAuthMetadata(value: unknown): value is ClientAuthMetadata {
  return v.is(ClientAuthMetadataSchema, value)
}

export function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return v.is(v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength)), value)
}

export function isClientAuthState(value: unknown): value is ClientAuthMetadata['authState'] {
  return v.is(v.picklist(['active', 'revoked', 'reauth-required']), value)
}

export function isClientRefreshState(value: unknown): value is ClientAuthMetadata['refreshState'] {
  return v.is(v.picklist(['idle', 'refreshing', 'backing-off']), value)
}

import { isRecord } from '../utils/shared'
export { isRecord }
