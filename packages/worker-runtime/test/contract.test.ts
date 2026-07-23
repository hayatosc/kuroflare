import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve(import.meta.dirname, '..')
const distRoot = resolve(packageRoot, 'dist')
const forbidden = [
  /workspace:/,
  /@kuroflare\/(?:worker|core)/,
  /packages\/(?:worker|core)\/src/,
  /['"]node:/,
]

const distJavaScript = await readFile(resolve(distRoot, 'index.mjs'), 'utf8')
const distTypes = await readFile(resolve(distRoot, 'index.d.mts'), 'utf8')
for (const pattern of forbidden) {
  if (pattern.test(distJavaScript) || pattern.test(distTypes)) {
    throw new Error(`Bundled output contains forbidden monorepo reference: ${pattern}`)
  }
}

const runtimeImportPattern = /(?:^|\n)\s*import\s+(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]/g
for (const match of distJavaScript.matchAll(runtimeImportPattern)) {
  throw new Error(`Bundled runtime contains an external import: ${match[1]}`)
}
for (const pattern of [/\bNodeJS\b/, /\bBuffer\b/, /['"]node:/]) {
  if (pattern.test(distTypes))
    throw new Error(`Declarations contain Node-only type leakage: ${pattern}`)
}

const runtime = await import(pathToFileURL(resolve(distRoot, 'index.mjs')).href)
for (const exportName of [
  'default',
  'workerApp',
  'workerEntrypoint',
  'workerModule',
  'scheduled',
  'VaultRoom',
  'UpdateCoordinator',
]) {
  if (!(exportName in runtime)) throw new Error(`Missing runtime export: ${exportName}`)
}
for (const exportName of ['AppType', 'WorkerEnv']) {
  if (!new RegExp(`\\b${exportName}\\b`).test(distTypes)) {
    throw new Error(`Missing declaration export: ${exportName}`)
  }
}

const packOutput = execFileSync('pnpm', ['pack', '--dry-run', '--json'], {
  cwd: packageRoot,
  encoding: 'utf8',
})
const packRecord: unknown = JSON.parse(packOutput.trim())
if (packRecord === null || typeof packRecord !== 'object' || Array.isArray(packRecord)) {
  throw new Error('Pack output must be a JSON object')
}
const files = Reflect.get(packRecord, 'files')
if (!Array.isArray(files)) throw new Error('Pack output files must be an array')
const packedFiles = new Set(
  files.map((file: unknown) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('Pack output file entry must be an object')
    }
    const path: unknown = Reflect.get(file, 'path')
    if (typeof path !== 'string') throw new Error('Pack output file path must be a string')
    return path
  }),
)
for (const expected of [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.mjs',
  'dist/index.d.mts',
]) {
  if (!packedFiles.has(expected)) throw new Error(`Pack output is missing ${expected}`)
}
for (const file of packedFiles) {
  if (!/^(?:package\.json|README\.md|LICENSE|dist\/)/.test(file)) {
    throw new Error(`Unexpected file in package: ${file}`)
  }
}

console.log(`worker-runtime contract passed (${packedFiles.size} packed files)`)
