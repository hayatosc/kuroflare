import { makeVaultId, parseSetupUri, type DeviceSetupTokenIssueResponse } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { buildDeviceInviteSetupUri, issueDeviceInviteSetupToken } from './invite'

const vaultId = makeVaultId('invite-http-vault-1')

const response = {
  setupToken: 'issued-setup-token',
  vaultId,
  expiresAt: 1_700_000_600_000,
} satisfies DeviceSetupTokenIssueResponse

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

test('issues a device invite and posts the authenticated request', async () => {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: requestUrl(input), init })
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const result = await issueDeviceInviteSetupToken(
    { endpoint: 'https://sync.example.test', accessToken: 'device-access-token' },
    fetchImpl,
  )

  assert.deepEqual(result, { ok: true, response })
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.notEqual(call, undefined)
  if (call === undefined) return
  assert.equal(call.url, 'https://sync.example.test/devices/setup-tokens')
  assert.equal(call.init?.method, 'POST')
  assert.equal(call.init?.body, '{}')
  const headers = new Headers(call.init?.headers)
  assert.equal(headers.get('Authorization'), 'Bearer device-access-token')

  assert.equal(
    buildDeviceInviteSetupUri({
      endpoint: 'https://sync.example.test',
      vaultId: result.ok ? result.response.vaultId : '',
      setupToken: result.ok ? result.response.setupToken : '',
    }),
    'kuroflare://setup?endpoint=https%3A%2F%2Fsync.example.test&vaultId=invite-http-vault-1' +
      '&setupToken=issued-setup-token&bootstrapMode=join-existing',
  )
})

test('sends the requested expiry and surfaces an auth-rejected response without throwing', async () => {
  const calls: { readonly init: RequestInit | undefined }[] = []
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init })
    return new Response(
      JSON.stringify({ code: 'auth/rejected', retryable: false, detail: 'invalid-token' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
  }

  const result = await issueDeviceInviteSetupToken(
    { endpoint: 'https://sync.example.test', accessToken: 'stale-token', expiresInMs: 60_000 },
    fetchImpl,
  )

  assert.deepEqual(result, {
    ok: false,
    status: 401,
    error: { code: 'auth/rejected', retryable: false, detail: 'invalid-token' },
  })
  assert.equal(calls[0]?.init?.body, JSON.stringify({ expiresInMs: 60_000 }))
})

test('builds a setup URI the receiving device can parse', () => {
  // The two halves are written independently, so pin the round trip rather than
  // only the literal string: an invite the joining device cannot parse is useless.
  const uri = buildDeviceInviteSetupUri({
    endpoint: 'https://sync.example.test',
    vaultId,
    setupToken: 'issued-setup-token',
  })

  assert.deepEqual(parseSetupUri(uri), {
    endpoint: 'https://sync.example.test',
    vaultId,
    setupToken: 'issued-setup-token',
    bootstrapMode: 'join-existing',
  })
})

test('rejects an invalid success body without throwing', async () => {
  const result = await issueDeviceInviteSetupToken(
    { endpoint: 'https://sync.example.test', accessToken: 'device-access-token' },
    async () => new Response(JSON.stringify({ vaultId }), { status: 200 }),
  )

  assert.deepEqual(result, { ok: false, status: 200, error: undefined })
})
