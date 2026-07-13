import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

function obsidian(args: readonly string[]): string {
  return execFileSync('obsidian', args, {
    cwd: packageDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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

function requireIncludes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}:\n${value}`)
  }
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
  const output = obsidian(['eval', `code=${code}`])
  // A console.warn/error fired during eval prints its own line(s) before the
  // return value, so the marker must be found anywhere in the output (not
  // just at the start) and only the text after the last occurrence parsed.
  const marker = '=> '
  const index = output.lastIndexOf(marker)
  const parsed: unknown = JSON.parse(index === -1 ? output : output.slice(index + marker.length))
  return parsed
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
    if (!app.vault.getAbstractFileByPath(${JSON.stringify(input.targetPath)}) && !(await app.vault.adapter.exists(${JSON.stringify(input.targetPath)}))) {
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

/**
 * Clears the plugin's local Yjs IndexedDB state before enabling it, so each
 * run starts as a genuine fresh join instead of inheriting fileId/ydocId
 * mappings left behind by earlier runs.
 *
 * This must delete both the per-file text databases (`kuroflare-file:*`) AND
 * the current vault's namespaced meta database (`kuroflare-meta:<vaultId>`),
 * while retaining the legacy `kuroflare-meta` name for old installs. Leaving
 * the current database in place lets a stale local fileId survive across runs
 * for any path reused between them (e.g. the fixed `notePath` used for the
 * active-file join scenario) — the join code then takes the hash-mismatch
 * "adopt-with-local-edit" branch instead of the "no remote entry yet,
 * allocate-new" branch a real fresh join would hit, which made the freshly
 * seeded remote content look like a local edit to be kept.
 */
function clearTextIndexedDb() {
  obsidian([
    'eval',
    `code=(async () => { const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []; const names = databases.map((database) => database.name).filter((name) => name?.startsWith('kuroflare-file:') || name === 'kuroflare-meta' || name === 'kuroflare-meta:${vaultId}'); await Promise.all(names.map((name) => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve('deleted'); request.onerror = () => reject(request.error); request.onblocked = () => resolve('blocked'); }))); return 'deleted'; })()`,
  ])
}

/**
 * Deletes this script's own leftover test files from earlier runs.
 *
 * The e2e vault is long-lived infrastructure shared across every invocation
 * of this script (and the other smoke scripts), so without cleanup it grows
 * forever. Once `clearTextIndexedDb` resets local meta on every run (see
 * above), `adoptLocalFilesAfterRemoteMeta` re-adopts *every* leftover
 * markdown file as a brand-new local file each run, and the worker's
 * alarm-driven checkpoint sweep over that ever-growing file set gets slow
 * enough to blow past this script's `waitFor` timeouts. Pruning prior runs'
 * artifacts up front keeps each run's adoption/checkpoint cost bounded.
 */
function cleanupStaleVaultArtifacts(vaultPath: string): void {
  for (const entry of readdirSync(vaultPath)) {
    if (STALE_VAULT_ARTIFACT_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      // `recursive` handles the (unexpected but observed) case where a past
      // run left a directory behind at one of these names.
      rmSync(join(vaultPath, entry), { force: true, recursive: true })
    }
  }
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

export {
  obsidian,
  requireObsidianVaultPath,
  requireIncludes,
  waitForRemoteMeta,
  evalInObsidian,
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
  clearTextIndexedDb,
  cleanupStaleVaultArtifacts,
  copyPlugin,
}
