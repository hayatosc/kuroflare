import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const rootDirectory = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const RUNTIME_PACKAGE_NAME = '@kuroflare/worker-runtime'
export const WRANGLER_PACKAGE_NAME = 'wrangler'
export const WRANGLER_VERSION = '4.105.0'
export const MINIMUM_WRANGLER_VERSION = '4.70.0'
export const CHECKSUMS_FILE = 'SHA256SUMS'
export const INPUT_CHECKSUMS_FILE = 'INPUT_SHA256SUMS'
export const WORKER_RELEASE_FILE = 'worker-release.json'
export const BUILD_LOCK_FILE = 'build-lock.json'
export const RUNTIME_TARBALL_FILE = 'worker-runtime.tgz'
export const RUNTIME_BUNDLE_FILE = 'worker-runtime-index.mjs'
export const COMPATIBILITY_FILE = 'core-version.ts'
export const GENERATOR_FILE = 'worker.ts'
export const PUBLIC_RELEASE_FILES = [
  'main.js',
  'manifest.json',
  'versions.json',
  'styles.css',
  WORKER_RELEASE_FILE,
  BUILD_LOCK_FILE,
  CHECKSUMS_FILE,
] as const
export const INTERNAL_RELEASE_FILES = [
  COMPATIBILITY_FILE,
  'publish-plugin.mjs',
  RUNTIME_BUNDLE_FILE,
  RUNTIME_TARBALL_FILE,
  GENERATOR_FILE,
] as const

const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const NPM_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const PACKAGE_PATH_PATTERN =
  /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/
const KNOWN_STAGING_FILES = new Set<string>([...PUBLIC_RELEASE_FILES, ...INTERNAL_RELEASE_FILES])
KNOWN_STAGING_FILES.add('publish-plugin.mjs')
KNOWN_STAGING_FILES.add(INPUT_CHECKSUMS_FILE)

type JsonObject = Record<string, unknown>

export interface CompatibilityMetadata {
  readonly productVersion: string
  readonly protocolVersion: number
  readonly minimumProtocolVersion: number
  readonly minimumPluginVersion: string
}

export interface BuildLockDetails {
  readonly runtimeIntegrity: string
  readonly wranglerIntegrity: string
}

export interface WorkerReleaseManifest {
  readonly schemaVersion: 1
  readonly bootstrapProtocolVersion: 1
  readonly requiredTemplateProtocolVersion: 1
  readonly productVersion: string
  readonly runtimeVersion: string
  readonly runtimeIntegrity: string
  readonly runtimeBundleSha256: string
  readonly wranglerVersion: string
  readonly wranglerIntegrity: string
  readonly buildLockSha256: string
  readonly buildCommit: string
  readonly protocolVersion: number
  readonly minimumProtocolVersion: number
  readonly minimumPluginVersion: string
  readonly automaticUpdate: true
  readonly rolloutSalt: string
  readonly publishedAt: string
}

function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requireInteger(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`)
  }
  return value
}

function requireStableVersion(value: unknown, label: string): string {
  const version = requireString(value, label)
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`${label} must be a stable x.y.z version, got ${JSON.stringify(version)}`)
  }
  return version
}

function requireSemver(value: unknown, label: string): string {
  const version = requireString(value, label)
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`${label} must be a semantic version, got ${JSON.stringify(version)}`)
  }
  return version
}

function compareStableVersion(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return (leftParts[index] ?? 0) < (rightParts[index] ?? 0) ? -1 : 1
    }
  }
  return 0
}

function requireWranglerVersion(value: unknown, label: string): string {
  const version = requireStableVersion(value, label)
  if (compareStableVersion(version, MINIMUM_WRANGLER_VERSION) < 0) {
    throw new Error(`${label} must be at least ${MINIMUM_WRANGLER_VERSION}`)
  }
  return version
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label)
  if (!SHA256_PATTERN.test(digest))
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`)
  return digest
}

function requireCommit(value: unknown, label: string): string {
  const commit = requireString(value, label)
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`${label} must be a lowercase 40-character SHA`)
  return commit
}

function requireIntegrity(value: unknown, label: string): string {
  const integrity = requireString(value, label)
  if (!NPM_INTEGRITY_PATTERN.test(integrity)) {
    throw new Error(`${label} must be a canonical SHA-512 npm integrity value`)
  }
  return integrity
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function npmSha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export function canonicalUtcTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('publishedAt must be a valid UTC timestamp')
  const canonical = date.toISOString()
  if (!UTC_TIMESTAMP_PATTERN.test(canonical)) throw new Error('publishedAt must be UTC')
  return canonical
}

function requireUtcTimestamp(value: unknown, label: string): string {
  const source = requireString(value, label)
  if (!UTC_TIMESTAMP_PATTERN.test(source)) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  const canonical = canonicalUtcTimestamp(source)
  if (canonical !== source && canonical.replace('.000Z', 'Z') !== source) {
    throw new Error(`${label} must use canonical UTC notation`)
  }
  return source
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    throw new Error(
      `${label} is missing: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!stats.isFile()) throw new Error(`${label} must be a regular file`)
}

async function readJson(path: string, label: string): Promise<JsonObject> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    return requireObject(JSON.parse(source) as unknown, label)
  } catch (error) {
    throw new Error(
      `Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function exactlyOneExport(source: string, pattern: RegExp, label: string): string {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`${label} must have exactly one export`)
  return requireString(
    matches[0]?.slice(1).find((value) => value !== undefined),
    label,
  )
}

export async function readCompatibilityMetadata(path: string): Promise<CompatibilityMetadata> {
  const source = await readFile(path, 'utf8')
  const productVersion = requireStableVersion(
    exactlyOneExport(
      source,
      /export const PRODUCT_VERSION\s*=\s*['"]([^'"\r\n]+)['"]/g,
      'PRODUCT_VERSION',
    ),
    'PRODUCT_VERSION',
  )
  const protocolVersion = requireInteger(
    Number(
      exactlyOneExport(
        source,
        /export const CURRENT_PROTOCOL_VERSION\s*=\s*(\d+)/g,
        'CURRENT_PROTOCOL_VERSION',
      ),
    ),
    'CURRENT_PROTOCOL_VERSION',
  )
  const minimumProtocolVersion = requireInteger(
    Number(
      exactlyOneExport(
        source,
        /export const MIN_SUPPORTED_PROTOCOL_VERSION\s*=\s*(\d+)/g,
        'MIN_SUPPORTED_PROTOCOL_VERSION',
      ),
    ),
    'MIN_SUPPORTED_PROTOCOL_VERSION',
  )
  const minimumPluginVersionRaw = exactlyOneExport(
    source,
    /export const MINIMUM_PLUGIN_VERSION\s*=\s*(?:['"]([^'"\r\n]+)['"]|([A-Za-z_$][\w$]*))/g,
    'MINIMUM_PLUGIN_VERSION',
  )
  const minimumPluginVersion = requireStableVersion(
    minimumPluginVersionRaw === 'PRODUCT_VERSION' ? productVersion : minimumPluginVersionRaw,
    'MINIMUM_PLUGIN_VERSION',
  )
  if (minimumProtocolVersion > protocolVersion) {
    throw new Error('MIN_SUPPORTED_PROTOCOL_VERSION cannot exceed CURRENT_PROTOCOL_VERSION')
  }
  return { productVersion, protocolVersion, minimumProtocolVersion, minimumPluginVersion }
}

function requireLockPackages(value: unknown): JsonObject {
  const lock = requireObject(value, 'build lockfile')
  if (lock.lockfileVersion !== 3) throw new Error('build lockfile lockfileVersion must be 3')
  return requireObject(lock.packages, 'build lockfile.packages')
}

/** Validate npm's lockfile-only output and return the two direct package integrities. */
export function validateBuildLock(
  value: unknown,
  expected: { readonly productVersion: string; readonly wranglerVersion: string },
): BuildLockDetails {
  const lock = requireObject(value, 'build lockfile')
  const packages = requireLockPackages(lock)
  const root = requireObject(packages[''], 'build lockfile root package')
  if (root.version !== expected.productVersion) {
    throw new Error('build lockfile root version does not match the release')
  }
  const dependencies = requireObject(root.dependencies, 'build lockfile root dependencies')
  const names = Object.keys(dependencies).sort()
  const expectedNames = [RUNTIME_PACKAGE_NAME, WRANGLER_PACKAGE_NAME].sort()
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error('build lockfile root dependencies must contain only the runtime and Wrangler')
  }
  if (dependencies[RUNTIME_PACKAGE_NAME] !== expected.productVersion) {
    throw new Error('build lockfile runtime dependency does not match the release')
  }
  if (dependencies[WRANGLER_PACKAGE_NAME] !== expected.wranglerVersion) {
    throw new Error('build lockfile Wrangler dependency does not match the release')
  }

  for (const [packagePath, entryValue] of Object.entries(packages)) {
    if (packagePath === '') continue
    if (!PACKAGE_PATH_PATTERN.test(packagePath)) {
      throw new Error(`build lockfile package path is unsafe: ${packagePath}`)
    }
    const entry = requireObject(entryValue, `build lockfile package ${packagePath}`)
    requireSemver(entry.version, `build lockfile package ${packagePath}.version`)
    requireIntegrity(entry.integrity, `build lockfile package ${packagePath}.integrity`)
    const resolved = requireString(entry.resolved, `build lockfile package ${packagePath}.resolved`)
    let resolvedUrl: URL
    try {
      resolvedUrl = new URL(resolved)
    } catch (error) {
      throw new Error(
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
      throw new Error(
        `build lockfile package ${packagePath}.resolved is not a safe npm tarball URL`,
      )
    }
  }

  const runtime = requireObject(
    packages[`node_modules/${RUNTIME_PACKAGE_NAME}`],
    `build lockfile node_modules/${RUNTIME_PACKAGE_NAME}`,
  )
  const wrangler = requireObject(
    packages[`node_modules/${WRANGLER_PACKAGE_NAME}`],
    `build lockfile node_modules/${WRANGLER_PACKAGE_NAME}`,
  )
  if (runtime.version !== expected.productVersion) {
    throw new Error('build lockfile runtime entry version does not match the release')
  }
  if (wrangler.version !== expected.wranglerVersion) {
    throw new Error('build lockfile Wrangler entry version does not match the release')
  }
  return {
    runtimeIntegrity: requireIntegrity(runtime.integrity, 'build lockfile runtime integrity'),
    wranglerIntegrity: requireIntegrity(wrangler.integrity, 'build lockfile Wrangler integrity'),
  }
}

export function validateChannelPointer(value: unknown, channel: 'stable' | 'beta'): JsonObject {
  const pointer = requireObject(value, `${channel} channel pointer`)
  if (pointer.schemaVersion !== 1) throw new Error(`${channel} pointer schemaVersion must be 1`)
  if (pointer.channel !== channel) throw new Error(`${channel} pointer channel is incorrect`)
  requireStableVersion(pointer.productVersion, `${channel} pointer productVersion`)
  if (
    !Number.isSafeInteger(pointer.rolloutPercentage) ||
    Number(pointer.rolloutPercentage) < 0 ||
    Number(pointer.rolloutPercentage) > 100
  ) {
    throw new Error(`${channel} pointer rolloutPercentage must be an integer from 0 to 100`)
  }
  if (!Array.isArray(pointer.blockedSourceVersions)) {
    throw new Error(`${channel} pointer blockedSourceVersions must be an array`)
  }
  const blocked = pointer.blockedSourceVersions.map((version, index) =>
    requireStableVersion(version, `${channel} pointer blockedSourceVersions[${index}]`),
  )
  if (new Set(blocked).size !== blocked.length) {
    throw new Error(`${channel} pointer blockedSourceVersions must not contain duplicates`)
  }
  if (typeof pointer.paused !== 'boolean')
    throw new Error(`${channel} pointer paused must be boolean`)
  requireUtcTimestamp(pointer.updatedAt, `${channel} pointer updatedAt`)
  return pointer
}

// --- Phase 7: staged rollout / channel promotion (no artifact rebuild) ---
//
// These pure functions mutate a channel pointer only. Promotion never rebuilds or
// republishes a release: the immutable release manifest already fixes the runtime bundle,
// so pointing a channel at an already-published `productVersion` is what "promotes" it.
// `rolloutPercentage` is the share of installations that newly issue a Deploy Hook, not a
// hard cap on deployed workers (queued builds can still land), which is why only releases
// backward-compatible across the whole template-protocol-1 range are `automaticUpdate`.

/** The ordered staged-rollout percentages. A rollout advances through these in order. */
export const ROLLOUT_STAGES = [1, 10, 50, 100] as const
type RolloutStage = (typeof ROLLOUT_STAGES)[number]

function isRolloutStage(value: number): value is RolloutStage {
  return (ROLLOUT_STAGES as readonly number[]).includes(value)
}

/** Extract blockedSourceVersions as string[] from a validated channel pointer. */
function blockedVersionList(pointer: JsonObject): string[] {
  if (!Array.isArray(pointer.blockedSourceVersions)) return []
  return pointer.blockedSourceVersions.filter((v): v is string => typeof v === 'string')
}

/** The stage that may follow `current`, or undefined if `current` is terminal/invalid. */
function nextRolloutStage(current: number): RolloutStage | undefined {
  // A freshly promoted pointer sits at 0% and advances to the first real stage.
  if (current === 0) return ROLLOUT_STAGES[0]
  if (!isRolloutStage(current)) return undefined
  const index = ROLLOUT_STAGES.indexOf(current)
  return ROLLOUT_STAGES[index + 1]
}

/** Emergency stop / pre-switch drain: stop issuing new Deploy Hooks on a channel. */
export function pauseChannelPointer(
  pointer: unknown,
  channel: 'stable' | 'beta',
  now: string | Date,
): JsonObject {
  const current = validateChannelPointer(pointer, channel)
  return validateChannelPointer(
    { ...current, paused: true, updatedAt: canonicalUtcTimestamp(now) },
    channel,
  )
}

/**
 * Promote an already-published, fixed release onto a channel without rebuilding it. The
 * pointer switches to the new version paused at 0%; the operator then drains in-flight
 * builds, re-verifies that npm and the GitHub Release point at the same fixed artifact,
 * and starts the rollout with {@link advanceChannelRollout}.
 */
export function promoteChannelPointer(
  pointer: unknown,
  channel: 'stable' | 'beta',
  version: string,
  now: string | Date,
): JsonObject {
  const current = validateChannelPointer(pointer, channel)
  const target = requireStableVersion(version, 'promotion version')
  if (compareStableVersion(target, String(current.productVersion)) <= 0) {
    throw new Error(
      `cannot promote ${channel} to ${target}: not newer than the current ${String(current.productVersion)}`,
    )
  }
  return validateChannelPointer(
    {
      ...current,
      productVersion: target,
      paused: true,
      rolloutPercentage: 0,
      updatedAt: canonicalUtcTimestamp(now),
    },
    channel,
  )
}

/**
 * Advance (or resume) the staged rollout. Only the current stage (a resume that clears an
 * emergency pause) or the immediate next stage is allowed, so a rollout can never skip
 * ahead or roll backward via the pointer. Rolling out implies the channel is live, so this
 * clears `paused`.
 */
export function advanceChannelRollout(
  pointer: unknown,
  channel: 'stable' | 'beta',
  percentage: number,
  now: string | Date,
): JsonObject {
  const current = validateChannelPointer(pointer, channel)
  if (!isRolloutStage(percentage)) {
    throw new Error(
      `rollout percentage must be one of ${ROLLOUT_STAGES.join(', ')}; got ${percentage}`,
    )
  }
  const currentPercentage = Number(current.rolloutPercentage)
  if (percentage !== currentPercentage && percentage !== nextRolloutStage(currentPercentage)) {
    throw new Error(
      `rollout must resume the current stage (${currentPercentage}%) or advance to the next stage; got ${percentage}%`,
    )
  }
  return validateChannelPointer(
    {
      ...current,
      rolloutPercentage: percentage,
      paused: false,
      updatedAt: canonicalUtcTimestamp(now),
    },
    channel,
  )
}

/** Emergency block: stop workers running a specific source version from auto-updating. */
export function blockChannelSourceVersion(
  pointer: unknown,
  channel: 'stable' | 'beta',
  version: string,
  now: string | Date,
): JsonObject {
  const current = validateChannelPointer(pointer, channel)
  const target = requireStableVersion(version, 'blocked source version')
  const blocked = blockedVersionList(current)
  if (!blocked.includes(target)) blocked.push(target)
  blocked.sort(compareStableVersion)
  return validateChannelPointer(
    { ...current, blockedSourceVersions: blocked, updatedAt: canonicalUtcTimestamp(now) },
    channel,
  )
}

/** Reverse {@link blockChannelSourceVersion} for a source version once it is safe again. */
export function unblockChannelSourceVersion(
  pointer: unknown,
  channel: 'stable' | 'beta',
  version: string,
  now: string | Date,
): JsonObject {
  const current = validateChannelPointer(pointer, channel)
  const target = requireStableVersion(version, 'blocked source version')
  const blocked = blockedVersionList(current).filter((entry) => entry !== target)
  return validateChannelPointer(
    { ...current, blockedSourceVersions: blocked, updatedAt: canonicalUtcTimestamp(now) },
    channel,
  )
}

export function validateWorkerReleaseManifest(value: unknown): WorkerReleaseManifest {
  const manifest = requireObject(value, 'worker release manifest')
  if (manifest.schemaVersion !== 1) throw new Error('worker release schemaVersion must be 1')
  if (manifest.bootstrapProtocolVersion !== 1) {
    throw new Error('worker release bootstrapProtocolVersion must be 1')
  }
  if (manifest.requiredTemplateProtocolVersion !== 1) {
    throw new Error('worker release requiredTemplateProtocolVersion must be 1')
  }
  const productVersion = requireStableVersion(
    manifest.productVersion,
    'worker release productVersion',
  )
  if (manifest.runtimeVersion !== productVersion) {
    throw new Error('worker release runtimeVersion must match productVersion')
  }
  const runtimeIntegrity = requireIntegrity(
    manifest.runtimeIntegrity,
    'worker release runtimeIntegrity',
  )
  const runtimeBundleSha256 = requireSha256(
    manifest.runtimeBundleSha256,
    'worker release runtimeBundleSha256',
  )
  const wranglerVersion = requireWranglerVersion(
    manifest.wranglerVersion,
    'worker release wranglerVersion',
  )
  const wranglerIntegrity = requireIntegrity(
    manifest.wranglerIntegrity,
    'worker release wranglerIntegrity',
  )
  const buildLockSha256 = requireSha256(manifest.buildLockSha256, 'worker release buildLockSha256')
  const buildCommit = requireCommit(manifest.buildCommit, 'worker release buildCommit')
  const protocolVersion = requireInteger(manifest.protocolVersion, 'worker release protocolVersion')
  const minimumProtocolVersion = requireInteger(
    manifest.minimumProtocolVersion,
    'worker release minimumProtocolVersion',
  )
  if (minimumProtocolVersion > protocolVersion) {
    throw new Error('worker release minimumProtocolVersion cannot exceed protocolVersion')
  }
  const minimumPluginVersion = requireStableVersion(
    manifest.minimumPluginVersion,
    'worker release minimumPluginVersion',
  )
  if (manifest.automaticUpdate !== true)
    throw new Error('worker release automaticUpdate must be true')
  const rolloutSalt = requireString(manifest.rolloutSalt, 'worker release rolloutSalt')
  const publishedAt = requireUtcTimestamp(manifest.publishedAt, 'worker release publishedAt')
  return {
    schemaVersion: 1,
    bootstrapProtocolVersion: 1,
    requiredTemplateProtocolVersion: 1,
    productVersion,
    runtimeVersion: productVersion,
    runtimeIntegrity,
    runtimeBundleSha256,
    wranglerVersion,
    wranglerIntegrity,
    buildLockSha256,
    buildCommit,
    protocolVersion,
    minimumProtocolVersion,
    minimumPluginVersion,
    automaticUpdate: true,
    rolloutSalt,
    publishedAt,
  }
}

export function createWorkerReleaseManifest(options: {
  readonly productVersion: string
  readonly runtimeIntegrity: string
  readonly runtimeBundleSha256: string
  readonly wranglerIntegrity: string
  readonly buildLockSha256: string
  readonly buildCommit: string
  readonly compatibility: CompatibilityMetadata
  readonly publishedAt: string
  readonly rolloutSalt?: string
  readonly wranglerVersion?: string
}): WorkerReleaseManifest {
  const productVersion = requireStableVersion(options.productVersion, 'productVersion')
  if (options.compatibility.productVersion !== productVersion) {
    throw new Error(
      `core PRODUCT_VERSION (${options.compatibility.productVersion}) does not match productVersion (${productVersion})`,
    )
  }
  const buildCommit = requireCommit(options.buildCommit, 'buildCommit')
  const manifest = {
    schemaVersion: 1 as const,
    bootstrapProtocolVersion: 1 as const,
    requiredTemplateProtocolVersion: 1 as const,
    productVersion,
    runtimeVersion: productVersion,
    runtimeIntegrity: requireIntegrity(options.runtimeIntegrity, 'runtimeIntegrity'),
    runtimeBundleSha256: requireSha256(options.runtimeBundleSha256, 'runtimeBundleSha256'),
    wranglerVersion: requireWranglerVersion(
      options.wranglerVersion ?? WRANGLER_VERSION,
      'wranglerVersion',
    ),
    wranglerIntegrity: requireIntegrity(options.wranglerIntegrity, 'wranglerIntegrity'),
    buildLockSha256: requireSha256(options.buildLockSha256, 'buildLockSha256'),
    buildCommit,
    protocolVersion: requireInteger(options.compatibility.protocolVersion, 'protocolVersion'),
    minimumProtocolVersion: requireInteger(
      options.compatibility.minimumProtocolVersion,
      'minimumProtocolVersion',
    ),
    minimumPluginVersion: requireStableVersion(
      options.compatibility.minimumPluginVersion,
      'minimumPluginVersion',
    ),
    automaticUpdate: true as const,
    rolloutSalt: options.rolloutSalt ?? `${productVersion}-${buildCommit.slice(0, 16)}`,
    publishedAt: canonicalUtcTimestamp(options.publishedAt),
  }
  return validateWorkerReleaseManifest(manifest)
}

async function copyInput(source: string, destination: string, label: string): Promise<void> {
  await assertRegularFile(source, label)
  try {
    await lstat(destination)
    throw new Error(`staging destination already exists: ${destination}`)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await copyFile(source, destination)
}

export async function stageWorkerInputs(options: {
  readonly rootDir?: string
  readonly stagingDir: string
  readonly runtimeTarball: string
  readonly tag?: string
}): Promise<void> {
  const rootDir = resolve(options.rootDir ?? rootDirectory)
  const stagingDir = resolve(options.stagingDir)
  await mkdir(stagingDir, { recursive: true })
  const runtimeVersion = requireStableVersion(
    (
      await readJson(
        join(rootDir, 'packages/worker-runtime/package.json'),
        'worker-runtime/package.json',
      )
    ).version,
    'worker-runtime/package.json.version',
  )
  if (
    options.tag !== undefined &&
    runtimeVersion !== requireStableVersion(options.tag, 'release tag')
  ) {
    throw new Error(
      `worker-runtime/package.json.version (${runtimeVersion}) does not match release tag`,
    )
  }
  await copyInput(
    resolve(options.runtimeTarball),
    join(stagingDir, RUNTIME_TARBALL_FILE),
    'worker runtime tarball',
  )
  await copyInput(
    join(rootDir, 'packages/worker-runtime/dist/index.mjs'),
    join(stagingDir, RUNTIME_BUNDLE_FILE),
    'worker runtime bundle',
  )
  await copyInput(
    join(rootDir, 'packages/core/src/utils/version.ts'),
    join(stagingDir, COMPATIBILITY_FILE),
    'core compatibility metadata',
  )
  await copyInput(
    join(rootDir, 'scripts/release/worker.ts'),
    join(stagingDir, GENERATOR_FILE),
    'worker release generator',
  )
}

async function listStagingFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile())
      throw new Error(`Release staging directory contains a non-file: ${entry.name}`)
    if (entry.name === CHECKSUMS_FILE || entry.name === INPUT_CHECKSUMS_FILE) continue
    if (!KNOWN_STAGING_FILES.has(entry.name)) {
      throw new Error(`Release staging directory contains an unexpected asset: ${entry.name}`)
    }
    files.push(entry.name)
  }
  return files.sort()
}

async function writeChecksumFile(
  directory: string,
  fileName: string,
  files: readonly string[],
): Promise<string> {
  const lines: string[] = []
  for (const file of files) lines.push(`${sha256(await readFile(join(directory, file)))}  ${file}`)
  const content = `${lines.join('\n')}\n`
  await writeFile(join(directory, fileName), content, 'utf8')
  return content
}

export async function writeInputChecksums(stagingDir: string): Promise<string> {
  const directory = resolve(stagingDir)
  const files = await listStagingFiles(directory)
  for (const required of [
    'main.js',
    'manifest.json',
    'versions.json',
    'publish-plugin.mjs',
    ...INTERNAL_RELEASE_FILES,
  ]) {
    if (!files.includes(required)) throw new Error(`Release staging is missing ${required}`)
  }
  return writeChecksumFile(directory, INPUT_CHECKSUMS_FILE, files)
}

export async function writePublicChecksums(stagingDir: string): Promise<string> {
  const directory = resolve(stagingDir)
  const publicFiles = new Set<string>(PUBLIC_RELEASE_FILES)
  const files = (await listStagingFiles(directory)).filter((file) => publicFiles.has(file))
  for (const required of [
    'main.js',
    'manifest.json',
    'versions.json',
    WORKER_RELEASE_FILE,
    BUILD_LOCK_FILE,
  ]) {
    if (!files.includes(required)) throw new Error(`Release staging is missing ${required}`)
  }
  return writeChecksumFile(directory, CHECKSUMS_FILE, files)
}

/** Compatibility name for callers that checksum the complete build artifact. */
export const writeReleaseChecksums = writeInputChecksums

async function runNpmInstall(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  } catch {
    throw new Error(
      'npm package-lock-only resolution failed; verify registry access and package visibility',
    )
  }
}

export async function generateBuildLock(options: {
  readonly productVersion: string
  readonly wranglerVersion?: string
  readonly runInstall?: (cwd: string, args: string[]) => Promise<void>
}): Promise<{ readonly bytes: Buffer; readonly details: BuildLockDetails }> {
  const productVersion = requireStableVersion(options.productVersion, 'productVersion')
  const wranglerVersion = requireWranglerVersion(
    options.wranglerVersion ?? WRANGLER_VERSION,
    'wranglerVersion',
  )
  const directory = await mkdtemp(join(tmpdir(), 'kuroflare-build-lock-'))
  try {
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name: 'kuroflare-worker-build',
          version: productVersion,
          private: true,
          type: 'module',
          dependencies: {
            [RUNTIME_PACKAGE_NAME]: productVersion,
            [WRANGLER_PACKAGE_NAME]: wranglerVersion,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const install = options.runInstall ?? runNpmInstall
    await install(directory, [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ])
    const bytes = await readFile(join(directory, 'package-lock.json'))
    let lock: unknown
    try {
      lock = JSON.parse(bytes.toString('utf8')) as unknown
    } catch (error) {
      throw new Error(
        `npm generated invalid package-lock.json: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const details = validateBuildLock(lock, { productVersion, wranglerVersion })
    return { bytes, details }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function parseArguments(args: readonly string[]): Promise<{
  readonly command: string
  readonly values: Map<string, string>
}> {
  const command = args[0]
  if (
    !command ||
    ![
      'stage',
      'generate',
      'checksum',
      'public-checksum',
      'validate-pointers',
      'pointer-pause',
      'pointer-promote',
      'pointer-rollout',
      'pointer-block',
      'pointer-unblock',
    ].includes(command)
  ) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/release/worker.ts <stage|generate|checksum|validate-pointers|pointer-pause|pointer-promote|pointer-rollout|pointer-block|pointer-unblock> [options]',
    )
  }
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${key ?? ''}`)
    }
    values.set(key.slice(2), value)
    index += 1
  }
  return { command, values }
}

function requiredOption(values: Map<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function requireChannelOption(values: Map<string, string>): 'stable' | 'beta' {
  const channel = requiredOption(values, 'channel')
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`--channel must be "stable" or "beta"; got "${channel}"`)
  }
  return channel
}

function requirePercentage(values: Map<string, string>): number {
  const raw = requiredOption(values, 'percentage')
  const percentage = Number(raw)
  if (!Number.isInteger(percentage))
    throw new Error(`--percentage must be an integer; got "${raw}"`)
  return percentage
}

/** Reads a channel pointer file, applies a validated mutation, and writes it back. */
async function rewriteChannelPointer(
  channel: 'stable' | 'beta',
  mutate: (current: JsonObject) => JsonObject,
): Promise<JsonObject> {
  const path = join(rootDirectory, 'distribution/channels', `${channel}.json`)
  const current = await readJson(path, `${channel} channel pointer`)
  const next = mutate(current)
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

async function main(): Promise<void> {
  const { command, values } = await parseArguments(process.argv.slice(2))
  const stagingDir = values.get('staging-dir')
  if (command === 'validate-pointers') {
    for (const channel of ['stable', 'beta'] as const) {
      const pointer = await readJson(
        join(rootDirectory, 'distribution/channels', `${channel}.json`),
        `${channel} channel pointer`,
      )
      validateChannelPointer(pointer, channel)
    }
    console.log('[release] Channel pointers are valid.')
    return
  }
  if (command.startsWith('pointer-')) {
    const channel = requireChannelOption(values)
    const next = await rewriteChannelPointer(channel, (current) => {
      if (command === 'pointer-pause') return pauseChannelPointer(current, channel, new Date())
      if (command === 'pointer-promote') {
        return promoteChannelPointer(
          current,
          channel,
          requiredOption(values, 'version'),
          new Date(),
        )
      }
      if (command === 'pointer-rollout') {
        return advanceChannelRollout(current, channel, requirePercentage(values), new Date())
      }
      if (command === 'pointer-block') {
        return blockChannelSourceVersion(
          current,
          channel,
          requiredOption(values, 'version'),
          new Date(),
        )
      }
      return unblockChannelSourceVersion(
        current,
        channel,
        requiredOption(values, 'version'),
        new Date(),
      )
    })
    console.log(
      `[release] ${channel} pointer -> productVersion ${String(next.productVersion)}, ` +
        `rollout ${String(next.rolloutPercentage)}%, paused ${String(next.paused)}.`,
    )
    return
  }
  if (!stagingDir) throw new Error(`--staging-dir is required for ${command}`)
  if (command === 'stage') {
    await stageWorkerInputs({
      rootDir: values.get('root-dir'),
      stagingDir,
      runtimeTarball: requiredOption(values, 'runtime-tarball'),
      tag: requiredOption(values, 'tag'),
    })
    console.log(`[release] Staged worker release inputs in ${stagingDir}.`)
    return
  }
  if (command === 'checksum') {
    const content = await writeInputChecksums(stagingDir)
    console.log(`[release] Wrote ${INPUT_CHECKSUMS_FILE} (${content.length} bytes).`)
    return
  }
  if (command === 'public-checksum') {
    const content = await writePublicChecksums(stagingDir)
    console.log(`[release] Wrote ${CHECKSUMS_FILE} (${content.length} bytes).`)
    return
  }

  const tag = requireStableVersion(requiredOption(values, 'tag'), 'release tag')
  const commit = requireCommit(requiredOption(values, 'commit'), 'release commit')
  const lock = await generateBuildLock({
    productVersion: tag,
    wranglerVersion: values.get('wrangler-version'),
  })
  await writeFile(join(resolve(stagingDir), BUILD_LOCK_FILE), lock.bytes)
  const runtimeBytes = await readFile(join(resolve(stagingDir), RUNTIME_TARBALL_FILE))
  const bundleBytes = await readFile(join(resolve(stagingDir), RUNTIME_BUNDLE_FILE))
  const compatibility = await readCompatibilityMetadata(
    join(resolve(stagingDir), COMPATIBILITY_FILE),
  )
  if (compatibility.productVersion !== tag) {
    throw new Error(
      `core PRODUCT_VERSION (${compatibility.productVersion}) does not match release tag (${tag})`,
    )
  }
  const manifest = createWorkerReleaseManifest({
    productVersion: tag,
    runtimeIntegrity: lock.details.runtimeIntegrity,
    runtimeBundleSha256: sha256(bundleBytes),
    wranglerIntegrity: lock.details.wranglerIntegrity,
    buildLockSha256: sha256(lock.bytes),
    buildCommit: commit,
    compatibility,
    publishedAt: requiredOption(values, 'published-at'),
    wranglerVersion: values.get('wrangler-version'),
  })
  const runtimeIntegrity = npmSha512Integrity(runtimeBytes)
  if (runtimeIntegrity !== manifest.runtimeIntegrity) {
    throw new Error('Runtime tarball integrity differs from the npm registry lock entry')
  }
  await writeFile(
    join(resolve(stagingDir), WORKER_RELEASE_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  console.log(`[release] Generated ${WORKER_RELEASE_FILE} and ${BUILD_LOCK_FILE}.`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
