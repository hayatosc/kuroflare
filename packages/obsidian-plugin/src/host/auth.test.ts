// @vitest-environment jsdom

import { makeDeviceId, type ClientAuthMetadata } from '@kuroflare/core'
import { assert, expect, test, vi } from 'vitest'

import { LOCAL_AUTH_METADATA_KEY } from '../sync/engine/setup'
import {
  ensureUsableAccessTokenFromMetadata,
  acquireAuthRefreshLock,
  cancelAuthRefreshStartupRetry,
  matchesClientAuthMetadata,
  notifyAuthRefreshStartupRetry,
  releaseAuthRefreshLock,
  recoverAuthRefreshMetadataForPreflight,
  registerAuthRefreshStartupRetry,
  createRemoteSetupAccessTokenVerifier,
} from './auth'
import type { AuthRefreshRetryHost } from './auth'

const deviceId = makeDeviceId('auth-preflight-device')
const accessTokenSecretKey = 'kuroflare:auth-preflight:access-token'
const refreshTokenSecretKey = 'kuroflare:auth-preflight:refresh-token'

function metadata(accessTokenExpiresAt: number): ClientAuthMetadata {
  return {
    deviceId,
    authState: 'active',
    tokenVersion: 1,
    accessTokenExpiresAt,
    refreshState: 'idle',
    retryCount: 0,
    accessTokenSecretKey,
    refreshTokenSecretKey,
  }
}

test('expired metadata refreshes before admitting startup', async () => {
  const refreshedMetadata = {
    ...metadata(120_000),
    tokenVersion: 2,
  }
  const reasons: string[] = []

  const usable = await ensureUsableAccessTokenFromMetadata(
    metadata(0),
    'expired-access-token',
    async (reason) => {
      reasons.push(reason)
      return { metadata: refreshedMetadata, accessToken: 'fresh-access-token' }
    },
    () => 1_000,
  )

  expect(usable).toBe(true)
  expect(reasons).toEqual(['token-expired'])
})

test('fresh metadata admits startup without a refresh', async () => {
  let refreshCalls = 0

  const usable = await ensureUsableAccessTokenFromMetadata(
    metadata(120_000),
    'fresh-access-token',
    async () => {
      refreshCalls += 1
      return undefined
    },
    () => 1_000,
  )

  expect(usable).toBe(true)
  expect(refreshCalls).toBe(0)
})

test('failed refresh keeps an expired token blocked', async () => {
  let refreshCalls = 0

  const usable = await ensureUsableAccessTokenFromMetadata(
    metadata(0),
    'expired-access-token',
    async () => {
      refreshCalls += 1
      return undefined
    },
    () => 1_000,
  )

  expect(usable).toBe(false)
  expect(refreshCalls).toBe(1)
})

test('non-active auth remains fail-closed without refresh', async () => {
  let refreshCalls = 0

  const usable = await ensureUsableAccessTokenFromMetadata(
    { ...metadata(120_000), authState: 'revoked' },
    'fresh-access-token',
    async () => {
      refreshCalls += 1
      return undefined
    },
    () => 1_000,
  )

  expect(usable).toBe(false)
  expect(refreshCalls).toBe(0)
})

test('websocket preflight schedules startup retry while refresh marker is not stale', async () => {
  const retryAt: number[] = []
  const refreshingMetadata = {
    ...metadata(0),
    refreshState: 'refreshing' as const,
    refreshStartedAt: 1_000,
  }
  const usable = await recoverAuthRefreshMetadataForPreflight(
    refreshingMetadata,
    async () => ({
      ok: false,
      phase: 'recovery',
      recovery: { action: 'wait', refreshStartedAt: 1_000, staleAt: 2_000 },
    }),
    async () => refreshingMetadata,
    (retryAtValue) => retryAt.push(retryAtValue),
    () => undefined,
  )

  expect(usable).toBeUndefined()
  expect(retryAt).toEqual([2_000])
})

test('websocket preflight re-reads recovered backoff before refreshing', async () => {
  const refreshingMetadata = {
    ...metadata(0),
    refreshState: 'refreshing' as const,
    refreshStartedAt: 1_000,
  }
  const backingOffMetadata = {
    ...metadata(0),
    refreshState: 'backing-off' as const,
    nextAllowedRefreshAt: 2_000,
  }
  let readCount = 0
  const usable = await recoverAuthRefreshMetadataForPreflight(
    refreshingMetadata,
    async () => ({
      ok: true,
      recovery: { action: 'recover', metadata: backingOffMetadata },
      metadataPut: {
        kind: 'put-metadata-record',
        key: LOCAL_AUTH_METADATA_KEY,
        value: backingOffMetadata,
      },
    }),
    async () => {
      readCount += 1
      return backingOffMetadata
    },
    () => undefined,
    () => undefined,
  )

  expect(usable).toEqual(backingOffMetadata)
  expect(readCount).toBe(1)
  expect(usable?.refreshState).toBe('backing-off')
  expect(usable?.nextAllowedRefreshAt).toBe(2_000)
})

test('preflight cancels a stale retry when refresh completed before registration', async () => {
  const retryAt: number[] = []
  let cancelCalls = 0
  const refreshingMetadata = {
    ...metadata(0),
    refreshState: 'refreshing' as const,
    refreshStartedAt: 1_000,
  }
  const completedMetadata = { ...metadata(120_000), tokenVersion: 2 }
  const usable = await recoverAuthRefreshMetadataForPreflight(
    refreshingMetadata,
    async () => ({
      ok: false,
      phase: 'recovery',
      recovery: { action: 'wait', refreshStartedAt: 1_000, staleAt: 2_000 },
    }),
    async () => completedMetadata,
    (retryAtValue) => retryAt.push(retryAtValue),
    () => {
      cancelCalls += 1
    },
  )

  expect(usable).toEqual(completedMetadata)
  expect(retryAt).toEqual([2_000])
  expect(cancelCalls).toBe(1)
})

test('preflight schedules the newer marker after a conditional recovery mismatch', async () => {
  const retryAt: number[] = []
  const staleRefreshingMetadata = {
    ...metadata(0),
    refreshState: 'refreshing' as const,
    refreshStartedAt: 1_000,
  }
  const newerRefreshingMetadata = {
    ...metadata(0),
    refreshState: 'refreshing' as const,
    refreshStartedAt: 50_000,
  }
  const recoveredBackoffMetadata = {
    ...metadata(0),
    refreshState: 'backing-off' as const,
    nextAllowedRefreshAt: 2_000,
  }
  const usable = await recoverAuthRefreshMetadataForPreflight(
    staleRefreshingMetadata,
    async () => ({
      ok: true,
      recovery: { action: 'recover', metadata: recoveredBackoffMetadata },
      metadataPut: {
        kind: 'put-metadata-record',
        key: LOCAL_AUTH_METADATA_KEY,
        value: recoveredBackoffMetadata,
      },
    }),
    async () => newerRefreshingMetadata,
    (retryAtValue) => retryAt.push(retryAtValue),
    () => undefined,
    1_000,
  )

  expect(usable).toBeUndefined()
  expect(retryAt).toEqual([51_000])
})

test('outbox refresh completion wakes a waiting startup retry immediately', async () => {
  const plugin: AuthRefreshRetryHost = {
    authRefreshRetryTimeout: null,
    workerWebSocketOpenPromise: null,
  }
  let retryCalls = 0
  registerAuthRefreshStartupRetry(plugin, async () => {
    retryCalls += 1
  })
  plugin.authRefreshRetryTimeout = window.setTimeout(() => undefined, 60_000)

  notifyAuthRefreshStartupRetry(plugin)

  expect(retryCalls).toBe(1)
  expect(plugin.authRefreshRetryTimeout).toBeNull()
})

test('startup retry waits for an in-flight open to settle before reconnecting', async () => {
  const plugin: AuthRefreshRetryHost = {
    authRefreshRetryTimeout: null,
    workerWebSocketOpenPromise: Promise.reject(new Error('open-in-flight-failed')),
  }
  let retryCalls = 0
  registerAuthRefreshStartupRetry(plugin, async () => {
    retryCalls += 1
  })

  notifyAuthRefreshStartupRetry(plugin)
  expect(retryCalls).toBe(0)
  await Promise.resolve()
  await Promise.resolve()
  expect(retryCalls).toBe(1)
})

test('failed startup retry re-registers with bounded exponential backoff', async () => {
  vi.useFakeTimers()
  try {
    const plugin: AuthRefreshRetryHost = {
      authRefreshRetryTimeout: null,
      workerWebSocketOpenPromise: null,
    }
    let retryCalls = 0
    registerAuthRefreshStartupRetry(plugin, async () => {
      retryCalls += 1
      if (retryCalls === 1) {
        throw new Error('transient-open-failed')
      }
    })

    notifyAuthRefreshStartupRetry(plugin)
    await Promise.resolve()
    expect(plugin.authRefreshRetryTimeout).not.toBeNull()
    expect(retryCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(249)
    expect(retryCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(retryCalls).toBe(2)
    expect(plugin.authRefreshRetryTimeout).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('cancelled startup retry does not rearm after an in-flight failure', async () => {
  vi.useFakeTimers()
  try {
    const plugin: AuthRefreshRetryHost = {
      authRefreshRetryTimeout: null,
      workerWebSocketOpenPromise: null,
    }
    let rejectRetry: (error: unknown) => void = () => undefined
    const retryFailure = new Promise<void>((_, reject) => {
      rejectRetry = reject
    })
    let retryCalls = 0
    registerAuthRefreshStartupRetry(plugin, async () => {
      retryCalls += 1
      await retryFailure
    })

    notifyAuthRefreshStartupRetry(plugin)
    expect(retryCalls).toBe(1)
    cancelAuthRefreshStartupRetry(plugin)
    rejectRetry(new Error('cancelled-open-failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(plugin.authRefreshRetryTimeout).toBeNull()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(retryCalls).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

test('stale recovery CAS guard rejects metadata committed by a concurrent refresh', () => {
  const staleRefreshingMetadata = {
    ...metadata(0),
    refreshState: 'refreshing' as const,
    refreshStartedAt: 1_000,
  }
  const completedRefreshMetadata = {
    ...metadata(120_000),
    tokenVersion: 2,
  }

  expect(matchesClientAuthMetadata(staleRefreshingMetadata, staleRefreshingMetadata)).toBe(true)
  expect(matchesClientAuthMetadata(completedRefreshMetadata, staleRefreshingMetadata)).toBe(false)
})

test('auth refresh lock serializes refresh and revoke operations', () => {
  const host = { authRefreshRunning: false }

  expect(acquireAuthRefreshLock(host)).toBe(true)
  expect(acquireAuthRefreshLock(host)).toBe(false)
  releaseAuthRefreshLock(host)
  expect(acquireAuthRefreshLock(host)).toBe(true)
  releaseAuthRefreshLock(host)
  expect(host.authRefreshRunning).toBe(false)
})

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
