import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const rootDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const packageFiles = [
  'packages/core/package.json',
  'packages/model-tests/package.json',
  'packages/obsidian-plugin/package.json',
  'packages/worker/package.json',
  'packages/worker-runtime/package.json',
] as const

const manifestFile = 'packages/obsidian-plugin/manifest.json'
const versionsFile = 'packages/obsidian-plugin/versions.json'
const rootManifestFile = 'manifest.json'
const rootVersionsFile = 'versions.json'
const coreVersionFile = 'packages/core/src/utils/version.ts'
const coreVersionMarker =
  '// Generated from the root package version by the release-version sync check.'
const coreVersionExportPattern =
  /^\/\/ Generated from the root package version by the release-version sync check\.(\r?\n)(export const PRODUCT_VERSION = )'([^'\r\n]+)'(\r?)$/gm

type JsonObject = Record<string, unknown>

function fail(message: string): never {
  throw new Error(`[version] ${message}`)
}

async function readJson(relativePath: string): Promise<JsonObject> {
  const path = resolve(rootDirectory, relativePath)
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    fail(`Cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    fail(`Cannot parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${relativePath} must contain a JSON object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`)
  }
  return value
}

function requireProductVersion(value: unknown, field: string): string {
  const version = requireString(value, field)
  if (!PRODUCT_VERSION_PATTERN.test(version)) {
    fail(`${field} must be a valid semantic version, got ${JSON.stringify(version)}`)
  }
  return version
}

async function writeJsonIfChanged(relativePath: string, value: JsonObject): Promise<void> {
  const path = resolve(rootDirectory, relativePath)
  const next = `${JSON.stringify(value, null, 2)}\n`
  const current = await readFile(path, 'utf8')
  if (current !== next) {
    await writeFile(path, next, 'utf8')
  }
}

async function writeTextIfChanged(relativePath: string, next: string): Promise<void> {
  const path = resolve(rootDirectory, relativePath)
  const current = await readFile(path, 'utf8')
  if (current !== next) {
    await writeFile(path, next, 'utf8')
  }
}

async function readCoreProductVersion(): Promise<{ source: string; version: string }> {
  const path = resolve(rootDirectory, coreVersionFile)
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    fail(
      `Cannot read ${coreVersionFile}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const markerCount = source.split(coreVersionMarker).length - 1
  if (markerCount !== 1) {
    fail(`${coreVersionFile} must contain exactly one PRODUCT_VERSION marker`)
  }

  const exportCount = source.match(/^[ \t]*export const PRODUCT_VERSION\b/gm)?.length ?? 0
  if (exportCount !== 1) {
    fail(`${coreVersionFile} must contain exactly one PRODUCT_VERSION export`)
  }

  const matches = [...source.matchAll(coreVersionExportPattern)]
  if (matches.length !== 1) {
    fail(`${coreVersionFile} PRODUCT_VERSION export does not match the generated format`)
  }

  const version = requireProductVersion(matches[0]?.[3], `${coreVersionFile}.PRODUCT_VERSION`)
  return { source, version }
}

function updateCoreProductVersion(source: string, version: string): string {
  const updated = source.replace(
    coreVersionExportPattern,
    (_match, newline: string, prefix: string, _current: string, trailing: string) =>
      `${coreVersionMarker}${newline}${prefix}'${version}'${trailing}`,
  )
  if (updated === source && version !== readCoreProductVersionFromSource(source)) {
    fail(`${coreVersionFile} PRODUCT_VERSION export could not be updated safely`)
  }
  return updated
}

function readCoreProductVersionFromSource(source: string): string {
  const matches = [...source.matchAll(coreVersionExportPattern)]
  if (matches.length !== 1) {
    fail(`${coreVersionFile} PRODUCT_VERSION export does not match the generated format`)
  }
  return requireProductVersion(matches[0]?.[3], `${coreVersionFile}.PRODUCT_VERSION`)
}

async function loadContract(): Promise<{
  rootPackage: JsonObject
  version: string
  packages: JsonObject[]
  manifest: JsonObject
  versions: JsonObject
  rootManifest: JsonObject
  rootVersions: JsonObject
  coreProductVersion: { source: string; version: string }
}> {
  const rootPackage = await readJson('package.json')
  const version = requireProductVersion(rootPackage.version, 'package.json.version')
  const packages = await Promise.all(packageFiles.map((path) => readJson(path)))
  const manifest = await readJson(manifestFile)
  const versions = await readJson(versionsFile)
  const rootManifest = await readJson(rootManifestFile)
  const rootVersions = await readJson(rootVersionsFile)
  const coreProductVersion = await readCoreProductVersion()
  return {
    rootPackage,
    version,
    packages,
    manifest,
    versions,
    rootManifest,
    rootVersions,
    coreProductVersion,
  }
}

function validateMirror(actual: JsonObject, expected: JsonObject, file: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${file} must exactly mirror its packages/obsidian-plugin counterpart`)
  }
}

function validateVersionsEntries(versions: JsonObject): void {
  const entries = Object.entries(versions)
  if (entries.length === 0) {
    fail(`${versionsFile} must contain at least one version entry`)
  }

  for (const [version, minAppVersion] of entries) {
    requireProductVersion(version, `${versionsFile} key`)
    requireString(minAppVersion, `${versionsFile}.${version}`)
  }
}

function validateVersionsFile(
  versions: JsonObject,
  expectedVersion: string,
  expectedMinAppVersion: string,
): void {
  validateVersionsEntries(versions)
  const minAppVersion = requireString(
    versions[expectedVersion],
    `${versionsFile}.${expectedVersion}`,
  )
  if (minAppVersion !== expectedMinAppVersion) {
    fail(
      `${versionsFile}.${expectedVersion} (${minAppVersion}) does not match ${manifestFile}.minAppVersion (${expectedMinAppVersion})`,
    )
  }
}

function validateContract({
  version,
  packages,
  manifest,
  versions,
  rootManifest,
  rootVersions,
  coreProductVersion,
}: Awaited<ReturnType<typeof loadContract>>): void {
  for (const [index, packageJson] of packages.entries()) {
    const packageVersion = requireProductVersion(
      packageJson.version,
      `${packageFiles[index]}.version`,
    )
    if (packageVersion !== version) {
      fail(
        `${packageFiles[index]}.version (${packageVersion}) does not match package.json.version (${version})`,
      )
    }
  }

  const manifestVersion = requireProductVersion(manifest.version, `${manifestFile}.version`)
  if (manifestVersion !== version) {
    fail(
      `${manifestFile}.version (${manifestVersion}) does not match package.json.version (${version})`,
    )
  }

  if (coreProductVersion.version !== version) {
    fail(
      `${coreVersionFile}.PRODUCT_VERSION (${coreProductVersion.version}) does not match package.json.version (${version})`,
    )
  }

  const minAppVersion = requireString(manifest.minAppVersion, `${manifestFile}.minAppVersion`)
  validateVersionsFile(versions, version, minAppVersion)
  validateMirror(rootManifest, manifest, rootManifestFile)
  validateMirror(rootVersions, versions, rootVersionsFile)
}

async function syncContract(): Promise<void> {
  const contract = await loadContract()
  const minAppVersion = requireString(
    contract.manifest.minAppVersion,
    `${manifestFile}.minAppVersion`,
  )
  validateVersionsEntries(contract.versions)

  if (contract.coreProductVersion.version !== contract.version) {
    const updatedSource = updateCoreProductVersion(
      contract.coreProductVersion.source,
      contract.version,
    )
    await writeTextIfChanged(coreVersionFile, updatedSource)
  }

  for (const [index, packageJson] of contract.packages.entries()) {
    packageJson.version = contract.version
    await writeJsonIfChanged(packageFiles[index], packageJson)
  }
  contract.manifest.version = contract.version
  await writeJsonIfChanged(manifestFile, contract.manifest)
  contract.versions[contract.version] = minAppVersion
  await writeJsonIfChanged(versionsFile, contract.versions)
  await writeJsonIfChanged(rootManifestFile, contract.manifest)
  await writeJsonIfChanged(rootVersionsFile, contract.versions)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'sync' && command !== 'check') {
    fail('Usage: node --experimental-strip-types scripts/version.ts <sync|check>')
  }

  const contract = await loadContract()
  if (command === 'check') {
    validateContract(contract)
    console.log(`[version] Contract is consistent at ${contract.version}.`)
    return
  }

  await syncContract()
  validateContract(await loadContract())
  console.log(`[version] Synchronized contract at ${contract.version}.`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
