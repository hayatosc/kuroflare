import { execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import * as Y from 'yjs'

import {
  packageDir,
  pluginId,
  endpoint,
  vaultId,
  setupToken,
  runId,
  remoteMaterializeBlockedPath,
  STALE_VAULT_ARTIFACT_PREFIXES,
  canonicalizeVaultPath,
  isRecord,
  isActiveMetaEntry,
  isVaultFileReadResult,
  isVaultBinaryReadResult,
  isRepairRetryResult,
  isDegradedBinaryRestoreCheckResult,
  isInvalidMetaDiscardResult,
  isPathConflictRetryResult,
  isRenameMaterializeResolveResult,
  isRemoteMaterializeBlockedActionResult,
} from './types.ts'
import type {
  ActiveMetaEntry,
  JsonRecord,
  VaultFileReadResult,
  VaultBinaryReadResult,
  RepairRetryResult,
  DegradedBinaryRestoreCheckResult,
  InvalidMetaDiscardResult,
  PathConflictRetryResult,
  RenameMaterializeResolveResult,
  RemoteMaterializeBlockedActionResult,
  RemotePeer,
} from './types.ts'
import { encodeBase64, decodeBase64, metaPaths } from './yjs.ts'

function rawObsidian(args: readonly string[]): string {
  return execFileSync('obsidian', args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export interface LinuxProcessSnapshot {
  readonly pid: number
  readonly uid: number
  readonly argv: readonly string[]
  readonly executablePath: string
  readonly state: string
  readonly startTime: string
}

export interface ObsidianProcessRestartOptions {
  readonly appCommand: string
  readonly vaultPath: string
  readonly timeoutMs?: number
}

function resolveExecutablePath(command: string): string {
  const path = command.includes('/')
    ? command
    : execFileSync('which', [command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
  if (path === '') throw new Error(`Obsidian app command resolved to an empty path: ${command}`)
  accessSync(path)
  return realpathSync(path)
}

function parseLinuxProcessStat(
  value: string,
): { readonly state: string; readonly startTime: string } | null {
  const commandEnd = value.lastIndexOf(')')
  if (commandEnd < 0) return null
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const startTime = fields[19]
  if (state === undefined || startTime === undefined || !/^\d+$/.test(startTime)) return null
  return { state, startTime }
}

function readLinuxProcessSnapshots(): readonly LinuxProcessSnapshot[] {
  if (process.platform !== 'linux') {
    throw new Error('Obsidian process restart requires Linux /proc process inspection.')
  }
  const snapshots: LinuxProcessSnapshot[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`)
        .toString('utf8')
        .split('\0')
        .filter((value, index, values) => index < values.length - 1 || value !== '')
      if (argv.length === 0) continue
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const uidLine = status.split('\n').find((line) => line.startsWith('Uid:'))
      const uid = Number(uidLine?.trim().split(/\s+/)[1])
      if (!Number.isSafeInteger(uid)) continue
      const executablePath = realpathSync(`/proc/${pid}/exe`)
      const processStat = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (processStat === null) continue
      snapshots.push({ pid, uid, argv, executablePath, ...processStat })
    } catch {
      // Processes can exit between /proc reads; an unreadable candidate is not safe to kill.
    }
  }
  return snapshots
}

function isSameLinuxProcessIdentity(
  expected: LinuxProcessSnapshot,
  current: LinuxProcessSnapshot | null,
): boolean {
  return (
    current !== null &&
    current.state !== 'Z' &&
    current.pid === expected.pid &&
    current.uid === expected.uid &&
    current.executablePath === expected.executablePath &&
    current.startTime === expected.startTime &&
    sameArgv(current.argv, expected.argv)
  )
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function selectUniqueObsidianRootProcess(
  snapshots: readonly LinuxProcessSnapshot[],
  expected: {
    readonly executablePath: string
    readonly argv: readonly string[]
    readonly uid: number
  },
): LinuxProcessSnapshot {
  const matches = snapshots.filter(
    (snapshot) =>
      snapshot.uid === expected.uid &&
      snapshot.executablePath === expected.executablePath &&
      sameArgv(snapshot.argv, expected.argv) &&
      snapshot.state !== 'Z',
  )
  if (matches.length !== 1) {
    throw new Error(
      `Refusing Obsidian process restart: expected exactly one matching root process, found ${matches.length}.`,
    )
  }
  const match = matches[0]
  if (match === undefined) throw new Error('Obsidian process match disappeared during selection.')
  return match
}

function readLinuxProcessState(pid: number): string | null {
  try {
    return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.state ?? null
  } catch {
    return null
  }
}

async function waitForLinuxProcessStopped(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = readLinuxProcessState(pid)
    if (state === null || state === 'Z') return
    await sleep(100)
  }
  throw new Error(`Obsidian root process ${pid} did not stop within ${timeoutMs}ms.`)
}

async function restartObsidianProcess(options: ObsidianProcessRestartOptions): Promise<void> {
  requireSafeObsidianVaultPath(options.vaultPath)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid Obsidian process restart timeout: ${timeoutMs}`)
  }
  const executablePath = resolveExecutablePath(options.appCommand)
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Obsidian process restart requires a Linux process uid.')
  const expectedArgv = [options.appCommand, options.vaultPath]
  const rootProcess = selectUniqueObsidianRootProcess(readLinuxProcessSnapshots(), {
    executablePath,
    argv: expectedArgv,
    uid,
  })
  const currentRootProcess =
    readLinuxProcessSnapshots().find((snapshot) => snapshot.pid === rootProcess.pid) ?? null
  if (!isSameLinuxProcessIdentity(rootProcess, currentRootProcess)) {
    throw new Error(
      `Refusing Obsidian process restart: root process identity changed before SIGTERM (pid ${rootProcess.pid}).`,
    )
  }
  try {
    process.kill(rootProcess.pid, 'SIGTERM')
  } catch (error: unknown) {
    throw new Error(`Failed to stop Obsidian root process ${rootProcess.pid}.`, { cause: error })
  }
  await waitForLinuxProcessStopped(rootProcess.pid, timeoutMs)
  const child = spawn(options.appCommand, [options.vaultPath], {
    detached: true,
    stdio: 'ignore',
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', (error: unknown) => {
      reject(new Error(`Failed to start Obsidian: ${options.appCommand}`, { cause: error }))
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function obsidian(args: readonly string[]): string {
  if (args[0] !== 'vault' || args[1] !== 'info=path') {
    requireSafeObsidianVaultPath(requireObsidianVaultPath(rawObsidian(['vault', 'info=path'])))
  }
  return rawObsidian(args)
}

/**
 * Validates the active vault path returned by the Obsidian CLI.
 *
 * @param value - Raw stdout from `obsidian vault info=path`.
 * @returns The validated absolute path to an existing directory.
 * @throws When the CLI did not return a usable vault directory.
 */
function requireObsidianVaultPath(value: string): string {
  const vaultPath = value.trim()
  if (vaultPath === '' || vaultPath === 'Vault not found.') {
    throw new Error('Obsidian CLI did not return an active vault path.')
  }
  if (!isAbsolute(vaultPath)) {
    throw new Error(`Obsidian CLI returned a relative vault path: ${JSON.stringify(vaultPath)}`)
  }
  if (!statSync(vaultPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Obsidian CLI returned a vault path that is not an existing directory: ${JSON.stringify(vaultPath)}`,
    )
  }
  return vaultPath
}

const DEFAULT_E2E_OBSIDIAN_VAULT_PATH = '/tmp/kuroflare-obsidian-cli-smoke'

/**
 * Refuses destructive harness operations unless Obsidian is using the disposable e2e vault.
 *
 * @param vaultPath - Absolute active vault path returned by the Obsidian CLI.
 * @returns The validated vault path.
 * @throws When the active vault does not exactly match the configured e2e vault path.
 */
function requireSafeObsidianVaultPath(vaultPath: string): string {
  const expectedPath = resolve(
    process.env.KUROFLARE_E2E_OBSIDIAN_VAULT_PATH ?? DEFAULT_E2E_OBSIDIAN_VAULT_PATH,
  )
  const resolvedVaultPath = resolve(vaultPath)
  const canonicalExpectedPath = realpathSync(expectedPath)
  const canonicalVaultPath = realpathSync(resolvedVaultPath)
  if (
    !isAbsolute(vaultPath) ||
    resolvedVaultPath !== expectedPath ||
    canonicalExpectedPath !== expectedPath ||
    canonicalVaultPath !== expectedPath
  ) {
    throw new Error(
      `Refusing to mutate active Obsidian vault ${JSON.stringify(vaultPath)}. ` +
        `Expected the disposable e2e vault at ${JSON.stringify(expectedPath)}; ` +
        'set KUROFLARE_E2E_OBSIDIAN_VAULT_PATH to override it.',
    )
  }
  return vaultPath
}

function requireIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}:\n${value}`)
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

/** Acquires exclusive ownership of the shared disposable Obsidian vault. */
function acquireObsidianE2ELock(vaultPath: string): () => void {
  requireSafeObsidianVaultPath(vaultPath)
  const lockPath = join(vaultPath, '.kuroflare-e2e.lock')
  const owner = JSON.stringify({ pid: process.pid, runId })
  const writeLock = (): void => writeFileSync(lockPath, owner, { flag: 'wx' })
  try {
    writeLock()
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') {
      throw new Error(`Failed to acquire Obsidian e2e lock: ${lockPath}`, { cause: error })
    }
    throw new Error(
      `Obsidian e2e vault is already in use: ${lockPath}. Remove a stale lock only after confirming no harness is running.`,
      { cause: error },
    )
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      if (readFileSync(lockPath, 'utf8') === owner) {
        unlinkSync(lockPath)
      }
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        console.warn('Failed to release Obsidian e2e lock', { error })
      }
    }
  }
  process.once('exit', release)
  return release
}

// The e2e vault is long-lived and shared across every run of this script, so
// the worker DO's checkpoint alarm (`CHECKPOINT_ALARM_DELAY_MS` in
// runtime.ts) and per-file blob round-trips can serialize behind other work
// on the DO's single execution context and stall message acks/broadcasts --
// observed stalling different specific waits from run to run, not always the
// same one, and sometimes back-to-back (worker acks arriving in ~30s-apart
// bursts, e.g. two consecutive stalls in one run before the relevant ack
// landed). Every wait gated on a worker round-trip (this function, and
// `RemotePeer.waitFor` below) defaults to enough headroom to ride out a
// couple of those cycles; only genuinely local polls (e.g.
// `waitForActiveMetaEntry`, which reads local plugin state directly) keep a
// tight default.
async function waitForRemoteMeta(
  remote: RemotePeer,
  doc: Y.Doc,
  predicate: (doc: Y.Doc) => boolean,
  label: string,
  timeoutMs = 90_000,
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

function evalInObsidian(code: string): unknown {
  const expectedPath = requireSafeObsidianVaultPath(
    requireObsidianVaultPath(rawObsidian(['vault', 'info=path'])),
  )
  const guardedCode = `(async () => {
    const activeVaultPath = typeof app.vault.adapter.getBasePath === 'function'
      ? app.vault.adapter.getBasePath()
      : app.vault.adapter.basePath;
    if (activeVaultPath !== ${JSON.stringify(expectedPath)}) {
      throw new Error('Refusing Obsidian eval after active vault changed.');
    }
    return await (${code});
  })()`
  const output = rawObsidian(['eval', `code=${guardedCode}`])
  // A console.warn/error fired during eval prints its own line(s) before the
  // return value, so the marker must be found anywhere in the output (not
  // just at the start) and only the text after the last occurrence parsed.
  const marker = '=> '
  const index = output.lastIndexOf(marker)
  const parsed: unknown = JSON.parse(index === -1 ? output : output.slice(index + marker.length))
  return parsed
}

async function waitForObsidianVaultReady(vaultPath: string, timeoutMs = 30_000): Promise<void> {
  requireSafeObsidianVaultPath(vaultPath)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (
        requireObsidianVaultPath(rawObsidian(['vault', 'info=path'])) ===
        requireSafeObsidianVaultPath(vaultPath)
      ) {
        return
      }
    } catch {
      // The CLI socket is expected to be unavailable while the app restarts.
    }
    await sleep(250)
  }
  throw new Error(`Obsidian did not reopen the e2e vault within ${timeoutMs}ms.`)
}

async function deleteObsidianProviderDatabase(
  vaultId: string,
  ydocId: string,
  timeoutMs = 10_000,
): Promise<void> {
  if (vaultId === '')
    throw new Error('Cannot delete an Obsidian provider database without a vaultId.')
  if (ydocId === '')
    throw new Error('Cannot delete an Obsidian provider database without a ydocId.')
  const databaseName = `kuroflare-file:${vaultId}:${ydocId}`
  const result = evalInObsidian(`(async () => {
    const expectedName = ${JSON.stringify(databaseName)};
    const request = indexedDB.deleteDatabase(expectedName);
    let blocked = false;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('provider database deletion timed out')), ${timeoutMs});
      request.onblocked = () => { blocked = true; };
      request.onerror = () => { clearTimeout(timeout); reject(request.error ?? new Error('provider database deletion failed')); };
      request.onsuccess = () => { clearTimeout(timeout); resolve(undefined); };
    });
    return JSON.stringify({ databaseName: expectedName, blocked });
  })()`)
  if (
    !isRecord(result) ||
    result.databaseName !== databaseName ||
    typeof result.blocked !== 'boolean'
  ) {
    throw new Error(`invalid provider database deletion result: ${JSON.stringify(result)}`)
  }
}

interface OutboxDrainSummary {
  readonly kind: string
  readonly status: string
  readonly messageId: string
}

async function drainStartupOutbox(timeoutMs = 30_000): Promise<void> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    if (!plugin || typeof plugin.runOutboxWorkerTick !== 'function') {
      throw new Error('kuroflare outbox worker is unavailable');
    }
    const metadataAccess = plugin.metadataAccess;
    const db = plugin.localStoreDb;
    if (!db) throw new Error('kuroflare local store is unavailable');
    const deadline = Date.now() + ${timeoutMs};
    async function readSnapshot() {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(['outbox', 'running-leases'], 'readonly');
        const outboxRequest = transaction.objectStore('outbox').getAll();
        const leasesRequest = transaction.objectStore('running-leases').getAll();
        transaction.oncomplete = () => resolve({ outbox: outboxRequest.result, leases: leasesRequest.result });
        transaction.onerror = () => reject(transaction.error ?? new Error('outbox snapshot read failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('outbox snapshot read aborted'));
      });
    }
    function summary(rows) {
      return rows.map((row) => ({
        kind: typeof row?.kind === 'string' ? row.kind : 'unknown',
        status: typeof row?.status === 'string' ? row.status : 'unknown',
        messageId: typeof row?.messageId === 'string' ? row.messageId : typeof row?.id === 'string' ? row.id : 'unknown',
      }));
    }
    function remainingRows(snapshot) {
      return snapshot.outbox.filter((row) => {
        if (!row || (row.kind !== 'y-update' && row.kind !== 'meta-ref-update') || (row.status !== 'pending' && row.status !== 'retrying')) return false;
        return !(metadataAccess === 'read-only' && row.docId?.kind === 'meta');
      });
    }
    let emptySince = null;
    while (Date.now() < deadline) {
      const snapshot = await readSnapshot();
      const remaining = remainingRows(snapshot);
      if (remaining.length === 0) {
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 500) {
          return JSON.stringify({ ok: true, remaining: [] });
        }
      } else {
        emptySince = null;
        await plugin.runOutboxWorkerTick('e2e-startup-drain');
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const snapshot = await readSnapshot();
    return JSON.stringify({ ok: false, remaining: summary(remainingRows(snapshot)) });
  })()`)
  if (!isRecord(result) || typeof result.ok !== 'boolean' || !Array.isArray(result.remaining)) {
    throw new Error(`invalid startup outbox drain result: ${JSON.stringify(result)}`)
  }
  if (result.ok) return
  const summary = result.remaining.filter(
    (entry): entry is OutboxDrainSummary =>
      isRecord(entry) &&
      typeof entry.kind === 'string' &&
      typeof entry.status === 'string' &&
      typeof entry.messageId === 'string',
  )
  throw new Error(`startup outbox drain timed out: ${JSON.stringify(summary)}`)
}

function waitForObsidianPluginLoaded(timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const loaded = evalInObsidian(
      `(() => JSON.stringify(Boolean(app.plugins.plugins[${JSON.stringify(pluginId)}])))()`,
    )
    if (loaded === true) {
      return
    }
  }
  throw new Error(`${pluginId} plugin did not load within ${timeoutMs}ms`)
}

function readActiveMetaEntry(path: string): ActiveMetaEntry | null {
  const value = evalInObsidian(`(() => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!map || typeof plugin?.readMetaEntry !== 'function') return JSON.stringify(null);
    const target = ${JSON.stringify(path)}.normalize('NFC').replace(/\\/+/g, '/').toLowerCase();
    for (const [fileId] of map.entries()) {
      const value = plugin.readMetaEntry(fileId);
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
    if (!plugin || typeof plugin.readMetaEntry !== 'function') return JSON.stringify(null);
    const value = plugin.readMetaEntry(${JSON.stringify(fileId)});
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

async function waitForVaultPathAbsent(path: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exists = evalInObsidian(
      `(async () => JSON.stringify(await app.vault.adapter.exists(${JSON.stringify(path)})))()`,
    )
    if (exists === false) {
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
    if (!(await app.vault.adapter.exists(path))) {
      return JSON.stringify({ exists: false, size: 0, sha256: '' });
    }
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

function driveBinaryMaterializeOutbox(
  path: string,
  expectedSha256: string,
  timeoutMs = 30_000,
): VaultBinaryReadResult {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    if (!plugin) return JSON.stringify({ exists: false, size: 0, sha256: '' });
    const path = ${JSON.stringify(path)};
    const expectedSha256 = ${JSON.stringify(expectedSha256)};
    const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
    async function readHash() {
      if (!(await app.vault.adapter.exists(path))) {
        return { exists: false, size: 0, sha256: '' };
      }
      const buffer = await app.vault.adapter.readBinary(path);
      const hash = await crypto.subtle.digest('SHA-256', buffer);
      const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
      return { exists: true, size: buffer.byteLength, sha256 };
    }
    while (Date.now() < deadline) {
      await plugin.enqueueMissingDownloads?.();
      await plugin.runOutboxWorkerTick?.('e2e-binary-materialize');
      const result = await readHash();
      if (result.exists === true && result.sha256 === expectedSha256) {
        return JSON.stringify(result);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return JSON.stringify(await readHash());
  })()`)
  if (!isVaultBinaryReadResult(result)) {
    throw new Error(`invalid driven binary materialize result: ${JSON.stringify(result)}`)
  }
  return result
}

/**
 * Writes binary content into the Obsidian vault via the CLI `eval` bridge.
 *
 * The payload cannot be inlined into the eval'd source (as every other
 * `evalInObsidian` call site here does for small strings/ids): base64-encoding
 * even a moderately sized binary fixture produces an argv string that blows
 * past the OS `ARG_MAX` for `execFileSync`, failing with `E2BIG`. Instead the
 * payload is written to a temp file and the (short) file path is embedded in
 * the eval'd code, which reads it back via Node's `fs` module -- available
 * because the CLI `eval` runs in Obsidian's Electron renderer with Node
 * integration enabled.
 */
function createObsidianBinary(path: string, bytes: Uint8Array): void {
  const dir = mkdtempSync(join(tmpdir(), 'kuroflare-binary-payload-'))
  const payloadPath = join(dir, 'payload.b64')
  writeFileSync(payloadPath, encodeBase64(bytes))
  try {
    evalInObsidian(`(async () => {
      const base64 = require('fs').readFileSync(${JSON.stringify(payloadPath)}, 'utf8');
      const binary = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      if (existing || await app.vault.adapter.exists(${JSON.stringify(path)})) {
        await app.vault.adapter.writeBinary(${JSON.stringify(path)}, binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
        return JSON.stringify({ action: 'modified', size: binary.byteLength });
      }
      await app.vault.createBinary(${JSON.stringify(path)}, binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
      return JSON.stringify({ action: 'created', size: binary.byteLength });
    })()`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

function createOrOverwriteObsidianText(path: string, content: string): void {
  evalInObsidian(`(async () => {
    const path = ${JSON.stringify(path)};
    const content = ${JSON.stringify(content)};
    const file = app.vault.getAbstractFileByPath(path);
    if (file) {
      await app.vault.modify(file, content);
      return JSON.stringify({ action: 'modified' });
    }
    if (await app.vault.adapter.exists(path)) {
      await app.vault.adapter.write(path, content);
      return JSON.stringify({ action: 'written' });
    }
    await app.vault.create(path, content);
    return JSON.stringify({ action: 'created' });
  })()`)
}

async function retryBinaryRestoreCheck(fileId: string): Promise<RepairRetryResult> {
  const result = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const map = plugin?.metaDoc?.getMap('meta');
    if (!plugin || !map) return JSON.stringify({ repairLogContainsEntry: false });
    const current = plugin.readMetaEntry(${JSON.stringify(fileId)});
    if (!current) return JSON.stringify({ repairLogContainsEntry: false });
    const deletedAt = typeof current.deletedAt === 'number' ? current.deletedAt : Date.now();
    map.doc.transact(() => {
      plugin.writeMetaEntry({
        ...current,
        deleted: true,
        deletedAt,
        deletedBy: 'e2e-delete-device',
        // A stale deletion witness (distinct from the entry's real, still-uploaded
        // blobManifestHash) simulates a concurrent edit the deletion evidence never
        // observed, so reconciliation restores the current, restorable content.
        deletedContentVersion: { kind: 'binary', blobManifestHash: 'f'.repeat(64) },
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
    const after = plugin.readMetaEntry(${JSON.stringify(fileId)});
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
      plugin.writeMetaEntry({
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
        deletedContentVersion: { kind: 'binary', blobManifestHash: 'f'.repeat(64) },
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
    // A real invalid entry is only ever observed from a remote broadcast, applied
    // under the worker origin, which \`attachMetaDocObservers\` never auto-sends back
    // out. Tagging this simulated insert the same way keeps it from attempting (and
    // having to silently drop, since an invalid entry makes the doc temporarily
    // unwritable) an outbound send of its own: that dropped send would otherwise
    // leave the discard below referencing content the server never received,
    // which fails the server's causal-application check and quarantines the update.
    map.doc.transact(() => {
      map.set(${JSON.stringify(fileId)}, { invalid: true, path: 'invalid-meta.bin' });
    }, 'kuroflare:worker');
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
    const current = plugin.readMetaEntry(${JSON.stringify(input.fileId)});
    if (!current) {
      return JSON.stringify({
        sourceExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.sourcePath)})),
        targetExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})),
        repairLogContainsEntry: false,
      });
    }
    const now = Date.now();
    map.doc.transact(() => {
      plugin.writeMetaEntry({
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
    const after = plugin.readMetaEntry(${JSON.stringify(input.fileId)});
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
    const current = plugin.readMetaEntry(${JSON.stringify(input.fileId)});
    if (!current) {
      return JSON.stringify({
        sourceExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.sourcePath)})),
        blockedTargetExists: Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)})),
        resolvedExists: false,
        repairLogContainsEntry: false,
      });
    }
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)}) && !(await app.vault.adapter.exists(${JSON.stringify(input.targetPath)}))) {
      await app.vault.createFolder(${JSON.stringify(input.targetPath)});
    }
    const now = Date.now();
    map.doc.transact(() => {
      plugin.writeMetaEntry({
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
    const after = plugin.readMetaEntry(${JSON.stringify(input.fileId)});
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
      plugin.writeMetaEntry({
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
    if (!app.vault.getAbstractFileByPath(autoPath) && !(await app.vault.adapter.exists(autoPath))) {
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
      plugin.writeMetaEntry({
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
    const autoResolved = plugin.readMetaEntry(autoFileId);

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

/**
 * Deletes this script's own leftover test files from earlier runs.
 *
 * The e2e vault is long-lived infrastructure shared across every invocation
 * of this script (and the other smoke scripts), so without cleanup it grows
 * forever. Pruning prior runs' artifacts up front keeps adoption and the
 * worker's alarm-driven checkpoint sweep bounded.
 */
function cleanupStaleVaultArtifacts(vaultPath: string): void {
  requireSafeObsidianVaultPath(vaultPath)
  for (const entry of readdirSync(vaultPath)) {
    if (STALE_VAULT_ARTIFACT_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      // `recursive` handles the (unexpected but observed) case where a past
      // run left a directory behind at one of these names.
      rmSync(join(vaultPath, entry), { force: true, recursive: true })
    }
  }
}

function copyPlugin(vaultPath: string): void {
  requireSafeObsidianVaultPath(vaultPath)
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

export {
  obsidian,
  isSameLinuxProcessIdentity,
  selectUniqueObsidianRootProcess,
  restartObsidianProcess,
  requireObsidianVaultPath,
  requireSafeObsidianVaultPath,
  acquireObsidianE2ELock,
  requireIncludes,
  waitForRemoteMeta,
  evalInObsidian,
  waitForObsidianVaultReady,
  deleteObsidianProviderDatabase,
  drainStartupOutbox,
  waitForObsidianPluginLoaded,
  readActiveMetaEntry,
  readMetaEntryByFileId,
  waitForActiveMetaEntry,
  waitForMetaEntryByFileId,
  waitForActiveMetaEntryByFileId,
  waitForVaultPath,
  waitForVaultPathAbsent,
  waitForVaultFileIncludes,
  waitForVaultBinaryHash,
  readVaultBinaryHash,
  driveBinaryMaterializeOutbox,
  createObsidianBinary,
  renameObsidianFile,
  deleteObsidianFile,
  createOrOverwriteObsidianText,
  retryBinaryRestoreCheck,
  retryDegradedBinaryRestoreCheck,
  discardInvalidMetaEntry,
  retryPathConflictMaterialize,
  resolveRenameMaterializeFailure,
  runRemoteMaterializeBlockedActions,
  cleanupStaleVaultArtifacts,
  copyPlugin,
}
