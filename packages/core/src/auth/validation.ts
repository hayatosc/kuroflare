import * as v from 'valibot'
import { DeviceIdSchema } from '../ids'
import type { ClientAuthMetadata } from './types'

export function isClientAuthMetadata(value: unknown): value is ClientAuthMetadata {
  if (!isRecord(value)) {
    return false
  }

  if (
    !v.is(DeviceIdSchema, value.deviceId) ||
    !isClientAuthState(value.authState) ||
    !isPositiveSafeInteger(value.tokenVersion) ||
    !isClientRefreshState(value.refreshState) ||
    !isNonNegativeSafeInteger(value.retryCount)
  ) {
    return false
  }

  return (
    (value.accessTokenExpiresAt === undefined ||
      isNonNegativeSafeInteger(value.accessTokenExpiresAt)) &&
    (value.revokedAt === undefined || isNonNegativeSafeInteger(value.revokedAt)) &&
    (value.refreshStartedAt === undefined || isNonNegativeSafeInteger(value.refreshStartedAt)) &&
    (value.nextAllowedRefreshAt === undefined ||
      isNonNegativeSafeInteger(value.nextAllowedRefreshAt)) &&
    (value.accessTokenSecretKey === undefined ||
      isBoundedNonEmptyString(value.accessTokenSecretKey, 256)) &&
    (value.refreshTokenSecretKey === undefined ||
      isBoundedNonEmptyString(value.refreshTokenSecretKey, 256))
  )
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export function isClientAuthState(value: unknown): value is ClientAuthMetadata['authState'] {
  return value === 'active' || value === 'revoked' || value === 'reauth-required'
}

export function isClientRefreshState(value: unknown): value is ClientAuthMetadata['refreshState'] {
  return value === 'idle' || value === 'refreshing' || value === 'backing-off'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
