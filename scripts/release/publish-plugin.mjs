import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CHECKSUM_LINE_PATTERN = /^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$/
const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'versions.json']
const OPTIONAL_ASSETS = ['styles.css']
const BUNDLE_TOOL_FILES = ['publish-plugin.mjs']
const WORKER_RELEASE_ASSETS = ['build-lock.json', 'worker-release.json']
const CHECKSUMS_FILE = 'SHA256SUMS'
const RUNTIME_CANDIDATE_DIST_TAG = 'release-candidate'
const RUNTIME_PROMOTION_DIST_TAGS = ['stable', 'latest']
const ALLOWED_ASSETS = new Set([
  ...REQUIRED_ASSETS,
  ...OPTIONAL_ASSETS,
  ...BUNDLE_TOOL_FILES,
  ...WORKER_RELEASE_ASSETS,
  // Legacy bundles listed the publisher in SHA256SUMS; new public bundles do not.
])

class GhCommandError extends Error {
  constructor(args, error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    super(`gh ${args[0] ?? 'command'} failed${stderr ? `: ${stderr}` : ''}`)
    this.name = 'GhCommandError'
    this.stderr = stderr
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function npmSha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function npmNotFound(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  return /E404|404 Not Found|code E404/.test(stderr)
}

async function runNpm(args, options = {}) {
  const result = await execFileAsync('npm', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
  return result.stdout
}

async function readDistTag(npm, distTag, cwd) {
  let source
  try {
    source = await npm(
      [
        'view',
        '@kuroflare/worker-runtime',
        `dist-tags.${distTag}`,
        '--json',
        '--registry',
        'https://registry.npmjs.org',
      ],
      { cwd },
    )
  } catch {
    throw new Error(`Cannot verify the npm ${distTag} dist-tag`)
  }
  let value
  try {
    value = JSON.parse(source || 'null')
  } catch {
    throw new Error(`Cannot verify npm ${distTag} dist-tag`)
  }
  return value === null ? undefined : requireString(value, `npm ${distTag} dist-tag`)
}

async function assertDistTag(npm, distTag, tag, cwd) {
  const version = await readDistTag(npm, distTag, cwd)
  if (version !== tag)
    throw new Error(`npm ${distTag} dist-tag must point to ${tag}, got ${version}`)
}

async function assertRuntimeProvenance(npm, tag, cwd) {
  let source
  try {
    source = await npm(
      [
        'view',
        `@kuroflare/worker-runtime@${tag}`,
        'dist.attestations.provenance.predicateType',
        '--json',
        '--registry',
        'https://registry.npmjs.org',
      ],
      { cwd },
    )
  } catch {
    throw new Error('Cannot verify npm runtime provenance')
  }
  const predicateType = requireString(JSON.parse(source), 'npm runtime provenance predicateType')
  if (predicateType !== 'https://slsa.dev/provenance/v1') {
    throw new Error(`npm runtime provenance must use SLSA v1, got ${predicateType}`)
  }
}

async function inspectRuntimePackage(npm, tag, tarballPath) {
  const tarballBytes = await readFile(resolve(tarballPath))
  const expectedIntegrity = npmSha512Integrity(tarballBytes)
  const cwd = resolve(tarballPath, '..')
  let integrity
  try {
    const source = await npm(
      [
        'view',
        `@kuroflare/worker-runtime@${tag}`,
        'dist.integrity',
        '--json',
        '--registry',
        'https://registry.npmjs.org',
      ],
      { cwd },
    )
    integrity = requireString(JSON.parse(source), 'npm runtime dist.integrity')
  } catch (error) {
    if (!npmNotFound(error)) {
      throw new Error('Cannot inspect npm runtime package; verify registry access and credentials')
    }
  }
  if (integrity !== undefined && integrity !== expectedIntegrity) {
    throw new Error(
      `npm ${'@kuroflare/worker-runtime'}@${tag} already exists with a different tarball integrity`,
    )
  }
  return { cwd, expectedIntegrity, exists: integrity !== undefined }
}

/** Publish the runtime under a non-user candidate tag, or verify the exact existing version. */
export async function publishRuntimeCandidate(options) {
  const tag = requireString(options.tag, 'tag')
  if (!STABLE_VERSION_PATTERN.test(tag)) {
    throw new Error(`tag must be a stable x.y.z version, got ${tag}`)
  }
  const tarballPath = requireString(options.tarballPath, 'tarballPath')
  const npm = options.runNpm ?? runNpm
  const runtime = await inspectRuntimePackage(npm, tag, tarballPath)
  if (runtime.exists) {
    await assertRuntimeProvenance(npm, tag, runtime.cwd)
    return { published: false, integrity: runtime.expectedIntegrity }
  }
  try {
    await npm(
      [
        'publish',
        resolve(tarballPath),
        '--provenance',
        '--access',
        'public',
        '--tag',
        RUNTIME_CANDIDATE_DIST_TAG,
        '--registry',
        'https://registry.npmjs.org',
      ],
      { cwd: runtime.cwd },
    )
  } catch {
    throw new Error(
      'npm runtime publish failed; configure the trusted publisher/OIDC or registry authentication for this repository',
    )
  }
  try {
    const source = await npm(
      [
        'view',
        `@kuroflare/worker-runtime@${tag}`,
        'dist.integrity',
        '--json',
        '--registry',
        'https://registry.npmjs.org',
      ],
      { cwd: runtime.cwd },
    )
    const visibleIntegrity = requireString(JSON.parse(source), 'npm runtime dist.integrity')
    if (visibleIntegrity !== runtime.expectedIntegrity) {
      throw new Error('published runtime tarball integrity does not match the local tarball')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('published runtime tarball')) throw error
    throw new Error('npm runtime was published but is not visible at the expected registry version')
  }
  await assertDistTag(npm, RUNTIME_CANDIDATE_DIST_TAG, tag, runtime.cwd)
  await assertRuntimeProvenance(npm, tag, runtime.cwd)
  return { published: true, integrity: runtime.expectedIntegrity }
}

function compareStableVersions(left, right) {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

function validatePromotionVersion(distTag, currentVersion, targetVersion) {
  if (currentVersion === undefined) return
  if (!STABLE_VERSION_PATTERN.test(currentVersion)) {
    throw new Error(`npm ${distTag} dist-tag must be a stable x.y.z version, got ${currentVersion}`)
  }
  if (compareStableVersions(currentVersion, targetVersion) > 0) {
    throw new Error(
      `npm ${distTag} dist-tag cannot move backward from ${currentVersion} to ${targetVersion}`,
    )
  }
}

/** Promote an already-published exact runtime version to stable and latest without republishing it. */
export async function promoteRuntimeStable(options) {
  const tag = requireString(options.tag, 'tag')
  if (!STABLE_VERSION_PATTERN.test(tag)) {
    throw new Error(`tag must be a stable x.y.z version, got ${tag}`)
  }
  const tarballPath = requireString(options.tarballPath, 'tarballPath')
  const npm = options.runNpm ?? runNpm
  const runtime = await inspectRuntimePackage(npm, tag, tarballPath)
  if (!runtime.exists) throw new Error(`npm runtime ${tag} must exist before stable promotion`)
  await assertRuntimeProvenance(npm, tag, runtime.cwd)
  const currentVersions = new Map(
    await Promise.all(
      RUNTIME_PROMOTION_DIST_TAGS.map(async (distTag) => [
        distTag,
        await readDistTag(npm, distTag, runtime.cwd),
      ]),
    ),
  )
  for (const distTag of RUNTIME_PROMOTION_DIST_TAGS) {
    validatePromotionVersion(distTag, currentVersions.get(distTag), tag)
  }

  const pendingTags = RUNTIME_PROMOTION_DIST_TAGS.filter(
    (distTag) => currentVersions.get(distTag) !== tag,
  )
  let promoted = false
  for (const distTag of pendingTags) {
    const currentVersion = await readDistTag(npm, distTag, runtime.cwd)
    validatePromotionVersion(distTag, currentVersion, tag)
    if (currentVersion === tag) continue
    try {
      await npm(
        [
          'dist-tag',
          'add',
          `@kuroflare/worker-runtime@${tag}`,
          distTag,
          '--registry',
          'https://registry.npmjs.org',
        ],
        { cwd: runtime.cwd },
      )
    } catch {
      throw new Error(`Cannot promote the npm runtime ${distTag} dist-tag`)
    }
    await assertDistTag(npm, distTag, tag, runtime.cwd)
    promoted = true
  }
  for (const distTag of RUNTIME_PROMOTION_DIST_TAGS) {
    await assertDistTag(npm, distTag, tag, runtime.cwd)
  }
  return { promoted, integrity: runtime.expectedIntegrity }
}

async function runGh(args, options = {}) {
  try {
    const result = await execFileAsync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    })
    return result.stdout
  } catch (error) {
    throw new GhCommandError(args, error)
  }
}

async function runGhJson(args, options = {}) {
  const source = await runGh(args, options)
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(
      `gh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function isNotFound(error) {
  return error instanceof GhCommandError && /\bHTTP 404\b/.test(error.stderr)
}

export function createGhReleaseClient(repository, immutableReleaseToken) {
  const repo = requireString(repository, 'repository')
  const adminToken = requireString(immutableReleaseToken, 'immutableReleaseToken')
  return {
    async assertImmutableReleasesEnabled() {
      let setting
      try {
        setting = await runGhJson(
          [
            'api',
            `repos/${repo}/immutable-releases`,
            '-H',
            'Accept: application/vnd.github+json',
            '-H',
            'X-GitHub-Api-Version: 2026-03-10',
          ],
          {
            env: { ...process.env, GH_TOKEN: adminToken },
          },
        )
      } catch (error) {
        if (isNotFound(error)) {
          throw new Error(
            'GitHub immutable releases are not enabled; enable release immutability before publishing',
          )
        }
        throw new Error(
          'Cannot verify GitHub immutable releases; RELEASE_ADMIN_TOKEN needs repository Administration read permission',
        )
      }
      if (setting?.enabled !== true) {
        throw new Error('GitHub immutable releases are not enabled')
      }
    },

    async resolveTagCommit(tag) {
      const ref = await runGhJson(['api', `repos/${repo}/git/ref/tags/${tag}`])
      let object = ref?.object
      for (let depth = 0; depth < 8; depth += 1) {
        const type = requireString(object?.type, 'Git tag object type')
        const sha = requireString(object?.sha, 'Git tag object SHA')
        if (type === 'commit') {
          return sha
        }
        if (type !== 'tag') {
          throw new Error(`Git tag resolves to unsupported object type: ${type}`)
        }
        const annotatedTag = await runGhJson(['api', `repos/${repo}/git/tags/${sha}`])
        object = annotatedTag?.object
      }
      throw new Error('Git tag indirection exceeds the supported depth')
    },

    async getRelease(tag) {
      try {
        return await runGhJson(['api', `repos/${repo}/releases/tags/${tag}`])
      } catch (error) {
        if (isNotFound(error)) {
          return undefined
        }
        throw error
      }
    },

    async createRelease(tag, expectedCommit) {
      await runGh([
        'release',
        'create',
        tag,
        '--draft',
        '--verify-tag',
        '--target',
        expectedCommit,
        '--repo',
        repo,
        '--title',
        `Kuroflare ${tag}`,
        '--generate-notes',
      ])
    },

    async publishRelease(tag) {
      await runGh(['release', 'edit', tag, '--draft=false', '--repo', repo])
    },

    async downloadAsset(tag, name) {
      const directory = await mkdtemp(join(tmpdir(), 'kuroflare-release-download-'))
      try {
        await runGh([
          'release',
          'download',
          tag,
          '--repo',
          repo,
          '--pattern',
          name,
          '--dir',
          directory,
        ])
        return await readFile(join(directory, name))
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },

    async uploadAsset(tag, path) {
      await runGh(['release', 'upload', tag, path, '--repo', repo])
    },
  }
}

async function loadLocalAssets(assetDirectory, requireWorkerAssets, requireBundleTool) {
  const directory = resolve(assetDirectory)
  const checksumBytes = await readFile(join(directory, CHECKSUMS_FILE))
  const source = checksumBytes.toString('utf8')
  if (!source.endsWith('\n')) {
    throw new Error(`${CHECKSUMS_FILE} must end with a newline`)
  }

  const entries = []
  const seen = new Set()
  for (const line of source.trimEnd().split('\n')) {
    const match = CHECKSUM_LINE_PATTERN.exec(line)
    if (!match) {
      throw new Error(`Invalid ${CHECKSUMS_FILE} line: ${JSON.stringify(line)}`)
    }
    const digest = match[1]
    const name = match[2]
    if (!digest || !name || !ALLOWED_ASSETS.has(name) || basename(name) !== name) {
      throw new Error(`Unexpected release asset in ${CHECKSUMS_FILE}: ${name}`)
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate release asset in ${CHECKSUMS_FILE}: ${name}`)
    }
    seen.add(name)
    entries.push({ digest, name })
  }

  const names = entries.map(({ name }) => name)
  const sortedNames = [...names].sort()
  if (names.some((name, index) => name !== sortedNames[index])) {
    throw new Error(`${CHECKSUMS_FILE} entries must be sorted by asset name`)
  }
  for (const name of [...REQUIRED_ASSETS, ...(requireBundleTool ? BUNDLE_TOOL_FILES : [])]) {
    if (!seen.has(name)) {
      throw new Error(`${CHECKSUMS_FILE} is missing required asset ${name}`)
    }
  }
  const hasWorkerRelease = WORKER_RELEASE_ASSETS.some((name) => seen.has(name))
  if (
    (requireWorkerAssets || hasWorkerRelease) &&
    WORKER_RELEASE_ASSETS.some((name) => !seen.has(name))
  ) {
    throw new Error(`${CHECKSUMS_FILE} must contain both worker release assets`)
  }
  if (!requireBundleTool && seen.has('publish-plugin.mjs')) {
    throw new Error('publish-plugin.mjs is an internal input and must not be in public SHA256SUMS')
  }
  const assets = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const bytes = await readFile(path)
    const digest = sha256(bytes)
    if (digest !== entry.digest) {
      throw new Error(`${entry.name} does not match ${CHECKSUMS_FILE}`)
    }
    assets.push({ ...entry, bytes, path })
  }
  assets.push({
    bytes: checksumBytes,
    digest: sha256(checksumBytes),
    name: CHECKSUMS_FILE,
    path: join(directory, CHECKSUMS_FILE),
  })
  return assets
}

function validateRelease(release, tag) {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('GitHub Release response must be an object')
  }
  const releaseTag = requireString(release.tag_name, 'GitHub Release tag_name')
  if (releaseTag !== tag) {
    throw new Error(`GitHub Release tag (${releaseTag}) does not match ${tag}`)
  }
  if (typeof release.draft !== 'boolean') {
    throw new Error('GitHub Release draft must be a boolean')
  }
  if (typeof release.immutable !== 'boolean') {
    throw new Error('GitHub Release immutable must be a boolean')
  }
  if (release.draft && release.immutable) {
    throw new Error('GitHub Release cannot be both draft and immutable')
  }
  if (!release.draft && !release.immutable) {
    throw new Error('Published GitHub Release must be immutable')
  }
  if (!Array.isArray(release.assets)) {
    throw new Error('GitHub Release assets must be an array')
  }
  return {
    assets: release.assets,
    draft: release.draft,
    immutable: release.immutable,
  }
}

function indexRemoteAssets(assets) {
  const byName = new Map()
  for (const asset of assets) {
    if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error('GitHub Release asset must be an object')
    }
    const name = requireString(asset.name, 'GitHub Release asset name')
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`GitHub Release asset ${name} has an invalid size`)
    }
    if (byName.has(name)) {
      throw new Error(`GitHub Release contains duplicate asset ${name}`)
    }
    byName.set(name, asset)
  }
  return byName
}

async function verifyRemoteAssets(client, tag, remoteAssets, localAssets, complete) {
  const localByName = new Map(localAssets.map((asset) => [asset.name, asset]))
  const remoteByName = indexRemoteAssets(remoteAssets)
  for (const name of remoteByName.keys()) {
    if (!localByName.has(name)) {
      throw new Error(`Unexpected release asset: ${name}`)
    }
  }

  let matchedAssets = 0
  for (const [name, remote] of remoteByName) {
    const local = localByName.get(name)
    if (!local) {
      throw new Error(`Unexpected release asset: ${name}`)
    }
    const remoteBytes = await client.downloadAsset(tag, name)
    const remoteDigest = sha256(remoteBytes)
    if (
      remote.size !== local.bytes.length ||
      remoteDigest !== local.digest ||
      !Buffer.from(remoteBytes).equals(local.bytes)
    ) {
      throw new Error(`Immutable release asset violation: ${name} differs from local bytes`)
    }
    matchedAssets += 1
  }

  const missing = localAssets.filter(({ name }) => !remoteByName.has(name))
  if (complete && missing.length > 0) {
    throw new Error(
      `GitHub Release is missing asset(s): ${missing.map(({ name }) => name).join(', ')}`,
    )
  }
  return { matchedAssets, missing }
}

export async function publishPluginRelease(options) {
  const repository = requireString(options.repository, 'repository')
  const tag = requireString(options.tag, 'tag')
  const expectedCommit = requireString(options.expectedCommit, 'expectedCommit')
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`repository must be OWNER/REPO, got ${repository}`)
  }
  if (!STABLE_VERSION_PATTERN.test(tag)) {
    throw new Error(`tag must be a stable x.y.z version, got ${tag}`)
  }
  if (!COMMIT_PATTERN.test(expectedCommit)) {
    throw new Error('expectedCommit must be a lowercase 40-character commit SHA')
  }

  const client = options.client ?? createGhReleaseClient(repository, options.immutableReleaseToken)
  await client.assertImmutableReleasesEnabled()
  const currentTagCommit = requireString(await client.resolveTagCommit(tag), 'Git tag commit SHA')
  if (!COMMIT_PATTERN.test(currentTagCommit)) {
    throw new Error('Git tag resolves to an invalid commit SHA')
  }
  if (currentTagCommit !== expectedCommit) {
    throw new Error(
      `Git tag moved after build: expected ${expectedCommit}, currently ${currentTagCommit}`,
    )
  }

  const requireWorkerAssets = options.requireWorkerAssets !== false
  const requireBundleTool = options.requireBundleTool ?? !requireWorkerAssets
  const localAssets = await loadLocalAssets(
    options.assetDirectory,
    requireWorkerAssets,
    requireBundleTool,
  )
  let release = await client.getRelease(tag)
  let created = false
  if (release === undefined) {
    await client.createRelease(tag, expectedCommit)
    created = true
    release = await client.getRelease(tag)
    if (release === undefined) {
      throw new Error(`GitHub Release ${tag} was not visible after creation`)
    }
  }

  const releaseState = validateRelease(release, tag)
  const verified = await verifyRemoteAssets(
    client,
    tag,
    releaseState.assets,
    localAssets,
    !releaseState.draft,
  )

  if (!releaseState.draft) {
    return {
      created,
      matchedAssets: verified.matchedAssets,
      uploadedAssets: [],
    }
  }

  for (const asset of verified.missing) {
    await client.uploadAsset(tag, asset.path)
  }

  const finalRelease = await client.getRelease(tag)
  if (finalRelease === undefined) {
    throw new Error(`GitHub Release ${tag} was not visible after asset upload`)
  }
  const finalState = validateRelease(finalRelease, tag)
  if (!finalState.draft) {
    throw new Error(`GitHub Release ${tag} was published before final verification`)
  }
  await verifyRemoteAssets(client, tag, finalState.assets, localAssets, true)
  await client.publishRelease(tag)
  const publishedRelease = await client.getRelease(tag)
  if (publishedRelease === undefined) {
    throw new Error(`GitHub Release ${tag} was not visible after publishing`)
  }
  const publishedState = validateRelease(publishedRelease, tag)
  if (publishedState.draft || !publishedState.immutable) {
    throw new Error(`GitHub Release ${tag} did not become immutable after publishing`)
  }
  await verifyRemoteAssets(client, tag, publishedState.assets, localAssets, true)

  return {
    created,
    matchedAssets: verified.matchedAssets,
    uploadedAssets: verified.missing.map(({ name }) => name),
  }
}

async function main() {
  if (process.argv.includes('--runtime-candidate')) {
    const result = await publishRuntimeCandidate({
      tag: requireString(process.env.RELEASE_TAG, 'RELEASE_TAG'),
      tarballPath: requireString(process.env.RELEASE_RUNTIME_TARBALL, 'RELEASE_RUNTIME_TARBALL'),
    })
    console.log(
      `[release] Runtime candidate ${result.published ? 'published' : 'already matched'} (${result.integrity}).`,
    )
    return
  }
  if (process.argv.includes('--runtime-stable')) {
    const result = await promoteRuntimeStable({
      tag: requireString(process.env.RELEASE_TAG, 'RELEASE_TAG'),
      tarballPath: requireString(process.env.RELEASE_RUNTIME_TARBALL, 'RELEASE_RUNTIME_TARBALL'),
    })
    console.log(
      `[release] Runtime stable/latest tags ${result.promoted ? 'promoted' : 'already matched'} (${result.integrity}).`,
    )
    return
  }
  if (!process.env.GH_TOKEN) {
    throw new Error('GH_TOKEN is required')
  }
  const result = await publishPluginRelease({
    assetDirectory: requireString(process.env.RELEASE_ASSET_DIR, 'RELEASE_ASSET_DIR'),
    expectedCommit: requireString(process.env.RELEASE_COMMIT, 'RELEASE_COMMIT'),
    repository: requireString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'),
    tag: requireString(process.env.RELEASE_TAG, 'RELEASE_TAG'),
    immutableReleaseToken: requireString(process.env.RELEASE_ADMIN_TOKEN, 'RELEASE_ADMIN_TOKEN'),
  })
  console.log(
    `[release] ${result.created ? 'Created release and uploaded' : 'Reconciled'} ${result.uploadedAssets.length} asset(s); ${result.matchedAssets} already matched.`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
