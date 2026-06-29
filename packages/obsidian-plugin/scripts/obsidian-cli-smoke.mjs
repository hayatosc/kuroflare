import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '..')
const pluginId = 'kuroflare'
const notePath = 'e2e-smoke.md'
const initialContent = 'initial smoke'

function obsidian(args) {
  return execFileSync('obsidian', args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function requireIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}:\n${value}`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForFileIncludes(path, expected) {
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

function copyPlugin(vaultPath) {
  const targetDir = join(vaultPath, '.obsidian', 'plugins', pluginId)
  mkdirSync(targetDir, { recursive: true })
  for (const file of ['manifest.json', 'versions.json', 'main.js']) {
    copyFileSync(join(packageDir, file), join(targetDir, file))
  }
}

function clearSpikeIndexedDb() {
  obsidian([
    'eval',
    "code=new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('kuroflare-cm6-spike'); request.onsuccess = () => resolve('deleted'); request.onerror = () => reject(request.error); request.onblocked = () => resolve('blocked'); })",
  ])
}

const vaultPath = obsidian(['vault', 'info=path'])
copyPlugin(vaultPath)

const noteFile = join(vaultPath, notePath)
writeFileSync(noteFile, initialContent)

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

const state = obsidian([
  'eval',
  'code=JSON.stringify({activeFile: app.workspace.getActiveFile()?.path, targetPath: app.plugins.plugins.kuroflare?.targetPath, yText: app.plugins.plugins.kuroflare?.ytext?.toJSON?.()})',
])
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

const errors = obsidian(['dev:errors'])
requireIncludes(errors, 'No errors captured.', 'dev errors')

console.log(`Obsidian CLI smoke passed for ${notePath}`)
