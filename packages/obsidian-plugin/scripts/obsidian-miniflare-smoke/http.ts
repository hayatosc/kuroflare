import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  endpoint,
  vaultId,
  adminSecret,
  packageDir,
  pluginDir,
  runId,
  requireRecord,
  isRecord,
  stringRecord,
  isSnapshotImportCliResult,
  isSetupExchangeResponse,
  isBlobManifest,
} from './types.ts'
import type {
  SourceBinaryChunk,
  BinaryChunk,
  BlobManifest,
  BuiltBinaryManifest,
  SetupExchangeResponse,
  RemotePeer,
  RemoteWaiter,
  JsonRecord,
  SnapshotImportCliResult,
} from './types.ts'
import { encodeBase64, decodeBase64, sha256Hex } from './yjs.ts'

function makeBinaryBytes(): Uint8Array {
  const bytes = new Uint8Array(160 * 1024)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const blockSalt = Math.floor(index / (64 * 1024))
    bytes[index] = (index * 31 + blockSalt * 17 + runId.charCodeAt(index % runId.length)) % 256
  }
  return bytes
}

function makeLocalBinaryBytes(): Uint8Array {
  const bytes = makeBinaryBytes()
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) {
      throw new Error(`missing local binary byte at ${index}`)
    }
    bytes[index] = byte ^ 0xa5
  }
  return bytes
}

function chunkFixed(bytes: Uint8Array, size: number): SourceBinaryChunk[] {
  const chunks: SourceBinaryChunk[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push({ offset, bytes: bytes.slice(offset, Math.min(offset + size, bytes.byteLength)) })
  }
  return chunks
}

function stringifyBlobManifest(manifest: BlobManifest): string {
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

async function buildBinaryManifest(
  fileId: string,
  bytes: Uint8Array,
  createdBy: string,
): Promise<BuiltBinaryManifest> {
  const chunks: BinaryChunk[] = []
  for (const chunk of chunkFixed(bytes, 64 * 1024)) {
    chunks.push({
      sha256: await sha256Hex(chunk.bytes),
      offset: chunk.offset,
      size: chunk.bytes.byteLength,
      bytes: chunk.bytes,
    })
  }
  const manifest: BlobManifest = {
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

async function seedSetupToken(token: string): Promise<void> {
  const response = await fetch(`${endpoint}/admin/setup-tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kuroflare-admin-secret': adminSecret,
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

function importBootstrapSnapshotsWithCli(input: {
  readonly setupToken: string
  readonly metaUpdate: Uint8Array
  readonly files: readonly {
    readonly ydocId: string
    readonly update: Uint8Array
  }[]
}): SnapshotImportCliResult {
  const dir = mkdtempSync(join(tmpdir(), 'kuroflare-snapshot-import-'))
  const inputPath = join(dir, 'snapshots.json')
  writeFileSync(
    inputPath,
    JSON.stringify({
      meta: { updateBytesBase64: encodeBase64(input.metaUpdate), metadataSchemaVersion: 2 },
      files: input.files.map((file) => ({
        ydocId: file.ydocId,
        updateBytesBase64: encodeBase64(file.update),
      })),
    }),
  )
  const output = execFileSync(
    'node',
    [
      '--experimental-strip-types',
      join(pluginDir, '..', 'kuroflare-snapshot-import.ts'),
      '--endpoint',
      endpoint,
      '--vault-id',
      vaultId,
      '--setup-token',
      input.setupToken,
      '--device-name',
      'CLI Snapshot Import E2E',
      '--input',
      inputPath,
    ],
    {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
  const parsed: unknown = JSON.parse(output)
  if (!isSnapshotImportCliResult(parsed)) {
    throw new Error(`invalid snapshot import CLI result: ${output}`)
  }
  if (parsed.imports.length !== input.files.length + 1) {
    throw new Error(`snapshot import CLI imported wrong count: ${output}`)
  }
  return parsed
}

async function uploadBlobChunk(setup: SetupExchangeResponse, chunk: BinaryChunk): Promise<void> {
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
  const uploadTarget = requireRecord(await uploadUrlResponse.json(), 'blob upload target')
  if (uploadTarget.kind === 'already-exists') {
    return
  }
  if (uploadTarget.kind !== 'single-put') {
    throw new Error(`unexpected blob upload target: ${JSON.stringify(uploadTarget)}`)
  }
  if (typeof uploadTarget.url !== 'string') {
    throw new Error(`blob upload target missing URL: ${JSON.stringify(uploadTarget)}`)
  }
  const uploadHeaders =
    uploadTarget.headers === undefined ? {} : stringRecord(uploadTarget.headers, 'upload headers')
  const putResponse = await fetch(uploadTarget.url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${setup.accessToken}`,
      'content-length': String(chunk.bytes.byteLength),
      ...uploadHeaders,
    },
    body: Buffer.from(chunk.bytes),
  })
  if (!putResponse.ok) {
    throw new Error(
      `blob PUT failed for ${chunk.sha256}: ${putResponse.status} ${await putResponse.text()}`,
    )
  }
}

async function uploadBlobManifest(
  setup: SetupExchangeResponse,
  manifestHash: string,
  manifestBytes: Uint8Array,
): Promise<void> {
  const response = await fetch(`${endpoint}/blob-manifests/${manifestHash}.json`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${setup.accessToken}`,
      'content-type': 'application/json',
      'content-length': String(manifestBytes.byteLength),
    },
    body: Buffer.from(manifestBytes),
  })
  if (!response.ok) {
    throw new Error(`manifest PUT failed: ${response.status} ${await response.text()}`)
  }
}

async function downloadWorkerBytes(
  setup: SetupExchangeResponse,
  path: string,
): Promise<Uint8Array> {
  const response = await fetch(`${endpoint}${path}`, {
    headers: { authorization: `Bearer ${setup.accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`download failed for ${path}: ${response.status} ${await response.text()}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function fetchLatestMetaUpdate(setup: SetupExchangeResponse): Promise<Uint8Array> {
  const response = await fetch(
    `${endpoint}/vaults/${encodeURIComponent(setup.vaultId)}/meta/latest`,
    {
      headers: { authorization: `Bearer ${setup.accessToken}` },
    },
  )
  if (!response.ok) {
    throw new Error(`meta latest fetch failed: ${response.status} ${await response.text()}`)
  }
  const body = requireRecord(await response.json(), 'meta latest response')
  if (typeof body.updateBytesBase64 !== 'string') {
    throw new Error(`meta latest response missing update bytes: ${JSON.stringify(body)}`)
  }
  return decodeBase64(body.updateBytesBase64)
}

async function fetchLatestFileUpdate(
  setup: SetupExchangeResponse,
  ydocId: string,
): Promise<Uint8Array> {
  const response = await fetch(
    `${endpoint}/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(ydocId)}/latest`,
    {
      headers: { authorization: `Bearer ${setup.accessToken}` },
    },
  )
  if (!response.ok) {
    throw new Error(`file latest fetch failed: ${response.status} ${await response.text()}`)
  }
  const body = requireRecord(await response.json(), 'file latest response')
  if (
    !isRecord(body.docId) ||
    body.docId.kind !== 'file' ||
    body.docId.ydocId !== ydocId ||
    typeof body.updateBytesBase64 !== 'string' ||
    body.updateBytesBase64.length === 0
  ) {
    throw new Error(`file latest response was invalid: ${JSON.stringify(body)}`)
  }
  return decodeBase64(body.updateBytesBase64)
}

async function downloadWorkerBinaryByManifest(
  setup: SetupExchangeResponse,
  manifestHash: string,
): Promise<Uint8Array> {
  const manifestBytes = await downloadWorkerBytes(setup, `/blob-manifests/${manifestHash}.json`)
  if ((await sha256Hex(manifestBytes)) !== manifestHash) {
    throw new Error(`downloaded manifest hash mismatch for ${manifestHash}`)
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes))
  if (!isBlobManifest(parsed)) {
    throw new Error(`downloaded manifest was invalid: ${JSON.stringify(parsed)}`)
  }
  const chunks = []
  for (const chunk of parsed.chunks) {
    const bytes = await downloadWorkerBytes(setup, `/blobs/${chunk.sha256}`)
    if (bytes.byteLength !== chunk.size || (await sha256Hex(bytes)) !== chunk.sha256) {
      throw new Error(`downloaded blob chunk mismatch: ${chunk.sha256}`)
    }
    chunks.push(bytes)
  }
  const assembled = new Uint8Array(parsed.size)
  for (const [index, chunk] of parsed.chunks.entries()) {
    const bytes = chunks[index]
    if (bytes === undefined) {
      throw new Error(`missing downloaded chunk at ${index}`)
    }
    assembled.set(bytes, chunk.offset)
  }
  if ((await sha256Hex(assembled)) !== parsed.contentSha256) {
    throw new Error(`downloaded binary content mismatch for manifest ${manifestHash}`)
  }
  return assembled
}

async function exchangeSetupToken(
  token: string,
  requestedDeviceName: string,
): Promise<SetupExchangeResponse> {
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
  const body: unknown = await response.json()
  if (!isSetupExchangeResponse(body)) {
    throw new Error(`invalid setup exchange response: ${JSON.stringify(body)}`)
  }
  return body
}

function workerWebSocketUrl(setup: SetupExchangeResponse): string {
  const url = new URL(setup.endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${encodeURIComponent(setup.vaultId)}`
  url.searchParams.set('access_token', setup.accessToken)
  url.hash = ''
  return url.toString()
}

async function connectRemoteDevice(setup: SetupExchangeResponse): Promise<RemotePeer> {
  if (typeof WebSocket !== 'function') {
    throw new Error('global WebSocket is unavailable in this Node runtime')
  }

  // The worker always echoes `Sec-WebSocket-Protocol: kuroflare.v1` on the
  // upgrade response (see runtime.ts), because real browser WebSocket clients
  // (the plugin) always offer it and fail the handshake otherwise. Node's
  // WebSocket client is strict about this from the other direction: it
  // throws if the response names a protocol the client never offered. Offer
  // it here too so this raw Node connection matches what the plugin sends.
  const socket = new WebSocket(workerWebSocketUrl(setup), ['kuroflare.v1'])
  const messages: JsonRecord[] = []
  const waiters: RemoteWaiter[] = []
  const failWaiters = (error: Error) => {
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        waiter.reject(error)
      }
    }
  }
  socket.addEventListener('message', (event) => {
    const message = requireRecord(JSON.parse(String(event.data)), 'websocket message')
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]
      if (waiter === undefined) {
        continue
      }
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
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('remote websocket open failed')), {
      once: true,
    })
  })

  // See the comment on `waitForRemoteMeta` above: this default is generous
  // because every wait through this function is a worker round-trip that can
  // land behind a DO checkpoint sweep or blob upload, sometimes for more
  // than one debounce cycle in a row.
  const waitFor = (
    predicate: (message: JsonRecord) => boolean,
    label: string,
    timeoutMs = 90_000,
  ): Promise<JsonRecord> => {
    const existingIndex = messages.findIndex(predicate)
    if (existingIndex !== -1) {
      const existing = messages.splice(existingIndex, 1)[0]
      if (existing === undefined) {
        return Promise.reject(new Error(`${label} matched missing message`))
      }
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
      // Matches the real plugin's default advertisement (sync-websocket.ts)
      // so this raw test client is granted read-write metadata access, the
      // same as a real device performing a remote meta write.
      capabilities: ['binary-v1', 'awareness', 'metadata-schema-v2'],
    }),
  )
  await waitFor(
    (message) =>
      message.type === 'hello-accepted' &&
      message.vaultId === setup.vaultId &&
      message.deviceId === setup.deviceId,
    'remote hello',
  )

  return { socket, waitFor, close: () => socket.close(1000, 'e2e-complete') }
}

export {
  makeBinaryBytes,
  makeLocalBinaryBytes,
  chunkFixed,
  stringifyBlobManifest,
  buildBinaryManifest,
  seedSetupToken,
  importBootstrapSnapshotsWithCli,
  uploadBlobChunk,
  uploadBlobManifest,
  downloadWorkerBytes,
  fetchLatestMetaUpdate,
  fetchLatestFileUpdate,
  downloadWorkerBinaryByManifest,
  exchangeSetupToken,
  workerWebSocketUrl,
  connectRemoteDevice,
}
