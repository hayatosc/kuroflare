import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  downloadWorkerBinaryByManifest,
} from './http.ts'
import {
  obsidian,
  requireObsidianVaultPath,
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
  clearTextIndexedDb,
  cleanupStaleVaultArtifacts,
  copyPlugin,
  requireIncludes,
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
import {
  activeDocIdForPath,
  makeYTextUpdate,
  makeMetaSnapshotUpdate,
  encodeBase64,
  decodeBase64,
  sha256Hex,
  metaPaths,
  renameMetaEntry,
} from './yjs.ts'

const vaultPath = requireObsidianVaultPath(obsidian(['vault', 'info=path']))

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

writeFileSync(join(vaultPath, notePath), `Obsidian Miniflare local placeholder ${runId}`)

obsidian(['dev:debug', 'on'])
obsidian(['dev:errors', 'clear'])
obsidian(['dev:console', 'clear'])
obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
// Prune prior runs' leftover artifacts while the plugin is inactive, so no
// live vault watcher reacts to files disappearing out from under it.
cleanupStaleVaultArtifacts(vaultPath)
obsidian(['open', `path=${notePath}`])
clearTextIndexedDb()
obsidian(['plugins:restrict', 'off'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
waitForObsidianPluginLoaded()
obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

const resultValue = evalInObsidian(`(async () => {
  const deadline = Date.now() + 5000;
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
Y.applyUpdate(remoteMetaDoc, await fetchLatestMetaUpdate(remoteSetup))
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

  createOrOverwriteObsidianText(metaLocalPath, 'local meta rename source')
  createOrOverwriteObsidianText(metaPeerPath, 'peer meta rename source')
  const localMetaEntry = await waitForActiveMetaEntry(metaLocalPath)
  const peerMetaEntry = await waitForActiveMetaEntry(metaPeerPath)
  if (localMetaEntry === null || peerMetaEntry === null) {
    throw new Error(
      `Obsidian did not register meta entries: ${JSON.stringify({ localMetaEntry, peerMetaEntry })}`,
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

  createOrOverwriteObsidianText(pathConflictRepairSourcePath, 'path conflict repair source')
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

  createOrOverwriteObsidianText(renameRepairSourcePath, 'rename materialize repair source')
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
  if (!(await waitForVaultPathAbsent(localBinaryRenamedPath))) {
    throw new Error(`binary delete did not remove vault file: ${localBinaryRenamedPath}`)
  }
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
  obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])
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
} finally {
  remoteObservedDoc.destroy()
  remoteMetaDoc.destroy()
  remote.close()
}

obsidian(['plugin:disable', `id=${pluginId}`, 'filter=community'])
obsidian(['plugin:enable', `id=${pluginId}`, 'filter=community'])
waitForObsidianPluginLoaded()
obsidian(['command', 'id=kuroflare:kuroflare-sync-run-startup-tick'])

const reconnectResultValue = evalInObsidian(`(async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const plugin = app.plugins.plugins.kuroflare;
    const state = {
      setupVaultId: plugin?.kuroflareSettings?.setupVaultId,
      setupToken: plugin?.kuroflareSettings?.setupToken,
      connected: plugin?.workerHelloAccepted,
      socketReadyState: plugin?.workerWebSocketSession?.snapshot()?.readyState,
    };
    if (state.setupVaultId === ${JSON.stringify(vaultId)} && state.setupToken === '' && state.connected === true && state.socketReadyState === WebSocket.OPEN) {
      return JSON.stringify(state);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

const errors = obsidian(['dev:errors'])
requireIncludes(errors, 'No errors captured.', 'dev errors')

console.log(`Obsidian Miniflare sync, meta, and binary smoke passed for ${result.setupVaultId}`)
