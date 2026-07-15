import * as Y from 'yjs'

import {
  seedSetupToken,
  importBootstrapSnapshotsWithCli,
  makeBinaryBytes,
  makeLocalBinaryBytes,
  buildBinaryManifest,
  uploadBlobChunk,
  uploadBlobManifest,
  exchangeSetupToken,
  connectRemoteDevice,
  fetchLatestMetaUpdate,
  fetchLatestFileUpdate,
  downloadWorkerBinaryByManifest,
} from './http.ts'
import {
  obsidian,
  requireObsidianVaultPath,
  requireSafeObsidianVaultPath,
  acquireObsidianE2ELock,
  evalInObsidian,
  waitForObsidianPluginLoaded,
  waitForVaultFileIncludes,
  waitForVaultPath,
  waitForVaultPathAbsent,
  waitForActiveMetaEntry,
  waitForActiveMetaEntryByFileId,
  waitForMetaEntryByFileId,
  waitForRemoteMeta,
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
  deleteObsidianProviderDatabase,
  drainStartupOutbox,
  requireIncludes,
  restartObsidianProcess,
  waitForObsidianVaultReady,
} from './obsidian-utils.ts'
import {
  notePath,
  initialFullSyncPath,
  initialFullSyncText,
  initialFullSyncFileId,
  initialFullSyncYDocId,
  remoteSeedText,
  remotePeerText,
  localObsidianText,
  pendingRecoveryText,
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
  vaultId,
  setupToken,
  runId,
  pluginId,
  cliBootstrapSetupToken,
  remoteSetupToken,
  yTextName,
  canonicalizeVaultPath,
  isRecord,
  isStartupSyncResult,
  isReconnectResult,
} from './types.ts'
import type { RemotePeer } from './types.ts'
import {
  activeDocIdForPath,
  makeYTextUpdate,
  makeMetaSnapshotUpdate,
  setMetaEntry,
  encodeBase64,
  decodeBase64,
  sha256Hex,
  readNormalizedMetaEntry,
  metaPaths,
  renameMetaEntry,
} from './yjs.ts'

const obsidianPollTimeoutMs = parsePositiveInteger(
  process.env.KUROFLARE_E2E_OBSIDIAN_POLL_TIMEOUT_MS,
  30_000,
)
const workerRoundTripTimeoutMs = parsePositiveInteger(
  process.env.KUROFLARE_E2E_WORKER_ROUND_TRIP_TIMEOUT_MS,
  90_000,
)
const obsidianAppCommand = process.env.KUROFLARE_E2E_OBSIDIAN_APP ?? 'obsidian-app'

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`)
  }
  return parsed
}

interface RecoverySnapshot {
  readonly vaultId: string | null
  readonly docId: string | null
  readonly actorClientId: number | null
  readonly epochId: string | null
  readonly epochStatus: string | null
  readonly providerPresent: boolean
  readonly connected: boolean
  readonly socketReadyState: number | null
  readonly fileText: string
}

function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  return (
    isRecord(value) &&
    (value.vaultId === null || typeof value.vaultId === 'string') &&
    (value.docId === null || typeof value.docId === 'string') &&
    (value.actorClientId === null || typeof value.actorClientId === 'number') &&
    (value.epochId === null || typeof value.epochId === 'string') &&
    (value.epochStatus === null || typeof value.epochStatus === 'string') &&
    typeof value.providerPresent === 'boolean' &&
    typeof value.connected === 'boolean' &&
    (value.socketReadyState === null || typeof value.socketReadyState === 'number') &&
    typeof value.fileText === 'string'
  )
}

function readRecoverySnapshot(): RecoverySnapshot {
  const value = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const ydocId = ${JSON.stringify(docId.ydocId)};
    const loaded = plugin?.loadedTextDocs?.get(ydocId);
    const epochKey = ${JSON.stringify(`document-epoch:file:${docId.ydocId}`)};
    let epoch = null;
    const db = plugin?.localStoreDb;
    if (db) {
      epoch = await new Promise((resolve, reject) => {
        const request = db.transaction(['metadata'], 'readonly').objectStore('metadata').get(epochKey);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error('epoch read failed'));
      });
    }
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    const providerPresent = databases.some((database) => database?.name === ${JSON.stringify(`kuroflare-file:${docId.ydocId}`)});
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
    return JSON.stringify({
      vaultId: typeof plugin?.kuroflareSettings?.setupVaultId === 'string' ? plugin.kuroflareSettings.setupVaultId : null,
      docId: loaded?.docId?.kind === 'file' && typeof loaded.docId.ydocId === 'string' ? loaded.docId.ydocId : null,
      actorClientId: typeof loaded?.doc?.clientID === 'number' ? loaded.doc.clientID : null,
      epochId: epoch && typeof epoch.epochId === 'string' ? epoch.epochId : null,
      epochStatus: epoch && typeof epoch.status === 'string' ? epoch.status : null,
      providerPresent,
      connected: plugin?.workerHelloAccepted === true,
      socketReadyState: plugin?.workerWebSocketSession?.snapshot()?.readyState ?? null,
      fileText: file ? await app.vault.read(file) : '',
    });
  })()`)
  if (!isRecoverySnapshot(value)) {
    throw new Error(`invalid recovery snapshot: ${JSON.stringify(value)}`)
  }
  return value
}

async function waitForRecoverySnapshot(timeoutMs: number): Promise<RecoverySnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = readRecoverySnapshot()
    if (
      snapshot.vaultId === vaultId &&
      snapshot.docId === docId.ydocId &&
      snapshot.actorClientId !== null &&
      snapshot.epochId !== null &&
      snapshot.epochStatus === 'ready' &&
      snapshot.providerPresent &&
      snapshot.connected &&
      snapshot.socketReadyState === WebSocket.OPEN &&
      snapshot.fileText.includes(remoteSeedText)
    ) {
      return snapshot
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return readRecoverySnapshot()
}

const vaultPath = requireSafeObsidianVaultPath(
  requireObsidianVaultPath(obsidian(['vault', 'info=path'])),
)
acquireObsidianE2ELock(vaultPath)

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

copyPlugin(vaultPath)

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
// Prune prior runs' leftover artifacts while the plugin is inactive, so no
// live vault watcher reacts to files disappearing out from under it.
cleanupStaleVaultArtifacts(vaultPath)
requireSafeObsidianVaultPath(vaultPath)
createOrOverwriteObsidianText(notePath, `Obsidian Miniflare local placeholder ${runId}`)
obsidian(['open', `path=${notePath}`])
obsidian(['plugins:restrict', 'off'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
waitForObsidianPluginLoaded(obsidianPollTimeoutMs)
obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

const resultValue = evalInObsidian(`(async () => {
  const deadline = Date.now() + ${obsidianPollTimeoutMs};
  while (Date.now() < deadline) {
    const plugin = app.plugins.plugins.kuroflare;
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(notePath)});
    const fileText = file ? await app.vault.read(file) : '';
    const state = {
      setupVaultId: plugin?.kuroflareSettings?.setupVaultId,
      setupToken: plugin?.kuroflareSettings?.setupToken,
      connected: plugin?.workerHelloAccepted,
      socketReadyState: plugin?.workerWebSocketSession?.snapshot()?.readyState,
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
    setupVaultId: plugin?.kuroflareSettings?.setupVaultId,
    setupToken: plugin?.kuroflareSettings?.setupToken,
    connected: plugin?.workerHelloAccepted,
    socketReadyState: plugin?.workerWebSocketSession?.snapshot()?.readyState,
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
  obsidianPollTimeoutMs,
)
if (
  initialFullSyncResult.exists !== true ||
  !initialFullSyncResult.text.includes(initialFullSyncText)
) {
  throw new Error(
    `plugin did not materialize initial full sync file: ${JSON.stringify(initialFullSyncResult)}`,
  )
}

await drainStartupOutbox(workerRoundTripTimeoutMs)

await seedSetupToken(remoteSetupToken)
const remoteSetup = await exchangeSetupToken(remoteSetupToken, 'Remote WebSocket E2E')
const remote = await connectRemoteDevice(remoteSetup)
let recoveryRemote: RemotePeer | null = null
const remoteObservedDoc = new Y.Doc()
const remoteMetaDoc = new Y.Doc()
const recoveryPeerDoc = new Y.Doc()
try {
  Y.applyUpdate(remoteObservedDoc, seedUpdate)
  Y.applyUpdate(remoteMetaDoc, await fetchLatestMetaUpdate(remoteSetup))
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
    const deadline = Date.now() + ${obsidianPollTimeoutMs};
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

  createOrOverwriteObsidianText(metaLocalPath, 'local meta rename source')
  createOrOverwriteObsidianText(metaPeerPath, 'peer meta rename source')
  const localMetaEntry = await waitForActiveMetaEntry(metaLocalPath, obsidianPollTimeoutMs)
  const peerMetaEntry = await waitForActiveMetaEntry(metaPeerPath, obsidianPollTimeoutMs)
  if (localMetaEntry === null || peerMetaEntry === null) {
    const metadataRegistrationState = evalInObsidian(`(() => {
      const plugin = app.plugins.plugins.kuroflare;
      const root = plugin?.metaDoc?.getMap('meta');
      const gate = plugin?.startupSideEffectGate;
      return JSON.stringify({
        metadataAccess: plugin?.metadataAccess ?? null,
        metadataCapabilityAdvertised: plugin?.metadataCapabilityAdvertised ?? null,
        metadataCapabilityFallbackAttempted: plugin?.metadataCapabilityFallbackAttempted ?? null,
        metadataMigrationPending: plugin?.metadataMigrationPending ?? null,
        metaSize: root?.size ?? null,
        metaValueKinds: root ? [...root.values()].map((value) => value?.constructor?.name ?? typeof value) : [],
        gate: gate ? {
          permission: gate.permission,
          replayingPersistence: gate.replayingPersistence,
          recoveryInProgress: gate.recoveryInProgress,
          recoveryBlockReason: gate.recoveryBlockReason,
          canRun: gate.canRun(),
          canSendNetwork: gate.canSendNetwork(),
        } : null,
        files: {
          local: app.vault.getAbstractFileByPath(${JSON.stringify(metaLocalPath)})?.path ?? null,
          peer: app.vault.getAbstractFileByPath(${JSON.stringify(metaPeerPath)})?.path ?? null,
        },
      });
    })()`)
    throw new Error(
      `Obsidian did not register meta entries: ${JSON.stringify({ localMetaEntry, peerMetaEntry, metadataRegistrationState })}`,
    )
  }
  obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])
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
      return (
        readNormalizedMetaEntry(doc, localMetaEntry.fileId)?.path === metaSharedPath &&
        readNormalizedMetaEntry(doc, peerMetaEntry.fileId)?.path === peerConflictPath
      )
    },
    'remote meta conflict repair broadcast',
  )

  const sharedEntry = await waitForActiveMetaEntry(metaSharedPath, obsidianPollTimeoutMs)
  const conflictEntry = await waitForActiveMetaEntry(peerConflictPath, obsidianPollTimeoutMs)
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

  if (
    !(await waitForVaultPath(metaSharedPath, obsidianPollTimeoutMs)) ||
    !(await waitForVaultPath(peerConflictPath, obsidianPollTimeoutMs))
  ) {
    throw new Error(
      `meta rename was not materialized on disk: ${JSON.stringify({
        metaSharedPath,
        peerConflictPath,
      })}`,
    )
  }

  createOrOverwriteObsidianText(pathConflictRepairSourcePath, 'path conflict repair source')
  const pathConflictRepairEntry = await waitForActiveMetaEntry(
    pathConflictRepairSourcePath,
    obsidianPollTimeoutMs,
  )
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
      readNormalizedMetaEntry(doc, pathConflictRepairEntry.fileId)?.path ===
      pathConflictRepairTargetPath,
    'path-conflict repair meta broadcast',
  )

  createOrOverwriteObsidianText(renameRepairSourcePath, 'rename materialize repair source')
  const renameRepairEntry = await waitForActiveMetaEntry(
    renameRepairSourcePath,
    obsidianPollTimeoutMs,
  )
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

  // Let the repair-driven meta writes above (each its own outbox item, on the
  // shared sync-control lane) settle before the binary steps below queue
  // more: starting a new local write while an earlier one is still
  // unacknowledged can build a causally-dependent chain the server
  // momentarily lacks enough history to apply, quarantining the update.
  await drainStartupOutbox(workerRoundTripTimeoutMs)

  const localBinaryBytes = makeLocalBinaryBytes()
  const localBinaryHash = await sha256Hex(localBinaryBytes)
  createObsidianBinary(localBinaryPath, localBinaryBytes)
  const localBinaryEntry = await waitForActiveMetaEntry(localBinaryPath, obsidianPollTimeoutMs)
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
      const entry = readNormalizedMetaEntry(doc, localBinaryEntry.fileId)
      return (
        entry?.path === localBinaryPath &&
        entry.type === 'binary' &&
        entry.blobManifestHash === localBinaryEntry.blobManifestHash
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
    obsidianPollTimeoutMs,
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
      const entry = readNormalizedMetaEntry(doc, localBinaryEntry.fileId)
      return (
        entry?.path === localBinaryPath &&
        entry.blobManifestHash === modifiedLocalBinaryEntry.blobManifestHash
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
    obsidianPollTimeoutMs,
  )
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = readNormalizedMetaEntry(doc, localBinaryEntry.fileId)
      return (
        entry?.path === localBinaryRenamedPath &&
        entry.blobManifestHash === modifiedLocalBinaryEntry.blobManifestHash
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
  if (!(await waitForVaultPathAbsent(localBinaryRenamedPath, obsidianPollTimeoutMs))) {
    throw new Error(`binary delete did not remove vault file: ${localBinaryRenamedPath}`)
  }
  const deletedLocalBinaryEntry = await waitForMetaEntryByFileId(
    localBinaryEntry.fileId,
    (entry) => entry.deleted === true && entry.path === localBinaryRenamedPath,
    'local binary delete tombstone',
    obsidianPollTimeoutMs,
  )
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      return readNormalizedMetaEntry(doc, localBinaryEntry.fileId)?.deleted === true
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
  obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])
  await waitForRemoteMeta(
    remote,
    remoteMetaDoc,
    (doc) => {
      const entry = readNormalizedMetaEntry(doc, localBinaryEntry.fileId)
      return entry?.deleted === false && entry.path === localBinaryRenamedPath
    },
    'local binary restore repair broadcast',
  )
  const restoredLocalBinary = driveBinaryMaterializeOutbox(
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
  // See the drain above the local binary section: let this repair's outbox
  // item settle before the remote binary meta write below queues another.
  await drainStartupOutbox(workerRoundTripTimeoutMs)

  const binaryFileId = `binary-${runId}`
  const binaryBytes = makeBinaryBytes()
  const builtBinary = await buildBinaryManifest(binaryFileId, binaryBytes, remoteSetup.deviceId)
  for (const chunk of builtBinary.chunks) {
    await uploadBlobChunk(remoteSetup, chunk)
  }
  await uploadBlobManifest(remoteSetup, builtBinary.manifestHash, builtBinary.manifestBytes)

  const binaryMetaBaseVector = Y.encodeStateVector(remoteMetaDoc)
  setMetaEntry(remoteMetaDoc, {
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

  const binaryEntry = await waitForActiveMetaEntry(binaryPath, obsidianPollTimeoutMs)
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

  const materializedBinary = driveBinaryMaterializeOutbox(
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
  await drainStartupOutbox(workerRoundTripTimeoutMs)

  const pendingRecoveryResult = evalInObsidian(`(async () => {
    const plugin = app.plugins.plugins.kuroflare;
    const expectedYDocId = ${JSON.stringify(docId.ydocId)};
    const loaded = plugin?.loadedTextDocs?.get(expectedYDocId);
    const active = plugin?.activeTextDoc;
    const gate = plugin?.startupSideEffectGate;
    if (!plugin || !loaded || !active || active !== loaded || !loaded.doc || !loaded.text) {
      return JSON.stringify({ ok: false, reason: 'exact active/loaded text doc was unavailable' });
    }
    if (loaded.docId?.kind !== 'file' || loaded.docId.ydocId !== expectedYDocId) {
      return JSON.stringify({ ok: false, reason: 'loaded text doc id did not match expected ydocId' });
    }
    if (gate?.permission !== 'allowed' || gate.canSendNetwork() !== true) {
      return JSON.stringify({ ok: false, reason: 'startup side-effect gate was not allowed before injection', permission: gate?.permission ?? null });
    }
    const db = plugin.localStoreDb;
    if (!db) {
      return JSON.stringify({ ok: false, reason: 'local store database was unavailable' });
    }
    const readStoreSnapshot = () => new Promise((resolve, reject) => {
      const transaction = db.transaction(['outbox', 'running-leases'], 'readonly');
      const outboxRequest = transaction.objectStore('outbox').getAll();
      const leaseRequest = transaction.objectStore('running-leases').getAll();
      let outbox = [];
      let leases = [];
      outboxRequest.onsuccess = () => { outbox = outboxRequest.result ?? []; };
      leaseRequest.onsuccess = () => { leases = leaseRequest.result ?? []; };
      transaction.onerror = () => reject(transaction.error ?? new Error('outbox snapshot transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('outbox snapshot transaction aborted'));
      transaction.oncomplete = () => resolve({ outbox, leases });
    });
    const before = await readStoreSnapshot();
    const beforeIds = new Set(before.outbox.map((row) => row?.id));
    let listenerAttached = false;
    let capturedUpdateBytesBase64 = null;
    const testListener = (update) => {
      // Production registers its update listener before this harness listener.
      // Block the startup gate in the same dispatch after production starts persistence.
      loaded.doc.off('update', testListener);
      listenerAttached = false;
      let binary = '';
      for (const byte of update) binary += String.fromCharCode(byte);
      capturedUpdateBytesBase64 = btoa(binary);
      plugin.startupSideEffectGate.setPermission('blocked');
    };
    loaded.doc.on('update', testListener);
    listenerAttached = true;
    try {
      loaded.text.insert(loaded.text.length, ${JSON.stringify(`\n${pendingRecoveryText}`)});
      const deadline = Date.now() + ${obsidianPollTimeoutMs};
      while (Date.now() < deadline) {
        const snapshot = await readStoreSnapshot();
        const pendingRows = snapshot.outbox.filter((row) => {
          if (
            beforeIds.has(row?.id) ||
            row?.kind !== 'y-update' ||
            (row?.status !== 'pending' && row?.status !== 'retrying') ||
            row?.docId?.kind !== 'file' ||
            row.docId.ydocId !== expectedYDocId ||
            typeof row.updateBytesBase64 !== 'string' ||
            row.updateBytesBase64.length === 0 ||
            row.updateBytesBase64 !== capturedUpdateBytesBase64
          ) {
            return false;
          }
          return !snapshot.leases.some(
            (lease) => lease?.itemId === row.id && lease?.leaseExpiresAt > Date.now(),
          );
        });
        if (plugin.startupSideEffectGate.permission === 'blocked' && pendingRows.length > 0) {
          return JSON.stringify({
            ok: true,
            permission: plugin.startupSideEffectGate.permission,
            localMarkerPresent: loaded.text.toJSON().includes(${JSON.stringify(pendingRecoveryText)}),
            pendingRows: pendingRows.map((row) => ({
              id: row.id,
              status: row.status,
              docId: row.docId,
              updateBytesLength: row.updateBytesBase64.length,
            })),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const snapshot = await readStoreSnapshot();
      return JSON.stringify({
        ok: false,
        permission: plugin.startupSideEffectGate.permission,
        localMarkerPresent: loaded.text.toJSON().includes(${JSON.stringify(pendingRecoveryText)}),
        outboxCount: snapshot.outbox.length,
        leaseCount: snapshot.leases.length,
        reason: 'pending recovery outbox row did not become durable without an active lease',
      });
    } finally {
      if (listenerAttached) loaded.doc.off('update', testListener);
    }
  })()`)
  if (
    !isRecord(pendingRecoveryResult) ||
    pendingRecoveryResult.ok !== true ||
    pendingRecoveryResult.permission !== 'blocked' ||
    pendingRecoveryResult.localMarkerPresent !== true
  ) {
    throw new Error(`pending recovery staging failed: ${JSON.stringify(pendingRecoveryResult)}`)
  }
  if (remoteObservedDoc.getText(yTextName).toJSON().includes(pendingRecoveryText)) {
    throw new Error(
      'pending recovery marker was already present on remote before provider deletion',
    )
  }

  Y.applyUpdate(remoteObservedDoc, await fetchLatestFileUpdate(remoteSetup, docId.ydocId))
  const workerLatestText = remoteObservedDoc.getText(yTextName).toJSON()
  if (workerLatestText.includes(pendingRecoveryText)) {
    throw new Error('Worker latest file state unexpectedly contained pending recovery marker')
  }

  const recoveryBeforeRestart = await waitForRecoverySnapshot(obsidianPollTimeoutMs)
  if (
    recoveryBeforeRestart.vaultId !== vaultId ||
    recoveryBeforeRestart.docId !== docId.ydocId ||
    recoveryBeforeRestart.actorClientId === null ||
    recoveryBeforeRestart.epochId === null ||
    recoveryBeforeRestart.epochStatus !== 'ready' ||
    !recoveryBeforeRestart.providerPresent
  ) {
    throw new Error(`recovery precondition was not ready: ${JSON.stringify(recoveryBeforeRestart)}`)
  }

  obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
  await deleteObsidianProviderDatabase(docId.ydocId, obsidianPollTimeoutMs)
  await restartObsidianProcess({
    appCommand: obsidianAppCommand,
    vaultPath,
    timeoutMs: obsidianPollTimeoutMs,
  })
  await waitForObsidianVaultReady(vaultPath, obsidianPollTimeoutMs)
  obsidian(['plugins:restrict', 'off'])
  obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
  waitForObsidianPluginLoaded(obsidianPollTimeoutMs)
  obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

  const recoveryAfterRestart = await waitForRecoverySnapshot(workerRoundTripTimeoutMs)
  if (
    recoveryAfterRestart.vaultId !== vaultId ||
    recoveryAfterRestart.docId !== docId.ydocId ||
    recoveryAfterRestart.actorClientId === null ||
    recoveryAfterRestart.actorClientId === recoveryBeforeRestart.actorClientId ||
    recoveryAfterRestart.epochId === null ||
    recoveryAfterRestart.epochId === recoveryBeforeRestart.epochId ||
    recoveryAfterRestart.epochStatus !== 'ready' ||
    !recoveryAfterRestart.providerPresent ||
    recoveryAfterRestart.connected !== true ||
    recoveryAfterRestart.socketReadyState !== 1 ||
    !recoveryAfterRestart.fileText.includes(remoteSeedText) ||
    !recoveryAfterRestart.fileText.includes(remotePeerText) ||
    !recoveryAfterRestart.fileText.includes(localObsidianText) ||
    !recoveryAfterRestart.fileText.includes(pendingRecoveryText)
  ) {
    throw new Error(
      `provider-loss recovery after process restart failed: ${JSON.stringify({ before: recoveryBeforeRestart, after: recoveryAfterRestart })}`,
    )
  }

  const workerRecoveryDeadline = Date.now() + workerRoundTripTimeoutMs
  let workerRecoveryConfirmed = false
  while (Date.now() < workerRecoveryDeadline) {
    const candidate = new Y.Doc()
    try {
      Y.applyUpdate(candidate, await fetchLatestFileUpdate(remoteSetup, docId.ydocId))
      const candidateText = candidate.getText(yTextName).toJSON()
      if (
        candidateText.includes(remoteSeedText) &&
        candidateText.includes(remotePeerText) &&
        candidateText.includes(localObsidianText) &&
        candidateText.includes(pendingRecoveryText)
      ) {
        workerRecoveryConfirmed = true
        break
      }
    } finally {
      candidate.destroy()
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!workerRecoveryConfirmed) {
    throw new Error('Worker latest file state did not converge after provider-loss recovery')
  }

  const reconnectResultValue = evalInObsidian(`(async () => {
  const plugin = app.plugins.plugins.kuroflare;
  return JSON.stringify({
    setupVaultId: plugin?.kuroflareSettings?.setupVaultId,
    setupToken: plugin?.kuroflareSettings?.setupToken,
    connected: plugin?.workerHelloAccepted,
    socketReadyState: plugin?.workerWebSocketSession?.snapshot()?.readyState,
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

  const recoverySyncRequestMessageId = `remote-recovery-sync-${runId}`
  // NeedFullSnapshot does not carry a request message ID. Use a fresh peer so
  // this request is the only response candidate in its receive queue.
  recoveryRemote = await connectRemoteDevice(remoteSetup)
  recoveryRemote.socket.send(
    JSON.stringify({
      type: 'sync-request',
      protocolVersion: 1,
      vaultId,
      deviceId: remoteSetup.deviceId,
      messageId: recoverySyncRequestMessageId,
      docId,
      stateVector: encodeBase64(Y.encodeStateVector(recoveryPeerDoc)),
    }),
  )
  const recoverySyncResponse = await recoveryRemote.waitFor((message) => {
    const candidateDocId = message.docId
    if (
      !isRecord(candidateDocId) ||
      candidateDocId.kind !== 'file' ||
      candidateDocId.ydocId !== docId.ydocId
    ) {
      return false
    }
    if (message.type === 'sync-update') {
      return message.messageId === recoverySyncRequestMessageId
    }
    return message.type === 'need-full-snapshot'
  }, 'recovery sync response')
  if (recoverySyncResponse.type === 'sync-update') {
    if (
      typeof recoverySyncResponse.update !== 'string' ||
      recoverySyncResponse.update.length === 0
    ) {
      throw new Error(
        `recovery sync-update was missing an update payload: ${JSON.stringify(recoverySyncResponse)}`,
      )
    }
    Y.applyUpdate(recoveryPeerDoc, decodeBase64(recoverySyncResponse.update))
  } else if (recoverySyncResponse.type === 'need-full-snapshot') {
    Y.applyUpdate(recoveryPeerDoc, await fetchLatestFileUpdate(remoteSetup, docId.ydocId))
  } else {
    throw new Error(`unexpected recovery sync response: ${JSON.stringify(recoverySyncResponse)}`)
  }
  const recoveredRemoteText = recoveryPeerDoc.getText(yTextName).toJSON()
  requireIncludes(recoveredRemoteText, remoteSeedText, 'remote recovery sync state')
  requireIncludes(recoveredRemoteText, remotePeerText, 'remote recovery sync state')
  requireIncludes(recoveredRemoteText, localObsidianText, 'remote recovery sync state')
  requireIncludes(recoveredRemoteText, pendingRecoveryText, 'remote recovery sync state')

  const errors = obsidian(['dev:errors'])
  requireIncludes(errors, 'No errors captured.', 'dev errors')

  console.log(`Obsidian Miniflare sync, meta, and binary smoke passed for ${result.setupVaultId}`)
} finally {
  remoteObservedDoc.destroy()
  remoteMetaDoc.destroy()
  recoveryPeerDoc.destroy()
  recoveryRemote?.close()
  remote.close()
}
