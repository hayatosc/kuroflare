import { v } from 'valibot'

import { reconcileMetaDoc } from '../sync/meta/reconcile'
import { planInvalidMetaIsolationDetail } from '../sync/obsidian/invalid-meta-isolation'
import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION } from '../sync/store/schema'
import type KuroflareSpikePlugin from './plugin'

export async function reconcileAndMaterializeMeta(plugin: KuroflareSpikePlugin): Promise<void> {
  const restorableBinaryFileIds = await plugin.findRestorableBinaryFileIdsForReconcile()
  const reconciled = reconcileMetaDoc(plugin.metaMap, {
    updatedAt: Date.now(),
    updatedBy: REPAIR_DEVICE,
    restorableBinaryFileIds,
    origin: REPAIR_ORIGIN,
  })
  await plugin.recordMetaRepairLog(reconciled.repairs, reconciled.invalidFileIds)
  await plugin.materializeMetaRenames()
  plugin.materializeMetaDeletes()
}

export async function removeRepairLogEntry(
  plugin: KuroflareSpikePlugin,
  entryId: string,
): Promise<void> {
  await plugin.updateSettings({
    repairLog: (plugin.kuroflareSettings.repairLog ?? []).filter((entry) => entry.id !== entryId),
  })
}

export async function clearRepairLogEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  await plugin.removeRepairLogEntry(entry.id)
  new Notice(`Kuroflare repair: cleared ${entry.kind}`)
}

export async function retryRemoteMaterializeBlockedRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  await retryRemoteMaterializeBlockedRepairEntryWithPorts(entry, {
    getMetaEntry: (fileId) => plugin.metaMap.get(fileId),
    requestMissingRemoteTextFile: async (current) => {
      await plugin.requestMissingRemoteTextFile(current)
    },
    enqueueMissingRemoteBinaryDownloads: async (reason) => {
      await plugin.enqueueMissingRemoteBinaryDownloads(reason)
    },
    removeRepairLogEntry: async (entryId) => {
      await plugin.removeRepairLogEntry(entryId)
    },
    showNotice: (message) => {
      new Notice(message)
    },
  })
}

export async function resolveRemoteMaterializeBlockedRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  const plan = planRemoteMaterializeBlockedAutoResolve({
    entry,
    current: plugin.metaMap.get(entry.fileId),
    isPathAvailable: (path) => plugin.isRepairConflictPathAvailable(path),
  })
  if (plan.action === 'ignored-kind') {
    new Notice('Kuroflare repair: only remote materialize entries can be resolved here')
    return
  }
  if (plan.action === 'unsupported-reason') {
    new Notice(`Kuroflare repair: ${plan.reason} must be fixed manually`)
    return
  }
  if (plan.action === 'stale') {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale remote materialize entry cleared')
    return
  }
  if (plan.action === 'unsupported-meta-type') {
    new Notice(`Kuroflare repair: unsupported remote materialize type ${plan.type}`)
    return
  }
  if (plan.action === 'no-path-available') {
    new Notice('Kuroflare repair: could not allocate a conflict path')
    return
  }

  const current = plugin.metaMap.get(entry.fileId)
  if (!isMetaFile(current, entry.fileId) || current.deleted) {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale remote materialize entry cleared')
    return
  }
  const updatedAt = Date.now()
  plugin.metaDoc.transact(() => {
    plugin.metaMap.set(entry.fileId, {
      ...current,
      path: plan.toPath,
      canonicalPath: plan.toCanonicalPath,
      updatedAt,
      updatedBy: REPAIR_DEVICE,
    })
  }, REPAIR_ORIGIN)
  await plugin.retryRemoteMaterializeBlockedRepairEntry(entry)
  new Notice(`Kuroflare repair: moved remote file to ${plan.toPath}`)
}

export async function retryPathConflictRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  if (entry.kind !== 'path-conflict') {
    new Notice('Kuroflare repair: only path conflict entries can be retried here')
    return
  }
  const current = plugin.metaMap.get(entry.fileId)
  if (!isMetaFile(current, entry.fileId) || current.deleted) {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale path conflict entry cleared')
    return
  }

  await plugin.materializeMetaRenames()
  await plugin.removeRepairLogEntry(entry.id)
  new Notice(`Kuroflare repair: path materialize retried (${current.path})`)
}

export async function resolvePathConflictRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  const plan = planPathConflictAutoResolve({
    entry,
    current: plugin.metaMap.get(entry.fileId),
    isPathAvailable: (path) => plugin.isRepairConflictPathAvailable(path),
  })
  if (plan.action === 'ignored-kind') {
    new Notice('Kuroflare repair: only path conflict entries can be resolved here')
    return
  }
  if (plan.action === 'stale') {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale path conflict entry cleared')
    return
  }
  if (plan.action === 'no-path-available') {
    new Notice('Kuroflare repair: could not allocate a conflict path')
    return
  }

  const current = plugin.metaMap.get(entry.fileId)
  if (!isMetaFile(current, entry.fileId) || current.deleted) {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale path conflict entry cleared')
    return
  }
  const updatedAt = Date.now()
  plugin.metaDoc.transact(() => {
    plugin.metaMap.set(entry.fileId, {
      ...current,
      path: plan.toPath,
      canonicalPath: plan.toCanonicalPath,
      updatedAt,
      updatedBy: REPAIR_DEVICE,
    })
  }, REPAIR_ORIGIN)
  await plugin.materializeMetaRenames()
  await plugin.removeRepairLogEntry(entry.id)
  new Notice(`Kuroflare repair: moved path conflict to ${plan.toPath}`)
}

export async function retryKeepDeletedRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  if (entry.kind !== 'delete-vs-edit' || entry.reason !== 'missing-binary-content') {
    new Notice('Kuroflare repair: only missing binary delete-vs-edit entries can be retried here')
    return
  }
  const current = plugin.metaMap.get(entry.fileId)
  if (!isMetaFile(current, entry.fileId) || !current.deleted || current.type !== 'binary') {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale keep-deleted entry cleared')
    return
  }

  if (!(await plugin.checkDeletedBinaryRestoreAvailability(current))) {
    new Notice(`Kuroflare repair: binary restore check still degraded (${current.path})`)
    return
  }
  await plugin.reconcileAndMaterializeMeta()
  await plugin.enqueueMissingRemoteBinaryDownloads('repair:keep-deleted-retry')
  await plugin.removeRepairLogEntry(entry.id)
  new Notice(`Kuroflare repair: binary restore check retried (${current.path})`)
}

export async function discardInvalidMetaRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
  confirmation: string,
): Promise<void> {
  if (entry.kind !== 'invalid-meta') {
    new Notice('Kuroflare repair: only invalid meta entries can be discarded here')
    return
  }
  if (confirmation.trim() !== INVALID_META_DISCARD_CONFIRMATION) {
    new Notice(`Kuroflare repair: type ${INVALID_META_DISCARD_CONFIRMATION} to discard`)
    return
  }

  const current = plugin.metaMap.get(entry.fileId)
  if (current === undefined || isMetaFile(current, entry.fileId)) {
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale invalid meta entry cleared')
    return
  }

  plugin.metaDoc.transact(() => {
    plugin.metaMap.delete(entry.fileId)
  }, REPAIR_ORIGIN)
  if (plugin.invalidMetaIsolationDetail?.fileId === entry.fileId) {
    plugin.invalidMetaIsolationDetail = null
  }
  await plugin.removeRepairLogEntry(entry.id)
  new Notice(`Kuroflare repair: invalid meta discarded (${entry.fileId})`)
}

export async function inspectInvalidMetaRepairEntry(
  plugin: KuroflareSpikePlugin,
  entry: KuroflareRepairLogEntry,
): Promise<void> {
  const plan = planInvalidMetaIsolationDetail({
    entry,
    current: plugin.metaMap.get(entry.fileId),
    inspectedAt: Date.now(),
  })
  if (plan.action === 'ignored-kind') {
    new Notice('Kuroflare repair: only invalid meta entries can be inspected here')
    return
  }
  if (plan.action === 'stale') {
    if (plugin.invalidMetaIsolationDetail?.fileId === entry.fileId) {
      plugin.invalidMetaIsolationDetail = null
    }
    await plugin.removeRepairLogEntry(entry.id)
    new Notice('Kuroflare repair: stale invalid meta entry cleared')
    return
  }

  plugin.invalidMetaIsolationDetail = plan.detail
  new Notice(`Kuroflare repair: invalid meta isolated (${entry.fileId})`)
}

export async function findRestorableBinaryFileIdsForReconcile(
  plugin: KuroflareSpikePlugin,
): Promise<ReadonlySet<FileId>> {
  const restorable = new Set<FileId>()
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (!isMetaFile(value, fileId) || !value.deleted || value.type !== 'binary') {
      continue
    }
    if (await plugin.checkDeletedBinaryRestoreAvailability(value)) {
      restorable.add(value.fileId)
    }
  }
  return restorable
}

export async function checkDeletedBinaryRestoreAvailability(
  plugin: KuroflareSpikePlugin,
  value: BinaryMetaFile,
): Promise<boolean> {
  const checkedAt = Date.now()
  const setDegraded = (reason: KuroflareBinaryRestoreCheckDetail['reason']): false => {
    plugin.binaryRestoreCheckDetail = {
      fileId: value.fileId,
      path: value.path,
      checkedAt,
      reason,
    }
    return false
  }

  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    return setDegraded('setup-missing')
  }
  const accessToken = await plugin.readAccessToken(accessTokenSecretKeyForSetup(setup))
  if (accessToken === undefined) {
    return setDegraded('access-token-missing')
  }

  const manifest = await plugin.fetchBlobManifestForMeta(setup, accessToken, value)
  if (manifest === undefined) {
    return setDegraded('manifest-unavailable')
  }

  const url = new URL(setup.endpoint)
  url.pathname = '/blobs/head'
  const head = await plugin.fetchJsonSideEffect({
    method: 'POST',
    url: url.toString(),
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    bodyJson: {
      hashes: manifest.chunks.map((chunk) => chunk.sha256),
    },
  })
  if (head.kind !== 'success' || !v.is(BlobHeadResponseSchema, head.body)) {
    return setDegraded('head-unavailable')
  }
  for (const chunk of manifest.chunks) {
    const entry = head.body.exists[chunk.sha256]
    if (entry?.found !== true) {
      return setDegraded('chunk-missing')
    }
    if (entry.size === undefined) {
      return setDegraded('chunk-size-unknown')
    }
    if (entry.size !== chunk.size) {
      return setDegraded('chunk-size-mismatch')
    }
  }
  if (plugin.binaryRestoreCheckDetail?.fileId === value.fileId) {
    plugin.binaryRestoreCheckDetail = null
  }
  return true
}

export async function materializeMetaRenames(plugin: KuroflareSpikePlugin): Promise<void> {
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (!isMetaFile(value, fileId) || value.deleted) {
      continue
    }
    plugin.activeRemoteDeletedFileIds.delete(value.fileId)
    const known = plugin.materializedPaths.get(value.fileId)
    if (known === value.path) {
      continue
    }
    if (known === undefined) {
      plugin.materializedPaths.set(value.fileId, value.path)
      await plugin.requestMissingRemoteTextFile(value)
      continue
    }
    const file = plugin.app.vault.getAbstractFileByPath(known)
    if (!(file instanceof TFile)) {
      plugin.materializedPaths.set(value.fileId, value.path)
      continue
    }
    const wasActive = plugin.isActiveMetaEntry(value, known)
    const canonicalTarget = canonicalizeVaultPath(value.path)
    plugin.pendingFsRenames.add(canonicalTarget)
    try {
      await plugin.app.fileManager.renameFile(file, value.path)
      plugin.materializedPaths.set(value.fileId, value.path)
      if (wasActive) {
        plugin.targetPath = value.path
        const renamed = plugin.app.vault.getAbstractFileByPath(value.path)
        plugin.activeFile = renamed instanceof TFile ? renamed : file
        plugin.setStatus(`bound: ${plugin.activeFile.basename}`)
        console.info('[kuroflare] active file followed remote rename', {
          from: known,
          to: value.path,
          fileId: value.fileId,
        })
      }
    } catch (error: unknown) {
      plugin.pendingFsRenames.delete(canonicalTarget)
      console.error('[kuroflare] failed to materialize meta rename', {
        from: known,
        to: value.path,
        error: safeLogError(error),
      })
      await plugin.recordRenameMaterializeBlocked(
        value.fileId,
        value.path,
        'rename-materialize-failed',
      )
    }
  }
}

export function materializeMetaDeletes(plugin: KuroflareSpikePlugin): void {
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (!isMetaFile(value, fileId) || !value.deleted) {
      continue
    }
    const known = plugin.materializedPaths.get(value.fileId)
    if (!plugin.isActiveMetaEntry(value, known)) {
      continue
    }
    plugin.materializedPaths.set(value.fileId, value.path)
    plugin.showActiveRemoteDeleteNotice(value)
  }
}

export function isActiveMetaEntry(
  plugin: KuroflareSpikePlugin,
  value: MetaFile,
  knownPath: string | undefined,
): boolean {
  const activePath = plugin.activeFile?.path
  if (activePath !== undefined && (knownPath === activePath || value.path === activePath)) {
    return true
  }
  const activeYDocId = plugin.activeTextDoc?.docId.ydocId
  return value.type === 'text' && activeYDocId !== undefined && value.ydocId === activeYDocId
}

export function showActiveRemoteDeleteNotice(plugin: KuroflareSpikePlugin, value: MetaFile): void {
  if (plugin.activeRemoteDeletedFileIds.has(value.fileId)) {
    return
  }
  plugin.activeRemoteDeletedFileIds.add(value.fileId)
  plugin.syncStatusEl?.setText(`Kuroflare sync: remote tombstone ${value.path}`)
  new Notice('Kuroflare sync: active file was deleted remotely; local editor kept open')
  console.warn('[kuroflare] active file kept open after remote tombstone', {
    path: value.path,
    fileId: value.fileId,
    deletedAt: 'deletedAt' in value ? value.deletedAt : undefined,
    deletedBy: 'deletedBy' in value ? value.deletedBy : undefined,
  })
}

export function getSettingsSnapshot(plugin: KuroflareSpikePlugin): KuroflareSettings {
  return plugin.kuroflareSettings
}

export function getSyncRepairEntriesSnapshot(
  plugin: KuroflareSpikePlugin,
): readonly SyncRuntimeObsidianRepairPresentation[] {
  return plugin.syncRepairEntries
}

export function getInvalidMetaIsolationSnapshot(
  plugin: KuroflareSpikePlugin,
): KuroflareInvalidMetaIsolationDetail | null {
  return plugin.invalidMetaIsolationDetail
}

export function getBinaryRestoreCheckSnapshot(
  plugin: KuroflareSpikePlugin,
): KuroflareBinaryRestoreCheckDetail | null {
  return plugin.binaryRestoreCheckDetail
}

export async function exportLocalOutboxRepair(plugin: KuroflareSpikePlugin): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare repair: setup metadata is missing')
    return
  }
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const outboxRecords = snapshot.outboxRecords.filter((record) => record.status !== 'done')
  const exportedAt = Date.now()
  const exportPlan = buildLocalStoreRepairExport({
    exportedAt,
    vaultId: setup.vaultId,
    deviceId: setup.deviceId,
    metadata: {
      localStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      targetStoreVersion: LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
      degradedReason: 'manual-export',
    },
    outboxRecords,
  })
  if (!exportPlan.ok) {
    new Notice(`Kuroflare repair export failed: ${exportPlan.reason}`)
    console.warn('[kuroflare] local outbox repair export rejected', exportPlan)
    return
  }
  const path = localStoreRepairExportPath(`kuroflare-local-outbox-${exportedAt}.json`)
  await plugin.ensureAdapterParentFolders(path)
  await writeLocalStoreRepairExportFile({
    adapter: plugin.app.vault.adapter,
    path,
    exportFile: exportPlan.exportFile,
  })
  await plugin.updateSettings({
    localRepairExport: {
      path,
      exportedAt,
      pendingOutboxCount: outboxRecords.length,
    },
  })
  new Notice(`Kuroflare repair export written: ${path}`)
  console.info('[kuroflare] local outbox repair export written', {
    path,
    entries: exportPlan.exportedEntryIds.length,
  })
}

export async function rebuildLocalStoreAfterConfirmation(
  plugin: KuroflareSpikePlugin,
  confirmation: string,
): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare repair: setup metadata is missing')
    return
  }

  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const pendingOutboxCount = snapshot.outboxRecords.filter(
    (record) => record.status !== 'done',
  ).length
  const exportMetadata = plugin.kuroflareSettings.localRepairExport
  const exportMatchesPendingOutbox =
    exportMetadata !== undefined && exportMetadata.pendingOutboxCount === pendingOutboxCount
  const rebuildAfterExportConfirmed =
    confirmation === LOCAL_STORE_REBUILD_CONFIRMATION && exportMatchesPendingOutbox
  const discardConfirmed = confirmation === LOCAL_STORE_DISCARD_CONFIRMATION
  if (pendingOutboxCount > 0 && !rebuildAfterExportConfirmed && !discardConfirmed) {
    new Notice(
      `Kuroflare repair: export pending outbox first, then type ${LOCAL_STORE_REBUILD_CONFIRMATION}; or type ${LOCAL_STORE_DISCARD_CONFIRMATION}`,
    )
    return
  }

  await plugin.rebuildLocalStoreDatabase(setup.vaultId)
  await plugin.updateSettings({ localRepairExport: undefined })
  new Notice(`Kuroflare local store rebuilt (${pendingOutboxCount} pending entries discarded)`)
  void plugin.runSyncStartupTick('local-store-rebuild')
}

export async function stageLocalOutboxRepairImport(
  plugin: KuroflareSpikePlugin,
  path: string,
): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare repair: setup metadata is missing')
    return
  }
  if (path.length === 0) {
    new Notice('Kuroflare repair: export path is required')
    return
  }

  const exportRead = await readLocalStoreRepairExportFile({
    adapter: plugin.app.vault.adapter,
    path,
  })
  if (!exportRead.ok && exportRead.reason === 'unreadable-json') {
    new Notice('Kuroflare repair import failed: invalid or unreadable JSON')
    console.warn('[kuroflare] repair import JSON read failed', {
      path,
      error: safeLogError(exportRead.error),
    })
    return
  }
  if (!exportRead.ok) {
    new Notice('Kuroflare repair import failed: invalid export file')
    console.warn('[kuroflare] repair import rejected invalid export file', { path })
    return
  }
  const exportFile = exportRead.exportFile

  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const evidenceItems: LocalOutboxRepairEvidenceQueryItem[] = []
  for (const entry of exportFile.entries) {
    if (entry.kind !== 'y-update' || entry.docId === undefined || entry.messageId === undefined) {
      continue
    }
    evidenceItems.push(
      entry.updateSha256 === undefined
        ? { docId: entry.docId, messageId: entry.messageId }
        : { docId: entry.docId, messageId: entry.messageId, updateSha256: entry.updateSha256 },
    )
  }
  const evidence = await plugin.fetchLocalOutboxRepairEvidence(setup, evidenceItems)
  if (evidence === null) {
    return
  }
  const plan = planLocalStoreRepairImport({
    exportFile,
    vaultId: setup.vaultId,
    deviceId: setup.deviceId,
    existingOutboxIds: snapshot.outboxRecords.map((record) => record.id),
    durableMessages: evidence.durableMessages,
    quarantinedMessages: evidence.quarantinedMessages,
  })
  if (!plan.ok) {
    new Notice(`Kuroflare repair import rejected: ${plan.reason}`)
    console.warn('[kuroflare] repair import plan rejected', { path, plan })
    return
  }
  if (plan.effects.length === 0) {
    new Notice('Kuroflare repair import: no safe y-update entries to stage')
    return
  }

  const commit = await commitLocalStoreIndexedDbDatabaseTransaction({
    database: createLocalStoreIndexedDbDatabasePort(db),
    operations: planLocalStoreRepairImportStageTransaction(plan),
  })
  if (!commit.ok) {
    new Notice(`Kuroflare repair import staging rejected: ${commit.reason}`)
    console.warn('[kuroflare] repair import staging rejected', { path, commit })
    return
  }

  new Notice(`Kuroflare repair import staged: ${plan.effects.length}`)
}

export async function resumeStagedRepairImports(plugin: KuroflareSpikePlugin): Promise<void> {
  const setup = plugin.currentSetupMetadata()
  if (setup === undefined) {
    new Notice('Kuroflare repair: setup metadata is missing')
    return
  }
  const db = await plugin.openLocalStoreDatabase(setup.vaultId)
  const snapshot = await plugin.readOutboxWorkerSnapshot(db)
  const candidates = snapshot.outboxRecords.filter(isStagedRepairImportRecord)
  if (candidates.length === 0) {
    new Notice('Kuroflare repair: no staged repair imports')
    return
  }
  const evidence = await plugin.fetchLocalOutboxRepairEvidence(
    setup,
    candidates.map((record) => ({
      docId: record.docId,
      messageId: record.messageId,
      updateSha256: record.updateSha256,
    })),
  )
  if (evidence === null) {
    return
  }

  const operations = []
  for (const record of candidates) {
    const plan = planLocalStoreRepairImportResume({
      record,
      userConfirmed: true,
      durableMessages: evidence.durableMessages,
      quarantinedMessages: evidence.quarantinedMessages,
    })
    if (!plan.ok || plan.action !== 'resume') {
      console.warn('[kuroflare] repair import resume skipped', {
        itemId: record.id,
        action: plan.action,
      })
      continue
    }
    operations.push(...planLocalStoreRepairImportResumeTransaction(plan))
  }
  if (operations.length === 0) {
    new Notice('Kuroflare repair imports resumed: 0')
    return
  }

  const commit = await commitLocalStoreIndexedDbDatabaseTransaction({
    database: createLocalStoreIndexedDbDatabasePort(db),
    operations,
  })
  if (!commit.ok) {
    new Notice(`Kuroflare repair import resume rejected: ${commit.reason}`)
    console.warn('[kuroflare] repair import resume commit rejected', { commit })
    return
  }

  new Notice(`Kuroflare repair imports resumed: ${operations.length}`)
  if (operations.length > 0) {
    void plugin.runOutboxWorkerTick('repair-import-resume')
  }
}

export function repairLogEntryFromMetaRepair(
  plugin: KuroflareSpikePlugin,
  repair: MetaRepair,
  createdAt: number,
): KuroflareRepairLogEntry {
  if ('action' in repair) {
    return {
      id: `delete-vs-edit:${repair.fileId}:${repair.action}`,
      kind: 'delete-vs-edit',
      fileId: repair.fileId,
      reason:
        repair.action === 'keep-deleted'
          ? 'missing-binary-content'
          : 'concurrent-edit-after-delete',
      createdAt,
    }
  }
  return {
    id: `path-conflict:${repair.fileId}`,
    kind: 'path-conflict',
    fileId: repair.fileId,
    path: repair.toPath,
    reason: 'path-conflict-renamed',
    createdAt,
  }
}
