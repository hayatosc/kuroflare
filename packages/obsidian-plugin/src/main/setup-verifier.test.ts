import { assert, test } from 'vitest'

import { createRemoteSetupAccessTokenVerifier } from './setup-verifier'

test('remote setup verifier rejects forged or malformed worker responses', async () => {
  const verifier = createRemoteSetupAccessTokenVerifier({
    endpoint: 'https://worker.example/api/',
    fetch: async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      assert.equal(url, 'https://worker.example/auth/verify')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer forged.jwt')
      return new Response(JSON.stringify({ aud: 'vault-1', exp: 'not-a-number' }), { status: 200 })
    },
  })

  assert.equal(await verifier.verify('forged.jwt'), undefined)
})

test('remote setup verifier accepts only a valid verified claims response', async () => {
  const claims = {
    iss: 'kuroflare-worker',
    sub: 'device-1',
    aud: 'vault-1',
    scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
    iat: 1_000,
    exp: 2_000,
    tokenVersion: 1,
  }
  const verifier = createRemoteSetupAccessTokenVerifier({
    endpoint: 'https://worker.example',
    fetch: async () => new Response(JSON.stringify(claims), { status: 200 }),
  })

  assert.deepEqual(await verifier.verify('valid.jwt'), claims)
})
