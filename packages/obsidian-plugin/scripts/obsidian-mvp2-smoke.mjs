import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '..')
const pluginId = 'kuroflare'
const notePath = 'mvp2-note.md'
const renamedPath = 'mvp2-renamed.md'

function obsidian(args) {
  return execFileSync('obsidian', args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function evalInObsidian(code) {
  return JSON.parse(obsidian(['eval', `code=${code}`]).replace(/^=>\s*/, ''))
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function copyPlugin(vaultPath) {
  const targetDir = join(vaultPath, '.obsidian', 'plugins', pluginId)
  mkdirSync(targetDir, { recursive: true })
  for (const file of ['manifest.json', 'versions.json', 'main.js']) {
    copyFileSync(join(packageDir, file), join(targetDir, file))
  }
}

// Read the active (non-deleted) meta entry for a path, or null. fileId never changes across a rename.
function readActiveMetaEntry(path) {
  return evalInObsidian(`(() => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!map) return JSON.stringify(null);
    const target = ${JSON.stringify(path)}.normalize('NFC').replace(/\\/+/g, '/').toLowerCase();
    for (const [fileId, value] of map.entries()) {
      if (value && value.deleted === false && value.canonicalPath === target) {
        return JSON.stringify({ fileId, path: value.path, type: value.type, deleted: value.deleted });
      }
    }
    return JSON.stringify(null);
  })()`)
}

async function waitForActiveMetaEntry(path) {
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
    "code=new Promise((resolve) => { const r = indexedDB.deleteDatabase('kuroflare-meta'); r.onsuccess = () => resolve('deleted'); r.onerror = () => resolve('error'); r.onblocked = () => resolve('blocked'); })",
  ])
}

const vaultPath = obsidian(['vault', 'info=path'])
copyPlugin(vaultPath)

// Start from a clean slate so the run is idempotent.
rmSync(join(vaultPath, notePath), { force: true })
rmSync(join(vaultPath, renamedPath), { force: true })

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
clearMetaIndexedDb()
obsidian(['plugins:restrict', 'off'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])

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

// Rename inside Obsidian. The MVP-2 invariant: the entry keeps its fileId; only the path updates.
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
  throw new Error(`old path still has an active entry after rename: ${JSON.stringify(oldStillActive)}`)
}

const errors = obsidian(['dev:errors'])
if (!errors.includes('No errors captured.')) {
  throw new Error(`Obsidian captured errors:\n${errors}`)
}

console.log(`Obsidian MVP-2 file-tree smoke passed: rename kept fileId ${created.fileId}`)
