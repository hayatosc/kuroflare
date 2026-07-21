import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const PRODUCT_VERSION_EXPORT_PATTERN = /export const PRODUCT_VERSION\s*=\s*['"]([^'"\r\n]+)['"]/g
const PLUGIN_ID_PATTERN = /^[a-z-]+$/

export const REQUIRED_PLUGIN_ASSETS = ['main.js', 'manifest.json', 'versions.json'] as const
export const OPTIONAL_PLUGIN_ASSETS = ['styles.css'] as const
export const BUNDLE_TOOL_FILES = ['publish-plugin.mjs'] as const
/** Worker metadata is uploaded with the plugin release after npm is visible. */
export const WORKER_RELEASE_ASSETS = ['build-lock.json', 'worker-release.json'] as const
/** Build inputs are checksummed but remain internal to the workflow artifact. */
export const WORKER_RELEASE_INPUTS = [
  'core-version.ts',
  'worker-runtime-index.mjs',
  'worker-runtime.tgz',
  'worker.ts',
] as const
export const CHECKSUMS_FILE = 'SHA256SUMS'
export const INPUT_CHECKSUMS_FILE = 'INPUT_SHA256SUMS'

const rootDirectory = resolve(fileURLToPath(new URL('../..', import.meta.url)))

type JsonObject = Record<string, unknown>

export interface ReleaseContract {
  readonly version: string
  readonly minAppVersion: string
  readonly rootPackage: JsonObject
  readonly pluginPackage: JsonObject
  readonly manifest: JsonObject
  readonly versions: JsonObject
  readonly coreProductVersion: string
}

export interface ReleasePaths {
  readonly pluginDirectory: string
  readonly rootPackage: string
  readonly pluginPackage: string
  readonly manifest: string
  readonly versions: string
  readonly coreVersion: string
}

export function isStableVersion(value: string): boolean {
  return STABLE_VERSION_PATTERN.test(value)
}

export function assertStableVersion(value: string, label: string): string {
  if (!isStableVersion(value)) {
    throw new Error(`${label} must be a stable x.y.z version, got ${JSON.stringify(value)}`)
  }
  return value
}

function pathsFor(rootDir: string): ReleasePaths {
  const pluginDirectory = join(rootDir, 'packages/obsidian-plugin')
  return {
    pluginDirectory,
    rootPackage: join(rootDir, 'package.json'),
    pluginPackage: join(pluginDirectory, 'package.json'),
    manifest: join(pluginDirectory, 'manifest.json'),
    versions: join(pluginDirectory, 'versions.json'),
    coreVersion: join(rootDir, 'packages/core/src/utils/version.ts'),
  }
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
    const value: unknown = JSON.parse(source)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('must contain a JSON object')
    }
    return Object.fromEntries(Object.entries(value))
  } catch (error) {
    throw new Error(
      `Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function requirePluginId(value: unknown): string {
  const id = requireString(value, 'packages/obsidian-plugin/manifest.json.id')
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error(
      'packages/obsidian-plugin/manifest.json.id must use lowercase letters and hyphens',
    )
  }
  if (id.includes('obsidian')) {
    throw new Error('packages/obsidian-plugin/manifest.json.id must not contain "obsidian"')
  }
  if (id.endsWith('plugin')) {
    throw new Error('packages/obsidian-plugin/manifest.json.id must not end with "plugin"')
  }
  return id
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function validateRootMirrors(rootDir: string, paths: ReleasePaths): Promise<void> {
  const mirrors = [
    [join(rootDir, 'manifest.json'), paths.manifest, 'manifest.json'],
    [join(rootDir, 'versions.json'), paths.versions, 'versions.json'],
  ] as const

  for (const [rootPath, packagePath, label] of mirrors) {
    const rootFile = await readOptionalFile(rootPath)
    if (rootFile === undefined) {
      continue
    }
    const packageFile = await readFile(packagePath)
    if (!rootFile.equals(packageFile)) {
      throw new Error(`${label} must exactly match packages/obsidian-plugin/${label}`)
    }
  }

  const readme = await readOptionalFile(join(rootDir, 'README.md'))
  if (readme === undefined || readme.toString('utf8').trim().length === 0) {
    throw new Error('README.md must exist and contain Community Plugins documentation')
  }
}

async function readCoreProductVersion(path: string): Promise<string> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Cannot read core product version: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const matches = [...source.matchAll(PRODUCT_VERSION_EXPORT_PATTERN)]
  if (matches.length !== 1) {
    throw new Error('core PRODUCT_VERSION must have exactly one export')
  }
  return requireString(matches[0]?.[1], 'core PRODUCT_VERSION')
}

export async function validateReleaseContract(options: {
  readonly rootDir?: string
  readonly tag: string
}): Promise<ReleaseContract> {
  const rootDir = resolve(options.rootDir ?? rootDirectory)
  const paths = pathsFor(rootDir)
  const tag = assertStableVersion(options.tag, 'Git tag')
  const [rootPackage, pluginPackage, manifest, versions, coreProductVersion] = await Promise.all([
    readJson(paths.rootPackage, 'package.json'),
    readJson(paths.pluginPackage, 'packages/obsidian-plugin/package.json'),
    readJson(paths.manifest, 'packages/obsidian-plugin/manifest.json'),
    readJson(paths.versions, 'packages/obsidian-plugin/versions.json'),
    readCoreProductVersion(paths.coreVersion),
  ])
  await validateRootMirrors(rootDir, paths)

  const rootVersion = assertStableVersion(
    requireString(rootPackage.version, 'package.json.version'),
    'package.json.version',
  )
  const pluginVersion = assertStableVersion(
    requireString(pluginPackage.version, 'packages/obsidian-plugin/package.json.version'),
    'packages/obsidian-plugin/package.json.version',
  )
  const manifestVersion = assertStableVersion(
    requireString(manifest.version, 'packages/obsidian-plugin/manifest.json.version'),
    'packages/obsidian-plugin/manifest.json.version',
  )
  requirePluginId(manifest.id)
  requireString(manifest.name, 'packages/obsidian-plugin/manifest.json.name')
  const manifestMinAppVersion = assertStableVersion(
    requireString(manifest.minAppVersion, 'packages/obsidian-plugin/manifest.json.minAppVersion'),
    'packages/obsidian-plugin/manifest.json.minAppVersion',
  )
  requireString(manifest.description, 'packages/obsidian-plugin/manifest.json.description')
  requireString(manifest.author, 'packages/obsidian-plugin/manifest.json.author')
  requireBoolean(manifest.isDesktopOnly, 'packages/obsidian-plugin/manifest.json.isDesktopOnly')

  const versionsEntry = requireString(
    versions[tag],
    `packages/obsidian-plugin/versions.json.${tag}`,
  )
  if (tag !== rootVersion || tag !== pluginVersion || tag !== manifestVersion) {
    throw new Error(
      `Release tag ${tag} must match root package (${rootVersion}), plugin package (${pluginVersion}), and manifest (${manifestVersion})`,
    )
  }
  if (coreProductVersion !== tag) {
    throw new Error(
      `core PRODUCT_VERSION (${coreProductVersion}) does not match release tag (${tag})`,
    )
  }
  if (versionsEntry !== manifestMinAppVersion) {
    throw new Error(
      `versions.json.${tag} (${versionsEntry}) does not match manifest.minAppVersion (${manifestMinAppVersion})`,
    )
  }

  return {
    version: tag,
    minAppVersion: manifestMinAppVersion,
    rootPackage,
    pluginPackage,
    manifest,
    versions,
    coreProductVersion,
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${label} is missing`)
    }
    throw new Error(
      `${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file`)
  }
}

async function listDirectoryFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`Staging directory contains a non-file entry: ${entry.name}`)
    }
    files.push(entry.name)
  }
  return files.sort()
}

export async function validateStagingDirectory(options: {
  readonly stagingDir: string
  readonly contract?: ReleaseContract
}): Promise<string[]> {
  const stagingDir = resolve(options.stagingDir)
  let files: string[]
  try {
    files = await listDirectoryFiles(stagingDir)
  } catch (error) {
    throw new Error(
      `Cannot inspect plugin staging directory: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const allowed = new Set<string>([
    ...REQUIRED_PLUGIN_ASSETS,
    ...OPTIONAL_PLUGIN_ASSETS,
    ...BUNDLE_TOOL_FILES,
    ...WORKER_RELEASE_ASSETS,
    ...WORKER_RELEASE_INPUTS,
    CHECKSUMS_FILE,
    INPUT_CHECKSUMS_FILE,
  ])
  for (const file of files) {
    if (!allowed.has(file)) {
      throw new Error(`Staging directory contains an unexpected asset: ${file}`)
    }
  }
  for (const asset of REQUIRED_PLUGIN_ASSETS) {
    await assertRegularFile(join(stagingDir, asset), `staging/${asset}`)
  }
  if (files.includes('styles.css')) {
    await assertRegularFile(join(stagingDir, 'styles.css'), 'staging/styles.css')
  }
  for (const asset of [...WORKER_RELEASE_ASSETS, ...WORKER_RELEASE_INPUTS]) {
    if (files.includes(asset)) {
      await assertRegularFile(join(stagingDir, asset), `staging/${asset}`)
    }
  }

  if (options.contract) {
    const manifest = await readJson(join(stagingDir, 'manifest.json'), 'staging/manifest.json')
    const version = requireString(manifest.version, 'staging/manifest.json.version')
    if (version !== options.contract.version) {
      throw new Error(
        `staging/manifest.json.version (${version}) does not match release ${options.contract.version}`,
      )
    }
    const versions = await readJson(join(stagingDir, 'versions.json'), 'staging/versions.json')
    const minAppVersion = requireString(
      versions[options.contract.version],
      `staging/versions.json.${options.contract.version}`,
    )
    if (minAppVersion !== options.contract.minAppVersion) {
      throw new Error(
        `staging/versions.json.${options.contract.version} (${minAppVersion}) does not match manifest.minAppVersion (${options.contract.minAppVersion})`,
      )
    }
  }

  return files
}

export async function stagePlugin(options: {
  readonly rootDir?: string
  readonly stagingDir: string
  readonly tag: string
}): Promise<ReleaseContract> {
  const rootDir = resolve(options.rootDir ?? rootDirectory)
  const contract = await validateReleaseContract({ rootDir, tag: options.tag })
  const paths = pathsFor(rootDir)
  const stagingDir = resolve(options.stagingDir)
  await mkdir(stagingDir, { recursive: true })
  const existingFiles = await readdir(stagingDir)
  if (existingFiles.length > 0) {
    throw new Error(`Plugin staging directory must be empty: ${stagingDir}`)
  }

  for (const asset of REQUIRED_PLUGIN_ASSETS) {
    const source = join(paths.pluginDirectory, asset)
    await assertRegularFile(source, `packages/obsidian-plugin/${asset}`)
    await copyFile(source, join(stagingDir, asset))
  }

  const stylesPath = join(paths.pluginDirectory, OPTIONAL_PLUGIN_ASSETS[0])
  try {
    await assertRegularFile(stylesPath, 'packages/obsidian-plugin/styles.css')
    await copyFile(stylesPath, join(stagingDir, OPTIONAL_PLUGIN_ASSETS[0]))
  } catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith('is missing')) {
      throw error
    }
  }

  await validateStagingDirectory({ stagingDir, contract })
  return contract
}

export async function writeChecksums(stagingDir: string): Promise<string> {
  const directory = resolve(stagingDir)
  const files = await validateStagingDirectory({ stagingDir: directory })
  const assets = files.filter((file) => file !== CHECKSUMS_FILE).sort()
  const lines: string[] = []
  for (const asset of assets) {
    const digest = createHash('sha256')
      .update(await readFile(join(directory, asset)))
      .digest('hex')
    lines.push(`${digest}  ${asset}`)
  }
  const content = `${lines.join('\n')}\n`
  await writeFile(join(directory, CHECKSUMS_FILE), content, 'utf8')
  return content
}

function parseArguments(args: readonly string[]): {
  readonly command: string
  readonly rootDir: string
  readonly tag: string | undefined
  readonly stagingDir: string | undefined
} {
  const command = args[0]
  let rootDir = rootDirectory
  let tag = process.env.GITHUB_REF_NAME
  let stagingDir: string | undefined
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument === '--') {
      continue
    } else if (argument === '--root-dir' && value) {
      rootDir = resolve(value)
      index += 1
    } else if (argument === '--tag' && value) {
      tag = value
      index += 1
    } else if (argument === '--staging-dir' && value) {
      stagingDir = resolve(value)
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
  }
  if (!command || !['validate', 'stage', 'checksum'].includes(command)) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/release/plugin.ts <validate|stage|checksum> [--tag x.y.z] [--staging-dir DIR] [--root-dir DIR]',
    )
  }
  return { command, rootDir, tag, stagingDir }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  if (options.command === 'validate') {
    if (!options.tag) {
      throw new Error('A release tag is required (pass --tag or set GITHUB_REF_NAME)')
    }
    const contract = await validateReleaseContract({ rootDir: options.rootDir, tag: options.tag })
    console.log(`[release] Release contract is consistent at ${contract.version}.`)
    return
  }
  if (!options.stagingDir) {
    throw new Error(`--staging-dir is required for ${options.command}`)
  }
  if (options.command === 'stage') {
    if (!options.tag) {
      throw new Error('A release tag is required for staging (pass --tag or set GITHUB_REF_NAME)')
    }
    const contract = await stagePlugin({
      rootDir: options.rootDir,
      stagingDir: options.stagingDir,
      tag: options.tag,
    })
    console.log(`[release] Staged ${contract.version} plugin assets in ${options.stagingDir}.`)
    return
  }
  const files = await validateStagingDirectory({ stagingDir: options.stagingDir })
  const content = await writeChecksums(options.stagingDir)
  console.log(
    `[release] Wrote ${CHECKSUMS_FILE} for ${files.length} assets (${content.length} bytes).`,
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
