import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(pluginDir, '../..')
const pluginId = 'kuroflare'
const endpoint = process.env.KUROFLARE_E2E_ENDPOINT ?? 'http://127.0.0.1:8787'
const seedSecret = process.env.KUROFLARE_E2E_SEED_SECRET ?? 'e2e-seed-secret'
const runId = Date.now().toString(36)
const notePath = `e2e-miniflare-${runId}.md`
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

function canonicalizeVaultPath(path: string): string {
  return path.normalize('NFC').replace(/\/+/g, '/').toLowerCase()
}

// Filename prefixes this script uses for its own test artifacts (see the path
// constants near the top of this file). The first entry removes the legacy
// fixed active-file fixture; the remaining current paths embed `${runId}` and
// cleanup runs before the current fixture is written.
const STALE_VAULT_ARTIFACT_PREFIXES = [
  'e2e-miniflare.md',
  'e2e-miniflare-',
  'meta-local-',
  'meta-peer-',
  'meta-shared-',
  'path-conflict-source-',
  'path-conflict-target-',
  'rename-repair-source-',
  'rename-repair-target-',
  'remote-materialize-blocked-',
  'asset-',
  'local-asset-',
  'initial-full-sync-',
] as const

export {
  pluginDir,
  packageDir,
  pluginId,
  notePath,
  endpoint,
  seedSecret,
  runId,
  vaultId,
  setupToken,
  cliBootstrapSetupToken,
  remoteSetupToken,
  yTextName,
  remoteSeedText,
  remotePeerText,
  localObsidianText,
  metaLocalPath,
  metaPeerPath,
  metaSharedPath,
  pathConflictRepairSourcePath,
  pathConflictRepairTargetPath,
  renameRepairSourcePath,
  renameRepairTargetPath,
  remoteMaterializeBlockedPath,
  binaryPath,
  localBinaryPath,
  localBinaryRenamedPath,
  initialFullSyncPath,
  initialFullSyncText,
  initialFullSyncFileId,
  initialFullSyncYDocId,
  STALE_VAULT_ARTIFACT_PREFIXES,
  canonicalizeVaultPath,
  isRecord,
  requireRecord,
  stringRecord,
  isActiveMetaEntry,
  isVaultFileReadResult,
  isVaultBinaryReadResult,
  isRepairRetryResult,
  isDegradedBinaryRestoreCheckResult,
  isInvalidMetaDiscardResult,
  isPathConflictRetryResult,
  isRenameMaterializeResolveResult,
  isRemoteMaterializeBlockedActionResult,
  isStartupSyncResult,
  isReconnectResult,
  isSetupExchangeResponse,
  isSnapshotImportCliResult,
  isBlobManifest,
}

export type {
  JsonRecord,
  SetupExchangeResponse,
  FileDocId,
  SourceBinaryChunk,
  BinaryChunk,
  BlobManifestChunk,
  BlobManifest,
  BuiltBinaryManifest,
  ActiveMetaEntry,
  VaultFileReadResult,
  VaultBinaryReadResult,
  RepairRetryResult,
  DegradedBinaryRestoreCheckResult,
  InvalidMetaDiscardResult,
  PathConflictRetryResult,
  RenameMaterializeResolveResult,
  RemoteMaterializeBlockedActionResult,
  StartupSyncResult,
  ReconnectResult,
  SnapshotImportCliResult,
  RemotePeer,
  RemoteWaiter,
}
