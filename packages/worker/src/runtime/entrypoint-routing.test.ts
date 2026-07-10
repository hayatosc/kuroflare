import { assert, test } from 'vitest'

import workerEntrypoint, {
  type DurableObjectIdBinding,
  type DurableObjectStubBinding,
  type WorkerEnv,
} from '../runtime'

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
