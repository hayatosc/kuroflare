import {
  makeDeviceId,
  makeVaultId,
  type SetupExchangeRequest,
  type SetupExchangeResponse,
} from '@kuroflare/core'
import { assert, expect, test } from 'vitest'

import {
  buildSetupExchangeRequest,
  createEvidenceBackedHttpSyncRuntimeSetupExchangePort,
  createHttpSyncRuntimeSetupExchangePort,
  requestSetupExchange,
  type SetupExchangeFetchPort,
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
  yClientId: 1,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenVersion: 1,
  protocolVersion: 1,
  bootstrapMode: 'new-vault',
} satisfies SetupExchangeResponse

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
  const calls: { readonly input: string; readonly init: RequestInit }[] = []
  const fetch: SetupExchangeFetchPort = async (input, init) => {
    calls.push({ input, init })
    return {
      ok: true,
      status: 200,
      async json() {
        return response
      },
    }
  }

  const result = await requestSetupExchange({
    endpoint: 'https://sync.example.test/',
    request,
    fetch,
  })

  assert.deepEqual(result, response)
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.notEqual(call, undefined)
  if (call === undefined) {
    return
  }
  assert.equal(call.input, 'https://sync.example.test/setup/exchange')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(call.init.headers, { 'content-type': 'application/json' })
  assert.equal(call.init.body, JSON.stringify(request))
})

test('setup exchange http client rejects non-ok responses without reading token-bearing body', async () => {
  let jsonRead = false
  const fetch: SetupExchangeFetchPort = async () => ({
    ok: false,
    status: 403,
    async json() {
      jsonRead = true
      return { error: 'setup-token:expired' }
    },
  })

  await expect(
    requestSetupExchange({
      endpoint: 'https://sync.example.test',
      request,
      fetch,
    }),
  ).rejects.toThrow(/setup-exchange-http:403/)
  assert.equal(jsonRead, false)
})

test('setup exchange http client rejects invalid json and invalid response shapes', async () => {
  const invalidJsonFetch: SetupExchangeFetchPort = async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error('json-parse-failed')
    },
  })

  await expect(
    requestSetupExchange({
      endpoint: 'https://sync.example.test',
      request,
      fetch: invalidJsonFetch,
    }),
  ).rejects.toThrow(/setup-exchange-invalid-json/)

  const invalidResponseFetch: SetupExchangeFetchPort = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ...response, refreshToken: '' }
    },
  })

  await expect(
    requestSetupExchange({
      endpoint: 'https://sync.example.test',
      request,
      fetch: invalidResponseFetch,
    }),
  ).rejects.toThrow(/invalid-setup-exchange-response/)
})

test('setup exchange http client rejects invalid endpoint before sending request', async () => {
  let called = false
  const fetch: SetupExchangeFetchPort = async () => {
    called = true
    return {
      ok: true,
      status: 200,
      async json() {
        return response
      },
    }
  }

  await expect(
    requestSetupExchange({
      endpoint: 'kuroflare://setup',
      request,
      fetch,
    }),
  ).rejects.toThrow(/invalid-setup-exchange-endpoint/)
  assert.equal(called, false)
})

test('http-backed setup exchange startup port schedules replan after validated response', async () => {
  const effect = {
    kind: 'run-setup-exchange',
    reason: 'setup-required',
  } satisfies SetupExchangeStartupEffect
  const effects: SetupExchangeStartupEffect[] = []
  const calls: { readonly input: string; readonly init: RequestInit }[] = []
  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []
  const port = createHttpSyncRuntimeSetupExchangePort({
    endpoint: 'https://sync.example.test',
    fetch: async (input, init) => {
      calls.push({ input, init })
      return {
        ok: true,
        status: 200,
        async json() {
          return response
        },
      }
    },
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
  assert.equal(calls.length, 1)
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
  const port = createHttpSyncRuntimeSetupExchangePort({
    endpoint: 'https://sync.example.test',
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ...response, tokenVersion: 0 }
      },
    }),
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
  const calls: { readonly input: string; readonly init: RequestInit }[] = []
  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []
  const port = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
    fetch: async (input, init) => {
      calls.push({ input, init })
      return {
        ok: true,
        status: 200,
        async json() {
          return response
        },
      }
    },
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

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.notEqual(call, undefined)
  if (call === undefined) {
    return
  }
  assert.equal(call.input, 'https://sync.example.test/setup/exchange')
  assert.equal(call.init.body, JSON.stringify(request))
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
  const scheduled: {
    readonly effect: SetupExchangeStartupEffect
    readonly response: SetupExchangeResponse
  }[] = []
  const port = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
    fetch: async () => {
      fetchCalled = true
      return {
        ok: true,
        status: 200,
        async json() {
          return response
        },
      }
    },
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
