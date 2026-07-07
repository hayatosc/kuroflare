import { assert, test } from 'vitest'

import workerEntrypoint, {
  type WorkerEnv,
  type DurableObjectIdBinding,
  type DurableObjectStubBinding,
} from '../runtime'
import { makeEnv, makeDeviceToken, makeEnvWithDeviceTokenSecret } from './test-helpers'

test('worker entrypoint keeps the e2e setup token seed endpoint disabled without a secret', async () => {
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/__e2e/setup-token', {
      method: 'POST',
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken: 'setup-token',
      }),
    }),
    makeEnv(),
  )

  assert.equal(response.status, 404)
})

test('worker entrypoint routes e2e setup token seeds by body vaultId when enabled', async () => {
  let routedName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    E2E_SETUP_TOKEN_SECRET: 'seed-secret',
    VAULT_ROOM: {
      idFromName(name: string): DurableObjectIdBinding {
        routedName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request: Request): Promise<Response> {
            routedRequest = request
            return new Response('seed-routed', { status: 206 })
          },
        }
      },
    },
  }

  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/__e2e/setup-token', {
      method: 'POST',
      headers: { 'x-kuroflare-e2e-secret': 'seed-secret' },
      body: JSON.stringify({
        vaultId: 'vault-1',
        setupToken: 'setup-token',
      }),
    }),
    env,
  )

  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'seed-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/__e2e/setup-token')
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
    headers: { Authorization: `Bearer ${await makeDeviceToken(secret)}` },
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
          body: JSON.stringify({}),
        }),
        env,
      )
    ).status,
    400,
  )
})
