import {
  makeDeviceId,
  makeVaultId,
  type SetupExchangeRequest,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, expect, test, vi } from 'vitest'

import {
  buildSetupExchangeRequest,
  createEvidenceBackedHttpSyncRuntimeSetupExchangePort,
  createHttpSyncRuntimeSetupExchangePort,
  requestSetupExchange,
  type SetupExchangeStartupEffect,
} from './setup-exchange-http'

const vaultId = makeVaultId('setup-http-vault-1')
const deviceId = makeDeviceId('setup-http-device-1')

const request = {
  vaultId,
  setupToken: 'setup-token',
  requestedDeviceName: 'Hayato Laptop',
} satisfies SetupExchangeRequest

const response = {
  endpoint: 'https://sync.example.test',
  vaultId,
  deviceId,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

test('setup exchange request builder normalizes UI evidence into protocol request', () => {
  assert.deepEqual(
    buildSetupExchangeRequest({
      vaultId: ` ${vaultId} `,
      setupToken: ' setup-token ',
      requestedDeviceName: ' Hayato Laptop ',
      existingDeviceId: ` ${deviceId} `,
    }),
    {
      ok: true,
      request: {
        vaultId,
        setupToken: 'setup-token',
        requestedDeviceName: 'Hayato Laptop',
        existingDeviceId: deviceId,
      },
    },
  )

  assert.deepEqual(
    buildSetupExchangeRequest({
      vaultId,
      setupToken: ' setup-token ',
      requestedDeviceName: ' Hayato Laptop ',
      existingDeviceId: '  ',
    }),
    {
      ok: true,
      request: {
        vaultId,
        setupToken: 'setup-token',
        requestedDeviceName: 'Hayato Laptop',
      },
    },
  )
})

test('setup exchange request builder returns non-secret failure reasons', () => {
  const token = 'secret-setup-token'
  const failures = [
    buildSetupExchangeRequest({
      vaultId: '/bad',
      setupToken: token,
      requestedDeviceName: 'Laptop',
    }),
    buildSetupExchangeRequest({
      vaultId,
      setupToken: ' ',
      requestedDeviceName: 'Laptop',
    }),
    buildSetupExchangeRequest({
      vaultId,
      setupToken: token,
      requestedDeviceName: ' ',
    }),
    buildSetupExchangeRequest({
      vaultId,
      setupToken: token,
      requestedDeviceName: 'Laptop',
      existingDeviceId: '/bad-device',
    }),
  ]

  assert.deepEqual(failures, [
    { ok: false, reason: 'invalid-vault-id' },
    { ok: false, reason: 'missing-setup-token' },
    { ok: false, reason: 'invalid-requested-device-name' },
    { ok: false, reason: 'invalid-existing-device-id' },
  ])
  assert.equal(JSON.stringify(failures).includes(token), false)
})

test('setup exchange http client posts request and validates response', async () => {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: requestUrl(input), init })
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const result = await requestSetupExchange(
    {
      endpoint: 'https://sync.example.test/',
      request,
    },
    fetchImpl,
  )

  assert.deepEqual(result, response)
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.notEqual(call, undefined)
  if (call === undefined) {
    return
  }
  assert.equal(call.url, 'https://sync.example.test/setup/exchange')
  assert.equal(call.init?.method, 'POST')
  assert.equal(call.init?.body, JSON.stringify(request))
})

test('setup exchange http client rejects non-ok responses without reading token-bearing body', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: 'setup-token:expired' }), { status: 403 })

  await expect(
    requestSetupExchange(
      { endpoint: 'https://sync.example.test', request },
      fetchImpl,
    ),
  ).rejects.toThrow(/setup-exchange-http:403/)
})

test('setup exchange http client rejects invalid json and invalid response shapes', async () => {
  await expect(
    requestSetupExchange(
      { endpoint: 'https://sync.example.test', request },
      async () => new Response('not json', { status: 200 }),
    ),
  ).rejects.toThrow(/setup-exchange-invalid-json/)

  await expect(
    requestSetupExchange(
      { endpoint: 'https://sync.example.test', request },
      async () => new Response(JSON.stringify({ ...response, refreshToken: '' }), { status: 200 }),
    ),
  ).rejects.toThrow(/invalid-setup-exchange-response/)
})

test('setup exchange http client rejects invalid endpoint before sending request', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return new Response(JSON.stringify(response), { status: 200 })
  }

  await expect(
    requestSetupExchange(
      { endpoint: 'kuroflare://setup', request },
      fetchImpl,
    ),
  ).rejects.toThrow(/invalid-setup-exchange-endpoint/)
  assert.equal(called, false)
})

test('http-backed setup exchange startup port schedules replan after validated response', async () => {
  const effect = {
    kind: 'run-setup-exchange',
    reason: 'setup-required',
  } satisfies SetupExchangeStartupEffect
  const effects: SetupExchangeStartupEffect[] = []
  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []

  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  const port = createHttpSyncRuntimeSetupExchangePort({
    endpoint: 'https://sync.example.test',
    buildRequest(startupEffect) {
      effects.push(startupEffect)
      return request
    },
    async scheduleReplan(replanRequest) {
      scheduled.push(replanRequest)
    },
  })

  await port.run(effect)

  assert.deepEqual(effects, [effect])
  assert.deepEqual(scheduled, [{ effect, response }])
  assert.deepEqual(port.snapshot().completed, [{ effect, response }])
})

test('http-backed setup exchange startup port does not schedule replan after invalid response', async () => {
  const effect = {
    kind: 'run-setup-exchange',
    reason: 'missing-local-credentials',
  } satisfies SetupExchangeStartupEffect
  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []

  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ ...response, tokenVersion: 0 }), { status: 200 }),
  )

  const port = createHttpSyncRuntimeSetupExchangePort({
    endpoint: 'https://sync.example.test',
    buildRequest() {
      return request
    },
    async scheduleReplan(replanRequest) {
      scheduled.push(replanRequest)
    },
  })

  await expect(port.run(effect)).rejects.toThrow(/invalid-setup-exchange-response/)
  assert.deepEqual(scheduled, [])
  assert.deepEqual(port.snapshot().completed, [])
})

test('evidence-backed setup exchange startup port builds request before scheduling replan', async () => {
  const effect = {
    kind: 'run-setup-exchange',
    reason: 'setup-required',
  } satisfies SetupExchangeStartupEffect
  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []

  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )

  const port = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
    readEvidence(startupEffect) {
      assert.deepEqual(startupEffect, effect)
      return {
        endpoint: 'https://sync.example.test',
        request: {
          vaultId: ` ${vaultId} `,
          setupToken: ' setup-token ',
          requestedDeviceName: ' Hayato Laptop ',
        },
      }
    },
    async scheduleReplan(replanRequest) {
      scheduled.push(replanRequest)
    },
  })

  await port.run(effect)

  assert.deepEqual(scheduled, [{ effect, response }])
  assert.deepEqual(port.snapshot().completed, [{ effect, response }])
})

test('evidence-backed setup exchange startup port fails invalid evidence without leaking setup token', async () => {
  const effect = {
    kind: 'run-setup-exchange',
    reason: 'setup-required',
  } satisfies SetupExchangeStartupEffect
  const token = 'secret-setup-token'
  let fetchCalled = false
  vi.stubGlobal(
    'fetch',
    async () => {
      fetchCalled = true
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  )

  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []
  const port = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
    readEvidence() {
      return {
        endpoint: 'https://sync.example.test',
        request: {
          vaultId,
          setupToken: token,
          requestedDeviceName: '',
        },
      }
    },
    async scheduleReplan(replanRequest) {
      scheduled.push(replanRequest)
    },
  })

  await expect(port.run(effect)).rejects.toThrow(
    /setup-exchange-request:invalid-requested-device-name/,
  )
  try {
    await port.run(effect)
  } catch (error) {
    assert.instanceOf(error, Error)
    assert.equal(error.message, 'setup-exchange-request:invalid-requested-device-name')
    assert.equal(error.message.includes(token), false)
  }
  assert.equal(fetchCalled, false)
  assert.deepEqual(scheduled, [])
  assert.deepEqual(port.snapshot().completed, [])
})
