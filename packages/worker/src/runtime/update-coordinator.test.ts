import { PRODUCT_VERSION } from '@kuroflare/core'
import { assert, expect, test, vi } from 'vitest'

import workerModule, {
  scheduled,
  UPDATE_COORDINATOR_ID_NAME,
  UPDATE_COORDINATOR_REQUEST_PATH,
  UPDATE_COORDINATOR_STATE_KEY,
  UpdateCoordinator,
  workerApp,
  type DurableObjectIdBinding,
  type DurableObjectStubBinding,
  type WorkerEnv,
  type WorkerExecutionContextBinding,
} from '../runtime'
import { FakeState, MemoryStorage, makeEnv } from '../tests/support'
import { UPDATE_FETCH_TIMEOUT_MS, UPDATE_METADATA_MAX_BYTES } from './update-coordinator'

const POINTER_URL =
  'https://raw.githubusercontent.com/hayatosc/kuroflare/main/distribution/channels/stable.json'
const MANIFEST_URL =
  'https://github.com/hayatosc/kuroflare/releases/download/0.2.0/worker-release.json'
const NEW_MANIFEST_URL =
  'https://github.com/hayatosc/kuroflare/releases/download/0.3.0/worker-release.json'
const RELEASE_ASSET_URL =
  'https://release-assets.githubusercontent.com/github-production-release-asset/123/abcdef01-2345?token=test'
const BUILD_UUID = '123e4567-e89b-72d3-a456-426614174000'

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function updateMetadataFixture(
  overrides: {
    pointer?: Record<string, unknown>
    manifest?: Record<string, unknown>
  } = {},
): { pointer: Record<string, unknown>; manifest: Record<string, unknown> } {
  return {
    pointer: {
      schemaVersion: 1,
      channel: 'stable',
      productVersion: '0.2.0',
      rolloutPercentage: 100,
      blockedSourceVersions: [],
      paused: false,
      updatedAt: '2026-07-21T12:00:00Z',
      ...overrides.pointer,
    },
    manifest: {
      schemaVersion: 1,
      bootstrapProtocolVersion: 1,
      requiredTemplateProtocolVersion: 1,
      productVersion: '0.2.0',
      runtimeVersion: '0.2.0',
      runtimeIntegrity: `sha512-${'A'.repeat(86)}==`,
      runtimeBundleSha256: 'a'.repeat(64),
      wranglerVersion: '4.105.0',
      wranglerIntegrity: `sha512-${'A'.repeat(86)}==`,
      buildLockSha256: 'b'.repeat(64),
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      // A real release derives `minimumPluginVersion` from its own (newer) product
      // version, so it is strictly greater than the running Worker's version. Using the
      // realistic value here keeps every triggering test a regression guard against the
      // former plugin-version gate that rejected all legitimate upgrades.
      minimumPluginVersion: '0.2.0',
      automaticUpdate: true,
      rolloutSalt: '0.2.0-test',
      publishedAt: '2026-07-21T12:00:00Z',
      ...overrides.manifest,
    },
  }
}

async function withUpdateFetch(
  fixture: ReturnType<typeof updateMetadataFixture>,
  hookResponse: Response,
  run: (urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = fetchInputUrl(input)
    urls.push(url)
    if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer), { status: 200 })
    if (url === MANIFEST_URL) return new Response(JSON.stringify(fixture.manifest), { status: 200 })
    if (url.startsWith('https://hooks.example.test/')) return hookResponse
    return new Response('unexpected URL', { status: 404 })
  }) as typeof fetch
  try {
    await run(urls)
  } finally {
    globalThis.fetch = previousFetch
  }
}

function makeContext(): {
  context: WorkerExecutionContextBinding
  waited: Promise<unknown>[]
} {
  const waited: Promise<unknown>[] = []
  return {
    waited,
    context: {
      passThroughOnException() {},
      waitUntil(promise) {
        waited.push(promise)
      },
    },
  }
}

function updateRequest(requestedAt: number): Request {
  return new Request(`https://worker.example${UPDATE_COORDINATOR_REQUEST_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestedAt }),
  })
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

test('UpdateCoordinator persists request state in one namespaced transaction key', async () => {
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), makeEnv())

  const first = await coordinator.fetch(updateRequest(100))
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { lastRequestedAt: 100, requestCount: 1 })

  const second = await coordinator.fetch(updateRequest(200))
  assert.deepEqual(await second.json(), { lastRequestedAt: 200, requestCount: 2 })
  assert.deepEqual(await storage.get(UPDATE_COORDINATOR_STATE_KEY), {
    lastRequestedAt: 200,
    requestCount: 2,
  })
})

test('UpdateCoordinator rejects invalid requests without mutating state', async () => {
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), makeEnv())

  const methodResponse = await coordinator.fetch(
    new Request(`https://worker.example${UPDATE_COORDINATOR_REQUEST_PATH}`),
  )
  assert.equal(methodResponse.status, 405)

  const bodyResponse = await coordinator.fetch(
    new Request(`https://worker.example${UPDATE_COORDINATOR_REQUEST_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ requestedAt: 'not-a-timestamp' }),
    }),
  )
  assert.equal(bodyResponse.status, 400)
  assert.equal(await storage.get(UPDATE_COORDINATOR_STATE_KEY), undefined)
})

test('default worker module delegates fetch to the existing worker app', async () => {
  assert.deepEqual(Object.keys(workerModule).sort(), ['fetch', 'scheduled'])
  const response = await workerModule.fetch(
    new Request('https://worker.example/version'),
    makeEnv(),
  )
  assert.equal(response.status, 503)
})

test('default worker module passes the original execution context to the worker app', async () => {
  const originalFetch = workerApp.fetch
  let observedContext: unknown
  workerApp.fetch = ((request, env, context) => {
    observedContext = context
    return originalFetch(request, env, context)
  }) as typeof workerApp.fetch

  const context = Object.create({
    waitUntil() {},
    passThroughOnException() {},
  }) as WorkerExecutionContextBinding
  try {
    await workerModule.fetch(new Request('https://worker.example/version'), makeEnv(), context)
  } finally {
    workerApp.fetch = originalFetch
  }
  assert.equal(observedContext, context)
})

test('scheduled handler uses one fixed coordinator id and never enumerates VaultRoom ids', async () => {
  let coordinatorName = ''
  let routedRequest: Request | undefined
  const env: WorkerEnv = {
    VAULT_ROOM: {
      idFromName() {
        throw new Error('VaultRoom must not be enumerated')
      },
      get() {
        throw new Error('VaultRoom must not be enumerated')
      },
    },
    UPDATE_COORDINATOR: {
      idFromName(name: string): DurableObjectIdBinding {
        coordinatorName = name
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(request) {
            routedRequest = request
            return new Response(null, { status: 204 })
          },
        }
      },
    },
  }
  const { context, waited } = makeContext()

  const operation = scheduled(
    { scheduledTime: 123, cron: '17 */6 * * *', type: 'cron' },
    env,
    context,
  )
  await operation
  assert.equal(coordinatorName, UPDATE_COORDINATOR_ID_NAME)
  assert.equal(waited.length, 1)
  assert.equal(waited[0], operation)
  assert.equal(routedRequest?.method, 'POST')
  assert.deepEqual(await routedRequest?.json(), { requestedAt: 123 })
})

test('scheduled handler exposes missing binding as a rejected waitUntil promise', async () => {
  const { context, waited } = makeContext()
  const operation = scheduled(
    { scheduledTime: 123, cron: '17 */6 * * *', type: 'cron' },
    makeEnv(),
    context,
  )

  assert.equal(waited.length, 1)
  assert.equal(waited[0], operation)
  await expect(operation).rejects.toThrow('UPDATE_COORDINATOR binding is not configured')
})

test('scheduled handler exposes non-success coordinator responses as rejection', async () => {
  const env: WorkerEnv = {
    ...makeEnv(),
    UPDATE_COORDINATOR: {
      idFromName(): DurableObjectIdBinding {
        return {}
      },
      get(): DurableObjectStubBinding {
        return { fetch: async () => new Response('failed', { status: 503 }) }
      },
    },
  }
  const { context, waited } = makeContext()
  const operation = scheduled(
    { scheduledTime: 123, cron: '17 */6 * * *', type: 'cron' },
    env,
    context,
  )

  assert.equal(waited.length, 1)
  assert.equal(waited[0], operation)
  await expect(operation).rejects.toThrow('UpdateCoordinator request failed: 503')
})

test('UpdateCoordinator triggers an eligible release and records only sanitized hook state', async () => {
  const fixture = updateMetadataFixture()
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy?secret=redacted',
  })

  await withUpdateFetch(
    fixture,
    new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } }), {
      status: 200,
    }),
    async (urls) => {
      const response = await coordinator.fetch(updateRequest(1_000))
      assert.equal(response.status, 200)
      const state = (await response.json()) as Record<string, unknown>
      assert.equal(state.lastOutcome, 'triggered')
      assert.equal(state.lastTargetVersion, '0.2.0')
      assert.equal(state.lastBuildUuid, BUILD_UUID)
      assert.equal(
        Object.values(state).some((value) => String(value).includes('redacted')),
        false,
      )
      assert.deepEqual(urls, [
        POINTER_URL,
        MANIFEST_URL,
        'https://hooks.example.test/deploy?secret=redacted',
      ])
    },
  )
})

test('UpdateCoordinator treats a missing hook as disabled and rollout zero as excluded', async () => {
  const fixture = updateMetadataFixture({ pointer: { rolloutPercentage: 0 } })
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })

  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    if (fetchInputUrl(input) === POINTER_URL) return new Response(JSON.stringify(fixture.pointer))
    if (fetchInputUrl(input) === MANIFEST_URL) return new Response(JSON.stringify(fixture.manifest))
    throw new Error('hook should not be called for rollout zero')
  }) as typeof fetch
  try {
    const response = await coordinator.fetch(updateRequest(1_000))
    assert.equal((await response.json()).lastOutcome, 'rollout-excluded')
  } finally {
    globalThis.fetch = previousFetch
  }

  const disabledFixture = updateMetadataFixture()
  const disabledCoordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
  })
  await withUpdateFetch(disabledFixture, new Response('{}', { status: 200 }), async () => {
    // Reuse the same fixture with a 100% cohort; no hook is still a normal state.
    const response = await disabledCoordinator.fetch(updateRequest(1_000))
    assert.equal((await response.json()).lastOutcome, 'disabled')
  })
})

test('UpdateCoordinator deduplicates a queued target and applies bounded retry backoff', async () => {
  const fixture = updateMetadataFixture()
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  let hookAttempts = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = fetchInputUrl(input)
    if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer))
    if (url === MANIFEST_URL) return new Response(JSON.stringify(fixture.manifest))
    if (url.startsWith('https://hooks.example.test/')) {
      hookAttempts += 1
      return new Response('failed', { status: 503 })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  try {
    assert.equal(
      (await (await coordinator.fetch(updateRequest(1_000))).json()).lastOutcome,
      'hook-failed',
    )
    assert.equal(
      (await (await coordinator.fetch(updateRequest(1_001))).json()).lastOutcome,
      'backoff',
    )
    assert.equal(hookAttempts, 1)
    assert.equal(
      (await (await coordinator.fetch(updateRequest(61_001))).json()).lastOutcome,
      'hook-failed',
    )
    assert.equal(hookAttempts, 2)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('UpdateCoordinator fails closed for malformed metadata and redirects without exposing secrets', async () => {
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy?secret=hidden',
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.redirect, 'error')
    if (fetchInputUrl(input) === POINTER_URL)
      return new Response('{"schemaVersion":1}', { status: 200 })
    throw new Error('unexpected request')
  }) as typeof fetch
  try {
    const response = await coordinator.fetch(updateRequest(1_000))
    const state = (await response.json()) as Record<string, unknown>
    assert.equal(state.lastOutcome, 'invalid-metadata')
    assert.equal(JSON.stringify(state).includes('hidden'), false)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('UpdateCoordinator follows one allowlisted release manifest redirect', async () => {
  const fixture = updateMetadataFixture()
  const coordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  const requests: { url: string; redirect: RequestRedirect | undefined }[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = fetchInputUrl(input)
    requests.push({ url, redirect: init?.redirect })
    if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer))
    if (url === MANIFEST_URL) {
      return new Response(null, { status: 302, headers: { location: RELEASE_ASSET_URL } })
    }
    if (url === RELEASE_ASSET_URL) return new Response(JSON.stringify(fixture.manifest))
    if (url.startsWith('https://hooks.example.test/')) {
      return new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } }))
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  try {
    const state = await (await coordinator.fetch(updateRequest(1_000))).json()
    assert.equal(state.lastOutcome, 'triggered')
    assert.deepEqual(requests, [
      { url: POINTER_URL, redirect: 'error' },
      { url: MANIFEST_URL, redirect: 'manual' },
      { url: RELEASE_ASSET_URL, redirect: 'manual' },
      { url: 'https://hooks.example.test/deploy', redirect: 'error' },
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('UpdateCoordinator rejects unsafe, repeated, and oversized release manifest responses', async () => {
  const fixture = updateMetadataFixture()
  for (const redirect of ['attacker', 'second', 'oversized'] as const) {
    const coordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
      ...makeEnv(),
      KUROFLARE_RELEASE_CHANNEL: 'stable',
      DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
    })
    let hookCalled = false
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input) => {
      const url = fetchInputUrl(input)
      if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer))
      if (url === MANIFEST_URL) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              redirect === 'attacker'
                ? 'https://attacker.invalid/github-production-release-asset/123/abcdef'
                : RELEASE_ASSET_URL,
          },
        })
      }
      if (url === RELEASE_ASSET_URL) {
        if (redirect === 'oversized') {
          return new Response('{}', {
            headers: { 'content-length': String(UPDATE_METADATA_MAX_BYTES + 1) },
          })
        }
        return new Response(null, { status: 302, headers: { location: RELEASE_ASSET_URL } })
      }
      if (url.startsWith('https://hooks.example.test/')) hookCalled = true
      return new Response(null, { status: 404 })
    }) as typeof fetch

    try {
      const state = await (await coordinator.fetch(updateRequest(1_000))).json()
      assert.equal(state.lastOutcome, 'fetch-failed')
      assert.equal(hookCalled, false)
    } finally {
      globalThis.fetch = previousFetch
    }
  }
})

test('UpdateCoordinator times out a hanging redirected manifest body', async () => {
  const fixture = updateMetadataFixture()
  const coordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  const bodyStarted = deferred<void>()
  const previousFetch = globalThis.fetch
  vi.useFakeTimers()
  globalThis.fetch = (async (input) => {
    const url = fetchInputUrl(input)
    if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer))
    if (url === MANIFEST_URL) {
      return new Response(null, { status: 302, headers: { location: RELEASE_ASSET_URL } })
    }
    if (url === RELEASE_ASSET_URL) {
      return new Response(
        new ReadableStream({
          pull() {
            bodyStarted.resolve()
            return new Promise(() => {})
          },
        }),
      )
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  try {
    const operation = coordinator.fetch(updateRequest(1_000))
    await bodyStarted.promise
    await vi.advanceTimersByTimeAsync(UPDATE_FETCH_TIMEOUT_MS)
    const state = await (await operation).json()
    assert.equal(state.lastOutcome, 'fetch-failed')
  } finally {
    globalThis.fetch = previousFetch
    vi.useRealTimers()
  }
})

test('UpdateCoordinator records paused, blocked, and compatibility decisions without triggering', async () => {
  const cases = [
    ['paused', { paused: true }, {}, 'paused'],
    ['blocked', { blockedSourceVersions: [PRODUCT_VERSION] }, {}, 'blocked-source-version'],
    ['protocol', {}, { protocolVersion: 2, minimumProtocolVersion: 2 }, 'incompatible-protocol'],
  ] as const

  for (const [, pointerOverrides, manifestOverrides, expectedOutcome] of cases) {
    const fixture = updateMetadataFixture({
      pointer: pointerOverrides,
      manifest: manifestOverrides,
    })
    const coordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
      ...makeEnv(),
      KUROFLARE_RELEASE_CHANNEL: 'stable',
      DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
    })
    await withUpdateFetch(fixture, new Response('{}', { status: 200 }), async (urls) => {
      const response = await coordinator.fetch(updateRequest(1_000))
      assert.equal((await response.json()).lastOutcome, expectedOutcome)
      assert.equal(
        urls.some((url) => url.startsWith('https://hooks.example.test/')),
        false,
      )
    })
  }
})

test('UpdateCoordinator triggers a release whose minimumPluginVersion exceeds the running version', async () => {
  // Regression: a real release manifest's `minimumPluginVersion` tracks its own (newer)
  // product version, so it is always greater than the running Worker's version. The
  // former plugin-version gate rejected every such upgrade as `incompatible-plugin`.
  const fixture = updateMetadataFixture({
    pointer: { productVersion: '0.2.0', rolloutPercentage: 100 },
    manifest: { productVersion: '0.2.0', runtimeVersion: '0.2.0', minimumPluginVersion: '0.2.0' },
  })
  const coordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  await withUpdateFetch(
    fixture,
    new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } })),
    async (urls) => {
      const state = await (await coordinator.fetch(updateRequest(1_000))).json()
      assert.equal(state.lastOutcome, 'triggered')
      assert.equal(state.lastTriggeredVersion, '0.2.0')
      assert.equal(
        urls.some((url) => url.startsWith('https://hooks.example.test/')),
        true,
      )
    },
  )
})

test('UpdateCoordinator stops retriggering after the ceiling when accepted builds never land', async () => {
  // Regression: a Deploy Hook that is accepted (200) but whose Workers Build never
  // updates the running Worker must not re-trigger every cron cycle forever. Each
  // observation-window-expired re-trigger counts as a failed attempt so the retry
  // ceiling is reachable even though the hook call itself always succeeds.
  const fixture = updateMetadataFixture({
    pointer: { productVersion: '0.2.0', rolloutPercentage: 100 },
    manifest: { productVersion: '0.2.0', runtimeVersion: '0.2.0', minimumPluginVersion: '0.2.0' },
  })
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  let hookCount = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = fetchInputUrl(input)
    if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer), { status: 200 })
    if (url === MANIFEST_URL) return new Response(JSON.stringify(fixture.manifest), { status: 200 })
    if (url.startsWith('https://hooks.example.test/')) {
      hookCount += 1
      return new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } }))
    }
    return new Response('unexpected URL', { status: 404 })
  }) as typeof fetch

  try {
    // Each tick is one cron cycle spaced past the build observation window so the prior
    // accepted-but-unobserved trigger is charged as a failed attempt.
    const oneHour = 60 * 60 * 1_000
    const outcomes: unknown[] = []
    for (let tick = 0; tick < 5; tick += 1) {
      const state = await (await coordinator.fetch(updateRequest(1_000 + tick * oneHour))).json()
      outcomes.push(state.lastOutcome)
    }
    // Triggered on ticks 0..2 (3 = UPDATE_MAX_RETRIES attempts), then stopped.
    assert.equal(hookCount, 3)
    assert.equal(outcomes[3], 'retry-ceiling')
    assert.equal(outcomes[4], 'retry-ceiling')
    const persisted = (await storage.get(UPDATE_COORDINATOR_STATE_KEY)) as Record<string, unknown>
    assert.equal(persisted.failureCount, 3)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('UpdateCoordinator preserves an in-flight reservation across same-target dedupe', async () => {
  const fixture = updateMetadataFixture()
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  const hook = deferred<Response>()
  const hookStarted = deferred<void>()
  let hookCount = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = fetchInputUrl(input)
    if (url === POINTER_URL) return new Response(JSON.stringify(fixture.pointer))
    if (url === MANIFEST_URL) return new Response(JSON.stringify(fixture.manifest))
    if (url.startsWith('https://hooks.example.test/')) {
      hookCount += 1
      hookStarted.resolve()
      return hook.promise
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  try {
    const firstOperation = coordinator.fetch(updateRequest(1_000))
    await hookStarted.promise
    const dedupeState = await (await coordinator.fetch(updateRequest(1_001))).json()
    assert.equal(dedupeState.lastOutcome, 'already-triggered')
    assert.equal(hookCount, 1)

    hook.resolve(
      new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } })),
    )
    await firstOperation
    const persisted = (await storage.get(UPDATE_COORDINATOR_STATE_KEY)) as Record<string, unknown>
    assert.equal(persisted.lastBuildUuid, BUILD_UUID)
    assert.equal(persisted.triggerReservationId, undefined)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('UpdateCoordinator ignores a stale hook completion after a newer reservation finishes', async () => {
  const oldFixture = updateMetadataFixture()
  const newFixture = updateMetadataFixture({
    pointer: { productVersion: '0.3.0' },
    manifest: { productVersion: '0.3.0', runtimeVersion: '0.3.0' },
  })
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  const firstHook = deferred<Response>()
  const secondHook = deferred<Response>()
  const firstStarted = deferred<void>()
  const secondStarted = deferred<void>()
  let hookCount = 0
  let useNewTarget = false
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const url = fetchInputUrl(input)
    if (url === POINTER_URL) {
      return new Response(JSON.stringify(useNewTarget ? newFixture.pointer : oldFixture.pointer))
    }
    if (url === MANIFEST_URL) return new Response(JSON.stringify(oldFixture.manifest))
    if (url === NEW_MANIFEST_URL) return new Response(JSON.stringify(newFixture.manifest))
    if (url.startsWith('https://hooks.example.test/')) {
      hookCount += 1
      if (hookCount === 1) {
        firstStarted.resolve()
        return firstHook.promise
      }
      secondStarted.resolve()
      return secondHook.promise
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  try {
    const firstOperation = coordinator.fetch(updateRequest(1_000))
    await firstStarted.promise
    useNewTarget = true
    const secondRequestedAt = 1_001
    const secondOperation = coordinator.fetch(updateRequest(secondRequestedAt))
    await secondStarted.promise

    const newerBuildUuid = '018f22ea-7b44-7f50-a234-0123456789ab'
    secondHook.resolve(
      new Response(JSON.stringify({ success: true, result: { build_uuid: newerBuildUuid } })),
    )
    await secondOperation
    firstHook.resolve(
      new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } })),
    )
    await firstOperation

    const persisted = (await storage.get(UPDATE_COORDINATOR_STATE_KEY)) as Record<string, unknown>
    assert.equal(persisted.lastBuildUuid, newerBuildUuid)
    assert.equal(persisted.lastTargetVersion, '0.3.0')
    assert.equal(persisted.triggeredAt, secondRequestedAt)
    assert.equal(persisted.triggerReservationId, undefined)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('UpdateCoordinator cannot roll back state with delayed older metadata', async () => {
  for (const delayedRequestedAt of [1_000, 2_000]) {
    const oldFixture = updateMetadataFixture()
    const newFixture = updateMetadataFixture({
      pointer: { productVersion: '0.3.0' },
      manifest: { productVersion: '0.3.0', runtimeVersion: '0.3.0' },
    })
    const storage = new MemoryStorage()
    const coordinator = new UpdateCoordinator(new FakeState(storage), {
      ...makeEnv(),
      KUROFLARE_RELEASE_CHANNEL: 'stable',
      DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
    })
    const oldPointer = deferred<Response>()
    const oldPointerStarted = deferred<void>()
    let pointerCount = 0
    let hookCount = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input) => {
      const url = fetchInputUrl(input)
      if (url === POINTER_URL) {
        pointerCount += 1
        if (pointerCount === 1) {
          oldPointerStarted.resolve()
          return oldPointer.promise
        }
        return new Response(JSON.stringify(newFixture.pointer))
      }
      if (url === MANIFEST_URL) return new Response(JSON.stringify(oldFixture.manifest))
      if (url === NEW_MANIFEST_URL) return new Response(JSON.stringify(newFixture.manifest))
      if (url.startsWith('https://hooks.example.test/')) {
        hookCount += 1
        return new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } }))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    try {
      const delayedOperation = coordinator.fetch(updateRequest(delayedRequestedAt))
      await oldPointerStarted.promise
      await coordinator.fetch(updateRequest(2_000))
      oldPointer.resolve(new Response(JSON.stringify(oldFixture.pointer)))
      await delayedOperation

      const persisted = (await storage.get(UPDATE_COORDINATOR_STATE_KEY)) as Record<string, unknown>
      assert.equal(persisted.lastRequestedAt, 2_000)
      assert.equal(persisted.lastTargetVersion, '0.3.0')
      assert.equal(persisted.lastTriggeredVersion, '0.3.0')
      assert.equal(hookCount, 1)
    } finally {
      globalThis.fetch = previousFetch
    }
  }
})

test('UpdateCoordinator saturates retry time at the safe integer boundary', async () => {
  const fixture = updateMetadataFixture()
  const storage = new MemoryStorage()
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })

  await withUpdateFetch(fixture, new Response('failed', { status: 503 }), async () => {
    const response = await coordinator.fetch(updateRequest(Number.MAX_SAFE_INTEGER))
    const state = (await response.json()) as Record<string, unknown>
    assert.equal(state.lastOutcome, 'hook-failed')
    assert.equal(state.nextRetryAt, Number.MAX_SAFE_INTEGER)
    assert.equal(Number.isSafeInteger(state.nextRetryAt), true)
  })
})

test('UpdateCoordinator accepts only the official idempotent hook response', async () => {
  const fixture = updateMetadataFixture()
  const officialCoordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  const body = JSON.stringify({
    success: true,
    result: { build_uuid: BUILD_UUID, already_exists: true },
  })

  await withUpdateFetch(fixture, new Response(body, { status: 200 }), async () => {
    const state = await (await officialCoordinator.fetch(updateRequest(1_000))).json()
    assert.equal(state.lastOutcome, 'already-triggered')
    assert.equal(state.lastBuildUuid, BUILD_UUID)
  })

  const nonSuccessCoordinator = new UpdateCoordinator(new FakeState(new MemoryStorage()), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })
  await withUpdateFetch(fixture, new Response(body, { status: 409 }), async () => {
    const state = await (await nonSuccessCoordinator.fetch(updateRequest(1_000))).json()
    assert.equal(state.lastOutcome, 'hook-failed')
  })
})

test('UpdateCoordinator reconciles a deployed reservation before equal or lower pointer decisions', async () => {
  for (const pointerVersion of [PRODUCT_VERSION, '0.0.9']) {
    const fixture = updateMetadataFixture({
      pointer: { productVersion: pointerVersion, paused: true },
    })
    const storage = new MemoryStorage()
    await storage.put(UPDATE_COORDINATOR_STATE_KEY, {
      lastRequestedAt: 1_000,
      requestCount: 1,
      installationId: '123e4567-e89b-42d3-a456-426614174000',
      lastCheckedAt: 1_000,
      lastOutcome: 'triggered',
      lastTargetVersion: '0.3.0',
      lastTriggeredVersion: PRODUCT_VERSION,
      triggeredAt: 900,
      failureCount: 2,
      nextRetryAt: 5_000,
      triggerReservationId: '223e4567-e89b-42d3-a456-426614174000',
    })
    const coordinator = new UpdateCoordinator(new FakeState(storage), {
      ...makeEnv(),
      KUROFLARE_RELEASE_CHANNEL: 'stable',
      DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
    })
    let hookCalled = false
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input) => {
      if (fetchInputUrl(input) === POINTER_URL) {
        return new Response(JSON.stringify(fixture.pointer))
      }
      hookCalled = true
      return new Response(null, { status: 500 })
    }) as typeof fetch

    try {
      const state = await (await coordinator.fetch(updateRequest(2_000))).json()
      assert.equal(state.lastRequestedAt, 2_000)
      assert.equal(state.requestCount, 2)
      assert.equal(state.lastCheckedAt, 2_000)
      assert.equal(state.lastOutcome, 'updated')
      assert.equal(state.lastObservedRunningVersion, PRODUCT_VERSION)
      assert.equal(state.lastTriggeredVersion, PRODUCT_VERSION)
      assert.equal(state.lastTargetVersion, '0.3.0')
      assert.equal(state.failureCount, 0)
      assert.equal(state.nextRetryAt, undefined)
      assert.equal(state.triggerReservationId, undefined)
      assert.equal(hookCalled, false)
    } finally {
      globalThis.fetch = previousFetch
    }
  }
})

test('UpdateCoordinator reconciles an old trigger and still reserves a newer pointer target', async () => {
  const fixture = updateMetadataFixture()
  const storage = new MemoryStorage()
  await storage.put(UPDATE_COORDINATOR_STATE_KEY, {
    lastRequestedAt: 1_000,
    requestCount: 1,
    installationId: '123e4567-e89b-42d3-a456-426614174000',
    lastCheckedAt: 1_000,
    lastOutcome: 'triggered',
    lastTargetVersion: '0.0.9',
    lastTriggeredVersion: '0.0.9',
    triggeredAt: 900,
    failureCount: 2,
    nextRetryAt: 5_000,
    triggerReservationId: '223e4567-e89b-42d3-a456-426614174000',
  })
  const coordinator = new UpdateCoordinator(new FakeState(storage), {
    ...makeEnv(),
    KUROFLARE_RELEASE_CHANNEL: 'stable',
    DEPLOY_HOOK_URL: 'https://hooks.example.test/deploy',
  })

  await withUpdateFetch(
    fixture,
    new Response(JSON.stringify({ success: true, result: { build_uuid: BUILD_UUID } })),
    async () => {
      const state = await (await coordinator.fetch(updateRequest(2_000))).json()
      assert.equal(state.lastObservedRunningVersion, PRODUCT_VERSION)
      assert.equal(state.lastTargetVersion, '0.2.0')
      assert.equal(state.lastTriggeredVersion, '0.2.0')
      assert.equal(state.lastBuildUuid, BUILD_UUID)
      assert.equal(state.lastOutcome, 'triggered')
      assert.equal(state.failureCount, 0)
      assert.equal(state.nextRetryAt, undefined)
      assert.equal(state.triggerReservationId, undefined)
    },
  )
})
