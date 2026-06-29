import {
  DEVICE_TOKEN_ISSUER,
  DeviceTokenClaimsSchema,
  SetupExchangeResponseSchema,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type SetupBootstrapMode,
  type SetupExchangeResponse,
  type VaultId,
} from '@kuroflare/core'
import * as v from 'valibot'

import { type SetupExchangeCredentialPlan } from '../devices'

/** Full device access scope granted after a successful setup exchange. */
export const SETUP_EXCHANGE_DEVICE_TOKEN_SCOPES: DeviceTokenScope[] = [
  'sync:read',
  'sync:write',
  'blob:read',
  'blob:write',
]

/** Input for assembling setup exchange JWT claims and response body. */
export interface SetupExchangeHttpResponsePlanInput {
  readonly credentialPlan: SetupExchangeCredentialPlan
  readonly endpoint: string
  readonly vaultId: VaultId
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessTokenIssuedAt: number
  readonly accessTokenExpiresAt: number
  readonly protocolVersion: number
  readonly bootstrapMode: SetupBootstrapMode
}

/** Setup exchange HTTP response plan after token material has been generated. */
export type SetupExchangeHttpResponsePlan =
  | {
      readonly action: 'respond'
      readonly claims: DeviceTokenClaims
      readonly response: SetupExchangeResponse
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'credentials-not-issued'
        | 'invalid-token-window'
        | 'invalid-claims'
        | 'invalid-response'
    }

/**
 * Builds the access-token claims and setup exchange response body from accepted credentials.
 *
 * @param input Accepted credential plan, signed token material, endpoint, vault, and protocol metadata.
 * @returns A response plan, or the reason the assembled wire objects are unsafe.
 */
export function planSetupExchangeHttpResponse(
  input: SetupExchangeHttpResponsePlanInput,
): SetupExchangeHttpResponsePlan {
  if (input.credentialPlan.action !== 'issue-credentials') {
    return { action: 'reject', reason: 'credentials-not-issued' }
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
    sub: input.credentialPlan.deviceId,
    scope: SETUP_EXCHANGE_DEVICE_TOKEN_SCOPES,
    iat: input.accessTokenIssuedAt,
    exp: input.accessTokenExpiresAt,
    tokenVersion: input.credentialPlan.tokenVersion,
  }
  if (!v.is(DeviceTokenClaimsSchema, claims)) {
    return { action: 'reject', reason: 'invalid-claims' }
  }

  const response: SetupExchangeResponse = {
    endpoint: input.endpoint,
    vaultId: input.vaultId,
    deviceId: input.credentialPlan.deviceId,
    yClientId: input.credentialPlan.yClientId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenVersion: input.credentialPlan.tokenVersion,
    protocolVersion: input.protocolVersion,
    bootstrapMode: input.bootstrapMode,
  }
  if (!v.is(SetupExchangeResponseSchema, response)) {
    return { action: 'reject', reason: 'invalid-response' }
  }

  return { action: 'respond', claims, response }
}
