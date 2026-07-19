import type { DocId, FileId, SetupExchangeResponse } from '@kuroflare/core'
import type { App } from 'obsidian'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import {
  documentEpochMetadataKey,
  probeIndexedDbProvider,
  createYDocFromSnapshot,
} from '../recovery/epoch'
import type { DocumentEpochRecord } from '../recovery/epoch'
import { commitDocumentRecoveryTransaction } from '../recovery/epoch-repair'
import {
  recoverDocumentEpochsAtStartup,
  type DocumentEpochRecoveryHost,
} from '../recovery/epoch-startup'
import { createVerifiedSyncRuntimeSetupPersistStepPort } from '../sync/engine/actuation'
import { createLocalSetupPersistIndexedDbMetadataPort } from '../sync/engine/persist'
import type { LocalSetupMetadata } from '../sync/engine/setup'
import { planSyncRuntimeObsidianLegacySettingsSecretCleanup } from '../sync/obsidian/settings'
import {
  createLocalStoreIndexedDbMetadataDatabasePort,
  createBrowserLocalStoreIndexedDbFactoryPort,
  readLocalStoreIndexedDbMetadataSnapshot,
  readLocalStoreIndexedDbSchemaEvidence,
} from '../sync/store/indexeddb'
import {
  LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
  localStoreIndexedDbName,
} from '../sync/store/schema'
import type {
  FileDocId,
  GenerationMarkerOwner,
  KuroflareSettings,
  LoadedTextDoc,
  TextDocumentOwner,
} from '../types'
import { currentSetupMetadata, currentSetupVaultIdHint } from './auth'
import { createRemoteSetupAccessTokenVerifier } from './auth'
import { createWorkerClient } from '../sync/api-client'
import type { StartupSideEffectGate } from './boot'
import { DEFAULT_SETTINGS, META_SYNC_DOC_ID, SPIKE_TEXT_NAME, WORKER_ORIGIN } from './constants'
import {
  isKuroflareLocalRepairExportMetadata,
  isKuroflareRepairLogEntry,
  isStoredYDocRecord,
  isPartialSettings,
} from './guards'
import { clearPathMarkers, metaPersistenceDatabaseName, setOwnedPathMarker } from './guards'
import {
  createObsidianSecretStoragePort,
  localSetupMetadataFromSetupResponse,
  safeLogError,
  waitForIndexedDbDeleteDatabase,
  waitForIndexedDbRequest,
  waitForIndexedDbTransaction,
} from './helpers'
import { createFreshMetaDocForVaultSwitch, metaDocWritable, metaMap, readMetaFile } from './meta'

/** The intentionally narrow host surface used by vault settings and persistence coordination. */
export interface VaultLifecycleHost {
  readonly app: App
  readonly loadData: () => Promise<unknown>
  readonly saveData: (data: unknown) => Promise<void>
  kuroflareSettings: KuroflareSettings
  settingsWritePromise: Promise<void> | null
  metadataSetupStagingCount: number
  metadataVaultGeneration: number
  pendingSetupResponse: SetupExchangeResponse | null
  trustedSetupMetadata: LocalSetupMetadata | null
  readonly startupSideEffectGate: StartupSideEffectGate
  readonly outboxWorkerCompletionPromise: Promise<void> | null
  readonly authRefreshCompletionPromise: Promise<void> | null
  readonly remoteTextMaterializationOperations: Set<Promise<void>>
  metadataMigrationPending: boolean
  readonly metadataMigrationPromise: Promise<void> | null
  readonly documentReplacementInProgress: Set<string>
  readonly loadedTextDocs: Map<string, LoadedTextDoc>
  readonly loadingTextDocs: Map<string, Promise<LoadedTextDoc>>
  readonly documentRecoveryRequired: Set<string>
  readonly documentRecoveryHydrating: Set<string>
  readonly needFullSnapshotRecoveryInProgress: Set<string>
  readonly needFullSnapshotRecoveryOwners: Map<string, object>
  readonly pendingTextDeletionEvidenceRequests: Map<string, number>
  readonly pendingTextDeletionEvidenceRetryTimers: Map<string, number>
  activeTextDoc: LoadedTextDoc | null
  ydoc: Y.Doc
  ytext: Y.Text
  bindGeneration: number
  metaDoc: Y.Doc
  metaPersistence: IndexeddbPersistence | null
  metaPersistenceName: string | null
  localStoreDb: IDBDatabase | null
  localStoreDbName: string | null
  readonly materializedPaths: Map<FileId, string>
  readonly materializedPathOwners: Map<FileId, GenerationMarkerOwner>
  readonly pendingRemoteTextFiles: Map<string, string>
  readonly pendingRemoteTextFileOwners: Map<string, GenerationMarkerOwner>
  readonly attachMetaDocObservers: () => void
  readonly openLocalStoreDatabase: (
    vaultId: string,
    isCurrent: () => boolean,
  ) => Promise<IDBDatabase>
  readonly loadTextDocument: (docId: FileDocId) => Promise<LoadedTextDoc>
  readonly prepareDocumentProvider: (
    docId: DocId,
    providerDbName: string,
  ) => Promise<DocumentEpochRecord | undefined>
  readonly establishInitialDocumentEpoch: (docId: DocId, providerDbName: string) => Promise<void>
  readonly readAccessToken: (setup: LocalSetupMetadata) => Promise<string | undefined>
}

export async function updateVaultSettings(
  host: VaultLifecycleHost,
  patch: Partial<KuroflareSettings>,
): Promise<void> {
  await enqueueSettingsWrite(host, async () => {
    const next = { ...host.kuroflareSettings, ...patch }
    host.kuroflareSettings = next
    await host.saveData(next)
  })
}

export async function loadVaultSettings(host: VaultLifecycleHost): Promise<void> {
  const loaded = await host.loadData()
  const loadedSettings = isPartialSettings(loaded) ? loaded : {}
  const secretCleanup = planSyncRuntimeObsidianLegacySettingsSecretCleanup(loadedSettings)
  host.kuroflareSettings = { ...DEFAULT_SETTINGS, ...secretCleanup.settings }
  host.kuroflareSettings = {
    ...host.kuroflareSettings,
    repairLog: Array.isArray(host.kuroflareSettings.repairLog)
      ? host.kuroflareSettings.repairLog.filter(isKuroflareRepairLogEntry)
      : undefined,
    localRepairExport: isKuroflareLocalRepairExportMetadata(
      host.kuroflareSettings.localRepairExport,
    )
      ? host.kuroflareSettings.localRepairExport
      : undefined,
  }
  if (secretCleanup.removedLegacySecretKeys.length > 0) {
    console.warn('[kuroflare] removed legacy plaintext token fields from settings', {
      keys: secretCleanup.removedLegacySecretKeys,
    })
    await enqueueSettingsWrite(host, () => host.saveData(host.kuroflareSettings))
  }
}

export async function enqueueSettingsWrite<Result>(
  host: VaultLifecycleHost,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previousWrite = host.settingsWritePromise
  const result = (async () => {
    if (previousWrite !== null) await previousWrite
    return operation()
  })()
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  host.settingsWritePromise = tail
  try {
    return await result
  } finally {
    if (host.settingsWritePromise === tail) host.settingsWritePromise = null
  }
}

export async function stagePendingSetupResponse(
  host: VaultLifecycleHost,
  response: SetupExchangeResponse,
): Promise<void> {
  host.startupSideEffectGate.setPermission('blocked')
  host.metadataSetupStagingCount += 1
  host.metadataVaultGeneration += 1
  const stagingGeneration = host.metadataVaultGeneration
  const settingsReset = enqueueSettingsWrite(host, async () => {
    if (host.metadataVaultGeneration !== stagingGeneration) return
    if ((host.kuroflareSettings.repairLog?.length ?? 0) === 0) return
    const next = { ...host.kuroflareSettings, repairLog: [] }
    host.kuroflareSettings = next
    await host.saveData(next)
  })
  const textDocumentCleanup = clearLoadedTextDocsForVaultTransition(host)
  try {
    await textDocumentCleanup
    await settingsReset
    const outboxCompletion = host.outboxWorkerCompletionPromise
    if (outboxCompletion !== null) await outboxCompletion
    const authRefreshCompletion = host.authRefreshCompletionPromise
    if (authRefreshCompletion !== null) await authRefreshCompletion
    await Promise.allSettled([...host.remoteTextMaterializationOperations])
    if (host.metadataVaultGeneration !== stagingGeneration) return
    host.pendingSetupResponse = response
  } finally {
    host.metadataSetupStagingCount -= 1
  }
}

export function metadataReconcileTransitionPending(host: VaultLifecycleHost): boolean {
  return (
    host.pendingSetupResponse !== null ||
    host.metadataSetupStagingCount > 0 ||
    host.startupSideEffectGate.replayingPersistence ||
    host.metadataMigrationPending ||
    host.metadataMigrationPromise !== null ||
    host.documentReplacementInProgress.has(documentEpochMetadataKey(META_SYNC_DOC_ID))
  )
}

export function captureVaultOperationContext(
  host: VaultLifecycleHost,
): TextDocumentOwner | undefined {
  if (host.pendingSetupResponse !== null || host.metadataSetupStagingCount > 0) return undefined
  const setup = currentSetupMetadata(host)
  if (setup === undefined) return undefined
  return { vaultId: setup.vaultId, generation: host.metadataVaultGeneration }
}

export function vaultOperationStillCurrent(
  host: VaultLifecycleHost,
  owner: TextDocumentOwner,
): boolean {
  return (
    host.pendingSetupResponse === null &&
    host.metadataSetupStagingCount === 0 &&
    host.metadataVaultGeneration === owner.generation &&
    currentSetupMetadata(host)?.vaultId === owner.vaultId
  )
}

export function loadedTextDocStillCurrent(
  host: VaultLifecycleHost,
  loaded: LoadedTextDoc,
  owner: TextDocumentOwner,
): boolean {
  return (
    loaded.vaultId === owner.vaultId &&
    loaded.vaultGeneration === owner.generation &&
    vaultOperationStillCurrent(host, owner) &&
    host.loadedTextDocs.get(loaded.docId.ydocId) === loaded
  )
}

export async function clearLoadedTextDocsForVaultTransition(
  host: VaultLifecycleHost,
): Promise<void> {
  host.bindGeneration += 1
  const loadedDocs = [...host.loadedTextDocs.values()]
  const previousActiveDoc = host.ydoc
  host.loadedTextDocs.clear()
  host.loadingTextDocs.clear()
  host.documentRecoveryRequired.clear()
  host.documentRecoveryHydrating.clear()
  host.needFullSnapshotRecoveryInProgress.clear()
  host.needFullSnapshotRecoveryOwners.clear()
  host.pendingTextDeletionEvidenceRequests.clear()
  for (const timer of host.pendingTextDeletionEvidenceRetryTimers.values()) {
    window.clearTimeout(timer)
  }
  host.pendingTextDeletionEvidenceRetryTimers.clear()
  host.activeTextDoc = null
  const replacement = new Y.Doc()
  host.ydoc = replacement
  host.ytext = replacement.getText(SPIKE_TEXT_NAME)
  if (!loadedDocs.some((loaded) => loaded.doc === previousActiveDoc)) {
    previousActiveDoc.destroy()
  }
  await Promise.all(
    loadedDocs.map(async (loaded) => {
      try {
        await loaded.persistence?.destroy()
      } catch (error: unknown) {
        console.warn('[kuroflare] failed to close stale text persistence', {
          docId: loaded.docId,
          error: safeLogError(error),
        })
      } finally {
        loaded.doc.destroy()
      }
    }),
  )
}

export async function openMetaPersistence(host: VaultLifecycleHost): Promise<void> {
  const vaultId = currentSetupVaultIdHint(host)
  const name = vaultId === undefined ? undefined : metaPersistenceDatabaseName(vaultId)
  if (name === undefined || host.metaPersistenceName === name) return
  await host.metaPersistence?.destroy()
  host.metaPersistence = null
  if (host.metaPersistenceName !== null) {
    host.metaPersistenceName = null
    host.metadataVaultGeneration += 1
    await clearLoadedTextDocsForVaultTransition(host)
    host.metaDoc = createFreshMetaDocForVaultSwitch(host.metaDoc)
    host.attachMetaDocObservers()
    clearPathMarkers(host.materializedPaths, host.materializedPathOwners)
    clearPathMarkers(host.pendingRemoteTextFiles, host.pendingRemoteTextFileOwners)
  }
  host.startupSideEffectGate.beginPersistenceReplay()
  try {
    const epoch = await host.prepareDocumentProvider(META_SYNC_DOC_ID, name)
    host.metaPersistence = new IndexeddbPersistence(name, host.metaDoc)
    host.metaPersistenceName = name
    await host.metaPersistence.whenSynced
    if (epoch === undefined) {
      await host.establishInitialDocumentEpoch(META_SYNC_DOC_ID, name)
    }
    for (const [fileId] of metaMap(host).entries()) {
      const value = readMetaFile(metaMap(host), fileId)
      if (value !== undefined && !value.deleted) {
        setOwnedPathMarker(
          host.materializedPaths,
          host.materializedPathOwners,
          value.fileId,
          value.path,
          host.metadataVaultGeneration,
        )
      }
    }
  } finally {
    host.startupSideEffectGate.endPersistenceReplay()
  }
}

export async function replaceMetaDoc(
  host: VaultLifecycleHost,
  updateBytes: Uint8Array,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return
  const oldDoc = host.metaDoc
  const persistenceName = host.metaPersistenceName
  const epochKey = documentEpochMetadataKey(META_SYNC_DOC_ID)
  const ownsReplacementMarker = !host.documentReplacementInProgress.has(epochKey)
  host.documentReplacementInProgress.add(epochKey)
  try {
    if (host.metaPersistence !== null) {
      const persistence = host.metaPersistence
      await persistence.clearData()
      if (!isCurrent()) return
      if (host.metaPersistence !== persistence) return
      host.metaPersistence = null
      host.metaPersistenceName = null
      if (persistenceName !== null) {
        await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(persistenceName))
        if (!isCurrent()) return
      }
    }
    oldDoc.destroy()
    host.metadataVaultGeneration += 1
    host.metaDoc = createYDocFromSnapshot(updateBytes, WORKER_ORIGIN)
    host.attachMetaDocObservers()
    await openMetaPersistence(host)
    clearPathMarkers(host.materializedPaths, host.materializedPathOwners)
  } finally {
    if (ownsReplacementMarker) host.documentReplacementInProgress.delete(epochKey)
  }
}

export async function persistPendingSetupResponse(host: VaultLifecycleHost): Promise<void> {
  const response = host.pendingSetupResponse
  if (response === null) {
    if (host.trustedSetupMetadata !== null) return
    throw new Error('setup-response-missing')
  }
  const db = await host.openLocalStoreDatabase(response.vaultId, () => true)
  const port = createVerifiedSyncRuntimeSetupPersistStepPort({
    response,
    now: Date.now(),
    verifier: createRemoteSetupAccessTokenVerifier({
      client: createWorkerClient(response.endpoint),
    }),
    secretKeyPrefix: 'kuroflare',
    secretStorage: createObsidianSecretStoragePort(host.app.secretStorage),
    metadata: createLocalSetupPersistIndexedDbMetadataPort(
      createLocalStoreIndexedDbMetadataDatabasePort(db),
    ),
  })
  await port.persistSetupResponse({
    kind: 'run-startup-step',
    vaultId: response.vaultId,
    step: 'persist-setup-response',
    phase: 'setup',
  })
  host.trustedSetupMetadata = localSetupMetadataFromSetupResponse(response)
  await updateVaultSettings(host, {
    endpoint: response.endpoint,
    setupVaultId: response.vaultId,
    setupToken: '',
    setupBootstrapMode: undefined,
  })
  await openMetaPersistence(host)
  host.pendingSetupResponse = null
}

export async function readLocalEvidence(host: VaultLifecycleHost) {
  const vaultId = currentSetupVaultIdHint(host)
  if (vaultId === undefined) {
    return {
      metadataSnapshot: undefined,
      localStoreEvidence: undefined,
      hasMetaYDoc: metaMap(host).size > 0,
      hasLocalVaultFiles: host.app.vault.getMarkdownFiles().length > 0,
      setupResponse: host.pendingSetupResponse ?? undefined,
    }
  }
  const localStoreEvidence = await readLocalStoreIndexedDbSchemaEvidence({
    dbName: localStoreIndexedDbName(vaultId),
    indexedDb: createBrowserLocalStoreIndexedDbFactoryPort(indexedDB),
  })
  const metadataSnapshot =
    localStoreEvidence.ok &&
    localStoreEvidence.evidence.dbExists &&
    localStoreEvidence.evidence.presentStores.includes('metadata')
      ? await readLocalSetupMetadataSnapshot(
          host,
          vaultId,
          localStoreEvidence.evidence.currentVersion,
        )
      : undefined
  if (metadataSnapshot?.ok === true) {
    host.trustedSetupMetadata = metadataSnapshot.snapshot.setup
  }
  const evidence = localStoreEvidence.ok ? localStoreEvidence.evidence : undefined
  const canOpenMetaPersistence =
    evidence !== undefined &&
    evidence.dbExists &&
    evidence.currentVersion !== undefined &&
    evidence.currentVersion >= LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION &&
    evidence.currentVersion <= LOCAL_STORE_INDEXEDDB_TARGET_VERSION &&
    evidence.presentStores.includes('metadata') &&
    evidence.presentStores.includes('outbox') &&
    evidence.presentStores.includes('running-leases')
  if (canOpenMetaPersistence) {
    if (host.localStoreDb === null && evidence.currentVersion !== undefined) {
      const existing = await openExistingLocalStoreDatabase(host, vaultId, evidence.currentVersion)
      host.localStoreDb = existing
      host.localStoreDbName = localStoreIndexedDbName(vaultId)
    }
    try {
      await openMetaPersistence(host)
    } catch (error: unknown) {
      if (!String(error).includes('document-provider-recovery-required')) throw error
      console.warn('[kuroflare] metadata provider recovery deferred until local-store startup step')
    }
  }
  return {
    metadataSnapshot,
    localStoreEvidence,
    hasMetaYDoc: metaMap(host).size > 0,
    hasLocalVaultFiles: host.app.vault.getMarkdownFiles().length > 0,
    setupResponse: host.pendingSetupResponse ?? undefined,
  }
}

async function readLocalSetupMetadataSnapshot(
  host: VaultLifecycleHost,
  vaultId: LocalSetupMetadata['vaultId'],
  version: number | undefined,
) {
  if (version === undefined) return undefined
  let db: IDBDatabase | undefined
  try {
    db = await openExistingLocalStoreDatabase(host, vaultId, version)
    return await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
  } catch (error: unknown) {
    console.warn('[kuroflare] failed to read local setup metadata', {
      error: safeLogError(error),
    })
    return undefined
  } finally {
    db?.close()
  }
}

export async function openExistingLocalStoreDatabase(
  _host: VaultLifecycleHost,
  vaultId: LocalSetupMetadata['vaultId'],
  version: number,
): Promise<IDBDatabase> {
  const dbName = localStoreIndexedDbName(vaultId)
  const request = indexedDB.open(dbName, version)
  return await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      request.transaction?.abort()
      reject(new Error('local-store-schema-changed-during-evidence-read'))
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export function createDocumentEpochRecoveryHost(
  host: VaultLifecycleHost,
  isCurrent: () => boolean = () => true,
): DocumentEpochRecoveryHost {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('document-recovery-vault-context-stale')
  }
  return {
    currentSetup: () => (isCurrent() ? currentSetupMetadata(host) : undefined),
    recoveryGate: {
      beginRecovery: () => {
        assertCurrent()
        host.startupSideEffectGate.beginRecovery()
      },
      clearRecoveryBlock: () => {
        if (isCurrent()) host.startupSideEffectGate.clearRecoveryBlock()
      },
      endRecovery: () => host.startupSideEffectGate.endRecovery(),
      failRecovery: (reason) => {
        if (isCurrent()) host.startupSideEffectGate.failRecovery(reason)
        else {
          host.startupSideEffectGate.endRecovery()
          host.startupSideEffectGate.setPermission('blocked')
        }
      },
    },
    recoveryRequired: {
      add: (key) => {
        assertCurrent()
        host.documentRecoveryRequired.add(key)
        return host.documentRecoveryRequired
      },
      clear: () => {
        if (isCurrent()) host.documentRecoveryRequired.clear()
      },
    },
    recoveryHydrating: {
      add: (key) => {
        assertCurrent()
        host.documentRecoveryHydrating.add(key)
        return host.documentRecoveryHydrating
      },
      delete: (key) => (isCurrent() ? host.documentRecoveryHydrating.delete(key) : false),
    },
    probeProvider: async (dbName) => {
      assertCurrent()
      const provider = await probeIndexedDbProvider(indexedDB, dbName)
      assertCurrent()
      return provider
    },
    resetProvider: async (docId, providerDbName) => {
      assertCurrent()
      if (docId.kind === 'meta') {
        const persistence = host.metaPersistence
        await persistence?.destroy()
        assertCurrent()
        if (host.metaPersistence === persistence) {
          host.metaPersistence = null
          host.metaPersistenceName = null
        }
      } else {
        const loaded = host.loadedTextDocs.get(docId.ydocId)
        if (loaded !== undefined) {
          await loaded.persistence?.destroy()
          assertCurrent()
          loaded.doc.destroy()
          if (host.loadedTextDocs.get(docId.ydocId) === loaded) {
            host.loadedTextDocs.delete(docId.ydocId)
          }
          if (host.activeTextDoc === loaded) host.activeTextDoc = null
        }
      }
      await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(providerDbName))
      assertCurrent()
    },
    readAccessToken: async (setup) => {
      assertCurrent()
      const token = await host.readAccessToken(setup)
      assertCurrent()
      return token
    },
    latestSnapshotUrl: (setup, docId) => {
      assertCurrent()
      return latestSnapshotUrl(setup, docId)
    },
    snapshotImportUrl: (setup, docId) => {
      assertCurrent()
      return snapshotImportUrl(setup, docId)
    },
    validateMetaCandidate: (doc) => {
      assertCurrent()
      return metaDocWritable(doc)
    },
    hydrateProvider: {
      create: async (docId) => {
        assertCurrent()
        if (docId.kind === 'meta') {
          if (host.metaPersistence === null) await openMetaPersistence(host)
          assertCurrent()
          return
        }
        await host.loadTextDocument(docId)
        assertCurrent()
      },
      apply: async (docId, updateBytes) => {
        assertCurrent()
        if (docId.kind === 'meta') {
          Y.applyUpdate(host.metaDoc, updateBytes, WORKER_ORIGIN)
          assertCurrent()
          return
        }
        const loaded = host.loadedTextDocs.get(docId.ydocId)
        if (loaded === undefined) throw new Error('document-recovery-provider-missing')
        Y.applyUpdate(loaded.doc, updateBytes, WORKER_ORIGIN)
        assertCurrent()
      },
      whenSynced: async (docId, epochId) => {
        assertCurrent()
        const persistence =
          docId.kind === 'meta'
            ? host.metaPersistence
            : host.loadedTextDocs.get(docId.ydocId)?.persistence
        await persistence?.whenSynced
        assertCurrent()
        await persistence?.set('__kuroflare_epoch_barrier', epochId)
        assertCurrent()
      },
    },
    commit: async (input) => {
      assertCurrent()
      await commitDocumentRecoveryTransaction(input)
      assertCurrent()
    },
  }
}

export async function loadIndexedDbYDocs(
  host: VaultLifecycleHost,
  vaultId?: LocalSetupMetadata['vaultId'],
): Promise<void> {
  const initialSetup = currentSetupMetadata(host)
  const targetVaultId = vaultId ?? initialSetup?.vaultId
  if (targetVaultId === undefined) return
  const generation = host.metadataVaultGeneration
  const targetMetaDoc = host.metaDoc
  const isCurrent = () =>
    host.metadataVaultGeneration === generation &&
    host.metaDoc === targetMetaDoc &&
    (currentSetupMetadata(host)?.vaultId ?? targetVaultId) === targetVaultId
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('local-store-vault-context-stale')
  }
  const db = await host.openLocalStoreDatabase(targetVaultId, isCurrent)
  assertCurrent()
  const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
    database: createLocalStoreIndexedDbMetadataDatabasePort(db),
  })
  assertCurrent()
  if (metadataSnapshot.ok) {
    if (metadataSnapshot.snapshot.setup.vaultId !== targetVaultId) {
      throw new Error('local-store-setup-vault-mismatch')
    }
    host.trustedSetupMetadata = metadataSnapshot.snapshot.setup
  }
  const setup = currentSetupMetadata(host)
  if (setup === undefined) return
  const transaction = db.transaction(['meta-ydoc', 'file-ydocs'], 'readonly')
  const metaRequest = transaction.objectStore('meta-ydoc').get('meta')
  const fileRequest = transaction.objectStore('file-ydocs').getAll()
  const [metaRecord, fileRecords] = await Promise.all([
    waitForIndexedDbRequest(metaRequest),
    waitForIndexedDbRequest(fileRequest),
  ])
  await waitForIndexedDbTransaction(transaction)
  assertCurrent()
  await recoverDocumentEpochsAtStartup(
    createDocumentEpochRecoveryHost(host, isCurrent),
    db,
    metaRecord,
    fileRecords,
  )
  assertCurrent()
  if (host.metaPersistence === null) {
    await openMetaPersistence(host)
    assertCurrent()
  }
  if (isStoredYDocRecord(metaRecord) && metaRecord.docId.kind === 'meta') {
    Y.applyUpdate(host.metaDoc, metaRecord.updateBytes, WORKER_ORIGIN)
  }
  for (const record of fileRecords) {
    if (!isStoredYDocRecord(record) || record.docId.kind !== 'file') continue
    const loaded = await host.loadTextDocument(record.docId)
    assertCurrent()
    Y.applyUpdate(loaded.doc, record.updateBytes, WORKER_ORIGIN)
  }
}

function latestSnapshotUrl(setup: LocalSetupMetadata, docId: DocId): string {
  const url = new URL(setup.endpoint)
  url.pathname =
    docId.kind === 'meta'
      ? `/vaults/${encodeURIComponent(setup.vaultId)}/meta/latest`
      : `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(docId.ydocId)}/latest`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function snapshotImportUrl(setup: LocalSetupMetadata, docId: DocId): string {
  const url = new URL(setup.endpoint)
  url.pathname =
    docId.kind === 'meta'
      ? `/vaults/${encodeURIComponent(setup.vaultId)}/meta/snapshot`
      : `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(docId.ydocId)}/snapshot`
  url.search = ''
  url.hash = ''
  return url.toString()
}
