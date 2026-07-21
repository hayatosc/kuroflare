import { assert, test } from 'vitest'

import workerEntrypoint, {
  type DurableObjectIdBinding,
  type DurableObjectStubBinding,
  type WorkerEnv,
} from '../runtime'

function makeVersionEnv(extra: Omit<WorkerEnv, 'VAULT_ROOM'> = {}): WorkerEnv {
  return {
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        return {}
      },
      get(): DurableObjectStubBinding {
        return { fetch: () => new Response('unused') }
      },
    },
    ...extra,
  }
}

test('worker entrypoint routes vault websocket upgrades to a Durable Object', async () => {
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
            return new Response('routed', { status: 209 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/ws/vault-1', {
    headers: { Upgrade: 'websocket' },
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 209)
  assert.equal(await response.text(), 'routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest, request)
})

test('worker entrypoint routes setup exchange requests by body vaultId', async () => {
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
            return new Response('setup-routed', { status: 207 })
          },
        }
      },
    },
  }

  const request = new Request('https://worker.example/setup/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vaultId: 'vault-1',
      setupToken: 'setup-token',
      requestedDeviceName: 'Laptop',
    }),
  })

  const response = await workerEntrypoint.fetch(request, env)

  assert.equal(response.status, 207)
  assert.equal(await response.text(), 'setup-routed')
  assert.equal(routedName, 'vault-1')
  assert.equal(routedRequest?.url, 'https://worker.example/setup/exchange')
})

test('worker entrypoint exposes the public release version contract', async () => {
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/version'),
    makeVersionEnv({
      KUROFLARE_RELEASE_CHANNEL: 'stable',
      KUROFLARE_BUILD_COMMIT: 'abc123',
      CF_VERSION_METADATA: { id: 'deployment-version-1', tag: 'stable' },
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    productVersion: '0.1.0',
    protocolVersion: 1,
    minimumProtocolVersion: 1,
    minimumPluginVersion: '0.1.0',
    channel: 'stable',
    buildCommit: 'abc123',
    deploymentVersionId: 'deployment-version-1',
  })
})

test('worker entrypoint fails closed when release metadata is missing', async () => {
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/version'),
    makeVersionEnv({
      KUROFLARE_RELEASE_CHANNEL: 'stable',
      KUROFLARE_BUILD_COMMIT: 'abc123',
    }),
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    code: 'server/degraded',
    retryable: true,
    detail: 'version-metadata-not-configured',
  })
})

test('worker version response never exposes secrets or installation identifiers', async () => {
  const response = await workerEntrypoint.fetch(
    new Request('https://worker.example/version'),
    makeVersionEnv({
      DEVICE_TOKEN_SECRET: 'device-secret',
      ADMIN_TOKEN_SECRET: 'admin-secret',
      KUROFLARE_RELEASE_CHANNEL: 'beta',
      KUROFLARE_BUILD_COMMIT: 'abc123',
      CF_VERSION_METADATA: {
        id: 'deployment-version-2',
        tag: 'account-id-installation-id-deploy-hook-url',
      },
    }),
  )

  assert.equal(response.status, 200)
  const body = await response.text()
  assert.equal(body.includes('device-secret'), false)
  assert.equal(body.includes('admin-secret'), false)
  assert.equal(body.includes('account-id-installation-id-deploy-hook-url'), false)
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), [
    'buildCommit',
    'channel',
    'deploymentVersionId',
    'minimumPluginVersion',
    'minimumProtocolVersion',
    'productVersion',
    'protocolVersion',
  ])
})
