import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireObsidianE2ELock,
  copyPluginWithSetup,
  requireObsidianVaultPath,
  requireSafeObsidianVaultPath,
  seedWorkerSetupToken,
  waitForPluginLoaded,
  waitForSetupReady,
} from './e2e-worker-setup.ts'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '..')
const pluginId = 'kuroflare'
const endpoint = process.env.KUROFLARE_E2E_ENDPOINT ?? 'http://127.0.0.1:8787'
const adminSecret = process.env.KUROFLARE_E2E_ADMIN_SECRET ?? 'e2e-admin-secret'
const runId = Date.now().toString(36)
const vaultId = process.env.KUROFLARE_E2E_VAULT_ID ?? `obsidian-mvp2-e2e-${runId}`
const setupToken = process.env.KUROFLARE_E2E_SETUP_TOKEN ?? `setup-token-${runId}`
const notePath = 'mvp2-note.md'
const renamedPath = 'mvp2-renamed.md'

interface ActiveMetaEntry {
  readonly fileId: string
  readonly path: string
  readonly type: string
  readonly deleted: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isActiveMetaEntry(value: unknown): value is ActiveMetaEntry {
  return (
    isRecord(value) &&
    typeof value.fileId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.type === 'string' &&
    typeof value.deleted === 'boolean'
  )
}

function obsidian(args: readonly string[]): string {
  return execFileSync('obsidian', args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function evalInObsidian(code: string): unknown {
  const output = obsidian(['eval', `code=${code}`])
  // A console.warn/error fired during eval prints its own line(s) before the
  // return value, so the marker must be found anywhere in the output (not
  // just at the start) and only the text after the last occurrence parsed.
  const marker = '=> '
  const index = output.lastIndexOf(marker)
  const parsed: unknown = JSON.parse(index === -1 ? output : output.slice(index + marker.length))
  return parsed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Read the active (non-deleted) meta entry for a path, or null. fileId never changes across a rename.
function readActiveMetaEntry(path: string): ActiveMetaEntry | null {
  const value = evalInObsidian(`(() => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!map || typeof plugin?.readMetaEntry !== 'function') return JSON.stringify(null);
    const target = ${JSON.stringify(path)}.normalize('NFC').replace(/\\/+/g, '/').toLowerCase();
    for (const [fileId] of map.entries()) {
      const value = plugin.readMetaEntry(fileId);
      if (value && value.deleted === false && value.canonicalPath === target) {
        return JSON.stringify({ fileId, path: value.path, type: value.type, deleted: value.deleted });
      }
    }
    return JSON.stringify(null);
  })()`)
  if (value === null || isActiveMetaEntry(value)) {
    return value
  }
  throw new Error(`invalid active meta entry: ${JSON.stringify(value)}`)
}

async function waitForActiveMetaEntry(path: string): Promise<ActiveMetaEntry | null> {
  const deadline = Date.now() + 5000
  let entry = null
  while (Date.now() < deadline) {
    entry = readActiveMetaEntry(path)
    if (entry !== null) {
      return entry
    }
    await sleep(100)
  }
  return entry
}

function clearMetaIndexedDb() {
  obsidian([
    'eval',
    "code=(async () => { const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []; const names = databases.map((database) => database.name).filter((name) => name === 'kuroflare-meta' || name?.startsWith('kuroflare-meta:')); await Promise.all(names.map((name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve('deleted'); request.onerror = () => reject(request.error); request.onblocked = () => resolve('blocked'); }))); return 'deleted'; })()",
  ])
}

const vaultPath = requireSafeObsidianVaultPath(
  requireObsidianVaultPath(obsidian(['vault', 'info=path'])),
)
acquireObsidianE2ELock(vaultPath, runId)

// Fail fast with an actionable message if the worker isn't running, instead
// of surfacing as an opaque plugin-state timeout later on.
await seedWorkerSetupToken({ endpoint, adminSecret, vaultId, setupToken })

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])

// Start from a clean slate so the run is idempotent.
rmSync(join(vaultPath, notePath), { force: true })
rmSync(join(vaultPath, renamedPath), { force: true })
clearMetaIndexedDb()
copyPluginWithSetup({
  vaultPath,
  packageDir,
  pluginId,
  endpoint,
  setupVaultId: vaultId,
  setupToken,
  requestedDeviceName: 'Obsidian MVP-2 E2E',
  setupBootstrapMode: 'new-vault',
})
obsidian(['plugins:restrict', 'off'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
waitForPluginLoaded(pluginId, evalInObsidian)
waitForSetupReady(evalInObsidian)
// Setup exchange races the very first (pre-setup) active-view bind attempt,
// which logs a benign, already-tracked error; clear it now so the final
// dev:errors assertion only reflects this scenario's own steps below.
obsidian(['dev:errors', 'clear'])

// Create a note inside Obsidian so the plugin's vault 'create' watcher registers a meta entry.
evalInObsidian(
  `(async () => { await app.vault.create(${JSON.stringify(notePath)}, 'hello mvp2'); return JSON.stringify('created'); })()`,
)

const created = await waitForActiveMetaEntry(notePath)
if (created === null || typeof created.fileId !== 'string') {
  throw new Error(`no meta entry registered for created note: ${JSON.stringify(created)}`)
}
if (created.type !== 'text') {
  throw new Error(`expected a text meta entry, got: ${JSON.stringify(created)}`)
}

// Rename inside Obsidian. The file-tree invariant: the entry keeps its fileId; only the path updates.
evalInObsidian(`(async () => {
  await app.fileManager.renameFile(app.vault.getAbstractFileByPath(${JSON.stringify(notePath)}), ${JSON.stringify(renamedPath)});
  return JSON.stringify('renamed');
})()`)

const renamed = await waitForActiveMetaEntry(renamedPath)
if (renamed === null) {
  throw new Error('no active meta entry at the renamed path')
}
if (renamed.fileId !== created.fileId) {
  throw new Error(
    `rename minted a new fileId (delete+create) instead of updating the path: ${created.fileId} -> ${renamed.fileId}`,
  )
}
if (renamed.path !== renamedPath) {
  throw new Error(`renamed entry path mismatch: ${JSON.stringify(renamed)}`)
}

const oldStillActive = readActiveMetaEntry(notePath)
if (oldStillActive !== null) {
  throw new Error(
    `old path still has an active entry after rename: ${JSON.stringify(oldStillActive)}`,
  )
}

const errors = obsidian(['dev:errors'])
if (!errors.includes('No errors captured.')) {
  throw new Error(`Obsidian captured errors:\n${errors}`)
}

console.log(`Obsidian MVP-2 file-tree smoke passed: rename kept fileId ${created.fileId}`)
