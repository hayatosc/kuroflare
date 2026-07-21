import {
  ApiErrorSchema,
  DeviceSetupTokenIssueResponseSchema,
  type ApiError,
  type DeviceSetupTokenIssueRequest,
  type DeviceSetupTokenIssueResponse,
} from '@kuroflare/core'
import * as v from 'valibot'

import { createWorkerClient } from '../api-client'

/** Endpoint, this device's access token, and optional expiry used to issue a device invite. */
export interface DeviceInviteIssueInput {
  readonly endpoint: string
  readonly accessToken: string
  readonly expiresInMs?: DeviceSetupTokenIssueRequest['expiresInMs']
}

/** Result of issuing a device invite setup token over HTTP. */
export type DeviceInviteIssueResult =
  | { readonly ok: true; readonly response: DeviceSetupTokenIssueResponse }
  | { readonly ok: false; readonly status: number; readonly error: ApiError | undefined }

/**
 * Issues a one-time, short-lived setup token that invites another device into this vault.
 *
 * Follows the same call shape as the existing device revoke request: an authenticated
 * worker client posts the request, and a failed response is surfaced as a result instead
 * of thrown, so callers never log or persist the returned setup token by accident.
 *
 * @param input Worker endpoint, this device's access token, and optional expiry.
 * @param fetchImpl Optional fetch override used for testing.
 * @returns The issued setup token/vault/expiry, or the failed response's status and `ApiError` body.
 */
export async function issueDeviceInviteSetupToken(
  input: DeviceInviteIssueInput,
  fetchImpl?: typeof fetch,
): Promise<DeviceInviteIssueResult> {
  const client = createWorkerClient(input.endpoint, input.accessToken, fetchImpl)
  const response = await client.devices['setup-tokens'].$post({
    json: input.expiresInMs === undefined ? {} : { expiresInMs: input.expiresInMs },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: v.is(ApiErrorSchema, body) ? body : undefined,
    }
  }
  if (!v.is(DeviceSetupTokenIssueResponseSchema, body)) {
    return { ok: false, status: response.status, error: undefined }
  }
  return { ok: true, response: body }
}

/** Fields required to build the `kuroflare://setup` URI carrying an issued device invite. */
export interface DeviceInviteSetupUriInput {
  readonly endpoint: string
  readonly vaultId: string
  readonly setupToken: string
}

/**
 * Builds the `kuroflare://setup` URI for a just-issued device invite.
 *
 * Always sets `bootstrapMode=join-existing`, since an invite only ever enrolls a new
 * device into this already-existing vault.
 *
 * @param input Worker endpoint plus the vault ID and setup token returned by the issue call.
 * @returns The setup URI to hand to the joining device.
 */
export function buildDeviceInviteSetupUri(input: DeviceInviteSetupUriInput): string {
  const url = new URL('kuroflare://setup')
  url.searchParams.set('endpoint', input.endpoint)
  url.searchParams.set('vaultId', input.vaultId)
  url.searchParams.set('setupToken', input.setupToken)
  url.searchParams.set('bootstrapMode', 'join-existing')
  return url.toString()
}
