import { SignJWT, jwtVerify } from 'jose'
import * as v from 'valibot'

import { DeviceTokenClaimsSchema, type DeviceTokenClaims } from '../sync/schemas'

const encoder = new TextEncoder()

const DeviceTokenSecretSchema = v.pipe(v.string(), v.minLength(1))

/** Input for signing worker-issued device access-token claims. */
export interface SignHs256DeviceTokenInput {
  readonly claims: DeviceTokenClaims
  readonly secret: string
}

/** Input for verifying worker-issued device access tokens. */
export interface VerifyHs256DeviceTokenInput {
  readonly token: string
  readonly secret: string
}

/**
 * Signs device token claims as an HS256 JWT.
 *
 * @param input Guarded claims and shared HMAC secret.
 * @returns Compact JWT string suitable for device access tokens.
 * @throws When the secret is empty or the claims fail the device-token claims guard.
 */
export async function signHs256DeviceToken(input: SignHs256DeviceTokenInput): Promise<string> {
  if (!v.is(DeviceTokenSecretSchema, input.secret)) {
    throw new Error('empty-device-token-secret')
  }
  if (!v.is(DeviceTokenClaimsSchema, input.claims)) {
    throw new Error('invalid-device-token-claims')
  }

  return new SignJWT({ ...input.claims })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(encoder.encode(input.secret))
}

/**
 * Verifies an HS256 device access token and returns guarded claims.
 *
 * Timestamp validation (exp/iat/nbf) is deliberately delegated to callers
 * via `clockTolerance`; this function performs only structural, signature,
 * and payload-schema checks.
 *
 * @param input Compact JWT and shared HMAC secret.
 * @returns Device token claims when header, signature, and payload validate; otherwise undefined.
 */
export async function verifyHs256DeviceToken(
  input: VerifyHs256DeviceTokenInput,
): Promise<DeviceTokenClaims | undefined> {
  if (!v.is(DeviceTokenSecretSchema, input.secret)) {
    return undefined
  }

  try {
    const { payload } = await jwtVerify<DeviceTokenClaims>(
      input.token,
      encoder.encode(input.secret),
      {
        algorithms: ['HS256'],
        // The caller (`decideAuthAdmission` / `decideClientAuthRefresh`) performs its own
        // timestamp checks with the project's conventions, so we disable jose's built-in
        // NumericDate enforcement which would otherwise interpret our millisecond timestamps
        // as seconds-since-epoch and reject every token as expired in 1970.
        clockTolerance: Number.MAX_SAFE_INTEGER,
      },
    )

    if (!v.is(DeviceTokenClaimsSchema, payload)) {
      return undefined
    }
    return payload
  } catch {
    return undefined
  }
}
