import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Y from 'yjs'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '..')
const pluginId = 'kuroflare'
const notePath = 'e2e-miniflare.md'

const endpoint = process.env.KUROFLARE_E2E_ENDPOINT ?? 'http://127.0.0.1:8787'
const seedSecret = process.env.KUROFLARE_E2E_SEED_SECRET ?? 'e2e-seed-secret'
const runId = Date.now().toString(36)
const vaultId = process.env.KUROFLARE_E2E_VAULT_ID ?? `obsidian-miniflare-e2e-${runId}`
const setupToken = process.env.KUROFLARE_E2E_SETUP_TOKEN ?? `setup-token-${runId}`
const remoteSetupToken = `${setupToken}-remote`
const yTextName = 'fixed-file'
const remoteSeedText = `R2 seeded content ${runId}`
const remotePeerText = `Remote peer edit ${runId}`
const localObsidianText = `Obsidian local edit ${runId}`

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

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function decodeBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

async function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function activeDocIdForPath(path) {
  const hash = createHash('sha256').update(path).digest('hex')
  return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
}

function makeYTextUpdate(text) {
  const doc = new Y.Doc()
  doc.getText(yTextName).insert(0, text)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

async function seedSetupToken(token) {
  const response = await fetch(`${endpoint}/__e2e/setup-token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kuroflare-e2e-secret': seedSecret,
    },
    body: JSON.stringify({
      vaultId,
      setupToken: token,
      expiresInMs: 10 * 60 * 1000,
    }),
  })
  if (!response.ok) {
    throw new Error(`setup token seed failed: ${response.status} ${await response.text()}`)
  }
}

async function seedSnapshot(docId, update) {
  const response = await fetch(`${endpoint}/__e2e/snapshot`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kuroflare-e2e-secret': seedSecret,
    },
    body: JSON.stringify({
      vaultId,
      docId,
      update: encodeBase64(update),
      latestSeq: 1,
    }),
  })
  if (!response.ok) {
    throw new Error(`snapshot seed failed: ${response.status} ${await response.text()}`)
  }
}

async function exchangeSetupToken(token, requestedDeviceName) {
  const response = await fetch(`${endpoint}/setup/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vaultId,
      setupToken: token,
      requestedDeviceName,
    }),
  })
  if (!response.ok) {
    throw new Error(`setup exchange failed: ${response.status} ${await response.text()}`)
  }
  return await response.json()
}

function workerWebSocketUrl(setup) {
  const url = new URL(setup.endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${encodeURIComponent(setup.vaultId)}`
  url.searchParams.set('access_token', setup.accessToken)
  url.hash = ''
  return url.toString()
}

async function connectRemoteDevice(setup) {
  if (typeof WebSocket !== 'function') {
    throw new Error('global WebSocket is unavailable in this Node runtime')
  }

  const socket = new WebSocket(workerWebSocketUrl(setup))
  const messages = []
  const waiters = []
  const failWaiters = (error) => {
    while (waiters.length > 0) {
      waiters.shift().reject(error)
    }
  }
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    messages.push(message)
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]
      if (waiter.predicate(message)) {
        waiters.splice(index, 1)
        clearTimeout(waiter.timeout)
        waiter.resolve(message)
        break
      }
    }
  })
  socket.addEventListener('close', (event) => {
    failWaiters(new Error(`remote websocket closed: ${event.code} ${event.reason}`))
  })
  socket.addEventListener('error', () => {
    failWaiters(new Error('remote websocket error'))
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('remote websocket open failed')), {
      once: true,
    })
  })

  const waitFor = (predicate, label, timeoutMs = 5000) => {
    const existing = messages.find(predicate)
    if (existing !== undefined) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const seen = messages.map((message) => message.type).join(', ')
        reject(new Error(`${label} timed out; seen messages: ${seen}`))
      }, timeoutMs)
      waiters.push({ predicate, resolve, reject, timeout })
    })
  }

  socket.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      vaultId: setup.vaultId,
      deviceId: setup.deviceId,
      yClientId: setup.yClientId,
      capabilities: [],
    }),
  )
  await waitFor(
    (message) =>
      message.type === 'hello-accepted' &&
      message.vaultId === setup.vaultId &&
      message.deviceId === setup.deviceId &&
      message.yClientId === setup.yClientId,
    'remote hello',
  )

  return { socket, waitFor, close: () => socket.close(1000, 'e2e-complete') }
}

function evalInObsidian(code) {
  const output = obsidian(['eval', `code=${code}`])
  return JSON.parse(output.replace(/^=>\s*/, ''))
}

function copyPlugin(vaultPath) {
  const targetDir = join(vaultPath, '.obsidian', 'plugins', pluginId)
  mkdirSync(targetDir, { recursive: true })
  for (const file of ['manifest.json', 'versions.json', 'main.js']) {
    copyFileSync(join(packageDir, file), join(targetDir, file))
  }
  writeFileSync(
    join(targetDir, 'data.json'),
    JSON.stringify(
      {
        endpoint,
        setupVaultId: vaultId,
        setupToken,
        requestedDeviceName: 'Obsidian CLI E2E',
        setupBootstrapMode: 'join-existing',
      },
      null,
      2,
    ),
  )
}

const docId = activeDocIdForPath(notePath)
const seedUpdate = makeYTextUpdate(remoteSeedText)
await seedSetupToken(setupToken)
await seedSnapshot(docId, seedUpdate)

const vaultPath = obsidian(['vault', 'info=path'])
copyPlugin(vaultPath)

writeFileSync(join(vaultPath, notePath), `Obsidian Miniflare local placeholder ${runId}`)

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
obsidian(['open', `path=${notePath}`])
obsidian(['plugins:restrict', 'off'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

const result = evalInObsidian(`(async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const plugin = app.plugins.plugins.kuroflare;
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
    const fileText = file ? await app.vault.read(file) : '';
    const state = {
      setupVaultId: plugin?.kuroflareSettings?.setupResponse?.vaultId,
      setupToken: plugin?.kuroflareSettings?.setupToken,
      connected: plugin?.workerHelloAccepted,
      socketReadyState: plugin?.workerSocket?.readyState,
      activeFile: app.workspace.getActiveFile()?.path,
      fileText,
    };
    if (state.setupVaultId === ${JSON.stringify(vaultId)} && state.setupToken === '' && state.connected === true && state.socketReadyState === WebSocket.OPEN && state.fileText.includes(${JSON.stringify(remoteSeedText)})) {
      return JSON.stringify(state);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const plugin = app.plugins.plugins.kuroflare;
  const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
  return JSON.stringify({
    setupVaultId: plugin?.kuroflareSettings?.setupResponse?.vaultId,
    setupToken: plugin?.kuroflareSettings?.setupToken,
    connected: plugin?.workerHelloAccepted,
    socketReadyState: plugin?.workerSocket?.readyState,
    activeFile: app.workspace.getActiveFile()?.path,
    fileText: file ? await app.vault.read(file) : '',
  });
})()`)

if (
  result.setupVaultId !== vaultId ||
  result.connected !== true ||
  result.socketReadyState !== 1 ||
  result.setupToken !== '' ||
  !result.fileText.includes(remoteSeedText)
) {
  throw new Error(`plugin did not sync R2 snapshot from Worker: ${JSON.stringify(result)}`)
}

await seedSetupToken(remoteSetupToken)
const remoteSetup = await exchangeSetupToken(remoteSetupToken, 'Remote WebSocket E2E')
const remote = await connectRemoteDevice(remoteSetup)
const remoteObservedDoc = new Y.Doc()
Y.applyUpdate(remoteObservedDoc, seedUpdate)
try {
  const remotePeerUpdate = makeYTextUpdate(remotePeerText)
  remote.socket.send(
    JSON.stringify({
      type: 'sync-update',
      protocolVersion: 1,
      vaultId,
      deviceId: remoteSetup.deviceId,
      messageId: `remote-${runId}`,
      docId,
      update: encodeBase64(remotePeerUpdate),
      updateSha256: await sha256Hex(remotePeerUpdate),
    }),
  )
  await remote.waitFor(
    (message) => message.type === 'ack' && message.messageId === `remote-${runId}`,
    'remote update ack',
  )

  const remoteEditResult = evalInObsidian(`(async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
      const fileText = file ? await app.vault.read(file) : '';
      if (fileText.includes(${JSON.stringify(remotePeerText)})) {
        return JSON.stringify({ fileText });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
    return JSON.stringify({ fileText: file ? await app.vault.read(file) : '' });
  })()`)
  requireIncludes(remoteEditResult.fileText, remotePeerText, 'Obsidian file after remote edit')

  Y.applyUpdate(remoteObservedDoc, remotePeerUpdate)
  const localEditResult = evalInObsidian(`(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
    if (!file) {
      return JSON.stringify({ edited: false, hasFile: false });
    }
    const before = await app.vault.read(file);
    await app.vault.modify(file, before + ${JSON.stringify(`\n${localObsidianText}`)});
    return JSON.stringify({ edited: true, length: before.length + ${JSON.stringify(`\n${localObsidianText}`)}.length });
  })()`)
  if (localEditResult.edited !== true) {
    throw new Error(`Obsidian editor edit failed: ${JSON.stringify(localEditResult)}`)
  }
  obsidian(['command', 'id=kuroflare:kuroflare-sync-import-and-send-active-file'])
  await remote.waitFor((message) => {
    if (message.type !== 'sync-update' || message.deviceId === remoteSetup.deviceId) {
      return false
    }
    Y.applyUpdate(remoteObservedDoc, decodeBase64(message.update))
    return remoteObservedDoc.getText(yTextName).toJSON().includes(localObsidianText)
  }, 'local obsidian edit broadcast')
} finally {
  remoteObservedDoc.destroy()
  remote.close()
}

obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

const reconnectResult = evalInObsidian(`(async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const plugin = app.plugins.plugins.kuroflare;
    const state = {
      setupVaultId: plugin?.kuroflareSettings?.setupResponse?.vaultId,
      setupToken: plugin?.kuroflareSettings?.setupToken,
      connected: plugin?.workerHelloAccepted,
      socketReadyState: plugin?.workerSocket?.readyState,
    };
    if (state.setupVaultId === ${JSON.stringify(vaultId)} && state.setupToken === '' && state.connected === true && state.socketReadyState === WebSocket.OPEN) {
      return JSON.stringify(state);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const plugin = app.plugins.plugins.kuroflare;
  return JSON.stringify({
    setupVaultId: plugin?.kuroflareSettings?.setupResponse?.vaultId,
    setupToken: plugin?.kuroflareSettings?.setupToken,
    connected: plugin?.workerHelloAccepted,
    socketReadyState: plugin?.workerSocket?.readyState,
  });
})()`)

if (
  reconnectResult.setupVaultId !== vaultId ||
  reconnectResult.setupToken !== '' ||
  reconnectResult.connected !== true ||
  reconnectResult.socketReadyState !== 1
) {
  throw new Error(`plugin did not reconnect to Worker: ${JSON.stringify(reconnectResult)}`)
}

const errors = obsidian(['dev:errors'])
requireIncludes(errors, 'No errors captured.', 'dev errors')

console.log(
  `Obsidian Miniflare R2 sync and concurrent edit smoke passed for ${result.setupVaultId}`,
)
