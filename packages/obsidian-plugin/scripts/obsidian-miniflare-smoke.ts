import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const cliBootstrapSetupToken = `${setupToken}-cli-bootstrap`
const remoteSetupToken = `${setupToken}-remote`
const yTextName = 'fixed-file'
const remoteSeedText = `R2 seeded content ${runId}`
const remotePeerText = `Remote peer edit ${runId}`
const localObsidianText = `Obsidian local edit ${runId}`
const metaLocalPath = `meta-local-${runId}.md`
const metaPeerPath = `meta-peer-${runId}.md`
const metaSharedPath = `meta-shared-${runId}.md`
const pathConflictRepairSourcePath = `path-conflict-source-${runId}.md`
const pathConflictRepairTargetPath = `path-conflict-target-${runId}.md`
const renameRepairSourcePath = `rename-repair-source-${runId}.md`
const renameRepairTargetPath = `rename-repair-target-${runId}.md`
const remoteMaterializeBlockedPath = `remote-materialize-blocked-${runId}.md`
const binaryPath = `asset-${runId}.bin`
const localBinaryPath = `local-asset-${runId}.bin`
const localBinaryRenamedPath = `local-asset-renamed-${runId}.bin`
const initialFullSyncPath = `initial-full-sync-${runId}.md`
const initialFullSyncText = `Initial full sync snapshot content ${runId}`
const initialFullSyncFileId = `initial-full-sync-file-${runId}`
const initialFullSyncYDocId = `initial-full-sync-doc-${runId}`

type JsonRecord = Record<string, unknown>

interface SetupExchangeResponse {
  readonly endpoint: string
  readonly vaultId: string
  readonly deviceId: string
  readonly yClientId: number
  readonly accessToken: string
}

interface FileDocId {
  readonly kind: 'file'
  readonly ydocId: string
}

interface SourceBinaryChunk {
  readonly offset: number
  readonly bytes: Uint8Array
}

interface BinaryChunk extends SourceBinaryChunk {
  readonly sha256: string
  readonly size: number
}

interface BlobManifestChunk {
  readonly sha256: string
  readonly offset: number
  readonly size: number
}

interface BlobManifest {
  readonly version: 1
  readonly fileId: string
  readonly contentSha256: string
  readonly size: number
  readonly chunks: readonly BlobManifestChunk[]
  readonly createdBy: string
  readonly createdAt: number
}

interface BuiltBinaryManifest {
  readonly manifest: BlobManifest
  readonly manifestBytes: Uint8Array
  readonly manifestHash: string
  readonly chunks: readonly BinaryChunk[]
}

interface ActiveMetaEntry {
  readonly fileId: string
  readonly path: string
  readonly ydocId?: string | undefined
  readonly type: string
  readonly blobManifestHash?: string | undefined
  readonly blobChunks?: readonly string[] | undefined
}

interface VaultFileReadResult {
  readonly exists: boolean
  readonly text: string
}

interface VaultBinaryReadResult {
  readonly exists: boolean
  readonly size: number
  readonly sha256: string
}

interface RepairRetryResult {
  readonly deleted?: boolean | undefined
  readonly path?: string | undefined
  readonly repairLogContainsEntry: boolean
}

interface DegradedBinaryRestoreCheckResult {
  readonly repairLogContainsEntry: boolean
  readonly degradedReason?: string | undefined
}

interface InvalidMetaDiscardResult {
  readonly isolatedBeforeDiscard: boolean
  readonly isolatedAfterDiscard: boolean
  readonly existsAfterWrongConfirmation: boolean
  readonly existsAfterDiscard: boolean
  readonly repairLogContainsEntry: boolean
}

interface PathConflictRetryResult {
  readonly sourceExists: boolean
  readonly targetExists: boolean
  readonly entryPath?: string | undefined
  readonly repairLogContainsEntry: boolean
}

interface RenameMaterializeResolveResult {
  readonly sourceExists: boolean
  readonly blockedTargetExists: boolean
  readonly resolvedPath?: string | undefined
  readonly resolvedExists: boolean
  readonly repairLogContainsEntry: boolean
}

interface RemoteMaterializeBlockedActionResult {
  readonly retryRepairLogContainsEntry: boolean
  readonly retryPendingPath?: string | undefined
  readonly clearRepairLogContainsEntry: boolean
  readonly autoResolvedPath?: string | undefined
  readonly autoPendingPath?: string | undefined
  readonly autoRepairLogContainsEntry: boolean
}

interface StartupSyncResult {
  readonly setupVaultId?: string | undefined
  readonly setupToken?: string | undefined
  readonly connected?: boolean | undefined
  readonly socketReadyState?: number | undefined
  readonly activeFile?: string | undefined
  readonly fileText: string
}

interface ReconnectResult {
  readonly setupVaultId?: string | undefined
  readonly setupToken?: string | undefined
  readonly connected?: boolean | undefined
  readonly socketReadyState?: number | undefined
}

interface SnapshotImportCliResult {
  readonly ok: true
  readonly vaultId: string
  readonly imports: readonly unknown[]
}

interface RemotePeer {
  readonly socket: WebSocket
  readonly waitFor: (
    predicate: (message: JsonRecord) => boolean,
    label: string,
    timeoutMs?: number,
  ) => Promise<JsonRecord>
  readonly close: () => void
}

interface RemoteWaiter {
  readonly predicate: (message: JsonRecord) => boolean
  readonly resolve: (message: JsonRecord) => void
  readonly reject: (error: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object: ${JSON.stringify(value)}`)
  }
  return value
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new Error(`${label}.${key} was not a string`)
    }
    result[key] = entry
  }
  return result
}

function isActiveMetaEntry(value: unknown): value is ActiveMetaEntry {
  return (
    isRecord(value) &&
    typeof value.fileId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.type === 'string' &&
    (value.ydocId === undefined || typeof value.ydocId === 'string') &&
    (value.blobManifestHash === undefined || typeof value.blobManifestHash === 'string') &&
    (value.blobChunks === undefined ||
      (Array.isArray(value.blobChunks) &&
        value.blobChunks.every((chunk) => typeof chunk === 'string')))
  )
}

function isVaultFileReadResult(value: unknown): value is VaultFileReadResult {
  return isRecord(value) && typeof value.exists === 'boolean' && typeof value.text === 'string'
}

function isVaultBinaryReadResult(value: unknown): value is VaultBinaryReadResult {
  return (
    isRecord(value) &&
    typeof value.exists === 'boolean' &&
    typeof value.size === 'number' &&
    typeof value.sha256 === 'string'
  )
}

function isRepairRetryResult(value: unknown): value is RepairRetryResult {
  return (
    isRecord(value) &&
    (value.deleted === undefined || typeof value.deleted === 'boolean') &&
    (value.path === undefined || typeof value.path === 'string') &&
    typeof value.repairLogContainsEntry === 'boolean'
  )
}

function isDegradedBinaryRestoreCheckResult(
  value: unknown,
): value is DegradedBinaryRestoreCheckResult {
  return (
    isRecord(value) &&
    typeof value.repairLogContainsEntry === 'boolean' &&
    (value.degradedReason === undefined || typeof value.degradedReason === 'string')
  )
}

function isInvalidMetaDiscardResult(value: unknown): value is InvalidMetaDiscardResult {
  return (
    isRecord(value) &&
    typeof value.isolatedBeforeDiscard === 'boolean' &&
    typeof value.isolatedAfterDiscard === 'boolean' &&
    typeof value.existsAfterWrongConfirmation === 'boolean' &&
    typeof value.existsAfterDiscard === 'boolean' &&
    typeof value.repairLogContainsEntry === 'boolean'
  )
}

function isPathConflictRetryResult(value: unknown): value is PathConflictRetryResult {
  return (
    isRecord(value) &&
    typeof value.sourceExists === 'boolean' &&
    typeof value.targetExists === 'boolean' &&
    (value.entryPath === undefined || typeof value.entryPath === 'string') &&
    typeof value.repairLogContainsEntry === 'boolean'
  )
}

function isRenameMaterializeResolveResult(value: unknown): value is RenameMaterializeResolveResult {
  return (
    isRecord(value) &&
    typeof value.sourceExists === 'boolean' &&
    typeof value.blockedTargetExists === 'boolean' &&
    (value.resolvedPath === undefined || typeof value.resolvedPath === 'string') &&
    typeof value.resolvedExists === 'boolean' &&
    typeof value.repairLogContainsEntry === 'boolean'
  )
}

function isRemoteMaterializeBlockedActionResult(
  value: unknown,
): value is RemoteMaterializeBlockedActionResult {
  return (
    isRecord(value) &&
    typeof value.retryRepairLogContainsEntry === 'boolean' &&
    (value.retryPendingPath === undefined || typeof value.retryPendingPath === 'string') &&
    typeof value.clearRepairLogContainsEntry === 'boolean' &&
    (value.autoResolvedPath === undefined || typeof value.autoResolvedPath === 'string') &&
    (value.autoPendingPath === undefined || typeof value.autoPendingPath === 'string') &&
    typeof value.autoRepairLogContainsEntry === 'boolean'
  )
}

function isStartupSyncResult(value: unknown): value is StartupSyncResult {
  return (
    isRecord(value) &&
    typeof value.fileText === 'string' &&
    (value.setupVaultId === undefined || typeof value.setupVaultId === 'string') &&
    (value.setupToken === undefined || typeof value.setupToken === 'string') &&
    (value.connected === undefined || typeof value.connected === 'boolean') &&
    (value.socketReadyState === undefined || typeof value.socketReadyState === 'number') &&
    (value.activeFile === undefined || typeof value.activeFile === 'string')
  )
}

function isReconnectResult(value: unknown): value is ReconnectResult {
  return (
    isRecord(value) &&
    (value.setupVaultId === undefined || typeof value.setupVaultId === 'string') &&
    (value.setupToken === undefined || typeof value.setupToken === 'string') &&
    (value.connected === undefined || typeof value.connected === 'boolean') &&
    (value.socketReadyState === undefined || typeof value.socketReadyState === 'number')
  )
}

function isSetupExchangeResponse(value: unknown): value is SetupExchangeResponse {
  return (
    isRecord(value) &&
    typeof value.endpoint === 'string' &&
    typeof value.vaultId === 'string' &&
    typeof value.deviceId === 'string' &&
    typeof value.yClientId === 'number' &&
    typeof value.accessToken === 'string'
  )
}

function isSnapshotImportCliResult(value: unknown): value is SnapshotImportCliResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    value.vaultId === vaultId &&
    Array.isArray(value.imports)
  )
}

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

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeBinaryBytes(): Uint8Array {
  const bytes = new Uint8Array(160 * 1024)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = (index * 31 + runId.charCodeAt(index % runId.length)) % 256
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

function activeDocIdForPath(path: string): FileDocId {
  const hash = createHash('sha256').update(path).digest('hex')
  return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
}

function canonicalizeVaultPath(path: string): string {
  return path.normalize('NFC').replace(/\/+/g, '/').toLowerCase()
}

function makeYTextUpdate(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText(yTextName).insert(0, text)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function makeMetaSnapshotUpdate(entries: readonly JsonRecord[]): Uint8Array {
  const doc = new Y.Doc()
  const map = doc.getMap('meta')
  for (const entry of entries) {
    const fileId = entry.fileId
    if (typeof fileId !== 'string') {
      throw new Error(`meta snapshot entry missing fileId: ${JSON.stringify(entry)}`)
    }
    map.set(fileId, entry)
  }
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

function metaPaths(doc: Y.Doc): [string, unknown][] {
  return [...doc.getMap('meta').entries()]
    .map(
      ([fileId, value]) =>
        [
          String(fileId),
          typeof value === 'object' && value !== null ? Reflect.get(value, 'path') : undefined,
        ] as [string, unknown],
    )
    .sort(([left], [right]) => left.localeCompare(right))
}

function renameMetaEntry(
  doc: Y.Doc,
  fileId: string,
  toPath: string,
  deviceId: string,
  now: number,
): void {
  const map = doc.getMap('meta')
  const entry = map.get(fileId)
  if (typeof entry !== 'object' || entry === null || Reflect.get(entry, 'type') !== 'text') {
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

async function waitForRemoteMeta(
  remote: RemotePeer,
  doc: Y.Doc,
  predicate: (doc: Y.Doc) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const message = await remote.waitFor(
      (candidate) =>
        candidate.type === 'sync-update' &&
        typeof candidate.docId === 'object' &&
        candidate.docId !== null &&
        Reflect.get(candidate.docId, 'kind') === 'meta',
      label,
      remaining,
    )
    if (typeof message.update !== 'string') {
      throw new Error(`${label} returned sync-update without update payload`)
    }
    Y.applyUpdate(doc, decodeBase64(message.update))
    if (predicate(doc)) {
      return message
    }
  }
  throw new Error(`${label} timed out; remote meta paths: ${JSON.stringify(metaPaths(doc))}`)
}

async function seedSetupToken(token: string): Promise<void> {
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
      meta: { updateBytesBase64: encodeBase64(input.metaUpdate) },
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
      join(pluginDir, 'kuroflare-snapshot-import.ts'),
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

function isBlobManifest(value: unknown): value is BlobManifest {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.fileId === 'string' &&
    typeof value.contentSha256 === 'string' &&
    typeof value.size === 'number' &&
    typeof value.createdBy === 'string' &&
    typeof value.createdAt === 'number' &&
    Array.isArray(value.chunks) &&
    value.chunks.every(
      (chunk) =>
        isRecord(chunk) &&
        typeof chunk.sha256 === 'string' &&
        typeof chunk.offset === 'number' &&
        typeof chunk.size === 'number',
    )
  )
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

  const socket = new WebSocket(workerWebSocketUrl(setup))
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

  const waitFor = (
    predicate: (message: JsonRecord) => boolean,
    label: string,
    timeoutMs = 5000,
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

function evalInObsidian(code: string): unknown {
  const output = obsidian(['eval', `code=${code}`])
  const parsed: unknown = JSON.parse(output.replace(/^=>\s*/, ''))
  return parsed
}

function readActiveMetaEntry(path: string): ActiveMetaEntry | null {
  const value = evalInObsidian(`(() => {
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
  if (value === null || isActiveMetaEntry(value)) {
    return value
  }
  throw new Error(`invalid active meta entry: ${JSON.stringify(value)}`)
}

function readMetaEntryByFileId(fileId: string): JsonRecord | null {
  const value = evalInObsidian(`(() => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!map) return JSON.stringify(null);
    const value = map.get(${JSON.stringify(fileId)});
    return JSON.stringify(value ?? null);
  })()`)
  if (value === null || isRecord(value)) {
    return value
  }
  throw new Error(`invalid meta entry for ${fileId}: ${JSON.stringify(value)}`)
}

async function waitForActiveMetaEntry(
  path: string,
  timeoutMs = 5000,
): Promise<ActiveMetaEntry | null> {
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

async function waitForMetaEntryByFileId(
  fileId: string,
  predicate: (entry: JsonRecord) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entry = readMetaEntryByFileId(fileId)
    if (entry !== null && predicate(entry)) {
      return entry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const entry = readMetaEntryByFileId(fileId)
  if (entry !== null && predicate(entry)) {
    return entry
  }
  throw new Error(`${label} timed out: ${JSON.stringify(entry)}`)
}

async function waitForActiveMetaEntryByFileId(
  fileId: string,
  predicate: (entry: ActiveMetaEntry) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<ActiveMetaEntry> {
  const entry = await waitForMetaEntryByFileId(
    fileId,
    (candidate) => isActiveMetaEntry(candidate) && predicate(candidate),
    label,
    timeoutMs,
  )
  if (!isActiveMetaEntry(entry)) {
    throw new Error(`${label} did not return an active meta entry: ${JSON.stringify(entry)}`)
  }
  return entry
}

async function waitForVaultPath(path: string, timeoutMs = 5000): Promise<boolean> {
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

async function waitForVaultFileIncludes(
  path: string,
  expected: string,
  timeoutMs = 5000,
): Promise<VaultFileReadResult> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = evalInObsidian(`(async () => {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      if (!file) return JSON.stringify({ exists: false, text: '' });
      return JSON.stringify({ exists: true, text: await app.vault.read(file) });
    })()`)
    if (!isVaultFileReadResult(result)) {
      throw new Error(`invalid vault file read result: ${JSON.stringify(result)}`)
    }
    if (result.exists === true && result.text.includes(expected)) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const result = evalInObsidian(`(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    if (!file) return JSON.stringify({ exists: false, text: '' });
    return JSON.stringify({ exists: true, text: await app.vault.read(file) });
  })()`)
  if (!isVaultFileReadResult(result)) {
    throw new Error(`invalid vault file read result: ${JSON.stringify(result)}`)
  }
  return result
}

async function waitForVaultBinaryHash(
  path: string,
  expectedSha256: string,
  timeoutMs = 5000,
): Promise<VaultBinaryReadResult> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = readVaultBinaryHash(path)
    if (result.exists === true && result.sha256 === expectedSha256) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return readVaultBinaryHash(path)
}

function readVaultBinaryHash(path: string): VaultBinaryReadResult {
  const result = evalInObsidian(`(async () => {
    const path = ${JSON.stringify(path)};
    const file = app.vault.getAbstractFileByPath(path);
    if (!file) return JSON.stringify({ exists: false, size: 0, sha256: '' });
    const buffer = await app.vault.adapter.readBinary(path);
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return JSON.stringify({ exists: true, size: buffer.byteLength, sha256 });
  })()`)
  if (!isVaultBinaryReadResult(result)) {
    throw new Error(`invalid vault binary read result: ${JSON.stringify(result)}`)
  }
  return result
}

function createObsidianBinary(path: string, bytes: Uint8Array): void {
  evalInObsidian(`(async () => {
    const base64 = ${JSON.stringify(encodeBase64(bytes))};
    const binary = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    if (existing) {
      await app.vault.adapter.writeBinary(${JSON.stringify(path)}, binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
      return JSON.stringify({ action: 'modified', size: binary.byteLength });
    }
    await app.vault.createBinary(${JSON.stringify(path)}, binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
    return JSON.stringify({ action: 'created', size: binary.byteLength });
  })()`)
}

function renameObsidianFile(fromPath: string, toPath: string): void {
  evalInObsidian(`(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(fromPath)});
    if (!file) return JSON.stringify({ renamed: false, reason: 'missing-file' });
    await app.fileManager.renameFile(file, ${JSON.stringify(toPath)});
    return JSON.stringify({ renamed: true });
  })()`)
}

function deleteObsidianFile(path: string): void {
  evalInObsidian(`(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    if (!file) return JSON.stringify({ deleted: false, reason: 'missing-file' });
    await app.vault.delete(file);
    return JSON.stringify({ deleted: true });
  })()`)
}

async function retryBinaryRestoreCheck(fileId: string): Promise<RepairRetryResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) return JSON.stringify({ repairLogContainsEntry: false });
    const current = map.get(${JSON.stringify(fileId)});
    if (!current) return JSON.stringify({ repairLogContainsEntry: false });
    const deletedAt = typeof current.deletedAt === 'number' ? current.deletedAt : Date.now();
    map.doc.transact(() => {
      map.set(${JSON.stringify(fileId)}, {
        ...current,
        deleted: true,
        deletedAt,
        deletedBy: 'e2e-delete-device',
        contentUpdatedAt: deletedAt + 1,
        contentUpdatedBy: 'e2e-edit-device',
        updatedAt: deletedAt + 1,
        updatedBy: 'e2e-edit-device',
      });
    }, 'kuroflare:repair');
    const repairEntry = {
      id: 'delete-vs-edit:' + ${JSON.stringify(fileId)} + ':keep-deleted',
      kind: 'delete-vs-edit',
      fileId: ${JSON.stringify(fileId)},
      reason: 'missing-binary-content',
      createdAt: Date.now(),
    };
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), repairEntry],
    });
    await plugin.retryKeepDeletedRepairEntry(repairEntry);
    const after = map.get(${JSON.stringify(fileId)});
    return JSON.stringify({
      deleted: after?.deleted,
      path: after?.path,
      repairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === repairEntry.id),
      ),
    });
  })()`)
  if (!isRepairRetryResult(result)) {
    throw new Error(`invalid binary restore retry result: ${JSON.stringify(result)}`)
  }
  return result
}

async function retryDegradedBinaryRestoreCheck(
  fileId: string,
): Promise<DegradedBinaryRestoreCheckResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) {
      return JSON.stringify({ repairLogContainsEntry: false });
    }
    const now = Date.now();
    const repairEntry = {
      id: 'delete-vs-edit:' + ${JSON.stringify(fileId)} + ':keep-deleted',
      kind: 'delete-vs-edit',
      fileId: ${JSON.stringify(fileId)},
      reason: 'missing-binary-content',
      createdAt: now,
    };
    map.doc.transact(() => {
      map.set(${JSON.stringify(fileId)}, {
        schemaVersion: 1,
        fileId: ${JSON.stringify(fileId)},
        path: 'degraded-binary-restore-' + ${JSON.stringify(runId)} + '.bin',
        canonicalPath: 'degraded-binary-restore-' + ${JSON.stringify(runId)} + '.bin',
        type: 'binary',
        blobManifestHash: 'f'.repeat(64),
        blobChunks: ['e'.repeat(64)],
        deleted: true,
        deletedAt: now,
        deletedBy: 'e2e-delete-device',
        createdAt: now - 10,
        createdBy: 'e2e-create-device',
        contentUpdatedAt: now + 1,
        contentUpdatedBy: 'e2e-edit-device',
        updatedAt: now + 1,
        updatedBy: 'e2e-edit-device',
        mtime: now,
      });
    }, 'kuroflare:repair');
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), repairEntry],
    });
    await plugin.retryKeepDeletedRepairEntry(repairEntry);
    return JSON.stringify({
      repairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === repairEntry.id),
      ),
      degradedReason: plugin.getBinaryRestoreCheckSnapshot()?.reason,
    });
  })()`)
  if (!isDegradedBinaryRestoreCheckResult(result)) {
    throw new Error(`invalid degraded binary restore check result: ${JSON.stringify(result)}`)
  }
  return result
}

async function discardInvalidMetaEntry(fileId: string): Promise<InvalidMetaDiscardResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) {
      return JSON.stringify({
        isolatedBeforeDiscard: false,
        isolatedAfterDiscard: false,
        existsAfterWrongConfirmation: false,
        existsAfterDiscard: false,
        repairLogContainsEntry: false,
      });
    }
    map.set(${JSON.stringify(fileId)}, { invalid: true, path: 'invalid-meta.bin' });
    const repairEntry = {
      id: 'invalid-meta:' + ${JSON.stringify(fileId)},
      kind: 'invalid-meta',
      fileId: ${JSON.stringify(fileId)},
      reason: 'meta-schema-invalid',
      createdAt: Date.now(),
    };
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), repairEntry],
    });
    await plugin.inspectInvalidMetaRepairEntry(repairEntry);
    const isolatedBeforeDiscard = Boolean(
      plugin.getInvalidMetaIsolationSnapshot()?.rawJson.includes('"invalid": true'),
    );
    await plugin.discardInvalidMetaRepairEntry(repairEntry, 'wrong confirmation');
    const existsAfterWrongConfirmation = map.has(${JSON.stringify(fileId)});
    await plugin.discardInvalidMetaRepairEntry(repairEntry, 'DISCARD INVALID META');
    return JSON.stringify({
      isolatedBeforeDiscard,
      isolatedAfterDiscard: plugin.getInvalidMetaIsolationSnapshot() !== null,
      existsAfterWrongConfirmation,
      existsAfterDiscard: map.has(${JSON.stringify(fileId)}),
      repairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === repairEntry.id),
      ),
    });
  })()`)
  if (!isInvalidMetaDiscardResult(result)) {
    throw new Error(`invalid invalid-meta discard result: ${JSON.stringify(result)}`)
  }
  return result
}

async function retryPathConflictMaterialize(input: {
  readonly fileId: string
  readonly sourcePath: string
  readonly targetPath: string
}): Promise<PathConflictRetryResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) {
      return JSON.stringify({
        sourceExists: false,
        targetExists: false,
        repairLogContainsEntry: false,
      });
    }
    const current = map.get(${JSON.stringify(input.fileId)});
    if (!current) {
      return JSON.stringify({
        sourceExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.sourcePath)})),
        targetExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})),
        repairLogContainsEntry: false,
      });
    }
    const now = Date.now();
    map.doc.transact(() => {
      map.set(${JSON.stringify(input.fileId)}, {
        ...current,
        path: ${JSON.stringify(input.targetPath)},
        canonicalPath: ${JSON.stringify(canonicalizeVaultPath(input.targetPath))},
        updatedAt: now,
        updatedBy: 'e2e-path-repair-device',
      });
    }, 'kuroflare:repair');
    const repairEntry = {
      id: 'path-conflict:' + ${JSON.stringify(input.fileId)},
      kind: 'path-conflict',
      fileId: ${JSON.stringify(input.fileId)},
      path: ${JSON.stringify(input.targetPath)},
      reason: 'path-conflict-renamed',
      createdAt: Date.now(),
    };
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), repairEntry],
    });
    await plugin.retryPathConflictRepairEntry(repairEntry);
    const after = map.get(${JSON.stringify(input.fileId)});
    return JSON.stringify({
      sourceExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.sourcePath)})),
      targetExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})),
      entryPath: after?.path,
      repairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === repairEntry.id),
      ),
    });
  })()`)
  if (!isPathConflictRetryResult(result)) {
    throw new Error(`invalid path-conflict retry result: ${JSON.stringify(result)}`)
  }
  return result
}

async function resolveRenameMaterializeFailure(input: {
  readonly fileId: string
  readonly sourcePath: string
  readonly targetPath: string
}): Promise<RenameMaterializeResolveResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) {
      return JSON.stringify({
        sourceExists: false,
        blockedTargetExists: false,
        resolvedExists: false,
        repairLogContainsEntry: false,
      });
    }
    const current = map.get(${JSON.stringify(input.fileId)});
    if (!current) {
      return JSON.stringify({
        sourceExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.sourcePath)})),
        blockedTargetExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})),
        resolvedExists: false,
        repairLogContainsEntry: false,
      });
    }
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})) {
      await app.vault.createFolder(${JSON.stringify(input.targetPath)});
    }
    const now = Date.now();
    map.doc.transact(() => {
      map.set(${JSON.stringify(input.fileId)}, {
        ...current,
        path: ${JSON.stringify(input.targetPath)},
        canonicalPath: ${JSON.stringify(canonicalizeVaultPath(input.targetPath))},
        updatedAt: now,
        updatedBy: 'e2e-rename-repair-device',
      });
    }, 'kuroflare:repair');
    const repairEntry = {
      id: 'path-conflict:' + ${JSON.stringify(input.fileId)} + ':rename-materialize-failed',
      kind: 'path-conflict',
      fileId: ${JSON.stringify(input.fileId)},
      path: ${JSON.stringify(input.targetPath)},
      reason: 'rename-materialize-failed',
      createdAt: Date.now(),
    };
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), repairEntry],
    });
    await plugin.resolvePathConflictRepairEntry(repairEntry);
    const after = map.get(${JSON.stringify(input.fileId)});
    const resolvedPath = after?.path;
    return JSON.stringify({
      sourceExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.sourcePath)})),
      blockedTargetExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})),
      resolvedPath,
      resolvedExists:
        typeof resolvedPath === 'string' && Boolean(app.vault.getAbstractFileByPath(resolvedPath)),
      repairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === repairEntry.id),
      ),
    });
  })()`)
  if (!isRenameMaterializeResolveResult(result)) {
    throw new Error(`invalid rename materialize resolve result: ${JSON.stringify(result)}`)
  }
  return result
}

async function runRemoteMaterializeBlockedActions(): Promise<RemoteMaterializeBlockedActionResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) {
      return JSON.stringify({
        retryRepairLogContainsEntry: false,
        clearRepairLogContainsEntry: false,
        autoRepairLogContainsEntry: false,
      });
    }
    const now = Date.now();
    const retryFileId = 'remote-materialize-blocked-retry-' + ${JSON.stringify(runId)};
    const retryYDocId = 'remote-materialize-blocked-retry-doc-' + ${JSON.stringify(runId)};
    const retryEntry = {
      id: 'remote-materialize-blocked:' + retryYDocId + ':path-collision',
      kind: 'remote-materialize-blocked',
      fileId: retryFileId,
      path: ${JSON.stringify(remoteMaterializeBlockedPath)},
      reason: 'path-collision',
      createdAt: now,
    };
    map.doc.transact(() => {
      map.set(retryFileId, {
        schemaVersion: 1,
        fileId: retryFileId,
        path: ${JSON.stringify(remoteMaterializeBlockedPath)},
        canonicalPath: ${JSON.stringify(canonicalizeVaultPath(remoteMaterializeBlockedPath))},
        type: 'text',
        ydocId: retryYDocId,
        deleted: false,
        createdAt: now,
        createdBy: 'e2e-remote-materialize-blocked',
        contentUpdatedAt: now,
        contentUpdatedBy: 'e2e-remote-materialize-blocked',
        updatedAt: now,
        updatedBy: 'e2e-remote-materialize-blocked',
        mtime: now,
      });
    }, 'kuroflare:repair');
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), retryEntry],
    });
    await plugin.retryRemoteMaterializeBlockedRepairEntry(retryEntry);

    const clearFileId = 'remote-materialize-blocked-clear-' + ${JSON.stringify(runId)};
    const clearEntry = {
      id: 'remote-materialize-blocked:' + clearFileId + ':parent-collision',
      kind: 'remote-materialize-blocked',
      fileId: clearFileId,
      path: 'blocked-clear-' + ${JSON.stringify(runId)} + '.md',
      reason: 'parent-collision',
      createdAt: Date.now(),
    };
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), clearEntry],
    });
    await plugin.clearRepairLogEntry(clearEntry);

    const autoFileId = 'remote-materialize-blocked-auto-' + ${JSON.stringify(runId)};
    const autoYDocId = 'remote-materialize-blocked-auto-doc-' + ${JSON.stringify(runId)};
    const autoPath = 'remote-materialize-blocked-auto-' + ${JSON.stringify(runId)} + '.md';
    if (!app.vault.getAbstractFileByPath(autoPath)) {
      await app.vault.createFolder(autoPath);
    }
    const autoEntry = {
      id: 'remote-materialize-blocked:' + autoYDocId + ':path-collision',
      kind: 'remote-materialize-blocked',
      fileId: autoFileId,
      path: autoPath,
      reason: 'path-collision',
      createdAt: Date.now(),
    };
    map.doc.transact(() => {
      map.set(autoFileId, {
        schemaVersion: 1,
        fileId: autoFileId,
        path: autoPath,
        canonicalPath: autoPath.normalize('NFC').replace(/\\/+/g, '/').toLowerCase(),
        type: 'text',
        ydocId: autoYDocId,
        deleted: false,
        createdAt: now,
        createdBy: 'e2e-remote-materialize-blocked',
        contentUpdatedAt: now,
        contentUpdatedBy: 'e2e-remote-materialize-blocked',
        updatedAt: now,
        updatedBy: 'e2e-remote-materialize-blocked',
        mtime: now,
      });
    }, 'kuroflare:repair');
    await plugin.updateSettings({
      repairLog: [...(plugin.kuroflareSettings.repairLog ?? []), autoEntry],
    });
    await plugin.resolveRemoteMaterializeBlockedRepairEntry(autoEntry);
    const autoResolved = map.get(autoFileId);

    return JSON.stringify({
      retryRepairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === retryEntry.id),
      ),
      retryPendingPath: plugin.pendingRemoteTextFiles?.get(retryYDocId),
      clearRepairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === clearEntry.id),
      ),
      autoResolvedPath: autoResolved?.path,
      autoPendingPath: plugin.pendingRemoteTextFiles?.get(autoYDocId),
      autoRepairLogContainsEntry: Boolean(
        plugin.kuroflareSettings.repairLog?.some((entry) => entry.id === autoEntry.id),
      ),
    });
  })()`)
  if (!isRemoteMaterializeBlockedActionResult(result)) {
    throw new Error(`invalid remote-materialize-blocked action result: ${JSON.stringify(result)}`)
  }
  return result
}

function clearTextIndexedDb() {
  obsidian([
    'eval',
    "code=(async () => { const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []; const names = databases.map((database) => database.name).filter((name) => name?.startsWith('kuroflare-file:')); await Promise.all(names.map((name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve('deleted'); request.onerror = () => reject(request.error); request.onblocked = () => resolve('blocked'); }))); return 'deleted'; })()",
  ])
}

function copyPlugin(vaultPath: string): void {
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
await seedSetupToken(cliBootstrapSetupToken)
importBootstrapSnapshotsWithCli({
  setupToken: cliBootstrapSetupToken,
  metaUpdate: initialMetaUpdate,
  files: [
    { ydocId: initialFullSyncYDocId, update: initialFullSyncUpdate },
    { ydocId: docId.ydocId, update: seedUpdate },
  ],
})
await seedSetupToken(setupToken)

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

const resultValue = evalInObsidian(`(async () => {
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
if (!isStartupSyncResult(resultValue)) {
  throw new Error(`invalid startup sync result: ${JSON.stringify(resultValue)}`)
}
const result = resultValue

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
  if (!isRecord(remoteEditResult) || typeof remoteEditResult.fileText !== 'string') {
    throw new Error(`invalid remote edit result: ${JSON.stringify(remoteEditResult)}`)
  }
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
  if (!isRecord(localEditResult) || typeof localEditResult.edited !== 'boolean') {
    throw new Error(`invalid local edit result: ${JSON.stringify(localEditResult)}`)
  }
  if (localEditResult.edited !== true) {
    throw new Error(`Obsidian editor edit failed: ${JSON.stringify(localEditResult)}`)
  }
  obsidian(['command', 'id=kuroflare:kuroflare-sync-import-and-send-active-file'])
  await remote.waitFor((message) => {
    if (message.type !== 'sync-update' || message.deviceId === remoteSetup.deviceId) {
      return false
    }
    if (typeof message.update !== 'string') {
      throw new Error('local obsidian edit broadcast missing update payload')
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
        Reflect.get(map.get(localMetaEntry.fileId) ?? {}, 'path') === metaSharedPath &&
        Reflect.get(map.get(peerMetaEntry.fileId) ?? {}, 'path') === peerConflictPath
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

  evalInObsidian(`(async () => {
    await app.vault.create(${JSON.stringify(pathConflictRepairSourcePath)}, 'path conflict repair source');
    return JSON.stringify('created');
  })()`)
  const pathConflictRepairEntry = await waitForActiveMetaEntry(pathConflictRepairSourcePath)
  if (pathConflictRepairEntry === null) {
    throw new Error('Obsidian did not register path-conflict repair source')
  }
  const pathConflictRetry = await retryPathConflictMaterialize({
    fileId: pathConflictRepairEntry.fileId,
    sourcePath: pathConflictRepairSourcePath,
    targetPath: pathConflictRepairTargetPath,
  })
  if (
    pathConflictRetry.sourceExists !== false ||
    pathConflictRetry.targetExists !== true ||
    pathConflictRetry.entryPath !== pathConflictRepairTargetPath ||
    pathConflictRetry.repairLogContainsEntry
  ) {
    throw new Error(`path-conflict repair retry failed: ${JSON.stringify(pathConflictRetry)}`)
  }
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) =>
      Reflect.get(doc.getMap('meta').get(pathConflictRepairEntry.fileId) ?? {}, 'path') ===
      pathConflictRepairTargetPath,
    'path-conflict repair meta broadcast',
  )

  evalInObsidian(`(async () => {
    await app.vault.create(${JSON.stringify(renameRepairSourcePath)}, 'rename materialize repair source');
    return JSON.stringify('created');
  })()`)
  const renameRepairEntry = await waitForActiveMetaEntry(renameRepairSourcePath)
  if (renameRepairEntry === null) {
    throw new Error('Obsidian did not register rename materialize repair source')
  }
  const renameResolve = await resolveRenameMaterializeFailure({
    fileId: renameRepairEntry.fileId,
    sourcePath: renameRepairSourcePath,
    targetPath: renameRepairTargetPath,
  })
  if (
    renameResolve.sourceExists !== false ||
    renameResolve.blockedTargetExists !== true ||
    renameResolve.resolvedPath === undefined ||
    !renameResolve.resolvedPath.includes(' (conflict ') ||
    renameResolve.resolvedExists !== true ||
    renameResolve.repairLogContainsEntry
  ) {
    throw new Error(`rename materialize resolve failed: ${JSON.stringify(renameResolve)}`)
  }

  const remoteMaterializeBlockedActions = await runRemoteMaterializeBlockedActions()
  if (
    remoteMaterializeBlockedActions.retryRepairLogContainsEntry ||
    remoteMaterializeBlockedActions.retryPendingPath !== remoteMaterializeBlockedPath ||
    remoteMaterializeBlockedActions.clearRepairLogContainsEntry ||
    remoteMaterializeBlockedActions.autoResolvedPath === undefined ||
    !remoteMaterializeBlockedActions.autoResolvedPath.includes(' (conflict ') ||
    remoteMaterializeBlockedActions.autoPendingPath !==
      remoteMaterializeBlockedActions.autoResolvedPath ||
    remoteMaterializeBlockedActions.autoRepairLogContainsEntry
  ) {
    throw new Error(
      `remote-materialize-blocked repair actions failed: ${JSON.stringify(
        remoteMaterializeBlockedActions,
      )}`,
    )
  }

  const localBinaryBytes = makeLocalBinaryBytes()
  const localBinaryHash = await sha256Hex(localBinaryBytes)
  createObsidianBinary(localBinaryPath, localBinaryBytes)
  const localBinaryEntry = await waitForActiveMetaEntry(localBinaryPath)
  if (
    localBinaryEntry?.type !== 'binary' ||
    localBinaryEntry.blobManifestHash === undefined ||
    localBinaryEntry.blobChunks === undefined
  ) {
    throw new Error(
      `Obsidian did not publish local binary meta: ${JSON.stringify(localBinaryEntry)}`,
    )
  }
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = doc.getMap('meta').get(localBinaryEntry.fileId)
      return (
        Reflect.get(entry ?? {}, 'path') === localBinaryPath &&
        Reflect.get(entry ?? {}, 'type') === 'binary' &&
        Reflect.get(entry ?? {}, 'blobManifestHash') === localBinaryEntry.blobManifestHash
      )
    },
    'local binary upload meta broadcast',
  )
  const remoteDownloadedLocalBinary = await downloadWorkerBinaryByManifest(
    remoteSetup,
    localBinaryEntry.blobManifestHash,
  )
  if ((await sha256Hex(remoteDownloadedLocalBinary)) !== localBinaryHash) {
    throw new Error('remote client downloaded different bytes for Obsidian binary upload')
  }

  const modifiedLocalBinaryBytes = makeBinaryBytes()
  const modifiedLocalBinaryHash = await sha256Hex(modifiedLocalBinaryBytes)
  createObsidianBinary(localBinaryPath, modifiedLocalBinaryBytes)
  const modifiedLocalBinaryEntry = await waitForActiveMetaEntryByFileId(
    localBinaryEntry.fileId,
    (entry) =>
      entry.path === localBinaryPath &&
      entry.type === 'binary' &&
      typeof entry.blobManifestHash === 'string' &&
      entry.blobManifestHash !== localBinaryEntry.blobManifestHash,
    'local binary modify meta update',
  )
  if (
    modifiedLocalBinaryEntry.blobManifestHash === undefined ||
    modifiedLocalBinaryEntry.blobChunks === undefined
  ) {
    throw new Error(
      `Obsidian did not publish modified binary manifest: ${JSON.stringify(modifiedLocalBinaryEntry)}`,
    )
  }
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = doc.getMap('meta').get(localBinaryEntry.fileId)
      return (
        Reflect.get(entry ?? {}, 'path') === localBinaryPath &&
        Reflect.get(entry ?? {}, 'blobManifestHash') === modifiedLocalBinaryEntry.blobManifestHash
      )
    },
    'local binary modify meta broadcast',
  )
  const remoteDownloadedModifiedBinary = await downloadWorkerBinaryByManifest(
    remoteSetup,
    modifiedLocalBinaryEntry.blobManifestHash,
  )
  if ((await sha256Hex(remoteDownloadedModifiedBinary)) !== modifiedLocalBinaryHash) {
    throw new Error('remote client downloaded different bytes for modified Obsidian binary')
  }

  renameObsidianFile(localBinaryPath, localBinaryRenamedPath)
  const renamedLocalBinaryEntry = await waitForActiveMetaEntryByFileId(
    localBinaryEntry.fileId,
    (entry) =>
      entry.path === localBinaryRenamedPath &&
      entry.type === 'binary' &&
      entry.blobManifestHash === modifiedLocalBinaryEntry.blobManifestHash,
    'local binary rename meta update',
  )
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = doc.getMap('meta').get(localBinaryEntry.fileId)
      return (
        Reflect.get(entry ?? {}, 'path') === localBinaryRenamedPath &&
        Reflect.get(entry ?? {}, 'blobManifestHash') === modifiedLocalBinaryEntry.blobManifestHash
      )
    },
    'local binary rename meta broadcast',
  )
  if (renamedLocalBinaryEntry.fileId !== localBinaryEntry.fileId) {
    throw new Error(
      `binary rename changed fileId: ${JSON.stringify({ before: localBinaryEntry, after: renamedLocalBinaryEntry })}`,
    )
  }

  deleteObsidianFile(localBinaryRenamedPath)
  const deletedLocalBinaryEntry = await waitForMetaEntryByFileId(
    localBinaryEntry.fileId,
    (entry) => entry.deleted === true && entry.path === localBinaryRenamedPath,
    'local binary delete tombstone',
  )
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = doc.getMap('meta').get(localBinaryEntry.fileId)
      return Reflect.get(entry ?? {}, 'deleted') === true
    },
    'local binary delete broadcast',
  )
  if (deletedLocalBinaryEntry.deleted !== true) {
    throw new Error(
      `binary delete did not tombstone meta: ${JSON.stringify(deletedLocalBinaryEntry)}`,
    )
  }

  const repairRetry = await retryBinaryRestoreCheck(localBinaryEntry.fileId)
  if (
    repairRetry.deleted !== false ||
    repairRetry.path !== localBinaryRenamedPath ||
    repairRetry.repairLogContainsEntry
  ) {
    throw new Error(`binary restore repair retry failed: ${JSON.stringify(repairRetry)}`)
  }
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = doc.getMap('meta').get(localBinaryEntry.fileId)
      return (
        Reflect.get(entry ?? {}, 'deleted') === false &&
        Reflect.get(entry ?? {}, 'path') === localBinaryRenamedPath
      )
    },
    'local binary restore repair broadcast',
  )
  const restoredLocalBinary = await waitForVaultBinaryHash(
    localBinaryRenamedPath,
    modifiedLocalBinaryHash,
  )
  if (
    restoredLocalBinary.exists !== true ||
    restoredLocalBinary.size !== modifiedLocalBinaryBytes.byteLength ||
    restoredLocalBinary.sha256 !== modifiedLocalBinaryHash
  ) {
    throw new Error(
      `binary restore repair did not materialize bytes: ${JSON.stringify(restoredLocalBinary)}`,
    )
  }
  const degradedRetry = await retryDegradedBinaryRestoreCheck(`degraded-binary-restore-${runId}`)
  if (
    !degradedRetry.repairLogContainsEntry ||
    degradedRetry.degradedReason !== 'manifest-unavailable'
  ) {
    throw new Error(`degraded binary restore check retry failed: ${JSON.stringify(degradedRetry)}`)
  }

  const invalidMetaDiscard = await discardInvalidMetaEntry(`invalid-meta-${runId}`)
  if (
    invalidMetaDiscard.isolatedBeforeDiscard !== true ||
    invalidMetaDiscard.isolatedAfterDiscard !== false ||
    invalidMetaDiscard.existsAfterWrongConfirmation !== true ||
    invalidMetaDiscard.existsAfterDiscard !== false ||
    invalidMetaDiscard.repairLogContainsEntry
  ) {
    throw new Error(`invalid-meta discard repair failed: ${JSON.stringify(invalidMetaDiscard)}`)
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

  const materializedBinary = await waitForVaultBinaryHash(
    binaryPath,
    builtBinary.manifest.contentSha256,
  )
  if (
    materializedBinary.exists !== true ||
    materializedBinary.size !== binaryBytes.byteLength ||
    materializedBinary.sha256 !== builtBinary.manifest.contentSha256
  ) {
    throw new Error(
      `Obsidian did not materialize remote binary bytes: ${JSON.stringify(materializedBinary)}`,
    )
  }

  const reassembled = await downloadWorkerBinaryByManifest(remoteSetup, builtBinary.manifestHash)
  if ((await sha256Hex(reassembled)) !== builtBinary.manifest.contentSha256) {
    throw new Error('remote binary reassembly mismatch')
  }
} finally {
  remoteObservedDoc.destroy()
  remoteMetaDoc.destroy()
  remote.close()
}

obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

const reconnectResultValue = evalInObsidian(`(async () => {
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
if (!isReconnectResult(reconnectResultValue)) {
  throw new Error(`invalid reconnect result: ${JSON.stringify(reconnectResultValue)}`)
}
const reconnectResult = reconnectResultValue

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
