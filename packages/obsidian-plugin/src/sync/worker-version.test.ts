import { assert, test, vi } from 'vitest'

import { fetchWorkerVersion } from './worker-version'

test('fetches the public version endpoint without an access token', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    assert.equal(input, 'https://worker.example/version')
    assert.deepEqual(init, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    return new Response(
      JSON.stringify({
        productVersion: '0.1.0',
        protocolVersion: 1,
        minimumProtocolVersion: 1,
        minimumPluginVersion: '0.1.0',
        channel: 'stable',
        buildCommit: '0123456789abcdef0123456789abcdef01234567',
        deploymentVersionId: 'version-1',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })

  const result = await fetchWorkerVersion('https://worker.example/api?ignored=1', fetchMock)

  assert.deepEqual(result, {
    ok: true,
    value: {
      productVersion: '0.1.0',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      minimumPluginVersion: '0.1.0',
      channel: 'stable',
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
      deploymentVersionId: 'version-1',
    },
  })
})

test('returns an unavailable result for network and invalid responses', async () => {
  const networkResult = await fetchWorkerVersion('https://worker.example', async () => {
    throw new Error('network failure')
  })
  assert.deepEqual(networkResult, { ok: false, reason: 'network' })

  const invalidResult = await fetchWorkerVersion(
    'https://worker.example',
    async () => new Response('{"productVersion":"not-enough"}', { status: 200 }),
  )
  assert.deepEqual(invalidResult, { ok: false, reason: 'invalid-response', status: 200 })
})

test('returns the HTTP status without parsing an error body', async () => {
  const result = await fetchWorkerVersion(
    'https://worker.example',
    async () => new Response('secret-free error', { status: 503 }),
  )
  assert.deepEqual(result, { ok: false, reason: 'http', status: 503 })
})
