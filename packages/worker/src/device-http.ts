import {
  RevokeDeviceResponseSchema,
  type DeviceId,
  type RevokeDeviceResponse,
} from '@kuroflare/protocol'
import * as v from 'valibot'

import { type RevokeDeviceDecision } from './devices.js'

/** Input for assembling a device revoke HTTP response. */
export interface RevokeDeviceHttpResponsePlanInput {
  readonly revokeDecision: RevokeDeviceDecision
  readonly deviceId: DeviceId
}

/** Device revoke HTTP response plan after registry mutation has been decided. */
export type RevokeDeviceHttpResponsePlan =
  | {
      readonly action: 'respond'
      readonly response: RevokeDeviceResponse
    }
  | {
      readonly action: 'reject'
      readonly reason: 'revoke-not-accepted' | 'invalid-response'
    }

/**
 * Builds the revoke response body from a revoke registry decision.
 *
 * @param input Revoke decision and target device identity from the routed request.
 * @returns A guarded revoke response, or the reason the response cannot be emitted.
 */
export function planRevokeDeviceHttpResponse(
  input: RevokeDeviceHttpResponsePlanInput,
): RevokeDeviceHttpResponsePlan {
  if (input.revokeDecision.action === 'reject') {
    return { action: 'reject', reason: 'revoke-not-accepted' }
  }

  const response: RevokeDeviceResponse = {
    deviceId: input.deviceId,
    status: input.revokeDecision.action === 'revoke-device' ? 'revoked' : 'already-revoked',
    revokedAt: input.revokeDecision.revokedAt,
    tokenVersion: input.revokeDecision.tokenVersion,
  }
  if (!v.is(RevokeDeviceResponseSchema, response)) {
    return { action: 'reject', reason: 'invalid-response' }
  }

  return { action: 'respond', response }
}
