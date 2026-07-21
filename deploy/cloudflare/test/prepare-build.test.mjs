import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CHANNEL_POINTER_BASE_URL,
  MAX_POINTER_BYTES,
  MINIMUM_WRANGLER_VERSION,
  RELEASE_ASSET_HOST,
  RELEASE_BASE_URL,
  prepareBuild,
} from '../scripts/prepare-build.mjs'

const PRODUCT_VERSION = '0.1.0'
const BUILD_COMMIT = '0123456789abcdef0123456789abcdef01234567'
const RUNTIME_INTEGRITY = `sha512-${'A'.repeat(86)}==`
const WRANGLER_INTEGRITY = `sha512-${'B'.repeat(85)}A==`
const RUNTIME_BUNDLE = Buffer.from('runtime bundle fixture\n')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function makeLock(wranglerVersion = '4.105.0') {
  return {
    name: 'kuroflare-worker-build',
    version: PRODUCT_VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'kuroflare-worker-build',
        version: PRODUCT_VERSION,
        dependencies: {
          '@kuroflare/worker-runtime': PRODUCT_VERSION,
          wrangler: wranglerVersion,
        },
      },
      'node_modules/@kuroflare/worker-runtime': {
        version: PRODUCT_VERSION,
        resolved: 'https://registry.npmjs.org/@kuroflare/worker-runtime/-/worker-runtime-0.1.0.tgz',
        integrity: RUNTIME_INTEGRITY,
      },
      'node_modules/wrangler': {
        version: wranglerVersion,
        resolved: `https://registry.npmjs.org/wrangler/-/wrangler-${wranglerVersion}.tgz`,
        integrity: WRANGLER_INTEGRITY,
      },
    },
  }
}

function makeFixture(overrides = {}) {
  const wranglerVersion = overrides.manifest?.wranglerVersion ?? '4.105.0'
  const lock = makeLock(wranglerVersion)
  overrides.mutateLock?.(lock)
  const lockText = json(lock)
  const lockBytes = Buffer.from(lockText)
  const manifest = {
    schemaVersion: 1,
    bootstrapProtocolVersion: 1,
    requiredTemplateProtocolVersion: 1,
    productVersion: PRODUCT_VERSION,
    runtimeVersion: PRODUCT_VERSION,
    runtimeIntegrity: RUNTIME_INTEGRITY,
    runtimeBundleSha256: sha256(RUNTIME_BUNDLE),
    wranglerVersion,
    wranglerIntegrity: WRANGLER_INTEGRITY,
    buildLockSha256: sha256(lockBytes),
    protocolVersion: 1,
    minimumProtocolVersion: 1,
    minimumPluginVersion: PRODUCT_VERSION,
    automaticUpdate: true,
    rolloutSalt: `${PRODUCT_VERSION}-fixture`,
    buildCommit: BUILD_COMMIT,
    publishedAt: '2026-07-21T12:00:00Z',
    ...overrides.manifest,
  }
  const pointer = {
    schemaVersion: 1,
    channel: 'stable',
    productVersion: PRODUCT_VERSION,
    rolloutPercentage: 100,
    blockedSourceVersions: [],
    paused: false,
    updatedAt: '2026-07-21T12:00:00Z',
    ...overrides.pointer,
  }
  return { lockBytes, manifest, pointer }
}

async function createRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), 'kuroflare-template-'))
  await mkdir(join(rootDir, 'src'), { recursive: true })
  await writeFile(
    join(rootDir, 'package.json'),
    json({ name: 'kuroflare-cloudflare-template', templateProtocolVersion: 1 }),
  )
  await writeFile(
    join(rootDir, 'src/index.ts'),
    "export { default } from '../.kuroflare-build/index.mjs'\n",
  )
  await writeFile(
    join(rootDir, 'wrangler.json'),
    json({
      $schema: 'node_modules/wrangler/config-schema.json',
      name: 'fixture-worker',
      main: 'src/index.ts',
      compatibility_date: '2026-06-12',
      durable_objects: { bindings: [{ name: 'VAULT_ROOM', class_name: 'VaultRoom' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['VaultRoom', 'UpdateCoordinator'] }],
      r2_buckets: [{ binding: 'SNAPSHOT_BUCKET', bucket_name: 'fixture' }],
      triggers: { crons: ['17 */6 * * *'] },
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      vars: { KEEP_ME: 'unchanged', KUROFLARE_RELEASE_CHANNEL: 'stable' },
      secrets: { required: ['DEVICE_TOKEN_SECRET', 'ADMIN_TOKEN_SECRET'] },
    }),
  )
  return rootDir
}

test('rejects template protocol drift before requesting release metadata', async () => {
  const rootDir = await createRoot()
  try {
    await writeFile(
      join(rootDir, 'package.json'),
      json({ name: 'kuroflare-cloudflare-template', templateProtocolVersion: 2 }),
    )
    let requested = false
    await assert.rejects(
      () =>
        prepareBuild({
          rootDir,
          fetchImpl: async () => {
            requested = true
            throw new Error('unexpected request')
          },
        }),
      /templateProtocolVersion must be 1/,
    )
    assert.equal(requested, false)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

function makeFetchFixture(fixture, channel = 'stable') {
  const releaseBase = `${RELEASE_BASE_URL}/${PRODUCT_VERSION}`
  const responses = new Map([
    [`${CHANNEL_POINTER_BASE_URL}/${channel}.json`, new Response(json(fixture.pointer))],
    [`${releaseBase}/worker-release.json`, new Response(json(fixture.manifest))],
    [`${releaseBase}/build-lock.json`, new Response(fixture.lockBytes)],
  ])
  const requests = []
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      const response = responses.get(url)
      if (response === undefined) throw new Error(`unexpected URL: ${url}`)
      return response
    },
  }
}

async function installRuntimeFixture(_file, _args, options) {
  const bundlePath = join(options.cwd, 'node_modules/@kuroflare/worker-runtime/dist')
  await mkdir(bundlePath, { recursive: true })
  await writeFile(join(bundlePath, 'index.mjs'), RUNTIME_BUNDLE)
}

test('prepares a verified build atomically and keeps source files unchanged', async () => {
  const rootDir = await createRoot()
  try {
    const fixture = makeFixture()
    const network = makeFetchFixture(fixture)
    const oldBuild = join(rootDir, '.kuroflare-build')
    await mkdir(oldBuild)
    await writeFile(join(oldBuild, 'old.txt'), 'old build')
    const sourceBefore = await readFile(join(rootDir, 'src/index.ts'), 'utf8')
    const npmCalls = []
    const result = await prepareBuild({
      rootDir,
      env: { KUROFLARE_UPDATE_CHANNEL: 'stable' },
      fetchImpl: network.fetchImpl,
      execFileImpl: async (file, args, options) => {
        npmCalls.push({ file, args, cwd: options.cwd })
        await installRuntimeFixture(file, args, options)
      },
    })
    assert.equal(result.productVersion, PRODUCT_VERSION)
    assert.deepEqual(npmCalls[0]?.args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    assert.equal(
      await readFile(join(oldBuild, 'index.mjs'), 'utf8'),
      "export { default, UpdateCoordinator, VaultRoom } from '@kuroflare/worker-runtime'\n",
    )
    await assert.rejects(() => readFile(join(oldBuild, 'old.txt'), 'utf8'))
    const generatedConfig = JSON.parse(
      await readFile(join(oldBuild, 'wrangler.generated.json'), 'utf8'),
    )
    assert.equal(generatedConfig.main, '../src/index.ts')
    assert.equal(generatedConfig.vars.KEEP_ME, 'unchanged')
    assert.equal(generatedConfig.vars.KUROFLARE_RELEASE_CHANNEL, 'stable')
    assert.equal(generatedConfig.vars.KUROFLARE_BUILD_COMMIT, BUILD_COMMIT)
    assert.equal(generatedConfig.durable_objects.bindings[0].class_name, 'VaultRoom')
    assert.deepEqual(
      network.requests.map((request) => request.url),
      [
        `${CHANNEL_POINTER_BASE_URL}/stable.json`,
        `${RELEASE_BASE_URL}/${PRODUCT_VERSION}/worker-release.json`,
        `${RELEASE_BASE_URL}/${PRODUCT_VERSION}/build-lock.json`,
      ],
    )
    assert.equal(network.requests[0]?.options.redirect, 'error')
    assert.ok(network.requests.slice(1).every((request) => request.options.redirect === 'manual'))
    assert.equal(await readFile(join(rootDir, 'src/index.ts'), 'utf8'), sourceBefore)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('accepts one allowlisted GitHub release asset redirect for each immutable asset', async () => {
  const rootDir = await createRoot()
  try {
    const fixture = makeFixture()
    const manifestAsset = `https://${RELEASE_ASSET_HOST}/github-production-release-asset/123/abcdef01-2345?token=manifest`
    const lockAsset = `https://${RELEASE_ASSET_HOST}/github-production-release-asset/123/abcdef01-6789?token=lock`
    const releaseBase = `${RELEASE_BASE_URL}/${PRODUCT_VERSION}`
    const responses = new Map([
      [`${CHANNEL_POINTER_BASE_URL}/stable.json`, () => new Response(json(fixture.pointer))],
      [
        `${releaseBase}/worker-release.json`,
        () => new Response(null, { status: 302, headers: { location: manifestAsset } }),
      ],
      [manifestAsset, () => new Response(json(fixture.manifest))],
      [
        `${releaseBase}/build-lock.json`,
        () => new Response(null, { status: 302, headers: { location: lockAsset } }),
      ],
      [lockAsset, () => new Response(fixture.lockBytes)],
    ])
    const requests = []
    await prepareBuild({
      rootDir,
      fetchImpl: async (url, options) => {
        if (typeof url !== 'string') throw new Error('unexpected non-string URL')
        requests.push({ url, options })
        const response = responses.get(url)
        if (response === undefined) throw new Error(`unexpected URL: ${url}`)
        return response()
      },
      execFileImpl: installRuntimeFixture,
    })
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        `${CHANNEL_POINTER_BASE_URL}/stable.json`,
        `${releaseBase}/worker-release.json`,
        manifestAsset,
        `${releaseBase}/build-lock.json`,
        lockAsset,
      ],
    )
    assert.equal(requests[0]?.options.redirect, 'error')
    assert.ok(requests.slice(1).every((request) => request.options.redirect === 'manual'))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('rejects unsafe and repeated release asset redirects', async () => {
  const redirectCases = [
    {
      name: 'attacker',
      location: 'https://attacker.invalid/github-production-release-asset/123/abcdef',
      expected: /must target release-assets/,
    },
    {
      name: 'credentials',
      location:
        'https://user@release-assets.githubusercontent.com/github-production-release-asset/123/abcdef',
      expected: /must target release-assets/,
    },
    {
      name: 'port',
      location:
        'https://release-assets.githubusercontent.com:444/github-production-release-asset/123/abcdef',
      expected: /must target release-assets/,
    },
    {
      name: 'unexpected path',
      location: 'https://release-assets.githubusercontent.com/unexpected/123/abcdef',
      expected: /invalid destination/,
    },
    {
      name: 'second',
      location: undefined,
      expected: /second redirect/,
    },
  ]
  for (const redirectCase of redirectCases) {
    const rootDir = await createRoot()
    try {
      const fixture = makeFixture()
      const releaseBase = `${RELEASE_BASE_URL}/${PRODUCT_VERSION}`
      const allowedAsset = `https://${RELEASE_ASSET_HOST}/github-production-release-asset/123/abcdef01-2345`
      const fetchImpl = async (url) => {
        if (url === `${CHANNEL_POINTER_BASE_URL}/stable.json`) {
          return new Response(json(fixture.pointer))
        }
        if (url === `${releaseBase}/worker-release.json`) {
          const location = redirectCase.location ?? allowedAsset
          return new Response(null, { status: 302, headers: { location } })
        }
        if (url === allowedAsset) {
          return new Response(null, { status: 302, headers: { location: `${allowedAsset}a` } })
        }
        throw new Error(`unexpected URL: ${url}`)
      }
      await assert.rejects(
        () => prepareBuild({ rootDir, fetchImpl, execFileImpl: installRuntimeFixture }),
        redirectCase.expected,
        redirectCase.name,
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
})

test('rejects paused channels, protocol mismatches, and arbitrary remote fields', async () => {
  for (const overrides of [
    { pointer: { paused: true } },
    { manifest: { requiredTemplateProtocolVersion: 2 } },
    { pointer: { releaseUrl: 'https://attacker.invalid/release.json' } },
  ]) {
    const rootDir = await createRoot()
    try {
      const fixture = makeFixture(overrides)
      const network = makeFetchFixture(fixture)
      await assert.rejects(
        () =>
          prepareBuild({
            rootDir,
            fetchImpl: network.fetchImpl,
            execFileImpl: async () => {},
          }),
        /prepare-build/,
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
})

test('rejects prerelease and build metadata in distribution product versions', async () => {
  for (const productVersion of ['0.1.0-beta.1', '0.1.0+build.1']) {
    const rootDir = await createRoot()
    try {
      const fixture = makeFixture({ pointer: { productVersion } })
      await assert.rejects(
        () =>
          prepareBuild({
            rootDir,
            fetchImpl: makeFetchFixture(fixture).fetchImpl,
            execFileImpl: installRuntimeFixture,
          }),
        /stable x\.y\.z/,
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
})

test('rejects redirects, oversized pointers, and lockfile mismatches', async () => {
  const rootDir = await createRoot()
  try {
    await assert.rejects(
      () =>
        prepareBuild({
          rootDir,
          fetchImpl: async () =>
            new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
          execFileImpl: async () => {},
        }),
      /HTTP 302/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }

  const oversizedRoot = await createRoot()
  try {
    await assert.rejects(
      () =>
        prepareBuild({
          rootDir: oversizedRoot,
          fetchImpl: async () => new Response('x'.repeat(MAX_POINTER_BYTES + 1)),
          execFileImpl: async () => {},
        }),
      /response limit/,
    )
  } finally {
    await rm(oversizedRoot, { recursive: true, force: true })
  }

  const lockRoot = await createRoot()
  try {
    const fixture = makeFixture({ manifest: { buildLockSha256: 'b'.repeat(64) } })
    const network = makeFetchFixture(fixture)
    await assert.rejects(
      () =>
        prepareBuild({
          rootDir: lockRoot,
          fetchImpl: network.fetchImpl,
          execFileImpl: async () => {},
        }),
      /SHA-256 mismatch/,
    )
  } finally {
    await rm(lockRoot, { recursive: true, force: true })
  }
})

test('failed npm installation leaves the previous build untouched', async () => {
  const rootDir = await createRoot()
  try {
    const oldBuild = join(rootDir, '.kuroflare-build')
    await mkdir(oldBuild)
    await writeFile(join(oldBuild, 'sentinel.txt'), 'keep me')
    const fixture = makeFixture()
    const network = makeFetchFixture(fixture)
    await assert.rejects(
      () =>
        prepareBuild({
          rootDir,
          fetchImpl: network.fetchImpl,
          execFileImpl: async () => {
            throw new Error('injected npm failure')
          },
        }),
      /npm ci failed.*injected npm failure/,
    )
    assert.equal(await readFile(join(oldBuild, 'sentinel.txt'), 'utf8'), 'keep me')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('rejects every unsafe non-root package-lock entry', async () => {
  const transitiveIntegrity = `sha512-${'C'.repeat(85)}A==`
  const validEntry = {
    version: '1.2.3',
    integrity: transitiveIntegrity,
    resolved: 'https://registry.npmjs.org/transitive/-/transitive-1.2.3.tgz',
  }
  const cases = [
    {
      name: 'unsafe path',
      mutateLock: (lock) => {
        lock.packages['../node_modules/transitive'] = { ...validEntry }
      },
    },
    {
      name: 'invalid version',
      entry: { ...validEntry, version: 'latest' },
    },
    {
      name: 'invalid integrity',
      entry: { ...validEntry, integrity: 'sha512-invalid' },
    },
    {
      name: 'noncanonical integrity tail bits',
      entry: { ...validEntry, integrity: `sha512-${'C'.repeat(86)}==` },
    },
    {
      name: 'arbitrary host',
      entry: { ...validEntry, resolved: 'https://attacker.invalid/transitive-1.2.3.tgz' },
    },
    {
      name: 'file dependency',
      entry: { ...validEntry, resolved: 'file:../transitive' },
    },
    {
      name: 'git dependency',
      entry: { ...validEntry, resolved: 'git+https://github.com/example/transitive.git' },
    },
    {
      name: 'link dependency',
      entry: { link: true },
    },
    {
      name: 'registry port',
      entry: {
        ...validEntry,
        resolved: 'https://registry.npmjs.org:444/transitive/-/transitive-1.2.3.tgz',
      },
    },
    {
      name: 'registry query',
      entry: {
        ...validEntry,
        resolved: 'https://registry.npmjs.org/transitive/-/transitive-1.2.3.tgz?token=x',
      },
    },
  ]
  for (const fixtureCase of cases) {
    const rootDir = await createRoot()
    try {
      const fixture = makeFixture({
        mutateLock: (lock) => {
          if (fixtureCase.mutateLock !== undefined) {
            fixtureCase.mutateLock(lock)
          } else {
            lock.packages['node_modules/transitive'] = fixtureCase.entry
          }
        },
      })
      const network = makeFetchFixture(fixture)
      await assert.rejects(
        () => prepareBuild({ rootDir, fetchImpl: network.fetchImpl, execFileImpl: async () => {} }),
        /build lockfile/,
        fixtureCase.name,
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
})

test('enforces the minimum stable Wrangler version', async () => {
  for (const version of ['4.69.9', '4.70.0-rc.1']) {
    const rootDir = await createRoot()
    try {
      const fixture = makeFixture({ manifest: { wranglerVersion: version } })
      const network = makeFetchFixture(fixture)
      await assert.rejects(
        () => prepareBuild({ rootDir, fetchImpl: network.fetchImpl, execFileImpl: async () => {} }),
        version.includes('-')
          ? /stable x\.y\.z/
          : new RegExp(`at least ${MINIMUM_WRANGLER_VERSION.replaceAll('.', '\\.')}`),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }

  const rootDir = await createRoot()
  try {
    const fixture = makeFixture({ manifest: { wranglerVersion: MINIMUM_WRANGLER_VERSION } })
    const network = makeFetchFixture(fixture)
    const result = await prepareBuild({
      rootDir,
      fetchImpl: network.fetchImpl,
      execFileImpl: installRuntimeFixture,
    })
    assert.equal(result.productVersion, PRODUCT_VERSION)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
