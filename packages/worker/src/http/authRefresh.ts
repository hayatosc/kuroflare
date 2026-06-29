import {
  DEVICE_TOKEN_ISSUER,
  DeviceTokenClaimsSchema,
  DeviceTokenRefreshResponseSchema,
  type DeviceTokenClaims,
  type DeviceTokenRefreshResponse,
  type DeviceTokenScope,
  type VaultId,
} from '@kuroflare/core'
import * as v from 'valibot'

import { type DeviceRefreshTokenRotationPlan, type DeviceTokenRefreshDecision } from '../devices'

/** Full device access scope granted after a successful refresh-token exchange. */
export const AUTH_REFRESH_DEVICE_TOKEN_SCOPES: DeviceTokenScope[] = [
  'sync:read',
  'sync:write',
  'blob:read',
  'blob:write',
]

/** Input for assembling a device-token refresh HTTP response. */
export interface DeviceTokenRefreshHttpResponsePlanInput {
  readonly refreshDecision: DeviceTokenRefreshDecision
  readonly rotationPlan: DeviceRefreshTokenRotationPlan
  readonly vaultId: VaultId
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessTokenIssuedAt: number
  readonly accessTokenExpiresAt: number
  readonly protocolVersion: number
}

/** Device-token refresh HTTP response plan after token material has been generated. */
export type DeviceTokenRefreshHttpResponsePlan =
  | {
      readonly action: 'respond'
      readonly claims: DeviceTokenClaims
      readonly response: DeviceTokenRefreshResponse
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'refresh-not-accepted'
        | 'rotation-not-accepted'
        | 'token-version-mismatch'
        | 'invalid-token-window'
        | 'invalid-claims'
        | 'invalid-response'
    }

/**
 * Builds the access-token claims and refresh response body from an accepted refresh decision.
 *
 * @param input Accepted refresh decision, rotation plan, signed token material, vault, and protocol metadata.
 * @returns A response plan, or the reason the assembled wire objects are unsafe.
 */
export function planDeviceTokenRefreshHttpResponse(
  input: DeviceTokenRefreshHttpResponsePlanInput,
): DeviceTokenRefreshHttpResponsePlan {
  if (input.refreshDecision.action !== 'mint-token') {
    return { action: 'reject', reason: 'refresh-not-accepted' }
  }
  if (input.rotationPlan.action !== 'rotate') {
    return { action: 'reject', reason: 'rotation-not-accepted' }
  }
  if (input.refreshDecision.tokenVersion <= 0) {
    return { action: 'reject', reason: 'token-version-mismatch' }
  }
  if (
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.accessTokenIssuedAt) ||
    !v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.accessTokenExpiresAt) ||
    input.accessTokenExpiresAt <= input.accessTokenIssuedAt
  ) {
    return { action: 'reject', reason: 'invalid-token-window' }
  }

  const claims: DeviceTokenClaims = {
    iss: DEVICE_TOKEN_ISSUER,
    aud: input.vaultId,
    sub: input.rotationPlan.insert.deviceId,
    scope: AUTH_REFRESH_DEVICE_TOKEN_SCOPES,
    iat: input.accessTokenIssuedAt,
    exp: input.accessTokenExpiresAt,
    tokenVersion: input.refreshDecision.tokenVersion,
  }
  if (!v.is(DeviceTokenClaimsSchema, claims)) {
    return { action: 'reject', reason: 'invalid-claims' }
  }

  const response: DeviceTokenRefreshResponse = {
    accessToken: input.accessToken,
    tokenVersion: input.refreshDecision.tokenVersion,
    expiresAt: input.accessTokenExpiresAt,
    protocolVersion: input.protocolVersion,
    refreshToken: input.refreshToken,
  }
  if (!v.is(DeviceTokenRefreshResponseSchema, response)) {
    return { action: 'reject', reason: 'invalid-response' }
  }

  return { action: 'respond', claims, response }
}
