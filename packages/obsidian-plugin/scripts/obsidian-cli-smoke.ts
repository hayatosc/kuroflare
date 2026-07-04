import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '..')
const pluginId = 'kuroflare'
const notePath = 'e2e-smoke.md'
const secondNotePath = 'e2e-smoke-second.md'
const initialContent = 'initial smoke'
const secondContent = 'second smoke'

function obsidian(args: readonly string[]): string {
  return execFileSync('obsidian', args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function requireIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}:\n${value}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForFileIncludes(path: string, expected: string): Promise<string> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const content = readFileSync(path, 'utf8')
    if (content.includes(expected)) {
      return content
    }
    await sleep(100)
  }
  return readFileSync(path, 'utf8')
}

async function waitForEvalIncludes(code: string, expected: string): Promise<string> {
  const deadline = Date.now() + 5000
  let output = ''
  while (Date.now() < deadline) {
    output = obsidian(['eval', `code=${code}`])
    if (output.includes(expected)) {
      return output
    }
    await sleep(100)
  }
  return output
}

function evalInObsidian(code: string): unknown {
  const parsed: unknown = JSON.parse(obsidian(['eval', `code=${code}`]).replace(/^=>\s*/, ''))
  return parsed
}

function listConflictCopies(vaultPath: string, basename: string): string[] {
  return readdirSync(vaultPath)
    .filter((name) => name.startsWith(`${basename} (kuroflare conflict `) && name.endsWith('.md'))
    .sort()
}

async function waitForNewConflictCopy(
  vaultPath: string,
  basename: string,
  before: readonly string[],
): Promise<{ readonly after: string[]; readonly created: string[] }> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const after = listConflictCopies(vaultPath, basename)
    const created = after.filter((path) => !before.includes(path))
    if (created.length > 0) {
      return { after, created }
    }
    await sleep(100)
  }
  const after = listConflictCopies(vaultPath, basename)
  return { after, created: after.filter((path) => !before.includes(path)) }
}

function copyPlugin(vaultPath: string): void {
  const targetDir = join(vaultPath, '.obsidian', 'plugins', pluginId)
  mkdirSync(targetDir, { recursive: true })
  for (const file of ['manifest.json', 'versions.json', 'main.js']) {
    copyFileSync(join(packageDir, file), join(targetDir, file))
  }
}

function clearSpikeIndexedDb() {
  obsidian([
    'eval',
    "code=(async () => { const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [{ name: 'kuroflare-cm6-spike' }]; const names = databases.map((database) => database.name).filter((name) => name === 'kuroflare-cm6-spike' || name?.startsWith('kuroflare-file:')); await Promise.all(names.map((name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve('deleted'); request.onerror = () => reject(request.error); request.onblocked = () => resolve('blocked'); }))); return 'deleted'; })()",
  ])
}

const vaultPath = obsidian(['vault', 'info=path'])
copyPlugin(vaultPath)

const noteFile = join(vaultPath, notePath)
writeFileSync(noteFile, initialContent)
const secondNoteFile = join(vaultPath, secondNotePath)
writeFileSync(secondNoteFile, secondContent)

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
obsidian(['open', `path=${notePath}`])
clearSpikeIndexedDb()
obsidian(['plugins:restrict', 'off'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])

const commands = obsidian(['commands', 'filter=kuroflare'])
requireIncludes(commands, 'kuroflare:kuroflare-spike-simulate-remote-insert', 'commands')
requireIncludes(commands, 'kuroflare:kuroflare-spike-flush-ytext-to-disk', 'commands')

const state = await waitForEvalIncludes(
  'code=JSON.stringify({activeFile: app.workspace.getActiveFile()?.path, targetPath: app.plugins.plugins.kuroflare?.targetPath, yText: app.plugins.plugins.kuroflare?.ytext?.toJSON?.()})',
  initialContent,
)
requireIncludes(state, `"activeFile":"${notePath}"`, 'plugin state')
requireIncludes(state, `"targetPath":"${notePath}"`, 'plugin state')
requireIncludes(state, `"yText":"${initialContent}"`, 'plugin state')

obsidian(['command', 'id=kuroflare:kuroflare-spike-simulate-remote-insert'])
const afterInsert = obsidian([
  'eval',
  'code=JSON.stringify({yText: app.plugins.plugins.kuroflare.ytext.toJSON(), editorText: app.workspace.activeLeaf?.view?.editor?.getValue?.()})',
])
requireIncludes(afterInsert, 'remote ', 'after insert state')

obsidian(['command', 'id=kuroflare:kuroflare-spike-flush-ytext-to-disk'])

const diskContent = await waitForFileIncludes(noteFile, 'remote ')
requireIncludes(diskContent, initialContent, 'disk content')
requireIncludes(diskContent, 'remote ', 'disk content')

// Other round-trip leg: an external disk edit (git pull / another app) is imported
// into YText via the vault watcher + hash gate, not overwritten by stale YText.
const externalMarker = 'external edit applied'
writeFileSync(noteFile, `${initialContent}\n${externalMarker}`)

const importedYText = await waitForEvalIncludes(
  'code=JSON.stringify({yText: app.plugins.plugins.kuroflare?.ytext?.toJSON?.()})',
  externalMarker,
)
requireIncludes(importedYText, externalMarker, 'YText after external disk edit')

obsidian(['open', `path=${secondNotePath}`])
const secondState = await waitForEvalIncludes(
  'code=JSON.stringify({activeFile: app.workspace.getActiveFile()?.path, targetPath: app.plugins.plugins.kuroflare?.targetPath, yText: app.plugins.plugins.kuroflare?.ytext?.toJSON?.()})',
  secondContent,
)
requireIncludes(secondState, `"activeFile":"${secondNotePath}"`, 'second file state')
requireIncludes(secondState, `"targetPath":"${secondNotePath}"`, 'second file state')
requireIncludes(secondState, `"yText":"${secondContent}"`, 'second file state')

obsidian(['command', 'id=kuroflare:kuroflare-spike-simulate-remote-insert'])
const secondAfterInsert = await waitForEvalIncludes(
  'code=JSON.stringify({yText: app.plugins.plugins.kuroflare?.ytext?.toJSON?.()})',
  'remote ',
)
requireIncludes(secondAfterInsert, secondContent, 'second YText after insert')

obsidian(['open', `path=${notePath}`])
const firstRestored = await waitForEvalIncludes(
  'code=JSON.stringify({activeFile: app.workspace.getActiveFile()?.path, yText: app.plugins.plugins.kuroflare?.ytext?.toJSON?.()})',
  externalMarker,
)
requireIncludes(firstRestored, `"activeFile":"${notePath}"`, 'first file restored state')
requireIncludes(firstRestored, externalMarker, 'first file restored state')
if (firstRestored.includes(secondContent)) {
  throw new Error(`first file YText contains second file content: ${firstRestored}`)
}

const conflictCopiesBefore = listConflictCopies(vaultPath, 'e2e-smoke')
evalInObsidian(`(() => {
  const plugin = app.plugins.plugins.kuroflare;
  if (!plugin?.fileModifyRef) return JSON.stringify({ disabled: false });
  app.vault.offref(plugin.fileModifyRef);
  plugin.fileModifyRef = null;
  return JSON.stringify({ disabled: true });
})()`)
const watcherDropMarker = 'watcher drop external edit'
writeFileSync(noteFile, `${initialContent}\n${watcherDropMarker}`)
evalInObsidian(`(() => {
  const plugin = app.plugins.plugins.kuroflare;
  plugin.lastMaterialized.set(${JSON.stringify(notePath)}, {
    diskHash: 'stale-disk-hash',
    ydocHash: 'stale-ydoc-hash',
    path: ${JSON.stringify(notePath)},
    writtenAt: Date.now(),
  });
  return JSON.stringify('stale-last-materialized');
})()`)
obsidian(['command', 'id=kuroflare:kuroflare-spike-simulate-remote-insert'])
evalInObsidian(`(async () => {
  const plugin = app.plugins.plugins.kuroflare;
  const warn = console.warn;
  plugin.lastMaterialized.set(${JSON.stringify(notePath)}, {
    diskHash: 'stale-disk-hash',
    ydocHash: 'stale-ydoc-hash',
    path: ${JSON.stringify(notePath)},
    writtenAt: Date.now(),
  });
  console.warn = () => {};
  try {
    await plugin.flushYTextToDisk('e2e-watcher-drop');
  } finally {
    console.warn = warn;
  }
  return JSON.stringify('flushed');
})()`)

const diskAfterBlockedFlush = readFileSync(noteFile, 'utf8')
requireIncludes(diskAfterBlockedFlush, watcherDropMarker, 'disk after watcher-drop flush')
if (diskAfterBlockedFlush.includes('remote ')) {
  throw new Error(`watcher-drop flush overwrote disk with stale YText: ${diskAfterBlockedFlush}`)
}

const { after: conflictCopiesAfter, created: newConflictCopies } = await waitForNewConflictCopy(
  vaultPath,
  'e2e-smoke',
  conflictCopiesBefore,
)
if (newConflictCopies.length !== 1) {
  throw new Error(
    `expected one new conflict copy after watcher-drop flush: ${JSON.stringify({
      before: conflictCopiesBefore,
      after: conflictCopiesAfter,
    })}`,
  )
}
const newConflictCopy = newConflictCopies[0]
if (newConflictCopy === undefined) {
  throw new Error('missing watcher-drop conflict copy')
}
const conflictContent = readFileSync(join(vaultPath, newConflictCopy), 'utf8')
requireIncludes(conflictContent, watcherDropMarker, 'watcher-drop conflict copy')

const errors = obsidian(['dev:errors'])
requireIncludes(errors, 'No errors captured.', 'dev errors')

console.log(`Obsidian CLI smoke passed for ${notePath}`)
