import { DeviceTokenClaimsSchema, type DeviceTokenClaims } from '@kuroflare/core'
import * as v from 'valibot'

import type { SyncRuntimeSetupPersistAccessTokenVerifierPort } from '../sync/engine/actuation'

/** Input for verifying setup access tokens through the worker's trusted JWT verifier. */
export interface RemoteSetupAccessTokenVerifierInput {
  readonly endpoint: string
  readonly fetch: typeof globalThis.fetch
}

/** Creates a verifier that delegates signature and claim validation to the worker. */
export function createRemoteSetupAccessTokenVerifier(
  input: RemoteSetupAccessTokenVerifierInput,
): SyncRuntimeSetupPersistAccessTokenVerifierPort {
  return {
    async verify(accessToken): Promise<DeviceTokenClaims | undefined> {
      let url: URL
      try {
        url = new URL('/auth/verify', input.endpoint)
      } catch {
        return undefined
      }
      let response: Response
      try {
        response = await input.fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      } catch {
        return undefined
      }
      if (!response.ok) return undefined
      const body: unknown = await response.json().catch(() => undefined)
      return v.is(DeviceTokenClaimsSchema, body) ? body : undefined
    },
  }
}
