import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  canonicalUtcTimestamp,
  createWorkerReleaseManifest,
  generateBuildLock,
  npmSha512Integrity,
  readCompatibilityMetadata,
  validateBuildLock,
  validateChannelPointer,
  validateWorkerReleaseManifest,
  writePublicChecksums,
  writeReleaseChecksums,
} from './worker.ts'

const integrity = npmSha512Integrity(Buffer.from('package'))

function lockFixture(productVersion = '0.1.0') {
  return {
    name: 'kuroflare-worker-build',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'kuroflare-worker-build',
        version: productVersion,
        dependencies: {
          '@kuroflare/worker-runtime': productVersion,
          wrangler: '4.105.0',
        },
      },
      'node_modules/@kuroflare/worker-runtime': {
        version: productVersion,
        resolved: `https://registry.npmjs.org/@kuroflare/worker-runtime/-/worker-runtime-${productVersion}.tgz`,
        integrity,
      },
      'node_modules/wrangler': {
        version: '4.105.0',
        resolved: 'https://registry.npmjs.org/wrangler/-/wrangler-4.105.0.tgz',
        integrity,
      },
    },
  }
}

test('canonical timestamps and release manifests are deterministic', () => {
  assert.equal(canonicalUtcTimestamp('2026-07-21T03:00:00+03:00'), '2026-07-21T00:00:00.000Z')
  const input = {
    productVersion: '0.1.0',
    runtimeIntegrity: integrity,
    runtimeBundleSha256: 'a'.repeat(64),
    wranglerIntegrity: integrity,
    buildLockSha256: 'b'.repeat(64),
    buildCommit: '0'.repeat(40),
    compatibility: {
      productVersion: '0.1.0',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      minimumPluginVersion: '0.1.0',
    },
    publishedAt: '2026-07-21T00:00:00Z',
  } as const
  const first = createWorkerReleaseManifest(input)
  const second = createWorkerReleaseManifest(input)
  assert.deepEqual(first, second)
  assert.equal(first.automaticUpdate, true)
  assert.equal(first.rolloutSalt, '0.1.0-0000000000000000')
  assert.deepEqual(validateWorkerReleaseManifest(first), first)
  assert.throws(
    () => createWorkerReleaseManifest({ ...input, wranglerVersion: '4.69.9' }),
    /at least 4\.70\.0/,
  )
  assert.throws(
    () => createWorkerReleaseManifest({ ...input, wranglerVersion: '4.70.0-rc.1' }),
    /stable x\.y\.z/,
  )
  assert.throws(
    () => validateWorkerReleaseManifest({ ...first, publishedAt: '2026-07-21T00:00:00+00:00' }),
    /ISO-8601 UTC/,
  )
  assert.throws(
    () => validateWorkerReleaseManifest({ ...first, minimumPluginVersion: '0.1.0-beta.1' }),
    /stable x\.y\.z/,
  )
})

test('compatibility metadata resolves MINIMUM_PLUGIN_VERSION aliases safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-worker-version-test-'))
  try {
    const path = join(directory, 'version.ts')
    await writeFile(
      path,
      [
        'export const CURRENT_PROTOCOL_VERSION = 1',
        'export const MIN_SUPPORTED_PROTOCOL_VERSION = 1',
        "export const PRODUCT_VERSION = '0.1.0'",
        'export const MINIMUM_PLUGIN_VERSION = PRODUCT_VERSION',
      ].join('\n'),
      'utf8',
    )
    assert.deepEqual(await readCompatibilityMetadata(path), {
      productVersion: '0.1.0',
      protocolVersion: 1,
      minimumProtocolVersion: 1,
      minimumPluginVersion: '0.1.0',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('compatibility metadata rejects non-stable product compatibility versions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-worker-version-invalid-'))
  try {
    const path = join(directory, 'version.ts')
    await writeFile(
      path,
      [
        'export const CURRENT_PROTOCOL_VERSION = 1',
        'export const MIN_SUPPORTED_PROTOCOL_VERSION = 1',
        "export const PRODUCT_VERSION = '0.1.0'",
        "export const MINIMUM_PLUGIN_VERSION = '0.1.0-beta.1'",
      ].join('\n'),
      'utf8',
    )
    await assert.rejects(() => readCompatibilityMetadata(path), /stable x\.y\.z/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('build lock validation enforces exact direct dependencies and integrity', () => {
  const lock = lockFixture()
  const details = validateBuildLock(lock, { productVersion: '0.1.0', wranglerVersion: '4.105.0' })
  assert.equal(details.runtimeIntegrity, integrity)
  assert.equal(details.wranglerIntegrity, integrity)
  assert.throws(
    () =>
      validateBuildLock(
        { ...lock, packages: { ...lock.packages, '': { ...lock.packages[''], dependencies: {} } } },
        { productVersion: '0.1.0', wranglerVersion: '4.105.0' },
      ),
    /only the runtime and Wrangler/,
  )
  assert.throws(
    () =>
      validateBuildLock(
        {
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/wrangler': {
              ...lock.packages['node_modules/wrangler'],
              resolved: 'https://evil.example/wrangler.tgz',
            },
          },
        },
        { productVersion: '0.1.0', wranglerVersion: '4.105.0' },
      ),
    /safe npm tarball URL/,
  )
  assert.throws(
    () =>
      validateBuildLock(
        {
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/../escape': lock.packages['node_modules/wrangler'],
          },
        },
        { productVersion: '0.1.0', wranglerVersion: '4.105.0' },
      ),
    /path is unsafe/,
  )
})

test('package-lock-only generation uses lifecycle-free npm arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-worker-lock-test-'))
  try {
    let observedArgs: string[] = []
    const result = await generateBuildLock({
      productVersion: '0.1.0',
      runInstall: async (cwd, args) => {
        observedArgs = args
        await writeFile(
          join(cwd, 'package-lock.json'),
          `${JSON.stringify(lockFixture())}\n`,
          'utf8',
        )
      },
    })
    assert.ok(result.bytes.length > 0)
    assert.ok(observedArgs.includes('--package-lock-only'))
    assert.ok(observedArgs.includes('--ignore-scripts'))
    assert.equal(directory.length > 0, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('initial channel pointers are paused and valid', () => {
  for (const channel of ['stable', 'beta'] as const) {
    const pointer = {
      schemaVersion: 1,
      channel,
      productVersion: '0.1.0',
      rolloutPercentage: 0,
      blockedSourceVersions: [],
      paused: true,
      updatedAt: '2026-07-21T00:00:00.000Z',
    }
    assert.deepEqual(validateChannelPointer(pointer, channel), pointer)
  }
  assert.throws(
    () =>
      validateChannelPointer(
        {
          schemaVersion: 1,
          channel: 'stable',
          productVersion: '0.1.0',
          rolloutPercentage: 0,
          blockedSourceVersions: [],
          paused: true,
          updatedAt: '2026-07-21T00:00:00+00:00',
        },
        'stable',
      ),
    /ISO-8601 UTC/,
  )
  for (const productVersion of ['0.1.0-beta.1', '0.1.0+build.1']) {
    assert.throws(
      () =>
        validateChannelPointer(
          {
            schemaVersion: 1,
            channel: 'stable',
            productVersion,
            rolloutPercentage: 0,
            blockedSourceVersions: [],
            paused: true,
            updatedAt: '2026-07-21T00:00:00.000Z',
          },
          'stable',
        ),
      /stable x\.y\.z/,
    )
  }
})

test('committed channel pointer files satisfy the distribution schema', async () => {
  for (const channel of ['stable', 'beta'] as const) {
    const path = resolve(import.meta.dirname, '../../distribution/channels', `${channel}.json`)
    const pointer = JSON.parse(await readFile(path, 'utf8')) as unknown
    const parsed = validateChannelPointer(pointer, channel)
    assert.equal(parsed.paused, true)
    assert.equal(parsed.rolloutPercentage, 0)
  }
})

test('release checksums include worker inputs and generated assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-worker-checksum-test-'))
  try {
    for (const [name, value] of [
      ['main.js', 'plugin'],
      ['manifest.json', '{}'],
      ['versions.json', '{}'],
      ['publish-plugin.mjs', 'export {}'],
      ['worker-runtime.tgz', 'tarball'],
      ['worker-runtime-index.mjs', 'runtime'],
      ['core-version.ts', 'version'],
      ['worker.ts', 'generator'],
      ['build-lock.json', '{}'],
      ['worker-release.json', '{}'],
    ] as const) {
      await writeFile(join(directory, name), value, 'utf8')
    }
    const checksums = await writeReleaseChecksums(directory)
    assert.match(checksums, /worker-runtime\.tgz$/m)
    assert.match(checksums, /worker-release\.json$/m)
    const publicChecksums = await writePublicChecksums(directory)
    assert.match(publicChecksums, /worker-release\.json$/m)
    assert.doesNotMatch(publicChecksums, /worker-runtime\.tgz/)
    assert.doesNotMatch(publicChecksums, /publish-plugin\.mjs/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
