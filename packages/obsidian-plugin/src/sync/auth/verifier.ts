import { verifyHs256DeviceToken } from '@kuroflare/core'

import { type SyncRuntimeSetupPersistAccessTokenVerifierPort } from '../engine/actuation'

/** Input for creating an HS256 access-token verifier. */
export interface Hs256AccessTokenVerifierInput {
  readonly secret: string
}

/**
 * Creates an HS256 verifier for worker-issued device access tokens.
 *
 * @param input Shared HMAC secret used by the worker to sign device access tokens.
 * @returns Verifier that returns guarded claims only when header, signature, and payload all validate.
 */
export function createHs256AccessTokenVerifier(
  input: Hs256AccessTokenVerifierInput,
): SyncRuntimeSetupPersistAccessTokenVerifierPort {
  return {
    async verify(accessToken) {
      return verifyHs256DeviceToken({ token: accessToken, secret: input.secret })
    },
  }
}
