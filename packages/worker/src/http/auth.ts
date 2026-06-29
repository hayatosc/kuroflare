import type { DeviceTokenClaims, DeviceTokenScope, VaultId } from '@kuroflare/core'
import * as v from 'valibot'

import type { DeviceRegistryEntry } from '../devices'

/** Input for admitting an authenticated HTTP or WebSocket request. */
export interface AuthAdmissionDecisionInput {
  readonly claims: DeviceTokenClaims
  readonly expectedVaultId: VaultId
  readonly device: DeviceRegistryEntry | undefined
  readonly requiredScopes: readonly DeviceTokenScope[]
  readonly now: number
}

/** Auth admission decision before the caller handles the request body or WebSocket frame. */
export type AuthAdmissionDecision =
  | { readonly action: 'accept'; readonly device: DeviceRegistryEntry }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'vault-mismatch'
        | 'unknown-device'
        | 'device-subject-mismatch'
        | 'device-revoked'
        | 'token-expired'
        | 'token-not-yet-valid'
        | 'stale-token'
        | 'missing-scope'
        | 'invalid-time'
    }

/**
 * Decides whether verified device-token claims may access a vault endpoint.
 *
 * @param input Verified JWT claims, route vault, registry row, required scopes, and current time.
 * @returns Whether the request can proceed, or a stable rejection reason.
 */
export function decideAuthAdmission(input: AuthAdmissionDecisionInput): AuthAdmissionDecision {
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(0)), input.now)) {
    return { action: 'reject', reason: 'invalid-time' }
  }

  if (input.claims.aud !== input.expectedVaultId) {
    return { action: 'reject', reason: 'vault-mismatch' }
  }

  if (input.now < input.claims.iat) {
    return { action: 'reject', reason: 'token-not-yet-valid' }
  }

  if (input.now >= input.claims.exp) {
    return { action: 'reject', reason: 'token-expired' }
  }

  if (!hasRequiredScopes(input.claims.scope, input.requiredScopes)) {
    return { action: 'reject', reason: 'missing-scope' }
  }

  if (!input.device) {
    return { action: 'reject', reason: 'unknown-device' }
  }

  if (input.device.deviceId !== input.claims.sub) {
    return { action: 'reject', reason: 'device-subject-mismatch' }
  }

  if (input.device.revokedAt !== undefined) {
    return { action: 'reject', reason: 'device-revoked' }
  }

  if (input.claims.tokenVersion < input.device.tokenVersion) {
    return { action: 'reject', reason: 'stale-token' }
  }

  return { action: 'accept', device: input.device }
}

function hasRequiredScopes(
  grantedScopes: readonly DeviceTokenScope[],
  requiredScopes: readonly DeviceTokenScope[],
): boolean {
  const granted = new Set(grantedScopes)
  return requiredScopes.every((scope) => granted.has(scope))
}
