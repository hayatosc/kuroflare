import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const TEMPLATE_PROTOCOL_VERSION = 1
export const BOOTSTRAP_PROTOCOL_VERSION = 1
export const DEFAULT_CHANNEL = 'stable'
export const CHANNELS = new Set(['stable', 'beta'])
export const MAX_POINTER_BYTES = 1024 * 1024
export const MAX_MANIFEST_BYTES = 1024 * 1024
export const MAX_BUILD_LOCK_BYTES = 16 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 15_000
export const RUNTIME_PACKAGE_NAME = '@kuroflare/worker-runtime'
export const WRANGLER_PACKAGE_NAME = 'wrangler'
export const MINIMUM_WRANGLER_VERSION = '4.70.0'
export const CHANNEL_POINTER_BASE_URL =
  'https://raw.githubusercontent.com/hayatosc/kuroflare/main/distribution/channels'
export const RELEASE_BASE_URL = 'https://github.com/hayatosc/kuroflare/releases/download'
export const RELEASE_ASSET_HOST = 'release-assets.githubusercontent.com'

const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/
const NPM_SHA512_PATTERN = /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const PACKAGE_LOCK_PATH_PATTERN =
  /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/
const RELEASE_ASSET_PATH_PATTERN = /^\/github-production-release-asset\/[1-9]\d*\/[0-9A-Fa-f-]+$/
const FORBIDDEN_REMOTE_FIELDS = new Set([
  'buildLockUrl',
  'manifestUrl',
  'releaseUrl',
  'runtimePackage',
  'runtimePackageName',
  'runtimeUrl',
  'wranglerPackage',
  'wranglerPackageName',
  'wranglerUrl',
])

const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execFile = promisify(nodeExecFile)

function fail(message) {
  throw new Error(`[prepare-build] ${message}`)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be a JSON object`)
  return value
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`)
  }
  return value
}

function requireSemver(value, label) {
  const version = requireString(value, label)
  if (!SEMVER_PATTERN.test(version)) fail(`${label} must be a semantic version`)
  return version
}

function requireStableVersion(value, label) {
  const version = requireString(value, label)
  if (!STABLE_VERSION_PATTERN.test(version)) fail(`${label} must be a stable x.y.z version`)
  return version
}

function compareWithMinimumStableVersion(version, minimum) {
  const versionWithoutBuild = version.split('+', 1)[0]
  const minimumWithoutBuild = minimum.split('+', 1)[0]
  const versionDash = versionWithoutBuild.indexOf('-')
  const minimumDash = minimumWithoutBuild.indexOf('-')
  const versionCore = (
    versionDash === -1 ? versionWithoutBuild : versionWithoutBuild.slice(0, versionDash)
  )
    .split('.')
    .map(BigInt)
  const minimumCore = (
    minimumDash === -1 ? minimumWithoutBuild : minimumWithoutBuild.slice(0, minimumDash)
  )
    .split('.')
    .map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (versionCore[index] < minimumCore[index]) return -1
    if (versionCore[index] > minimumCore[index]) return 1
  }
  if (versionDash !== -1 && minimumDash === -1) return -1
  if (versionDash === -1 && minimumDash !== -1) return 1
  return 0
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
  return value
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function requireSha256(value, label) {
  const hash = requireString(value, label)
  if (!SHA256_PATTERN.test(hash)) fail(`${label} must be a lowercase SHA-256 hex digest`)
  return hash
}

function requireNpmIntegrity(value, label) {
  const integrity = requireString(value, label)
  if (!NPM_SHA512_PATTERN.test(integrity)) {
    fail(`${label} must be an npm sha512 integrity value`)
  }
  return integrity
}

function requireUtcTimestamp(value, label) {
  const timestamp = requireString(value, label)
  if (!UTC_TIMESTAMP_PATTERN.test(timestamp)) fail(`${label} must be an ISO UTC timestamp`)
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) fail(`${label} must be a valid ISO UTC timestamp`)
  const canonical = parsed.toISOString()
  if (canonical !== timestamp && canonical.replace('.000Z', 'Z') !== timestamp) {
    fail(`${label} must be a canonical ISO UTC timestamp`)
  }
  return timestamp
}

function requireFullCommit(value, label) {
  const commit = requireString(value, label)
  if (!FULL_COMMIT_PATTERN.test(commit)) fail(`${label} must be a full hexadecimal commit SHA`)
  return commit
}

function assertNoRemoteFields(value, label) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_REMOTE_FIELDS.has(key) || /url|package/i.test(key)) {
      fail(`${label}.${key} is not an allowed release input`)
    }
  }
}

function parseJsonObject(bytes, label) {
  let value
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return requireObject(value, label)
}

async function readResponseBytes(response, url, maxBytes) {
  const contentLength = response.headers?.get('content-length')
  if (contentLength !== null && contentLength !== undefined) {
    const length = Number(contentLength)
    if (Number.isSafeInteger(length) && length > maxBytes) {
      fail(`${url} exceeds the ${maxBytes}-byte response limit`)
    }
  }

  if (response.body?.getReader !== undefined) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value)
        total += chunk.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          fail(`${url} exceeds the ${maxBytes}-byte response limit`)
        }
        chunks.push(chunk)
      }
    } finally {
      reader.releaseLock?.()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) fail(`${url} exceeds the ${maxBytes}-byte response limit`)
  return bytes
}

function requireReleaseAssetRedirect(location, sourceUrl) {
  const prefix = `https://${RELEASE_ASSET_HOST}/`
  if (!location.startsWith(prefix)) {
    fail(`release asset redirect from ${sourceUrl} must target ${RELEASE_ASSET_HOST}`)
  }
  let target
  try {
    target = new URL(location)
  } catch (error) {
    fail(
      `release asset redirect from ${sourceUrl} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (
    target.protocol !== 'https:' ||
    target.hostname !== RELEASE_ASSET_HOST ||
    target.username !== '' ||
    target.password !== '' ||
    target.port !== '' ||
    target.hash !== '' ||
    !RELEASE_ASSET_PATH_PATTERN.test(target.pathname)
  ) {
    fail(`release asset redirect from ${sourceUrl} has an invalid destination`)
  }
  return target.href
}

async function fetchJsonObject(url, maxBytes, fetchImpl, allowReleaseAssetRedirect = false) {
  const controller = new AbortController()
  let timeoutReject
  const timeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject
  })
  const timeout = setTimeout(() => {
    controller.abort()
    timeoutReject(new Error(`request timed out after ${FETCH_TIMEOUT_MS} ms`))
  }, FETCH_TIMEOUT_MS)
  try {
    return await Promise.race([
      (async () => {
        const redirectMode = allowReleaseAssetRedirect ? 'manual' : 'error'
        let response = await fetchImpl(url, { redirect: redirectMode, signal: controller.signal })
        if (allowReleaseAssetRedirect && response.status === 302) {
          const location = response.headers?.get('location')
          if (location === null || location === undefined) {
            fail(`release asset redirect from ${url} is missing Location`)
          }
          const target = requireReleaseAssetRedirect(location, url)
          response = await fetchImpl(target, { redirect: 'manual', signal: controller.signal })
          if (response.status >= 300 && response.status < 400) {
            fail(`release asset request for ${url} returned a second redirect`)
          }
        }
        if (response.status !== 200 || !response.ok) {
          fail(`request failed for ${url}: HTTP ${response.status}`)
        }
        const bytes = await readResponseBytes(response, url, maxBytes)
        return { value: parseJsonObject(bytes, url), bytes }
      })(),
      timeoutPromise,
    ])
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[prepare-build]')) throw error
    fail(`request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timeout)
  }
}

function validatePointer(pointer, channel) {
  assertNoRemoteFields(pointer, 'channel pointer')
  if (pointer.schemaVersion !== 1) fail('channel pointer schemaVersion must be 1')
  if (pointer.channel !== channel) fail(`channel pointer channel must be ${channel}`)
  const productVersion = requireStableVersion(
    pointer.productVersion,
    'channel pointer.productVersion',
  )
  requireInteger(pointer.rolloutPercentage, 'channel pointer.rolloutPercentage', 0, 100)
  requireBoolean(pointer.paused, 'channel pointer.paused')
  requireUtcTimestamp(pointer.updatedAt, 'channel pointer.updatedAt')
  if (!Array.isArray(pointer.blockedSourceVersions)) {
    fail('channel pointer.blockedSourceVersions must be an array')
  }
  if (new Set(pointer.blockedSourceVersions).size !== pointer.blockedSourceVersions.length) {
    fail('channel pointer.blockedSourceVersions must not contain duplicates')
  }
  pointer.blockedSourceVersions.forEach((version, index) =>
    requireStableVersion(version, `channel pointer.blockedSourceVersions[${index}]`),
  )
  return { productVersion }
}

function validateManifest(manifest, channel) {
  assertNoRemoteFields(manifest, 'release manifest')
  if (manifest.schemaVersion !== 1) fail('release manifest schemaVersion must be 1')
  if (manifest.bootstrapProtocolVersion !== BOOTSTRAP_PROTOCOL_VERSION) {
    fail(`release manifest bootstrapProtocolVersion must be ${BOOTSTRAP_PROTOCOL_VERSION}`)
  }
  if (manifest.requiredTemplateProtocolVersion !== TEMPLATE_PROTOCOL_VERSION) {
    fail(`release manifest requiredTemplateProtocolVersion must be ${TEMPLATE_PROTOCOL_VERSION}`)
  }
  const productVersion = requireStableVersion(
    manifest.productVersion,
    'release manifest.productVersion',
  )
  const runtimeVersion = requireStableVersion(
    manifest.runtimeVersion,
    'release manifest.runtimeVersion',
  )
  if (runtimeVersion !== productVersion) {
    fail('release manifest runtimeVersion must match productVersion')
  }
  if (Object.hasOwn(manifest, 'channel') && manifest.channel !== channel) {
    fail(`release manifest channel must be ${channel}`)
  }
  requireNpmIntegrity(manifest.runtimeIntegrity, 'release manifest.runtimeIntegrity')
  requireSha256(manifest.runtimeBundleSha256, 'release manifest.runtimeBundleSha256')
  const wranglerVersion = requireStableVersion(
    manifest.wranglerVersion,
    'release manifest.wranglerVersion',
  )
  if (compareWithMinimumStableVersion(wranglerVersion, MINIMUM_WRANGLER_VERSION) < 0) {
    fail(`release manifest.wranglerVersion must be at least ${MINIMUM_WRANGLER_VERSION}`)
  }
  requireNpmIntegrity(manifest.wranglerIntegrity, 'release manifest.wranglerIntegrity')
  requireSha256(manifest.buildLockSha256, 'release manifest.buildLockSha256')
  requireInteger(manifest.protocolVersion, 'release manifest.protocolVersion', 1, 2 ** 31 - 1)
  requireInteger(
    manifest.minimumProtocolVersion,
    'release manifest.minimumProtocolVersion',
    1,
    manifest.protocolVersion,
  )
  requireStableVersion(manifest.minimumPluginVersion, 'release manifest.minimumPluginVersion')
  if (manifest.automaticUpdate !== true) {
    fail('release manifest.automaticUpdate must be true for this template')
  }
  requireFullCommit(manifest.buildCommit, 'release manifest.buildCommit')
  requireUtcTimestamp(manifest.publishedAt, 'release manifest.publishedAt')
  requireString(manifest.rolloutSalt, 'release manifest.rolloutSalt')
  if (Object.hasOwn(manifest, 'rolloutPercentage')) {
    requireInteger(manifest.rolloutPercentage, 'release manifest.rolloutPercentage', 0, 100)
  }
  if (Object.hasOwn(manifest, 'paused')) {
    requireBoolean(manifest.paused, 'release manifest.paused')
    if (manifest.paused) fail('release manifest is paused')
  }
  return { productVersion }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateBuildLock(lockBytes, manifest) {
  const actualHash = sha256(lockBytes)
  if (actualHash !== manifest.buildLockSha256) {
    fail(`build lock SHA-256 mismatch: expected ${manifest.buildLockSha256}, got ${actualHash}`)
  }
  const lock = parseJsonObject(lockBytes, 'build lockfile')
  if (lock.lockfileVersion !== 3) fail('build lockfile lockfileVersion must be 3')
  const packages = requireObject(lock.packages, 'build lockfile.packages')
  const root = requireObject(packages[''], 'build lockfile root package')
  if (root.version !== manifest.productVersion) {
    fail('build lockfile root version does not match the release manifest')
  }
  const dependencies = requireObject(root.dependencies, 'build lockfile root dependencies')
  const dependencyNames = Object.keys(dependencies).sort()
  const expectedNames = [RUNTIME_PACKAGE_NAME, WRANGLER_PACKAGE_NAME].sort()
  if (JSON.stringify(dependencyNames) !== JSON.stringify(expectedNames)) {
    fail('build lockfile root dependencies must contain only the runtime and Wrangler')
  }
  if (dependencies[RUNTIME_PACKAGE_NAME] !== manifest.runtimeVersion) {
    fail('build lockfile runtime dependency does not match the release manifest')
  }
  if (dependencies[WRANGLER_PACKAGE_NAME] !== manifest.wranglerVersion) {
    fail('build lockfile Wrangler dependency does not match the release manifest')
  }

  for (const [packagePath, packageEntryValue] of Object.entries(packages)) {
    if (packagePath === '') continue
    if (!PACKAGE_LOCK_PATH_PATTERN.test(packagePath)) {
      fail(`build lockfile package path is unsafe: ${packagePath}`)
    }
    const packageEntry = requireObject(packageEntryValue, `build lockfile package ${packagePath}`)
    requireSemver(packageEntry.version, `build lockfile package ${packagePath}.version`)
    requireNpmIntegrity(packageEntry.integrity, `build lockfile package ${packagePath}.integrity`)
    const resolved = requireString(
      packageEntry.resolved,
      `build lockfile package ${packagePath}.resolved`,
    )
    if (!resolved.startsWith('https://registry.npmjs.org/')) {
      fail(`build lockfile package ${packagePath}.resolved must use registry.npmjs.org`)
    }
    let resolvedUrl
    try {
      resolvedUrl = new URL(resolved)
    } catch (error) {
      fail(
        `build lockfile package ${packagePath}.resolved is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (
      resolvedUrl.protocol !== 'https:' ||
      resolvedUrl.hostname !== 'registry.npmjs.org' ||
      resolvedUrl.username !== '' ||
      resolvedUrl.password !== '' ||
      resolvedUrl.port !== '' ||
      resolvedUrl.search !== '' ||
      resolvedUrl.hash !== '' ||
      !resolvedUrl.pathname.endsWith('.tgz')
    ) {
      fail(`build lockfile package ${packagePath}.resolved is not a safe npm tarball URL`)
    }
  }

  const runtimeEntry = requireObject(
    packages[`node_modules/${RUNTIME_PACKAGE_NAME}`],
    `build lockfile node_modules/${RUNTIME_PACKAGE_NAME}`,
  )
  const wranglerEntry = requireObject(
    packages[`node_modules/${WRANGLER_PACKAGE_NAME}`],
    `build lockfile node_modules/${WRANGLER_PACKAGE_NAME}`,
  )
  if (runtimeEntry.version !== manifest.runtimeVersion) {
    fail('build lockfile runtime entry version does not match the release manifest')
  }
  if (wranglerEntry.version !== manifest.wranglerVersion) {
    fail('build lockfile Wrangler entry version does not match the release manifest')
  }
  if (runtimeEntry.integrity !== manifest.runtimeIntegrity) {
    fail('build lockfile runtime integrity does not match the release manifest')
  }
  if (wranglerEntry.integrity !== manifest.wranglerIntegrity) {
    fail('build lockfile Wrangler integrity does not match the release manifest')
  }
  requireNpmIntegrity(runtimeEntry.integrity, 'build lockfile runtime integrity')
  requireNpmIntegrity(wranglerEntry.integrity, 'build lockfile Wrangler integrity')
  return lock
}

async function readTemplateConfig(rootDir) {
  let source
  try {
    source = await readFile(join(rootDir, 'wrangler.json'), 'utf8')
  } catch (error) {
    fail(`cannot read wrangler.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  let config
  try {
    config = JSON.parse(source)
  } catch (error) {
    fail(
      `wrangler.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const object = requireObject(config, 'wrangler.json')
  if (object.vars !== undefined && !isObject(object.vars))
    fail('wrangler.json.vars must be an object')
  return object
}

async function validateTemplateProtocol(rootDir) {
  let source
  try {
    source = await readFile(join(rootDir, 'package.json'), 'utf8')
  } catch (error) {
    fail(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  let packageJson
  try {
    packageJson = JSON.parse(source)
  } catch (error) {
    fail(
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const object = requireObject(packageJson, 'package.json')
  if (object.templateProtocolVersion !== TEMPLATE_PROTOCOL_VERSION) {
    fail(`package.json templateProtocolVersion must be ${TEMPLATE_PROTOCOL_VERSION}`)
  }
}

function makeGeneratedConfig(config, channel, buildCommit) {
  const vars = isObject(config.vars) ? { ...config.vars } : {}
  vars.KUROFLARE_RELEASE_CHANNEL = channel
  vars.KUROFLARE_BUILD_COMMIT = buildCommit
  return { ...config, main: '../src/index.ts', vars }
}

function makePackageJson(lock, manifest) {
  const root = isObject(lock.packages?.['']) ? lock.packages[''] : {}
  return {
    name:
      typeof root.name === 'string' && root.name.length > 0 ? root.name : 'kuroflare-worker-build',
    version:
      typeof root.version === 'string' && root.version.length > 0
        ? root.version
        : manifest.productVersion,
    private: true,
    type: 'module',
    dependencies: {
      [RUNTIME_PACKAGE_NAME]: manifest.runtimeVersion,
      [WRANGLER_PACKAGE_NAME]: manifest.wranglerVersion,
    },
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function runNpmCi(nextDir, env, execFileImpl) {
  try {
    await execFileImpl('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: nextDir,
      env,
      stdio: 'inherit',
    })
  } catch (error) {
    fail(`npm ci failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function verifyRuntimeBundle(nextDir, expectedHash) {
  const bundlePath = join(nextDir, 'node_modules', RUNTIME_PACKAGE_NAME, 'dist', 'index.mjs')
  let bytes
  try {
    bytes = await readFile(bundlePath)
  } catch (error) {
    fail(
      `installed runtime bundle is missing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const actualHash = sha256(bytes)
  if (actualHash !== expectedHash) {
    fail(`runtime bundle SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`)
  }
}

async function replaceBuildDirectory(rootDir, nextDir) {
  const currentDir = join(rootDir, '.kuroflare-build')
  const backupDir = `${currentDir}.previous-${process.pid}-${Date.now()}`
  let movedCurrent = false
  try {
    await rename(currentDir, backupDir)
    movedCurrent = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  try {
    await rename(nextDir, currentDir)
  } catch (error) {
    if (movedCurrent) await rename(backupDir, currentDir)
    throw error
  }
  if (movedCurrent) await rm(backupDir, { recursive: true, force: true })
}

export async function prepareBuild({
  rootDir = TEMPLATE_ROOT,
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = execFile,
} = {}) {
  if (typeof fetchImpl !== 'function') fail('global fetch is unavailable')
  const channel = env.KUROFLARE_UPDATE_CHANNEL ?? DEFAULT_CHANNEL
  if (!CHANNELS.has(channel)) fail('KUROFLARE_UPDATE_CHANNEL must be stable or beta')
  await validateTemplateProtocol(rootDir)

  const pointerUrl = `${CHANNEL_POINTER_BASE_URL}/${channel}.json`
  const pointerResponse = await fetchJsonObject(pointerUrl, MAX_POINTER_BYTES, fetchImpl)
  const pointer = validatePointer(pointerResponse.value, channel)
  if (pointerResponse.value.paused) fail(`release ${pointer.productVersion} is paused`)

  const releaseVersion = encodeURIComponent(pointer.productVersion)
  const releaseBase = `${RELEASE_BASE_URL}/${releaseVersion}`
  const manifestUrl = `${releaseBase}/worker-release.json`
  const lockUrl = `${releaseBase}/build-lock.json`
  const manifestResponse = await fetchJsonObject(manifestUrl, MAX_MANIFEST_BYTES, fetchImpl, true)
  const manifest = validateManifest(manifestResponse.value, channel)
  if (manifest.productVersion !== pointer.productVersion) {
    fail('channel pointer and release manifest productVersion values differ')
  }

  const lockResponse = await fetchJsonObject(lockUrl, MAX_BUILD_LOCK_BYTES, fetchImpl, true)
  const lock = validateBuildLock(lockResponse.bytes, manifestResponse.value)
  const templateConfig = await readTemplateConfig(rootDir)
  const nextDir = await mkdtemp(join(rootDir, '.kuroflare-build.next-'))
  try {
    await writeJson(join(nextDir, 'package.json'), makePackageJson(lock, manifestResponse.value))
    await writeFile(join(nextDir, 'package-lock.json'), lockResponse.bytes)
    await writeFile(
      join(nextDir, 'index.mjs'),
      `export { default, UpdateCoordinator, VaultRoom } from '${RUNTIME_PACKAGE_NAME}'\n`,
      'utf8',
    )
    await writeJson(
      join(nextDir, 'wrangler.generated.json'),
      makeGeneratedConfig(templateConfig, channel, manifestResponse.value.buildCommit),
    )
    await runNpmCi(nextDir, env, execFileImpl)
    await verifyRuntimeBundle(nextDir, manifestResponse.value.runtimeBundleSha256)
    await replaceBuildDirectory(rootDir, nextDir)
  } catch (error) {
    await rm(nextDir, { recursive: true, force: true })
    throw error
  }

  return {
    channel,
    productVersion: manifest.productVersion,
    buildCommit: manifestResponse.value.buildCommit,
    directory: join(rootDir, '.kuroflare-build'),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareBuild().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
