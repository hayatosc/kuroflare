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
const metaLocalPath = `meta-local-${runId}.md`
const metaPeerPath = `meta-peer-${runId}.md`
const metaSharedPath = `meta-shared-${runId}.md`
const binaryPath = `asset-${runId}.bin`
const initialFullSyncPath = `initial-full-sync-${runId}.md`
const initialFullSyncText = `Initial full sync snapshot content ${runId}`
const initialFullSyncFileId = `initial-full-sync-file-${runId}`
const initialFullSyncYDocId = `initial-full-sync-doc-${runId}`

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

function makeBinaryBytes() {
  const bytes = new Uint8Array(160 * 1024)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = (index * 31 + runId.charCodeAt(index % runId.length)) % 256
  }
  return bytes
}

function chunkFixed(bytes, size) {
  const chunks = []
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push({ offset, bytes: bytes.slice(offset, Math.min(offset + size, bytes.byteLength)) })
  }
  return chunks
}

function stringifyBlobManifest(manifest) {
  const chunks = manifest.chunks
    .map(
      (chunk) =>
        `{"sha256":${JSON.stringify(chunk.sha256)},"offset":${chunk.offset},"size":${chunk.size}}`,
    )
    .join(',')
  return (
    `{"version":1,` +
    `"fileId":${JSON.stringify(manifest.fileId)},` +
    `"contentSha256":${JSON.stringify(manifest.contentSha256)},` +
    `"size":${manifest.size},` +
    `"chunks":[${chunks}],` +
    `"createdBy":${JSON.stringify(manifest.createdBy)},` +
    `"createdAt":${manifest.createdAt}}`
  )
}

async function buildBinaryManifest(fileId, bytes, createdBy) {
  const chunks = []
  for (const chunk of chunkFixed(bytes, 64 * 1024)) {
    chunks.push({
      sha256: await sha256Hex(chunk.bytes),
      offset: chunk.offset,
      size: chunk.bytes.byteLength,
      bytes: chunk.bytes,
    })
  }
  const manifest = {
    version: 1,
    fileId,
    contentSha256: await sha256Hex(bytes),
    size: bytes.byteLength,
    chunks: chunks.map((chunk) => ({
      sha256: chunk.sha256,
      offset: chunk.offset,
      size: chunk.size,
    })),
    createdBy,
    createdAt: Date.now(),
  }
  const manifestBytes = new TextEncoder().encode(stringifyBlobManifest(manifest))
  return { manifest, manifestBytes, manifestHash: await sha256Hex(manifestBytes), chunks }
}

function activeDocIdForPath(path) {
  const hash = createHash('sha256').update(path).digest('hex')
  return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
}

function canonicalizeVaultPath(path) {
  return path.normalize('NFC').replace(/\/+/g, '/').toLowerCase()
}

function makeYTextUpdate(text) {
  const doc = new Y.Doc()
  doc.getText(yTextName).insert(0, text)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function makeMetaSnapshotUpdate(entries) {
  const doc = new Y.Doc()
  const map = doc.getMap('meta')
  for (const entry of entries) {
    map.set(entry.fileId, entry)
  }
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function metaPaths(doc) {
  return [...doc.getMap('meta').entries()]
    .map(([fileId, value]) => [fileId, value.path])
    .sort(([left], [right]) => left.localeCompare(right))
}

function renameMetaEntry(doc, fileId, toPath, deviceId, now) {
  const map = doc.getMap('meta')
  const entry = map.get(fileId)
  if (!entry || entry.type !== 'text') {
    throw new Error(`remote meta entry missing for ${fileId}`)
  }
  map.set(fileId, {
    ...entry,
    path: toPath,
    canonicalPath: canonicalizeVaultPath(toPath),
    updatedAt: now,
    updatedBy: deviceId,
    mtime: now,
  })
}

async function waitForRemoteMeta(remote, doc, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const message = await remote.waitFor(
      (candidate) => candidate.type === 'sync-update' && candidate.docId?.kind === 'meta',
      label,
      remaining,
    )
    Y.applyUpdate(doc, decodeBase64(message.update))
    if (predicate(doc)) {
      return message
    }
  }
  throw new Error(`${label} timed out; remote meta paths: ${JSON.stringify(metaPaths(doc))}`)
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

async function uploadBlobChunk(setup, chunk) {
  const uploadUrlResponse = await fetch(`${endpoint}/blobs/upload-url`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${setup.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sha256: chunk.sha256, size: chunk.bytes.byteLength }),
  })
  if (!uploadUrlResponse.ok) {
    throw new Error(
      `blob upload-url failed for ${chunk.sha256}: ${uploadUrlResponse.status} ${await uploadUrlResponse.text()}`,
    )
  }
  const uploadTarget = await uploadUrlResponse.json()
  if (uploadTarget.kind === 'already-exists') {
    return
  }
  if (uploadTarget.kind !== 'single-put') {
    throw new Error(`unexpected blob upload target: ${JSON.stringify(uploadTarget)}`)
  }
  const putResponse = await fetch(uploadTarget.url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${setup.accessToken}`,
      'content-length': String(chunk.bytes.byteLength),
      ...uploadTarget.headers,
    },
    body: chunk.bytes,
  })
  if (!putResponse.ok) {
    throw new Error(
      `blob PUT failed for ${chunk.sha256}: ${putResponse.status} ${await putResponse.text()}`,
    )
  }
}

async function uploadBlobManifest(setup, manifestHash, manifestBytes) {
  const response = await fetch(`${endpoint}/blob-manifests/${manifestHash}.json`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${setup.accessToken}`,
      'content-type': 'application/json',
      'content-length': String(manifestBytes.byteLength),
    },
    body: manifestBytes,
  })
  if (!response.ok) {
    throw new Error(`manifest PUT failed: ${response.status} ${await response.text()}`)
  }
}

async function downloadWorkerBytes(setup, path) {
  const response = await fetch(`${endpoint}${path}`, {
    headers: { authorization: `Bearer ${setup.accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`download failed for ${path}: ${response.status} ${await response.text()}`)
  }
  return new Uint8Array(await response.arrayBuffer())
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
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]
      if (waiter.predicate(message)) {
        waiters.splice(index, 1)
        clearTimeout(waiter.timeout)
        waiter.resolve(message)
        return
      }
    }
    messages.push(message)
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
    const existingIndex = messages.findIndex(predicate)
    if (existingIndex !== -1) {
      const [existing] = messages.splice(existingIndex, 1)
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

function readActiveMetaEntry(path) {
  return evalInObsidian(`(() => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!map) return JSON.stringify(null);
    const target = ${JSON.stringify(path)}.normalize('NFC').replace(/\\/+/g, '/').toLowerCase();
    for (const [fileId, value] of map.entries()) {
      if (value && value.deleted === false && value.canonicalPath === target) {
        return JSON.stringify({
          fileId,
          path: value.path,
          ydocId: value.ydocId,
          type: value.type,
          blobManifestHash: value.blobManifestHash,
          blobChunks: value.blobChunks,
        });
      }
    }
    return JSON.stringify(null);
  })()`)
}

async function waitForActiveMetaEntry(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entry = readActiveMetaEntry(path)
    if (entry !== null) {
      return entry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return readActiveMetaEntry(path)
}

async function waitForVaultPath(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exists = evalInObsidian(
      `(() => JSON.stringify(Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(path)}))))()`,
    )
    if (exists) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function waitForVaultFileIncludes(path, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = evalInObsidian(`(async () => {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      if (!file) return JSON.stringify({ exists: false, text: '' });
      return JSON.stringify({ exists: true, text: await app.vault.read(file) });
    })()`)
    if (result.exists === true && result.text.includes(expected)) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return evalInObsidian(`(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    if (!file) return JSON.stringify({ exists: false, text: '' });
    return JSON.stringify({ exists: true, text: await app.vault.read(file) });
  })()`)
}

function clearTextIndexedDb() {
  obsidian([
    'eval',
    "code=(async () => { const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []; const names = databases.map((database) => database.name).filter((name) => name?.startsWith('kuroflare-file:')); await Promise.all(names.map((name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve('deleted'); request.onerror = () => reject(request.error); request.onblocked = () => resolve('blocked'); }))); return 'deleted'; })()",
  ])
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
const initialFullSyncUpdate = makeYTextUpdate(initialFullSyncText)
const now = Date.now()
const initialMetaUpdate = makeMetaSnapshotUpdate([
  {
    schemaVersion: 1,
    fileId: initialFullSyncFileId,
    path: initialFullSyncPath,
    canonicalPath: canonicalizeVaultPath(initialFullSyncPath),
    type: 'text',
    ydocId: initialFullSyncYDocId,
    deleted: false,
    createdAt: now,
    createdBy: 'remote-seed',
    contentUpdatedAt: now,
    contentUpdatedBy: 'remote-seed',
    updatedAt: now,
    updatedBy: 'remote-seed',
    mtime: now,
  },
])
await seedSetupToken(setupToken)
await seedSnapshot({ kind: 'meta' }, initialMetaUpdate)
await seedSnapshot({ kind: 'file', ydocId: initialFullSyncYDocId }, initialFullSyncUpdate)
await seedSnapshot(docId, seedUpdate)

const vaultPath = obsidian(['vault', 'info=path'])
copyPlugin(vaultPath)

writeFileSync(join(vaultPath, notePath), `Obsidian Miniflare local placeholder ${runId}`)

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
obsidian(['open', `path=${notePath}`])
clearTextIndexedDb()
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

const initialFullSyncResult = await waitForVaultFileIncludes(
  initialFullSyncPath,
  initialFullSyncText,
)
if (
  initialFullSyncResult.exists !== true ||
  !initialFullSyncResult.text.includes(initialFullSyncText)
) {
  throw new Error(
    `plugin did not materialize initial full sync file: ${JSON.stringify(initialFullSyncResult)}`,
  )
}

await seedSetupToken(remoteSetupToken)
const remoteSetup = await exchangeSetupToken(remoteSetupToken, 'Remote WebSocket E2E')
const remote = await connectRemoteDevice(remoteSetup)
const remoteObservedDoc = new Y.Doc()
const remoteMetaDoc = new Y.Doc()
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

  evalInObsidian(`(async () => {
    await app.vault.create(${JSON.stringify(metaLocalPath)}, 'local meta rename source');
    await app.vault.create(${JSON.stringify(metaPeerPath)}, 'peer meta rename source');
    return JSON.stringify('created');
  })()`)
  const localMetaEntry = await waitForActiveMetaEntry(metaLocalPath)
  const peerMetaEntry = await waitForActiveMetaEntry(metaPeerPath)
  if (localMetaEntry === null || peerMetaEntry === null) {
    throw new Error(
      `Obsidian did not register meta entries: ${JSON.stringify({ localMetaEntry, peerMetaEntry })}`,
    )
  }
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const map = doc.getMap('meta')
      return map.has(localMetaEntry.fileId) && map.has(peerMetaEntry.fileId)
    },
    'remote meta create broadcast',
  )

  const remoteMetaBaseVector = Y.encodeStateVector(remoteMetaDoc)
  evalInObsidian(`(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(metaLocalPath)});
    if (!file) return JSON.stringify({ renamed: false, reason: 'missing-local-file' });
    await app.fileManager.renameFile(file, ${JSON.stringify(metaSharedPath)});
    return JSON.stringify({ renamed: true });
  })()`)
  renameMetaEntry(
    remoteMetaDoc,
    peerMetaEntry.fileId,
    metaSharedPath,
    remoteSetup.deviceId,
    Date.now(),
  )
  const remoteMetaRenameUpdate = Y.encodeStateAsUpdate(remoteMetaDoc, remoteMetaBaseVector)
  remote.socket.send(
    JSON.stringify({
      type: 'sync-update',
      protocolVersion: 1,
      vaultId,
      deviceId: remoteSetup.deviceId,
      messageId: `remote-meta-rename-${runId}`,
      docId: { kind: 'meta' },
      update: encodeBase64(remoteMetaRenameUpdate),
      updateSha256: await sha256Hex(remoteMetaRenameUpdate),
    }),
  )
  await remote.waitFor(
    (message) => message.type === 'ack' && message.messageId === `remote-meta-rename-${runId}`,
    'remote meta rename ack',
  )

  const peerConflictPath = metaSharedPath.replace(
    /\.md$/,
    ` (conflict ${peerMetaEntry.fileId.slice(0, 8)}).md`,
  )
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const map = doc.getMap('meta')
      return (
        map.get(localMetaEntry.fileId)?.path === metaSharedPath &&
        map.get(peerMetaEntry.fileId)?.path === peerConflictPath
      )
    },
    'remote meta conflict repair broadcast',
  )

  const sharedEntry = await waitForActiveMetaEntry(metaSharedPath)
  const conflictEntry = await waitForActiveMetaEntry(peerConflictPath)
  if (
    sharedEntry?.fileId !== localMetaEntry.fileId ||
    conflictEntry?.fileId !== peerMetaEntry.fileId
  ) {
    throw new Error(
      `meta conflict did not converge deterministically: ${JSON.stringify({
        sharedEntry,
        conflictEntry,
        expectedSharedFileId: localMetaEntry.fileId,
        expectedConflictFileId: peerMetaEntry.fileId,
        remoteMetaPaths: metaPaths(remoteMetaDoc),
      })}`,
    )
  }
  if (!(await waitForVaultPath(metaSharedPath)) || !(await waitForVaultPath(peerConflictPath))) {
    throw new Error(
      `meta rename was not materialized on disk: ${JSON.stringify({
        metaSharedPath,
        peerConflictPath,
      })}`,
    )
  }

  const binaryFileId = `binary-${runId}`
  const binaryBytes = makeBinaryBytes()
  const builtBinary = await buildBinaryManifest(binaryFileId, binaryBytes, remoteSetup.deviceId)
  for (const chunk of builtBinary.chunks) {
    await uploadBlobChunk(remoteSetup, chunk)
  }
  await uploadBlobManifest(remoteSetup, builtBinary.manifestHash, builtBinary.manifestBytes)

  const binaryMetaBaseVector = Y.encodeStateVector(remoteMetaDoc)
  remoteMetaDoc.getMap('meta').set(binaryFileId, {
    schemaVersion: 1,
    fileId: binaryFileId,
    path: binaryPath,
    canonicalPath: canonicalizeVaultPath(binaryPath),
    type: 'binary',
    blobManifestHash: builtBinary.manifestHash,
    blobChunks: builtBinary.manifest.chunks.map((chunk) => chunk.sha256),
    deleted: false,
    createdAt: builtBinary.manifest.createdAt,
    createdBy: remoteSetup.deviceId,
    contentUpdatedAt: builtBinary.manifest.createdAt,
    contentUpdatedBy: remoteSetup.deviceId,
    updatedAt: builtBinary.manifest.createdAt,
    updatedBy: remoteSetup.deviceId,
    mtime: builtBinary.manifest.createdAt,
  })
  const binaryMetaUpdate = Y.encodeStateAsUpdate(remoteMetaDoc, binaryMetaBaseVector)
  remote.socket.send(
    JSON.stringify({
      type: 'sync-update',
      protocolVersion: 1,
      vaultId,
      deviceId: remoteSetup.deviceId,
      messageId: `remote-binary-meta-${runId}`,
      docId: { kind: 'meta' },
      update: encodeBase64(binaryMetaUpdate),
      updateSha256: await sha256Hex(binaryMetaUpdate),
    }),
  )
  await remote.waitFor(
    (message) => message.type === 'ack' && message.messageId === `remote-binary-meta-${runId}`,
    'remote binary meta ack',
  )

  const binaryEntry = await waitForActiveMetaEntry(binaryPath)
  if (
    binaryEntry?.type !== 'binary' ||
    binaryEntry.blobManifestHash !== builtBinary.manifestHash ||
    JSON.stringify(binaryEntry.blobChunks) !==
      JSON.stringify(builtBinary.manifest.chunks.map((chunk) => chunk.sha256))
  ) {
    throw new Error(
      `binary meta reference was not published to Obsidian: ${JSON.stringify({
        binaryEntry,
        expectedManifestHash: builtBinary.manifestHash,
        expectedChunks: builtBinary.manifest.chunks.map((chunk) => chunk.sha256),
      })}`,
    )
  }

  const downloadedManifestBytes = await downloadWorkerBytes(
    remoteSetup,
    `/blob-manifests/${builtBinary.manifestHash}.json`,
  )
  if ((await sha256Hex(downloadedManifestBytes)) !== builtBinary.manifestHash) {
    throw new Error('downloaded manifest hash mismatch')
  }
  const downloadedChunks = []
  for (const chunk of builtBinary.manifest.chunks) {
    const downloaded = await downloadWorkerBytes(remoteSetup, `/blobs/${chunk.sha256}`)
    if ((await sha256Hex(downloaded)) !== chunk.sha256) {
      throw new Error(`downloaded blob chunk hash mismatch: ${chunk.sha256}`)
    }
    downloadedChunks.push(downloaded)
  }
  const reassembled = Buffer.concat(downloadedChunks.map((chunk) => Buffer.from(chunk)))
  if ((await sha256Hex(reassembled)) !== builtBinary.manifest.contentSha256) {
    throw new Error('reassembled binary content hash mismatch')
  }
} finally {
  remoteObservedDoc.destroy()
  remoteMetaDoc.destroy()
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

console.log(`Obsidian Miniflare sync, meta, and binary smoke passed for ${result.setupVaultId}`)
