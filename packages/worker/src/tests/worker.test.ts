import { assert, test } from 'vitest'

import workerEntrypoint, {
  type WorkerEnv,
  type DurableObjectIdBinding,
  type DurableObjectStubBinding,
} from '../runtime'
import {
  makeEnv,
  makeDeviceToken,
  makeEnvWithDeviceTokenSecret,
  TEST_DEVICE_TOKEN_SECRET,
} from './support'

test('worker entrypoint keeps the admin setup token issuance endpoint degraded without a secret', async () => {
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/admin/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken: 'setup-token',
      }),
    }),
    makeEnv(),
  )

  assert.equal(response.status, 503)
})

test('worker entrypoint routes admin setup token issuance by body vaultId when enabled', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    ADMIN_TOKEN_SECRET: 'admin-secret',
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('setup-token-routed', { status: 206 })
          },
        }
      },
    },
  }

  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/admin/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kuroflare-admin-secret': 'admin-secret' },
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken: 'setup-token',
      }),
    }),
    env,
  )

  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'setup-token-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/admin/setup-tokens')
})

test('worker entrypoint rejects admin setup token issuance with a mismatched secret', async () => {
  const env: WorkerEnv = {
    ADMIN_TOKEN_SECRET: 'admin-secret',
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        throw new Error('should not route')
      },
      get(): DurableObjectStubBinding {
        throw new Error('should not route')
      },
    },
  }

  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/admin/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kuroflare-admin-secret': 'wrong-secret' },
      body: JSON.stringify({ vaultId: 'vault-1', setupToken: 'setup-token' }),
    }),
    env,
  )

  assert.equal(response.status, 403)
})

function makeSetupTokenIssuingEnv(capture: {
  routedName?: string
  routedBody?: unknown
}): WorkerEnv {
  return {
    ...makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        capture.routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            capture.routedBody = await request.json()
            return Response.json({
              ok: true,
              vaultId: 'vault-1',
              expiresAt: 1_700_000_000_000,
              tokenReadable: true,
            })
          },
        }
      },
    },
  }
}

test('device setup token issuance rejects an unauthenticated caller', async () => {
  const capture: { routedName?: string } = {}
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/devices/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    makeSetupTokenIssuingEnv(capture),
  )

  assert.equal(response.status, 401)
  assert.equal(capture.routedName, undefined)
})

test('device setup token issuance returns a generated token bound to the caller vault', async () => {
  const capture: { routedName?: string; routedBody?: unknown } = {}
  const env = makeSetupTokenIssuingEnv(capture)
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/devices/setup-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
      },
      body: JSON.stringify({ expiresInMs: 60_000 }),
    }),
    env,
  )

  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    setupToken: string
    vaultId: string
    expiresAt: number
  }
  assert.equal(capture.routedName, 'vault-1')
  assert.equal(body.vaultId, 'vault-1')
  assert.equal(body.expiresAt, 1_700_000_000_000)
  // The edge generates the token and is the only place it exists in the clear;
  // the Durable Object receives the same value and stores only its hash.
  assert.ok(body.setupToken.length >= 32)
  assert.deepEqual(capture.routedBody, {
    vaultId: 'vault-1',
    setupToken: body.setupToken,
    expiresInMs: 60_000,
  })
})

test('device setup token issuance ignores a caller-supplied vaultId', async () => {
  const capture: { routedName?: string; routedBody?: unknown } = {}
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/devices/setup-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
      },
      body: JSON.stringify({ vaultId: 'vault-victim' }),
    }),
    makeSetupTokenIssuingEnv(capture),
  )

  assert.equal(response.status, 200)
  assert.equal(capture.routedName, 'vault-1')
  assert.equal((capture.routedBody as { vaultId: string }).vaultId, 'vault-1')
})

test('worker entrypoint routes auth refresh requests by body vaultId', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('refresh-routed', { status: 208 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vaultId: 'vault-1',
      deviceId: 'device-1',
      refreshToken: 'refresh-token',
      previousTokenVersion: 1,
    }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 208)
  assert.equal(await response.text(), 'refresh-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/auth/refresh')
})

test('worker entrypoint verifies setup access tokens and rejects forged JWTs', async () => {
  const secret = 'test-device-token-secret'
  const env = makeEnvWithDeviceTokenSecret(secret)
  const validResponse = await workerEntrypoint.fetch(
    new Request('https://worker.example/auth/verify', {
      headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
    }),
    env,
  )
  assert.equal(validResponse.status, 200)
  assert.equal((await validResponse.json()).aud, 'vault-1')

  const forgedResponse = await workerEntrypoint.fetch(
    new Request('https://worker.example/auth/verify', {
      headers: { Authorization: `Bearer ${await makeDeviceToken(`${secret}-wrong`)}` },
    }),
    env,
  )
  assert.equal(forgedResponse.status, 401)
})

test('worker entrypoint routes device revoke requests by token vault', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const secret = 'test-device-token-secret'
  const env: WorkerEnv = {
    ...makeEnvWithDeviceTokenSecret(secret),
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('revoke-routed', { status: 206 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/devices/device-2/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await makeDeviceToken(secret)}`,
    },
    body: JSON.stringify({ reason: 'lost' }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'revoke-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/devices/device-2/revoke')
})

test('worker entrypoint routes quarantine inspect requests by token vault', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const secret = 'test-device-token-secret'
  const env: WorkerEnv = {
    ...makeEnvWithDeviceTokenSecret(secret),
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('quarantine-routed', { status: 209 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/admin/quarantine/q-message-bad', {
    headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 209)
  assert.equal(await response.text(), 'quarantine-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/admin/quarantine/q-message-bad')
})

test('worker entrypoint rejects invalid routes before touching Durable Objects', async () => {
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        throw new Error('should not route')
      },
      get(): DurableObjectStubBinding {
        throw new Error('should not route')
      },
    },
  }

  assert.equal(
    (await workerEntrypoint.fetch(new Request('https://worker.example/'), env)).status,
    404,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/ws/bad id', {
          headers: { Upgrade: 'websocket' },
        }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(
    (await workerEntrypoint.fetch(new Request('https://worker.example/ws/vault-1'), env)).status,
    426,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/setup/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vaultId: 'bad id' }),
        }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vaultId: 'bad id' }),
        }),
        env,
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await workerEntrypoint.fetch(
        new Request('https://worker.example/devices/bad id/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        env,
      )
    ).status,
    401,
  )
})
