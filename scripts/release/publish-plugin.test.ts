import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { writeChecksums } from './plugin.ts'
import {
  npmSha512Integrity,
  publishPluginRelease,
  publishRuntimeCandidate,
  promoteRuntimeStable,
  selectReleaseByTag,
} from './publish-plugin.mjs'
import { sha256, writePublicChecksums } from './worker.ts'

const RELEASE_TAG = '0.1.0'
const RELEASE_COMMIT = '0123456789abcdef0123456789abcdef01234567'
const OTHER_COMMIT = '89abcdef0123456789abcdef0123456789abcdef'
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1'
const RELEASE_ASSET_NAMES = [
  'main.js',
  'manifest.json',
  'publish-plugin.mjs',
  'versions.json',
  'SHA256SUMS',
]

type ReleaseAsset = { name: string; size: number }
type Release = {
  tag_name: string
  target_commitish: string
  draft: boolean
  immutable: boolean
  assets: ReleaseAsset[]
}

async function createAssetFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-publish-fixture-'))
  await writeFile(join(directory, 'main.js'), 'plugin bundle\n', 'utf8')
  await writeFile(join(directory, 'manifest.json'), '{"version":"0.1.0"}\n', 'utf8')
  await writeFile(join(directory, 'publish-plugin.mjs'), 'export {}\n', 'utf8')
  await writeFile(join(directory, 'versions.json'), '{"0.1.0":"1.8.0"}\n', 'utf8')
  await writeChecksums(directory)
  return directory
}

async function createWorkerAssetFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-worker-publish-fixture-'))
  await writeFile(join(directory, 'main.js'), 'plugin bundle\n', 'utf8')
  await writeFile(join(directory, 'manifest.json'), '{"version":"0.1.0"}\n', 'utf8')
  await writeFile(join(directory, 'versions.json'), '{"0.1.0":"1.8.0"}\n', 'utf8')
  await writeFile(join(directory, 'build-lock.json'), '{"lockfileVersion":3}\n', 'utf8')
  await writeFile(join(directory, 'worker-release.json'), '{"schemaVersion":1}\n', 'utf8')
  await writePublicChecksums(directory)
  return directory
}

async function readAssets(directory: string): Promise<Map<string, Buffer>> {
  const assets = new Map<string, Buffer>()
  for (const name of RELEASE_ASSET_NAMES) {
    assets.set(name, await readFile(join(directory, name)))
  }
  return assets
}

class FakeReleaseClient {
  readonly operations: string[] = []
  readonly uploads: string[] = []
  readonly downloads = new Map<string, Buffer>()
  readonly tagCommit: string
  release: Release | undefined
  postCreateVisibilityMisses = 0
  private postCreateReadsRemaining = 0

  constructor(tagCommit: string, release: Release | undefined) {
    this.tagCommit = tagCommit
    this.release = release
  }

  async assertImmutableReleasesEnabled(): Promise<void> {
    this.operations.push('check-immutable-releases')
  }

  async resolveTagCommit(): Promise<string> {
    this.operations.push('resolve-tag')
    return this.tagCommit
  }

  async getRelease(): Promise<Release | undefined> {
    this.operations.push('get-release')
    if (this.postCreateReadsRemaining > 0) {
      this.postCreateReadsRemaining -= 1
      return undefined
    }
    return this.release
  }

  async createRelease(tag: string): Promise<void> {
    this.operations.push('create-draft')
    this.postCreateReadsRemaining = this.postCreateVisibilityMisses
    this.release = {
      tag_name: tag,
      target_commitish: 'main',
      draft: true,
      immutable: false,
      assets: [],
    }
  }

  async downloadAsset(_tag: string, name: string): Promise<Buffer> {
    this.operations.push(`download:${name}`)
    const bytes = this.downloads.get(name)
    if (!bytes) {
      throw new Error(`Missing fake download ${name}`)
    }
    return bytes
  }

  async uploadAsset(_tag: string, path: string): Promise<void> {
    const name = basename(path)
    this.operations.push(`upload:${name}`)
    this.uploads.push(name)
    const bytes = await readFile(path)
    this.downloads.set(name, bytes)
    if (!this.release) {
      throw new Error('Cannot upload without a release')
    }
    this.release.assets.push({ name, size: bytes.length })
  }

  async publishRelease(): Promise<void> {
    this.operations.push('publish-draft')
    if (!this.release) {
      throw new Error('Cannot publish without a release')
    }
    this.release = { ...this.release, draft: false, immutable: true }
  }
}

function existingRelease(
  assets: Map<string, Buffer>,
  names = [...assets.keys()],
  targetCommit = RELEASE_COMMIT,
  draft = false,
  immutable = !draft,
): Release {
  return {
    tag_name: RELEASE_TAG,
    target_commitish: targetCommit,
    draft,
    immutable,
    assets: names.map((name) => ({ name, size: assets.get(name)?.length ?? 0 })),
  }
}

async function publish(options: {
  assetDirectory: string
  client: FakeReleaseClient
  wait?: (milliseconds: number) => Promise<void>
}) {
  return publishPluginRelease({
    ...options,
    expectedCommit: RELEASE_COMMIT,
    repository: 'owner/repository',
    requireWorkerAssets: false,
    tag: RELEASE_TAG,
  })
}

test('first publish creates a draft, uploads every asset, verifies, then publishes', async () => {
  const directory = await createAssetFixture()
  try {
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    const result = await publish({ assetDirectory: directory, client })
    assert.deepEqual(client.uploads, RELEASE_ASSET_NAMES)
    assert.deepEqual(client.operations.slice(0, 5), [
      'check-immutable-releases',
      'resolve-tag',
      'get-release',
      'create-draft',
      'get-release',
    ])
    assert.ok(client.operations.includes('publish-draft'))
    assert.equal(client.operations.at(-1), 'download:SHA256SUMS')
    assert.equal(client.release?.draft, false)
    assert.equal(client.release?.immutable, true)
    assert.deepEqual(result, {
      created: true,
      matchedAssets: 0,
      uploadedAssets: RELEASE_ASSET_NAMES,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('first publish retries draft discovery when creation visibility lags', async () => {
  const directory = await createAssetFixture()
  try {
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    client.postCreateVisibilityMisses = 2
    const waits: number[] = []
    await publish({
      assetDirectory: directory,
      client,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    })
    assert.deepEqual(waits, [250, 250])
    assert.equal(client.release?.immutable, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release discovery selects an exact tag across paginated list results', () => {
  const release = { tag_name: RELEASE_TAG, draft: true }
  assert.equal(selectReleaseByTag([[{ tag_name: '0.0.9' }]], RELEASE_TAG), undefined)
  assert.equal(
    selectReleaseByTag([[{ tag_name: '0.0.9' }], [release, { tag_name: '0.1.1' }]], RELEASE_TAG),
    release,
  )
})

test('duplicate release discovery fails before create or upload', async () => {
  const directory = await createAssetFixture()
  try {
    const release = { tag_name: RELEASE_TAG, draft: true }
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    client.getRelease = async () => {
      client.operations.push('get-release')
      return selectReleaseByTag([[release], [release]], RELEASE_TAG)
    }
    await assert.rejects(
      () => publish({ assetDirectory: directory, client }),
      /multiple matching releases/,
    )
    assert.deepEqual(client.operations, ['check-immutable-releases', 'resolve-tag', 'get-release'])
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release discovery rejects malformed list results', () => {
  const release = { tag_name: RELEASE_TAG, draft: true }
  assert.throws(() => selectReleaseByTag([release], RELEASE_TAG), /page must be an array/)
  assert.throws(() => selectReleaseByTag([[null]], RELEASE_TAG), /entry must be an object/)
})

test('release publishing fails before mutation when immutable releases are disabled', async () => {
  const directory = await createAssetFixture()
  try {
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    client.assertImmutableReleasesEnabled = async () => {
      client.operations.push('check-immutable-releases')
      throw new Error('GitHub immutable releases are not enabled')
    }
    await assert.rejects(
      () => publish({ assetDirectory: directory, client }),
      /immutable releases are not enabled/,
    )
    assert.deepEqual(client.operations, ['check-immutable-releases'])
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('production publish uploads only the public worker release set', async () => {
  const directory = await createWorkerAssetFixture()
  try {
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    const result = await publishPluginRelease({
      assetDirectory: directory,
      expectedCommit: RELEASE_COMMIT,
      repository: 'owner/repository',
      tag: RELEASE_TAG,
      client,
    })
    assert.deepEqual(client.uploads, [
      'build-lock.json',
      'main.js',
      'manifest.json',
      'versions.json',
      'worker-release.json',
      'SHA256SUMS',
    ])
    assert.deepEqual(result.uploadedAssets, client.uploads)
    assert.equal(client.release?.immutable, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('production publish rejects a missing worker asset', async () => {
  const directory = await createWorkerAssetFixture()
  try {
    await rm(join(directory, 'worker-release.json'))
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    await assert.rejects(
      () =>
        publishPluginRelease({
          assetDirectory: directory,
          expectedCommit: RELEASE_COMMIT,
          repository: 'owner/repository',
          tag: RELEASE_TAG,
          client,
        }),
      /ENOENT|worker-release\.json/,
    )
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('production publish rejects internal inputs listed in public checksums', async () => {
  const directory = await createWorkerAssetFixture()
  try {
    await writeFile(
      join(directory, 'SHA256SUMS'),
      `${await readFile(join(directory, 'SHA256SUMS'), 'utf8')}${'a'.repeat(64)}  worker.ts\n`,
      'utf8',
    )
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    await assert.rejects(
      () =>
        publishPluginRelease({
          assetDirectory: directory,
          expectedCommit: RELEASE_COMMIT,
          repository: 'owner/repository',
          tag: RELEASE_TAG,
          client,
        }),
      /Unexpected release asset|entries must be sorted/,
    )
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('production publish rejects publisher tool listed in public checksums', async () => {
  const directory = await createWorkerAssetFixture()
  try {
    const publisher = 'export {}\n'
    await writeFile(join(directory, 'publish-plugin.mjs'), publisher, 'utf8')
    const lines = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n')
    lines.splice(3, 0, `${sha256(Buffer.from(publisher))}  publish-plugin.mjs`)
    await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
    const client = new FakeReleaseClient(RELEASE_COMMIT, undefined)
    await assert.rejects(
      () =>
        publishPluginRelease({
          assetDirectory: directory,
          expectedCommit: RELEASE_COMMIT,
          repository: 'owner/repository',
          tag: RELEASE_TAG,
          client,
        }),
      /internal input|entries must be sorted/,
    )
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retrying a draft verifies existing assets, uploads only missing assets, then publishes', async () => {
  const directory = await createAssetFixture()
  try {
    const assets = await readAssets(directory)
    const existingNames = ['main.js', 'manifest.json', 'publish-plugin.mjs', 'SHA256SUMS']
    const client = new FakeReleaseClient(
      RELEASE_COMMIT,
      existingRelease(assets, existingNames, RELEASE_COMMIT, true, false),
    )
    for (const name of existingNames) {
      const bytes = assets.get(name)
      assert.ok(bytes)
      client.downloads.set(name, bytes)
    }
    const result = await publish({ assetDirectory: directory, client })
    assert.deepEqual(client.uploads, ['versions.json'])
    assert.ok(client.operations.includes('publish-draft'))
    assert.deepEqual(result.uploadedAssets, ['versions.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('published immutable release with exact assets and branch target is a no-op', async () => {
  const directory = await createAssetFixture()
  try {
    const assets = await readAssets(directory)
    const client = new FakeReleaseClient(
      RELEASE_COMMIT,
      existingRelease(assets, [...assets.keys()], 'main', false, true),
    )
    for (const [name, bytes] of assets) {
      client.downloads.set(name, bytes)
    }
    const result = await publish({ assetDirectory: directory, client })
    assert.deepEqual(client.uploads, [])
    assert.ok(!client.operations.includes('publish-draft'))
    assert.equal(result.matchedAssets, RELEASE_ASSET_NAMES.length)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('published mutable release is rejected before mutation', async () => {
  const directory = await createAssetFixture()
  try {
    const assets = await readAssets(directory)
    const client = new FakeReleaseClient(
      RELEASE_COMMIT,
      existingRelease(assets, [...assets.keys()], RELEASE_COMMIT, false, false),
    )
    await assert.rejects(() => publish({ assetDirectory: directory, client }), /must be immutable/)
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('extra release asset is rejected before any upload', async () => {
  const directory = await createAssetFixture()
  try {
    const assets = await readAssets(directory)
    const client = new FakeReleaseClient(
      RELEASE_COMMIT,
      existingRelease(assets, [...assets.keys(), 'stale.bin'], RELEASE_COMMIT, true, false),
    )
    await assert.rejects(
      () => publish({ assetDirectory: directory, client }),
      /Unexpected release asset/,
    )
    assert.deepEqual(client.uploads, [])
    assert.ok(!client.operations.some((operation) => operation.startsWith('download:')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('partial published release is rejected without mutation', async () => {
  const directory = await createAssetFixture()
  try {
    const assets = await readAssets(directory)
    const existingNames = ['main.js', 'manifest.json', 'publish-plugin.mjs', 'SHA256SUMS']
    const client = new FakeReleaseClient(
      RELEASE_COMMIT,
      existingRelease(assets, existingNames, RELEASE_COMMIT, false, true),
    )
    for (const name of existingNames) {
      const bytes = assets.get(name)
      assert.ok(bytes)
      client.downloads.set(name, bytes)
    }
    await assert.rejects(() => publish({ assetDirectory: directory, client }), /missing asset/)
    assert.deepEqual(client.uploads, [])
    assert.ok(!client.operations.includes('publish-draft'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('draft retry rejects changed remote bytes before uploading missing assets', async () => {
  const directory = await createAssetFixture()
  try {
    const assets = await readAssets(directory)
    const existingNames = ['main.js', 'manifest.json', 'publish-plugin.mjs', 'SHA256SUMS']
    const client = new FakeReleaseClient(
      RELEASE_COMMIT,
      existingRelease(assets, existingNames, RELEASE_COMMIT, true, false),
    )
    for (const name of existingNames) {
      const bytes = assets.get(name)
      assert.ok(bytes)
      client.downloads.set(name, bytes)
    }
    client.downloads.set('main.js', Buffer.from('changed bytes\n'))

    await assert.rejects(
      () => publish({ assetDirectory: directory, client }),
      /Immutable release asset violation/,
    )
    assert.deepEqual(client.uploads, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('publish rejects a moved tag and invalid release state', async () => {
  const directory = await createAssetFixture()
  try {
    const movedTagClient = new FakeReleaseClient(OTHER_COMMIT, undefined)
    await assert.rejects(
      () => publish({ assetDirectory: directory, client: movedTagClient }),
      /Git tag moved after build/,
    )

    const assets = await readAssets(directory)
    const invalidStateClient = new FakeReleaseClient(RELEASE_COMMIT, {
      ...existingRelease(assets, [], RELEASE_COMMIT, true, true),
    })
    await assert.rejects(
      () => publish({ assetDirectory: directory, client: invalidStateClient }),
      /both draft and immutable/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('runtime candidate publish is idempotent only for exact integrity and provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-runtime-publish-fixture-'))
  const tarballPath = join(directory, 'worker-runtime.tgz')
  const bytes = Buffer.from('runtime tarball\n')
  await writeFile(tarballPath, bytes)
  const integrity = npmSha512Integrity(bytes)
  try {
    const operations: string[][] = []
    const matched = await publishRuntimeCandidate({
      tag: RELEASE_TAG,
      tarballPath,
      runNpm: async (args: string[]) => {
        operations.push(args)
        if (args.includes('dist.attestations.provenance.predicateType')) {
          return JSON.stringify(SLSA_PROVENANCE_V1)
        }
        return JSON.stringify(integrity)
      },
    })
    assert.deepEqual(matched, { published: false, integrity })
    assert.equal(operations.length, 2)

    await assert.rejects(
      () =>
        publishRuntimeCandidate({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) =>
            JSON.stringify(
              args.includes('dist.attestations.provenance.predicateType') ? null : integrity,
            ),
        }),
      /provenance predicateType/,
    )

    await assert.rejects(
      () =>
        publishRuntimeCandidate({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async () => JSON.stringify(`${integrity}x`),
        }),
      /different tarball integrity/,
    )

    const publishOperations: string[][] = []
    let viewCount = 0
    const published = await publishRuntimeCandidate({
      tag: RELEASE_TAG,
      tarballPath,
      runNpm: async (args: string[]) => {
        publishOperations.push(args)
        if (args.includes('dist-tags.release-candidate')) return JSON.stringify(RELEASE_TAG)
        if (args.includes('dist.attestations.provenance.predicateType')) {
          return JSON.stringify(SLSA_PROVENANCE_V1)
        }
        if (args[0] === 'view') {
          viewCount += 1
          if (viewCount > 1) return JSON.stringify(integrity)
          const error = Object.assign(new Error('not found'), { stderr: 'E404' })
          throw error
        }
        return ''
      },
    })
    assert.deepEqual(published, { published: true, integrity })
    assert.equal(publishOperations[1]?.[0], 'publish')
    assert.ok(publishOperations[1]?.includes('release-candidate'))
    assert.ok(!publishOperations[1]?.includes('stable'))
    assert.equal(publishOperations[2]?.[0], 'view')
    assert.ok(publishOperations[3]?.includes('dist-tags.release-candidate'))
    assert.ok(publishOperations[4]?.includes('dist.attestations.provenance.predicateType'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('release workflow forwards direct script arguments to pnpm', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/release-plugin.yml', import.meta.url),
    'utf8',
  )
  assert.ok(!/pnpm release:[^\n]+ -- --/.test(workflow))
  for (const invocation of [
    'pnpm release:plugin:validate --tag "$RELEASE_TAG"',
    'pnpm release:plugin:stage --tag "$RELEASE_TAG" --staging-dir "$staging_dir"',
    'pnpm release:worker:stage --staging-dir "$staging_dir" --runtime-tarball "$runtime_tarball" --tag "$RELEASE_TAG"',
    'pnpm release:worker:checksum --staging-dir "$staging_dir"',
  ]) {
    assert.ok(workflow.includes(invocation), `missing workflow invocation: ${invocation}`)
  }
})

test('stable/latest promotion verifies the exact candidate and retries partial completion without republishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-runtime-promote-fixture-'))
  const tarballPath = join(directory, 'worker-runtime.tgz')
  const bytes = Buffer.from('runtime tarball\n')
  await writeFile(tarballPath, bytes)
  const integrity = npmSha512Integrity(bytes)
  try {
    const operations: string[][] = []
    const distTags = new Map<string, string | undefined>([
      ['stable', undefined],
      ['latest', '0.0.0'],
    ])
    const promoted = await promoteRuntimeStable({
      tag: RELEASE_TAG,
      tarballPath,
      runNpm: async (args: string[]) => {
        operations.push(args)
        if (args.includes('dist.attestations.provenance.predicateType')) {
          return JSON.stringify(SLSA_PROVENANCE_V1)
        }
        if (args[0] === 'view' && args[2]?.startsWith('dist-tags.')) {
          const distTag = args[2].slice('dist-tags.'.length)
          const version = distTags.get(distTag)
          return version === undefined ? '' : JSON.stringify(version)
        }
        if (args[0] === 'dist-tag') {
          distTags.set(args[3], RELEASE_TAG)
          return ''
        }
        return JSON.stringify(integrity)
      },
    })
    assert.deepEqual(promoted, { promoted: true, integrity })
    assert.deepEqual(
      operations.filter((args) => args[0] === 'dist-tag').map((args) => args[3]),
      ['stable', 'latest'],
    )

    const retryOperations: string[][] = []
    const retried = await promoteRuntimeStable({
      tag: RELEASE_TAG,
      tarballPath,
      runNpm: async (args: string[]) => {
        retryOperations.push(args)
        if (args.includes('dist.attestations.provenance.predicateType')) {
          return JSON.stringify(SLSA_PROVENANCE_V1)
        }
        if (args[0] === 'view' && args[2]?.startsWith('dist-tags.')) {
          return JSON.stringify(RELEASE_TAG)
        }
        return JSON.stringify(integrity)
      },
    })
    assert.deepEqual(retried, { promoted: false, integrity })
    assert.equal(retryOperations.length, 6)
    assert.ok(retryOperations.every((args) => args[0] !== 'publish' && args[0] !== 'dist-tag'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stable/latest promotion resumes when the stable tag moved before latest failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-runtime-promote-partial-fixture-'))
  const tarballPath = join(directory, 'worker-runtime.tgz')
  const bytes = Buffer.from('runtime tarball\n')
  await writeFile(tarballPath, bytes)
  const integrity = npmSha512Integrity(bytes)
  try {
    const distTags = new Map<string, string | undefined>([
      ['stable', undefined],
      ['latest', '0.0.0'],
    ])
    let failLatest = true
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            if (args.includes('dist.attestations.provenance.predicateType')) {
              return JSON.stringify(SLSA_PROVENANCE_V1)
            }
            if (args[0] === 'view' && args[2]?.startsWith('dist-tags.')) {
              const version = distTags.get(args[2].slice('dist-tags.'.length))
              return version === undefined ? '' : JSON.stringify(version)
            }
            if (args[0] === 'dist-tag') {
              if (args[3] === 'latest' && failLatest) {
                failLatest = false
                throw new Error('temporary registry failure')
              }
              distTags.set(args[3], RELEASE_TAG)
              return ''
            }
            return JSON.stringify(integrity)
          },
        }),
      /Cannot promote the npm runtime latest dist-tag/,
    )
    assert.equal(distTags.get('stable'), RELEASE_TAG)
    assert.equal(distTags.get('latest'), '0.0.0')

    const retryOperations: string[][] = []
    const retried = await promoteRuntimeStable({
      tag: RELEASE_TAG,
      tarballPath,
      runNpm: async (args: string[]) => {
        retryOperations.push(args)
        if (args.includes('dist.attestations.provenance.predicateType')) {
          return JSON.stringify(SLSA_PROVENANCE_V1)
        }
        if (args[0] === 'view' && args[2]?.startsWith('dist-tags.')) {
          const version = distTags.get(args[2].slice('dist-tags.'.length))
          return version === undefined ? '' : JSON.stringify(version)
        }
        if (args[0] === 'dist-tag') {
          distTags.set(args[3], RELEASE_TAG)
          return ''
        }
        return JSON.stringify(integrity)
      },
    })
    assert.deepEqual(retried, { promoted: true, integrity })
    assert.deepEqual(
      retryOperations.filter((args) => args[0] === 'dist-tag').map((args) => args[3]),
      ['latest'],
    )
    assert.equal(distTags.get('stable'), RELEASE_TAG)
    assert.equal(distTags.get('latest'), RELEASE_TAG)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stable/latest promotion rejects a concurrent rollback before overwriting the tag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-runtime-promote-race-fixture-'))
  const tarballPath = join(directory, 'worker-runtime.tgz')
  const bytes = Buffer.from('runtime tarball\n')
  await writeFile(tarballPath, bytes)
  const integrity = npmSha512Integrity(bytes)
  try {
    const operations: string[][] = []
    let stableReadCount = 0
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            operations.push(args)
            if (args.includes('dist.attestations.provenance.predicateType')) {
              return JSON.stringify(SLSA_PROVENANCE_V1)
            }
            if (args.includes('dist-tags.stable')) {
              stableReadCount += 1
              return stableReadCount === 1 ? '' : JSON.stringify('0.2.0')
            }
            if (args.includes('dist-tags.latest')) return JSON.stringify(RELEASE_TAG)
            return JSON.stringify(integrity)
          },
        }),
      /npm stable dist-tag cannot move backward from 0\.2\.0 to 0\.1\.0/,
    )
    assert.ok(operations.every((args) => args[0] !== 'dist-tag'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stable/latest promotion verifies both tags after all mutations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-runtime-promote-final-fixture-'))
  const tarballPath = join(directory, 'worker-runtime.tgz')
  const bytes = Buffer.from('runtime tarball\n')
  await writeFile(tarballPath, bytes)
  const integrity = npmSha512Integrity(bytes)
  try {
    const distTags = new Map<string, string | undefined>([
      ['stable', undefined],
      ['latest', '0.0.0'],
    ])
    let latestReadCount = 0
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            if (args.includes('dist.attestations.provenance.predicateType')) {
              return JSON.stringify(SLSA_PROVENANCE_V1)
            }
            if (args[0] === 'view' && args[2]?.startsWith('dist-tags.')) {
              const distTag = args[2].slice('dist-tags.'.length)
              latestReadCount += distTag === 'latest' ? 1 : 0
              if (distTag === 'latest' && latestReadCount === 3) {
                distTags.set('stable', '0.0.0')
              }
              const version = distTags.get(distTag)
              return version === undefined ? '' : JSON.stringify(version)
            }
            if (args[0] === 'dist-tag') {
              distTags.set(args[3], RELEASE_TAG)
              return ''
            }
            return JSON.stringify(integrity)
          },
        }),
      /npm stable dist-tag must point to 0\.1\.0, got 0\.0\.0/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stable promotion rejects missing, changed, or rollback runtime states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-runtime-reject-fixture-'))
  const tarballPath = join(directory, 'worker-runtime.tgz')
  const bytes = Buffer.from('runtime tarball\n')
  await writeFile(tarballPath, bytes)
  const integrity = npmSha512Integrity(bytes)
  try {
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async () => {
            const error = Object.assign(new Error('not found'), { stderr: 'E404' })
            throw error
          },
        }),
      /must exist before stable promotion/,
    )
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async () => JSON.stringify(`${integrity}x`),
        }),
      /different tarball integrity/,
    )
    const provenanceOperations: string[][] = []
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            provenanceOperations.push(args)
            return JSON.stringify(
              args.includes('dist.attestations.provenance.predicateType') ? null : integrity,
            )
          },
        }),
      /provenance predicateType/,
    )
    assert.ok(provenanceOperations.every((args) => args[0] !== 'dist-tag'))
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            if (args.includes('dist.attestations.provenance.predicateType')) {
              return JSON.stringify(SLSA_PROVENANCE_V1)
            }
            return JSON.stringify(args.includes('dist-tags.stable') ? '0.2.0' : integrity)
          },
        }),
      /cannot move backward from 0\.2\.0 to 0\.1\.0/,
    )
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            if (args.includes('dist.attestations.provenance.predicateType')) {
              return JSON.stringify(SLSA_PROVENANCE_V1)
            }
            if (args.includes('dist-tags.latest')) return JSON.stringify('next')
            if (args.includes('dist-tags.stable')) return JSON.stringify(RELEASE_TAG)
            return JSON.stringify(integrity)
          },
        }),
      /npm latest dist-tag must be a stable x\.y\.z version, got next/,
    )
    await assert.rejects(
      () =>
        promoteRuntimeStable({
          tag: RELEASE_TAG,
          tarballPath,
          runNpm: async (args: string[]) => {
            if (args.includes('dist.attestations.provenance.predicateType')) {
              return JSON.stringify(SLSA_PROVENANCE_V1)
            }
            if (args.includes('dist-tags.latest')) return JSON.stringify('0.2.0')
            if (args.includes('dist-tags.stable')) return JSON.stringify(RELEASE_TAG)
            return JSON.stringify(integrity)
          },
        }),
      /npm latest dist-tag cannot move backward from 0\.2\.0 to 0\.1\.0/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
