import { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  SnapshotImportResponseSchema,
  decodeFullSnapshotBytesFromResponse,
  BlobHeadResponseSchema,
  BlobManifestSchema,
  blobManifestMatchesMetaFile,
  buildBinaryDownloadOutboxPlan,
  canonicalizeTextForYText,
  decideJoinFileAdoption,
  hashBytesSha256,
  hashCanonicalText,
  makeSha256Hex,
  type DocId,
  type LastMaterializedRecord,
  type DocLatestSnapshotResponse,
  type MetaLatestSnapshotResponse,
  type FileId,
  type MessageId,
  type OutboxResumeEvent,
  type ClientAuthMetadata,
  type SetupExchangeResponse,
  type QuarantinedUpdateEntry,
  type QuarantinedUpdateDetailResponse,
  type SyncUpdate,
  type BinaryMetaFile,
  type MetaFile,
  type BlobManifest,
  type MetadataAccess,
  type TextDeletionEvidence,
  type OutboxRunningLease,
} from '@kuroflare/core'
import { VaultRelativePathSchema, decodeMetaValue, type MetaRepair } from '@kuroflare/core'
import { Notice, Plugin, TFile, TFolder, type EventRef } from 'obsidian'
import * as v from 'valibot'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type {
  KuroflareSettings,
  KuroflareInvalidMetaIsolationDetail,
  KuroflareBinaryRestoreCheckDetail,
  LoadedTextDoc,
  KuroflareRepairLogEntry,
} from '../main-types'
import { LocalAwareness } from '../obsidian/awareness'
import { replaceYText } from '../obsidian/editor-binding'
import { KuroflareSettingTab } from '../obsidian/settings-tab'
import {
  createSyncRuntimeIndexedDbLocalStoreEffectPort,
  createSyncRuntimeLocalStoreRebuildReplanPort,
  createVerifiedSyncRuntimeSetupPersistStepPort,
  createSyncRuntimeStartupStepEffectPort,
  type SyncRuntimeStartupStepEffectPort,
} from '../sync/engine/actuation'
import { createLocalSetupPersistIndexedDbMetadataPort } from '../sync/engine/persist'
import { type LocalSetupMetadata } from '../sync/engine/setup'
import {
  commitFullSnapshotApplyIndexedDbTransaction,
  createFullSnapshotApplyIndexedDbDatabasePort,
  planFullSnapshotApplyRuntime,
  type VerifiedFullSnapshotBytes,
} from '../sync/engine/snapshot'
import {
  createSyncRuntimeWebSocketSession,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketStartupStepPort,
} from '../sync/engine/websocket'
import { reconcileMetaDoc } from '../sync/meta/reconcile'
import {
  createSyncRuntimeObsidianComposition,
  type SyncRuntimeObsidianComposition,
} from '../sync/obsidian/composition'
import {
  canDiscardInvalidMetaRepairEntry,
  planInvalidMetaIsolationDetail,
} from '../sync/obsidian/invalid-meta-isolation'
import { createSyncRuntimeObsidianResumePort } from '../sync/obsidian/lifecycle'
import type { SyncRuntimeObsidianRepairPresentation } from '../sync/obsidian/presentation'
import {
  listPausedRejectedUpdates,
  repairPausedRejectedUpdate,
  type RejectedUpdateRepairResult,
} from '../sync/obsidian/rejected-update-repair'
import {
  planPathConflictAutoResolve,
  planRemoteMaterializeBlockedAutoResolve,
} from '../sync/obsidian/repair-actions'
import {
  createSyncRuntimeObsidianSetupExchangeEvidenceReader,
  planSyncRuntimeObsidianLegacySettingsSecretCleanup,
} from '../sync/obsidian/settings'
import { createEvidenceBackedHttpSyncRuntimeSetupExchangePort } from '../sync/setup-exchange-http'
import {
  createBrowserLocalStoreIndexedDbFactoryPort,
  createLocalStoreIndexedDbMetadataDatabasePort,
  readLocalStoreIndexedDbMetadataSnapshot,
  readLocalStoreIndexedDbSchemaEvidence,
} from '../sync/store/indexeddb'
import {
  localStoreIndexedDbName,
  LOCAL_STORE_INDEXEDDB_MINIMUM_READABLE_VERSION,
  LOCAL_STORE_INDEXEDDB_TARGET_VERSION,
} from '../sync/store/schema'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import {
  activeDocId,
  cancelAuthRefreshStartupRetry,
  currentSetupDeviceId,
  currentSetupMetadata,
  currentSetupVaultIdHint,
  findActiveFileId,
  findMetaFileIdForDoc,
  readAccessToken,
  requireSetupMetadata,
} from './auth'
import {
  SPIKE_TEXT_NAME,
  DISK_ORIGIN,
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
  BINARY_UPLOAD_ORIGIN,
  REPAIR_ORIGIN,
  REPAIR_DEVICE,
  DEFAULT_SETTINGS,
} from './constants'
import { flushYTextToDisk } from './editor'
import {
  registerCommands,
  registerWorkspaceEvents,
  registerVaultWatcher,
  bindActiveMarkdownView,
} from './editor'
import {
  createRecoveringDocumentEpoch,
  documentEpochMetadataKey,
  isDocumentEpochRecord,
  probeIndexedDbProvider,
  recoverDocumentEpochLifecycle,
  type DocumentEpochRecord,
  type RecoveryOutboxUpdate,
} from './epoch-recovery'
import { commitDocumentRecoveryTransaction } from './epoch-recovery-store'
import {
  adoptLocalFilesAfterRemoteMeta,
  createLocalMetaYDocFromStartupScan,
  requestMissingRemoteTextFile,
  scanLocalVaultForStartup,
} from './file-tree'
import { registerFileTreeWatcher } from './file-tree'
import {
  isPartialSettings,
  isKuroflareRepairLogEntry,
  isKuroflareLocalRepairExportMetadata,
  isStoredYDocRecord,
  isDocIdLike,
} from './guards'
import {
  accessTokenSecretKeyForSetup,
  binaryBlobCacheKey,
  createObsidianSecretStoragePort,
  encodeBase64,
  localSetupMetadataFromSetupResponse,
  mergeRepairLogEntries,
  requireOutboxPlanItemId,
  safeLogError,
  sameDocId,
  hasPendingRunnableOutboxUpdate,
  waitForIndexedDbDeleteDatabase,
  waitForIndexedDbRequest,
  waitForIndexedDbTransaction,
} from './helpers'
import {
  activateLoadedTextDoc,
  establishInitialDocumentEpoch,
  loadTextDoc,
  insertMetaFile,
  metaMap,
  migrateLegacyMetaDoc,
  metadataWritesEnabled,
  metaDocWritable,
  metaDocLegacyOnly,
  hasLegacyDeletedTombstones,
  shouldAdoptRemoteMetadata,
  shouldPrepareMetadataMigration,
  readMetaFile,
  replaceTextDoc,
  prepareDocumentProvider,
  updateMetaFile,
} from './meta'
import { createFreshMetaDocForVaultSwitch } from './meta-namespace'
import { runOutboxWorkerTick } from './outbox'
import {
  blobHeadHashBatches,
  blobHeadEntryMatchesChunk,
  clearPendingFsRename,
  markPendingFsRename,
  metaPersistenceDatabaseName,
  MAX_BLOB_HEAD_HASHES_PER_REQUEST,
  deferStartupReplan,
} from './runtime-guards'
import { createRemoteSetupAccessTokenVerifier } from './setup-verifier'
import { createYDocFromSnapshot } from './snapshot-replace'
import { createStartupSideEffectGate } from './startup-gate'
import { openLocalStoreDatabase, putOutboxRecords, readOutboxWorkerSnapshot } from './store'
import { handleLifecycleResume } from './sync-runtime'
import {
  openWorkerWebSocket,
  requestActiveFileFromWorker,
  requestMetaDocFromWorker,
  requestDocFromWorker,
  requestPendingRemoteTextFilesFromWorker,
  sendMetaDocToWorker,
  sendWorkerHello,
  waitForOutboundUpdates,
  wireLocalAwarenessBroadcast,
} from './sync-websocket'
import { sendDocUpdateToWorker } from './sync-websocket'

/** Runs document-loss recovery at the startup boundary before normal provider side effects resume. */
export async function recoverDocumentEpochsAtStartup(
  plugin: KuroflareSpikePlugin,
  db: IDBDatabase,
  metaRecord: unknown,
  fileRecords: readonly unknown[],
): Promise<void> {
  await plugin.recoverDocumentEpochsAtStartup(db, metaRecord, fileRecords)
}

export default class KuroflareSpikePlugin extends Plugin {
  ydoc = new Y.Doc()
  ytext = this.ydoc.getText(SPIKE_TEXT_NAME)
  /** Presence for the active editor binding, broadcast to peers (see docs/spec/operations.md §4). */
  readonly awareness = new LocalAwareness()
  readonly cmCompartment = new Compartment()
  readonly lastMaterialized = new Map<string, LastMaterializedRecord>()
  readonly loadedTextDocs = new Map<string, LoadedTextDoc>()
  /** Documents whose provider evidence requires guarded epoch recovery before startup resumes. */
  readonly documentRecoveryRequired = new Set<string>()
  readonly documentRecoveryHydrating = new Set<string>()
  readonly documentReplacementInProgress = new Set<string>()
  activeTextDoc: LoadedTextDoc | null = null
  statusEl: HTMLElement | null = null
  syncStatusEl: HTMLElement | null = null
  syncRuntime: SyncRuntimeObsidianComposition | null = null
  syncRepairEntries: readonly SyncRuntimeObsidianRepairPresentation[] = []
  syncRejectedUpdateRepairEntries: readonly LocalStoreOutboxRecord[] = []
  syncRetryEnabled = false
  quarantineAdminEntries: readonly QuarantinedUpdateEntry[] = []
  quarantineAdminDetail: QuarantinedUpdateDetailResponse | null = null
  invalidMetaIsolationDetail: KuroflareInvalidMetaIsolationDetail | null = null
  binaryRestoreCheckDetail: KuroflareBinaryRestoreCheckDetail | null = null
  kuroflareSettings: KuroflareSettings = DEFAULT_SETTINGS
  readonly workerWebSocketSession: SyncRuntimeWebSocketSessionPort =
    createSyncRuntimeWebSocketSession()
  readonly outboxWorkerOwnerId = `obsidian-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`
  workerWebSocketStartupPort: SyncRuntimeWebSocketStartupStepPort | null = null
  workerWebSocketOpenPromise: Promise<void> | null = null
  workerWebSocketRecoveryPromise: Promise<void> | null = null
  outboxWorkerRunning = false
  outboxWorkerRetryTimeout: number | null = null
  authRefreshRunning = false
  authRefreshRetryTimeout: number | null = null
  pendingOutboxResumeEvents: OutboxResumeEvent[] = []
  syncStoppedByAuth: ClientAuthMetadata['authState'] | null = null
  foregroundResumeRunning = false
  workerHelloAccepted = false
  metadataAccess: MetadataAccess = 'read-only'
  metadataMigrationPromise: Promise<void> | null = null
  metadataMigrationPending = false
  metadataCapabilityAdvertised = true
  metadataCapabilityFallbackAttempted = false
  workerMessageCounter = 0
  pendingSyncRequestMessageIds = new Set<MessageId>()
  activeFile: TFile | null = null
  activeView: EditorView | null = null
  targetPath: string | null = null
  fileModifyRef: EventRef | null = null
  bindGeneration = 0
  readonly yCollabBoundViews = new WeakSet<EditorView>()
  metaDoc = new Y.Doc()
  metaPersistence: IndexeddbPersistence | null = null
  metaPersistenceName: string | null = null
  localStoreDb: IDBDatabase | null = null
  localStoreDbName: string | null = null
  readonly materializedPaths = new Map<FileId, string>()
  readonly pendingRemoteTextFiles = new Map<string, string>()
  readonly pendingTextDeletionEvidenceRequests = new Map<string, number>()
  readonly pendingTextDeletionEvidenceRetryTimers = new Map<string, number>()
  startupScannedMarkdownFiles: readonly TFile[] = []
  readonly pendingFsRenames = new Set<string>()
  readonly pendingFsDeletes = new Set<string>()
  readonly activeRemoteDeletedFileIds = new Set<FileId>()
  pendingRemoteMetaSnapshot: {
    readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
    readonly verifiedBytes: VerifiedFullSnapshotBytes
  } | null = null
  pendingSetupResponse: SetupExchangeResponse | null = null
  trustedSetupMetadata: LocalSetupMetadata | null = null
  readonly startupSideEffectGate = createStartupSideEffectGate()

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.statusEl = this.addStatusBarItem()
    this.syncStatusEl = this.addStatusBarItem()
    this.setStatus('loading')
    this.syncStatusEl.setText('Kuroflare sync: not started')

    this.addSettingTab(new KuroflareSettingTab(this.app, this))
    this.registerEditorExtension(this.cmCompartment.of([]))

    this.attachMetaDocObservers()
    wireLocalAwarenessBroadcast(this)
    this.syncRuntime = this.createSyncRuntime()

    registerCommands(this)
    registerFileTreeWatcher(this)
    registerVaultWatcher(this)
    registerWorkspaceEvents(this)

    this.app.workspace.onLayoutReady(() => {
      void bindActiveMarkdownView(this, 'layout-ready')
      void handleLifecycleResume(this, 'layout-ready')
    })

    this.setStatus('ready')
    console.info('[kuroflare] plugin loaded')
  }

  override onunload(): void {
    this.startupSideEffectGate.setPermission('blocked')
    if (this.fileModifyRef) {
      this.app.vault.offref(this.fileModifyRef)
      this.fileModifyRef = null
    }
    for (const loaded of this.loadedTextDocs.values()) {
      void loaded.persistence?.destroy()
      loaded.doc.destroy()
    }
    this.loadedTextDocs.clear()
    this.documentRecoveryRequired.clear()
    this.documentRecoveryHydrating.clear()
    this.documentReplacementInProgress.clear()
    this.pendingTextDeletionEvidenceRequests.clear()
    for (const timer of this.pendingTextDeletionEvidenceRetryTimers.values()) {
      window.clearTimeout(timer)
    }
    this.pendingTextDeletionEvidenceRetryTimers.clear()
    this.pendingFsDeletes.clear()
    this.activeTextDoc = null
    void this.metaPersistence?.destroy()
    this.metaPersistence = null
    this.metaPersistenceName = null
    this.localStoreDb?.close()
    this.localStoreDb = null
    this.localStoreDbName = null
    this.workerWebSocketSession.close(1000, 'plugin-unload')
    this.workerWebSocketStartupPort = null
    this.workerWebSocketOpenPromise = null
    this.workerWebSocketRecoveryPromise = null
    if (this.outboxWorkerRetryTimeout !== null) {
      window.clearTimeout(this.outboxWorkerRetryTimeout)
      this.outboxWorkerRetryTimeout = null
    }
    cancelAuthRefreshStartupRetry(this)
    this.metaDoc.destroy()
  }

  async updateSettings(patch: Partial<KuroflareSettings>): Promise<void> {
    this.kuroflareSettings = { ...this.kuroflareSettings, ...patch }
    await this.saveData(this.kuroflareSettings)
  }

  private async loadSettings(): Promise<void> {
    const loaded = await this.loadData()
    const loadedSettings = isPartialSettings(loaded) ? loaded : {}
    const secretCleanup = planSyncRuntimeObsidianLegacySettingsSecretCleanup(loadedSettings)
    this.kuroflareSettings = {
      ...DEFAULT_SETTINGS,
      ...secretCleanup.settings,
    }
    this.kuroflareSettings = {
      ...this.kuroflareSettings,
      repairLog: Array.isArray(this.kuroflareSettings.repairLog)
        ? this.kuroflareSettings.repairLog.filter(isKuroflareRepairLogEntry)
        : undefined,
      localRepairExport: isKuroflareLocalRepairExportMetadata(
        this.kuroflareSettings.localRepairExport,
      )
        ? this.kuroflareSettings.localRepairExport
        : undefined,
    }
    if (secretCleanup.removedLegacySecretKeys.length > 0) {
      console.warn('[kuroflare] removed legacy plaintext token fields from settings', {
        keys: secretCleanup.removedLegacySecretKeys,
      })
      await this.saveData(this.kuroflareSettings)
    }
  }

  getSettingsSnapshot(): KuroflareSettings {
    return this.kuroflareSettings
  }

  getSyncRepairEntriesSnapshot(): readonly SyncRuntimeObsidianRepairPresentation[] {
    return this.syncRepairEntries
  }

  getSyncRejectedUpdateRepairEntriesSnapshot(): readonly LocalStoreOutboxRecord[] {
    return this.syncRejectedUpdateRepairEntries
  }

  async refreshSyncRejectedUpdateRepairEntries(): Promise<void> {
    const setup = requireSetupMetadata(this)
    const db = await openLocalStoreDatabase(this, setup.vaultId)
    const snapshot = await readOutboxWorkerSnapshot(db)
    this.syncRejectedUpdateRepairEntries = listPausedRejectedUpdates(snapshot.outboxRecords).entries
  }

  async repairSyncRejectedUpdate(
    itemId: LocalStoreOutboxRecord['id'],
  ): Promise<RejectedUpdateRepairResult> {
    const setup = requireSetupMetadata(this)
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      return { ok: false, itemId, reason: 'auth-failed' }
    }
    const db = await openLocalStoreDatabase(this, setup.vaultId)
    const result = await repairPausedRejectedUpdate({
      db,
      setup,
      accessToken,
      itemId,
      http: { fetch: async (url, init) => await fetch(url, init) },
    })
    if (result.ok) {
      this.syncRejectedUpdateRepairEntries = this.syncRejectedUpdateRepairEntries.filter(
        (entry) => entry.id !== itemId,
      )
      return result
    }
    try {
      await this.refreshSyncRejectedUpdateRepairEntries()
    } catch (error: unknown) {
      console.warn('[kuroflare] rejected update repair list refresh failed', {
        error: safeLogError(error),
      })
    }
    return result
  }

  getQuarantineAdminSnapshot(): {
    readonly entries: readonly QuarantinedUpdateEntry[]
    readonly detail: QuarantinedUpdateDetailResponse | null
  } {
    return {
      entries: this.quarantineAdminEntries,
      detail: this.quarantineAdminDetail,
    }
  }

  getInvalidMetaIsolationSnapshot(): KuroflareInvalidMetaIsolationDetail | null {
    return this.invalidMetaIsolationDetail
  }

  getBinaryRestoreCheckSnapshot(): KuroflareBinaryRestoreCheckDetail | null {
    return this.binaryRestoreCheckDetail
  }

  async runOutboxWorkerTick(reason: string): Promise<void> {
    await runOutboxWorkerTick(this, reason)
  }

  async flushYTextToDisk(reason: string): Promise<void> {
    await flushYTextToDisk(this, reason)
  }

  private attachMetaDocObservers(): void {
    this.metaDoc.on('afterTransaction', (transaction: Y.Transaction) => {
      if (
        transaction.origin === REPAIR_ORIGIN ||
        transaction.origin === WORKER_ORIGIN ||
        transaction.origin === BINARY_UPLOAD_ORIGIN
      ) {
        return
      }
      if (!this.startupSideEffectGate.canSendNetwork()) return
      void this.reconcileAndMaterializeMeta()
    })
    this.metaDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === WORKER_ORIGIN || origin === BINARY_UPLOAD_ORIGIN) return
      if (!this.startupSideEffectGate.canSendNetwork()) return
      void sendDocUpdateToWorker(this, META_SYNC_DOC_ID, update, 'meta-update')
    })
  }

  private metaPersistenceDatabaseName(): string | undefined {
    const vaultId = currentSetupVaultIdHint(this)
    return vaultId === undefined ? undefined : metaPersistenceDatabaseName(vaultId)
  }

  private async openMetaPersistence(): Promise<void> {
    const name = this.metaPersistenceDatabaseName()
    if (name === undefined || this.metaPersistenceName === name) return
    await this.metaPersistence?.destroy()
    this.metaPersistence = null
    if (this.metaPersistenceName !== null) {
      this.metaPersistenceName = null
      this.metaDoc = createFreshMetaDocForVaultSwitch(this.metaDoc)
      this.attachMetaDocObservers()
      this.materializedPaths.clear()
      this.pendingRemoteTextFiles.clear()
    }
    this.startupSideEffectGate.beginPersistenceReplay()
    try {
      const epoch = await prepareDocumentProvider(this, META_SYNC_DOC_ID, name)
      this.metaPersistence = new IndexeddbPersistence(name, this.metaDoc)
      this.metaPersistenceName = name
      await this.metaPersistence.whenSynced
      if (epoch === undefined) {
        await establishInitialDocumentEpoch(this, META_SYNC_DOC_ID, name)
      }
      for (const [fileId] of metaMap(this).entries()) {
        const value = readMetaFile(metaMap(this), fileId)
        if (value !== undefined && !value.deleted) {
          this.materializedPaths.set(value.fileId, value.path)
        }
      }
    } finally {
      this.startupSideEffectGate.endPersistenceReplay()
    }
  }

  private async replaceMetaDoc(updateBytes: Uint8Array): Promise<void> {
    const oldDoc = this.metaDoc
    const persistenceName = this.metaPersistenceName
    const epochKey = documentEpochMetadataKey(META_SYNC_DOC_ID)
    this.documentReplacementInProgress.add(epochKey)
    try {
      if (this.metaPersistence !== null) {
        await this.metaPersistence.clearData()
        this.metaPersistence = null
        this.metaPersistenceName = null
        if (persistenceName !== null) {
          await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(persistenceName))
        }
      }
      oldDoc.destroy()
      this.metaDoc = createYDocFromSnapshot(updateBytes, WORKER_ORIGIN)
      this.attachMetaDocObservers()
      await this.openMetaPersistence()
      this.materializedPaths.clear()
    } finally {
      this.documentReplacementInProgress.delete(epochKey)
    }
  }

  /** Performs the legacy-to-v2 transition through the snapshot-import CAS endpoint. */
  async prepareMetadataAfterHello(): Promise<void> {
    if (this.metadataAccess !== 'read-write') return
    const root = this.metaDoc.getMap<unknown>('meta')
    if (root.size === 0) return
    if (metaDocWritable(this.metaDoc)) {
      this.metadataMigrationPending = false
      return
    }
    if (hasLegacyDeletedTombstones(this.metaDoc)) {
      this.metadataMigrationPending = false
      this.metadataAccess = 'read-only'
      new Notice(
        'Kuroflare metadata: legacy deleted entries require manual recovery; metadata writes are paused.',
      )
      return
    }
    const localUpdate = Y.encodeStateAsUpdate(this.metaDoc)
    let latest: Awaited<ReturnType<KuroflareSpikePlugin['fetchLatestSnapshotPayload']>> = null
    let manualRepairRequired = false
    try {
      latest = await this.fetchLatestSnapshotPayload(META_SYNC_DOC_ID, 'metadata-migration')
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = new Y.Doc()
        try {
          if (latest !== null) {
            Y.applyUpdate(candidate, latest.verifiedBytes.updateBytes)
            const candidateRoot = candidate.getMap<unknown>('meta')
            if (shouldAdoptRemoteMetadata(this.metaDoc, candidate)) {
              this.metadataMigrationPending = false
              await this.replaceMetaDoc(latest.verifiedBytes.updateBytes)
              return
            }
            if (candidateRoot.size > 0 && !metaDocLegacyOnly(candidate)) {
              manualRepairRequired = true
              break
            }
          }
          const baseStateVector = Y.encodeStateVector(candidate)
          Y.applyUpdate(candidate, localUpdate)
          if (!migrateLegacyMetaDoc(candidate)) break
          const migrationUpdate = Y.encodeStateAsUpdate(candidate, baseStateVector)
          const setup = requireSetupMetadata(this)
          const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
          if (accessToken === undefined) break
          const response = await fetch(this.snapshotImportUrl(setup, META_SYNC_DOC_ID), {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              updateBytesBase64: encodeBase64(migrationUpdate),
              ...(latest !== null && latest.response.manifestSeq > 0
                ? { latestSeq: latest.response.manifestSeq }
                : {}),
              metadataSchemaVersion: 2,
            }),
          })
          if (response.ok) {
            this.metadataMigrationPending = false
            await this.replaceMetaDoc(Y.encodeStateAsUpdate(candidate))
            return
          }
          if (response.status !== 409) break
          latest = await this.fetchLatestSnapshotPayload(
            META_SYNC_DOC_ID,
            'metadata-migration-retry',
          )
        } finally {
          candidate.destroy()
        }
      }
    } catch (error: unknown) {
      console.warn('[kuroflare] metadata migration CAS failed', { error: safeLogError(error) })
    }
    this.metadataMigrationPending = false
    this.metadataAccess = 'read-only'
    if (manualRepairRequired) {
      new Notice(
        'Kuroflare metadata: local metadata differs from remote v2; local data was preserved. Manual repair is required.',
      )
    }
  }

  /** Starts at most one deferred metadata migration and exposes its completion to startup. */
  startMetadataMigrationAfterHello(): Promise<void> {
    if (
      this.metadataMigrationPending &&
      this.metaDoc.getMap<unknown>('meta').size > 0 &&
      metaDocWritable(this.metaDoc)
    ) {
      this.metadataMigrationPending = false
    }
    if (
      !shouldPrepareMetadataMigration({
        metadataAccess: this.metadataAccess,
        migrationPending: this.metadataMigrationPending,
        metaDoc: this.metaDoc,
      })
    ) {
      return Promise.resolve()
    }
    const inFlight = this.metadataMigrationPromise
    if (inFlight !== null) return inFlight
    const migration = this.prepareMetadataAfterHello()
    const tracked = migration.finally(() => {
      if (this.metadataMigrationPromise === tracked) this.metadataMigrationPromise = null
    })
    this.metadataMigrationPromise = tracked
    return tracked
  }

  private createSyncRuntime(): SyncRuntimeObsidianComposition {
    const readSettings = () => ({
      endpoint: this.kuroflareSettings.endpoint,
      setupVaultId: this.kuroflareSettings.setupVaultId,
      setupToken: this.kuroflareSettings.setupToken,
      requestedDeviceName: this.kuroflareSettings.requestedDeviceName,
      setupBootstrapMode: this.kuroflareSettings.setupBootstrapMode,
      existingDeviceId: currentSetupDeviceId(this),
      persistedSetupMetadata: this.trustedSetupMetadata ?? undefined,
    })
    const setupEvidenceReader = createSyncRuntimeObsidianSetupExchangeEvidenceReader({
      readSettings,
    })
    const setupExchange = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
      fetch: (input, init) => fetch(input, init),
      readEvidence: (effect) => setupEvidenceReader.readEvidence(effect),
      scheduleReplan: async (request) => {
        this.pendingSetupResponse = request.response
      },
    })

    const resume = createSyncRuntimeObsidianResumePort({
      isDocumentHidden: () => document.hidden,
      isSyncBlocked: () => this.syncStoppedByAuth !== null,
      runForegroundResume: async (reason) => {
        await bindActiveMarkdownView(this, reason)
        await openWorkerWebSocket(this)
        await requestMetaDocFromWorker(this, reason)
        await requestActiveFileFromWorker(this, reason)
        void runOutboxWorkerTick(this, `resume:${reason}`)
      },
      scheduleOutboxTick: (reason) => {
        void runOutboxWorkerTick(this, reason)
      },
    })

    return createSyncRuntimeObsidianComposition({
      settings: { readSettings: async () => readSettings() },
      local: {
        readLocalEvidence: async () => await this.readLocalEvidence(),
      },
      setupExchange,
      localStore: createSyncRuntimeIndexedDbLocalStoreEffectPort({
        indexedDb: createBrowserLocalStoreIndexedDbFactoryPort(indexedDB),
      }),
      localStoreRebuild: createSyncRuntimeLocalStoreRebuildReplanPort({
        scheduleReplan: async () => {
          deferStartupReplan(
            () => {
              this.syncRuntime?.lifecycle.requestReplan()
              return this.syncRuntime?.lifecycle.runStartupTick()
            },
            (callback) => window.setTimeout(callback, 0),
          )
        },
      }),
      startupStep: this.createStartupStepPort(),
      resume,
      onSideEffectPermission: (permission) => {
        this.startupSideEffectGate.setPermission(permission)
      },
      ui: {
        setStatusText: (text) => this.syncStatusEl?.setText(text),
        showNotice: (text) => new Notice(text),
        setRepairEntries: (entries) => {
          this.syncRepairEntries = [...entries]
        },
        setRetryEnabled: (enabled) => {
          this.syncRetryEnabled = enabled
        },
      },
    })
  }

  private createStartupStepPort(): SyncRuntimeStartupStepEffectPort {
    const logStep = (step: string, phase: string, vaultId: string) => {
      console.info('[kuroflare] startup step', { step, phase, vaultId })
    }
    return createSyncRuntimeStartupStepEffectPort({
      setup: {
        persistSetupResponse: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.persistPendingSetupResponse()
        },
      },
      localScan: {
        scanLocalVault: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          scanLocalVaultForStartup(this)
        },
        createLocalMetaYDoc: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await createLocalMetaYDocFromStartupScan(this, `startup:${effect.step}`)
        },
        adoptLocalFilesAfterRemoteMeta: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await adoptLocalFilesAfterRemoteMeta(this)
        },
      },
      snapshot: {
        publishLocalMetaSnapshot: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.publishLocalMetaSnapshot(`startup:${effect.step}`)
        },
        publishInitialFileSnapshots: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.publishInitialFileSnapshots(`startup:${effect.step}`)
        },
        fetchRemoteMetaSnapshot: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          const snapshot = await this.fetchLatestSnapshotPayload(
            META_SYNC_DOC_ID,
            `startup:${effect.step}`,
          )
          if (snapshot === null) {
            throw new Error('remote-meta-snapshot-fetch-failed')
          }
          this.pendingRemoteMetaSnapshot = snapshot
        },
        applyRemoteMetaSnapshot: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          const snapshot = this.pendingRemoteMetaSnapshot
          if (snapshot === null) throw new Error('remote-meta-snapshot-missing')
          await this.applyLatestSnapshot(META_SYNC_DOC_ID, snapshot, `startup:${effect.step}`)
          this.pendingRemoteMetaSnapshot = null
        },
        syncMetaStateVector: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await requestMetaDocFromWorker(this, `startup:${effect.step}`)
        },
        syncActiveFileStateVector: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await requestActiveFileFromWorker(this, `startup:${effect.step}`)
        },
      },
      localStore: {
        loadIndexedDbYDocs: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.loadIndexedDbYDocs(effect.vaultId)
        },
      },
      websocket: {
        openWebSocket: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await openWorkerWebSocket(this)
        },
        sendClientHello: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await sendWorkerHello(this)
        },
      },
      outbox: {
        sendMetaUpdate: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await sendMetaDocToWorker(this, `startup:${effect.step}`)
        },
        enqueueMissingDownloads: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.enqueueMissingDownloads()
        },
        resumeBackgroundQueues: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await runOutboxWorkerTick(this, `startup:${effect.step}`)
        },
      },
    })
  }

  private async persistPendingSetupResponse(): Promise<void> {
    const response = this.pendingSetupResponse
    if (response === null) {
      if (this.trustedSetupMetadata !== null) return
      throw new Error('setup-response-missing')
    }
    const db = await openLocalStoreDatabase(this, response.vaultId)
    const port = createVerifiedSyncRuntimeSetupPersistStepPort({
      response,
      now: Date.now(),
      verifier: createRemoteSetupAccessTokenVerifier({
        endpoint: response.endpoint,
        fetch: (input, init) => fetch(input, init),
      }),
      secretKeyPrefix: 'kuroflare',
      secretStorage: createObsidianSecretStoragePort(this.app.secretStorage),
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
    this.trustedSetupMetadata = localSetupMetadataFromSetupResponse(response)
    await this.updateSettings({
      endpoint: response.endpoint,
      setupVaultId: response.vaultId,
      setupToken: '',
      setupBootstrapMode: undefined,
    })
    await this.openMetaPersistence()
    this.pendingSetupResponse = null
  }

  private async readLocalEvidence() {
    const vaultId = currentSetupVaultIdHint(this)
    if (vaultId === undefined) {
      return {
        metadataSnapshot: undefined,
        localStoreEvidence: undefined,
        hasMetaYDoc: metaMap(this).size > 0,
        hasLocalVaultFiles: this.app.vault.getMarkdownFiles().length > 0,
        setupResponse: this.pendingSetupResponse ?? undefined,
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
        ? await this.readLocalSetupMetadataSnapshot(
            vaultId,
            localStoreEvidence.evidence.currentVersion,
          )
        : undefined

    if (metadataSnapshot?.ok === true) {
      this.trustedSetupMetadata = metadataSnapshot.snapshot.setup
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
      if (this.localStoreDb === null && evidence.currentVersion !== undefined) {
        const existing = await this.openExistingLocalStoreDatabase(vaultId, evidence.currentVersion)
        this.localStoreDb = existing
        this.localStoreDbName = localStoreIndexedDbName(vaultId)
      }
      try {
        await this.openMetaPersistence()
      } catch (error: unknown) {
        if (!String(error).includes('document-provider-recovery-required')) throw error
        console.warn(
          '[kuroflare] metadata provider recovery deferred until local-store startup step',
        )
      }
    }

    return {
      metadataSnapshot,
      localStoreEvidence,
      hasMetaYDoc: metaMap(this).size > 0,
      hasLocalVaultFiles: this.app.vault.getMarkdownFiles().length > 0,
      setupResponse: this.pendingSetupResponse ?? undefined,
    }
  }

  private async readLocalSetupMetadataSnapshot(
    vaultId: LocalSetupMetadata['vaultId'],
    version: number | undefined,
  ) {
    if (version === undefined) return undefined
    let db: IDBDatabase | undefined
    try {
      db = await this.openExistingLocalStoreDatabase(vaultId, version)
      const snapshot = await readLocalStoreIndexedDbMetadataSnapshot({
        database: createLocalStoreIndexedDbMetadataDatabasePort(db),
      })
      return snapshot
    } catch (error: unknown) {
      console.warn('[kuroflare] failed to read local setup metadata', {
        error: safeLogError(error),
      })
      return undefined
    } finally {
      db?.close()
    }
  }

  private async openExistingLocalStoreDatabase(
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

  /** Recovers provider-loss documents before any provider, editor, socket, or outbox side effect resumes. */
  async recoverDocumentEpochsAtStartup(
    db: IDBDatabase,
    metaRecord: unknown,
    fileRecords: readonly unknown[],
  ): Promise<void> {
    const setup = currentSetupMetadata(this)
    if (setup === undefined) return
    this.startupSideEffectGate.beginRecovery()
    let recoverySucceeded = false
    try {
      const outboxSnapshot = await readOutboxWorkerSnapshot(db)
      const rawOutboxTransaction = db.transaction(['outbox'], 'readonly')
      const rawOutboxRows = await waitForIndexedDbRequest(
        rawOutboxTransaction.objectStore('outbox').getAll(),
      )
      await waitForIndexedDbTransaction(rawOutboxTransaction)
      const documents: Array<{ readonly docId: DocId; readonly updateBytes?: Uint8Array }> = []
      if (isStoredYDocRecord(metaRecord) && metaRecord.docId.kind === 'meta') {
        documents.push({ docId: META_SYNC_DOC_ID, updateBytes: metaRecord.updateBytes })
      }
      for (const record of fileRecords) {
        if (isStoredYDocRecord(record) && record.docId.kind === 'file') {
          documents.push({ docId: record.docId, updateBytes: record.updateBytes })
        }
      }
      const epochTransaction = db.transaction(['metadata'], 'readonly')
      const epochValues = await waitForIndexedDbRequest(
        epochTransaction.objectStore('metadata').getAll(),
      )
      await waitForIndexedDbTransaction(epochTransaction)
      for (const value of epochValues) {
        if (!isDocumentEpochRecord(value)) continue
        if (documents.some((document) => sameDocId(document.docId, value.docId))) continue
        documents.push({ docId: value.docId })
      }
      for (const row of outboxSnapshot.outboxRecords) {
        if (row.kind !== 'y-update' || row.docId === undefined || !isDocIdLike(row.docId)) continue
        const rowDocId = row.docId
        if (documents.some((document) => sameDocId(document.docId, rowDocId))) continue
        documents.push({ docId: rowDocId })
      }
      for (const row of rawOutboxRows) {
        if (typeof row !== 'object' || row === null) continue
        const docId = Reflect.get(row, 'docId')
        if (!isDocIdLike(docId)) continue
        if (Reflect.get(row, 'kind') !== 'y-update') continue
        const status = Reflect.get(row, 'status')
        if (status !== 'pending' && status !== 'retrying' && status !== 'paused') continue
        if (documents.some((document) => sameDocId(document.docId, docId))) continue
        documents.push({ docId })
      }
      const affected: Array<{
        readonly docId: DocId
        readonly providerDbName: string
        readonly baseUpdateBytes: Uint8Array | undefined
        readonly epoch: DocumentEpochRecord
      }> = []
      for (const document of documents) {
        const providerDbName =
          document.docId.kind === 'meta'
            ? metaPersistenceDatabaseName(setup.vaultId)
            : `kuroflare-file:${document.docId.ydocId}`
        const provider = await probeIndexedDbProvider(indexedDB, providerDbName)
        if (!provider.ok) {
          this.documentRecoveryRequired.add(documentEpochMetadataKey(document.docId))
          throw new Error(`document-provider-probe-failed:${provider.reason}`)
        }
        const epochValue = await this.readDocumentEpochRecord(db, document.docId)
        const hasPendingOutbox = outboxSnapshot.outboxRecords.some(
          (row) =>
            row.docId !== undefined &&
            sameDocId(row.docId, document.docId) &&
            (row.status === 'pending' || row.status === 'retrying' || row.status === 'paused'),
        )
        const rawHasPendingOutbox = rawOutboxRows.some((row) => {
          if (typeof row !== 'object' || row === null) return false
          const rowDocId = Reflect.get(row, 'docId')
          const status = Reflect.get(row, 'status')
          return (
            isDocIdLike(rowDocId) &&
            sameDocId(rowDocId, document.docId) &&
            (status === 'pending' || status === 'retrying' || status === 'paused')
          )
        })
        if (
          (provider.status === 'absent' || epochValue?.status === 'recovering') &&
          (epochValue !== undefined || hasPendingOutbox || rawHasPendingOutbox)
        ) {
          this.documentRecoveryRequired.add(documentEpochMetadataKey(document.docId))
          this.assertNoMalformedRecoveryOutboxRows(rawOutboxRows, document.docId)
          if (provider.status === 'present' && epochValue?.status === 'recovering') {
            if (document.docId.kind === 'meta') {
              await this.metaPersistence?.destroy()
              this.metaPersistence = null
              this.metaPersistenceName = null
            } else {
              const loaded = this.loadedTextDocs.get(document.docId.ydocId)
              if (loaded !== undefined) {
                await loaded.persistence?.destroy()
                loaded.doc.destroy()
                this.loadedTextDocs.delete(document.docId.ydocId)
                if (this.activeTextDoc === loaded) this.activeTextDoc = null
              }
            }
            await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(providerDbName))
          }
          const recovering = createRecoveringDocumentEpoch({
            docId: document.docId,
            providerDbName,
            now: Date.now(),
            previous: epochValue,
            reason: 'provider-loss',
          })
          await this.writeDocumentEpochRecord(db, recovering)
          affected.push({
            docId: document.docId,
            providerDbName,
            baseUpdateBytes: document.updateBytes,
            epoch: recovering,
          })
        }
      }
      if (affected.length === 0) {
        this.documentRecoveryRequired.clear()
        this.startupSideEffectGate.clearRecoveryBlock()
        recoverySucceeded = true
        return
      }
      for (const document of affected) {
        await this.recoverOneDocumentEpoch({
          db,
          setup,
          document,
          outboxRecords: outboxSnapshot.outboxRecords,
          leaseRows: outboxSnapshot.leaseRows,
        })
      }
      this.documentRecoveryRequired.clear()
      this.startupSideEffectGate.clearRecoveryBlock()
      recoverySucceeded = true
    } catch (error: unknown) {
      this.startupSideEffectGate.failRecovery(
        error instanceof Error ? error.message.slice(0, 256) : 'document-recovery-failed',
      )
      throw error
    } finally {
      if (recoverySucceeded) this.startupSideEffectGate.endRecovery()
    }
  }

  private assertNoMalformedRecoveryOutboxRows(rows: readonly unknown[], docId: DocId): void {
    const ids = new Set<string>()
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const id = Reflect.get(row, 'id')
      if (typeof id === 'string') ids.add(id)
    }
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const candidate = Reflect.get(row, 'docId')
      if (!isDocIdLike(candidate) || !sameDocId(candidate, docId)) continue
      if (Reflect.get(row, 'kind') !== 'y-update') continue
      const status = Reflect.get(row, 'status')
      if (status !== 'pending' && status !== 'retrying' && status !== 'paused') continue
      const bytes = Reflect.get(row, 'updateBytesBase64')
      const id = Reflect.get(row, 'id')
      const dependsOn = Reflect.get(row, 'dependsOn')
      if (
        typeof id !== 'string' ||
        !Array.isArray(dependsOn) ||
        typeof bytes !== 'string' ||
        bytes.length === 0 ||
        decodeBase64Bytes(bytes) === null
      ) {
        throw new Error(`document-recovery-malformed-outbox:${String(id)}`)
      }
      if (
        dependsOn.some(
          (dependency: unknown) => typeof dependency !== 'string' || !ids.has(dependency),
        )
      ) {
        throw new Error(`document-recovery-missing-outbox-dependency:${String(id)}`)
      }
    }
  }

  private async recoverOneDocumentEpoch(input: {
    readonly db: IDBDatabase
    readonly setup: LocalSetupMetadata
    readonly document: {
      readonly docId: DocId
      readonly providerDbName: string
      readonly baseUpdateBytes: Uint8Array | undefined
      readonly epoch: DocumentEpochRecord
    }
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  }): Promise<void> {
    const pendingUpdates: RecoveryOutboxUpdate[] = []
    for (const row of input.outboxRecords) {
      if (row.docId === undefined || !sameDocId(row.docId, input.document.docId)) continue
      if (row.kind !== 'y-update') continue
      if (row.status !== 'pending' && row.status !== 'retrying' && row.status !== 'paused') continue
      if (row.updateBytesBase64 === undefined || row.id === undefined) {
        throw new Error(`document-recovery-malformed-outbox:${row.id ?? 'unknown'}`)
      }
      const bytes = decodeBase64Bytes(row.updateBytesBase64)
      if (bytes === null) throw new Error(`document-recovery-malformed-outbox:${row.id}`)
      pendingUpdates.push({
        id: row.id,
        docId: row.docId,
        status: row.status,
        updateBytes: bytes,
        dependsOn: row.dependsOn,
      })
    }
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(input.setup))
    if (accessToken === undefined) throw new Error('document-recovery-token-missing')
    const key = documentEpochMetadataKey(input.document.docId)
    this.documentRecoveryHydrating.add(key)
    try {
      await recoverDocumentEpochLifecycle({
        docId: input.document.docId,
        ...(input.document.baseUpdateBytes !== undefined
          ? { localBaseUpdateBytes: input.document.baseUpdateBytes }
          : {}),
        pendingUpdates,
        durableOutboxIds: input.outboxRecords
          .filter(
            (row) =>
              row.status === 'done' &&
              row.docId !== undefined &&
              sameDocId(row.docId, input.document.docId),
          )
          .map((row) => row.id),
        validateCandidate:
          input.document.docId.kind === 'meta' ? (doc) => metaDocWritable(doc) : undefined,
        snapshots: {
          fetchLatest: async () => {
            const response = await fetch(
              this.latestSnapshotUrl(input.setup, input.document.docId),
              {
                headers: { Authorization: `Bearer ${accessToken}` },
              },
            )
            if (response.status === 404) return { kind: 'not-found' as const }
            if (!response.ok) throw new Error(`document-recovery-latest-${response.status}`)
            const body: unknown = await response.json().catch(() => undefined)
            const schema =
              input.document.docId.kind === 'meta'
                ? MetaLatestSnapshotResponseSchema
                : DocLatestSnapshotResponseSchema
            if (!v.is(schema, body)) throw new Error('document-recovery-latest-invalid')
            const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
            if (!decoded.ok) throw new Error(`document-recovery-latest-${decoded.reason}`)
            return {
              kind: 'found' as const,
              updateBytes: decoded.updateBytes,
              manifestSeq: body.manifestSeq,
            }
          },
          importSnapshot: async ({ updateBytes, latestSeq }) => {
            const response = await fetch(
              this.snapshotImportUrl(input.setup, input.document.docId),
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  updateBytesBase64: encodeBase64(updateBytes),
                  ...(latestSeq !== undefined ? { latestSeq } : {}),
                  ...(input.document.docId.kind === 'meta' ? { metadataSchemaVersion: 2 } : {}),
                }),
              },
            )
            if (response.status === 409) return { ok: false as const, status: 409 as const }
            if (!response.ok) return { ok: false as const, status: response.status }
            const body: unknown = await response.json().catch(() => undefined)
            if (!v.is(SnapshotImportResponseSchema, body)) {
              return { ok: false as const, status: 502, reason: 'invalid-import-response' }
            }
            return { ok: true as const, snapshotSeq: body.snapshotSeq }
          },
        },
        recoveringEpoch: input.document.epoch,
        hydrateProvider: {
          create: async () => {
            if (input.document.docId.kind === 'meta') {
              if (this.metaPersistence === null) await this.openMetaPersistence()
              return
            }
            await loadTextDoc(this, input.document.docId)
          },
          apply: async (candidate) => {
            if (input.document.docId.kind === 'meta') {
              Y.applyUpdate(this.metaDoc, candidate.updateBytes, WORKER_ORIGIN)
              return
            }
            const loaded = this.loadedTextDocs.get(input.document.docId.ydocId)
            if (loaded === undefined) throw new Error('document-recovery-provider-missing')
            Y.applyUpdate(loaded.doc, candidate.updateBytes, WORKER_ORIGIN)
          },
          whenSynced: async () => {
            if (input.document.docId.kind === 'meta') {
              await this.metaPersistence?.whenSynced
              await this.metaPersistence?.set(
                '__kuroflare_epoch_barrier',
                input.document.epoch.epochId,
              )
              return
            }
            const loaded = this.loadedTextDocs.get(input.document.docId.ydocId)
            await loaded?.persistence?.whenSynced
            await loaded?.persistence?.set(
              '__kuroflare_epoch_barrier',
              input.document.epoch.epochId,
            )
          },
        },
        commit: async ({ readyEpoch, candidate, snapshotSeq }) => {
          await this.commitDocumentRecoveryTransaction({
            db: input.db,
            docId: input.document.docId,
            updateBytes: candidate.updateBytes,
            snapshotSeq,
            epoch: readyEpoch,
            includedOutboxIds: candidate.includedOutboxIds,
            leaseRows: input.leaseRows,
            outboxRecords: input.outboxRecords,
          })
        },
      })
    } finally {
      this.documentRecoveryHydrating.delete(key)
    }
  }

  private async readDocumentEpochRecord(
    db: IDBDatabase,
    docId: DocId,
  ): Promise<DocumentEpochRecord | undefined> {
    const transaction = db.transaction(['metadata'], 'readonly')
    const value = await waitForIndexedDbRequest(
      transaction.objectStore('metadata').get(documentEpochMetadataKey(docId)),
    )
    await waitForIndexedDbTransaction(transaction)
    if (value === undefined) return undefined
    if (!isDocumentEpochRecord(value))
      throw new Error(`document-epoch-malformed:${documentEpochMetadataKey(docId)}`)
    return value
  }

  private async writeDocumentEpochRecord(
    db: IDBDatabase,
    epoch: DocumentEpochRecord,
  ): Promise<void> {
    const transaction = db.transaction(['metadata'], 'readwrite')
    await waitForIndexedDbRequest(
      transaction.objectStore('metadata').put(epoch, documentEpochMetadataKey(epoch.docId)),
    )
    await waitForIndexedDbTransaction(transaction)
  }

  private async commitDocumentRecoveryTransaction(input: {
    readonly db: IDBDatabase
    readonly docId: DocId
    readonly updateBytes: Uint8Array
    readonly snapshotSeq: number
    readonly epoch: DocumentEpochRecord
    readonly includedOutboxIds: readonly string[]
    readonly leaseRows: readonly OutboxRunningLease[]
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
  }): Promise<void> {
    await commitDocumentRecoveryTransaction(input)
  }

  private async loadIndexedDbYDocs(vaultId?: LocalSetupMetadata['vaultId']): Promise<void> {
    const initialSetup = currentSetupMetadata(this)
    const targetVaultId = vaultId ?? initialSetup?.vaultId
    if (targetVaultId === undefined) return
    const db = await openLocalStoreDatabase(this, targetVaultId)
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (metadataSnapshot.ok) {
      this.trustedSetupMetadata = metadataSnapshot.snapshot.setup
    }
    const setup = currentSetupMetadata(this)
    if (setup === undefined) return
    const transaction = db.transaction(['meta-ydoc', 'file-ydocs'], 'readonly')
    const metaRequest = transaction.objectStore('meta-ydoc').get('meta')
    const fileRequest = transaction.objectStore('file-ydocs').getAll()
    const [metaRecord, fileRecords] = await Promise.all([
      waitForIndexedDbRequest(metaRequest),
      waitForIndexedDbRequest(fileRequest),
    ])
    await waitForIndexedDbTransaction(transaction)
    await this.recoverDocumentEpochsAtStartup(db, metaRecord, fileRecords)
    if (this.metaPersistence === null) {
      await this.openMetaPersistence()
    }
    if (isStoredYDocRecord(metaRecord) && metaRecord.docId.kind === 'meta') {
      Y.applyUpdate(this.metaDoc, metaRecord.updateBytes, WORKER_ORIGIN)
    }
    for (const record of fileRecords) {
      if (!isStoredYDocRecord(record) || record.docId.kind !== 'file') continue
      const loaded = await loadTextDoc(this, record.docId)
      Y.applyUpdate(loaded.doc, record.updateBytes, WORKER_ORIGIN)
    }
  }

  private async publishLocalMetaSnapshot(reason: string): Promise<void> {
    await this.importLocalSnapshot(META_SYNC_DOC_ID, Y.encodeStateAsUpdate(this.metaDoc), reason)
  }

  private async publishInitialFileSnapshots(reason: string): Promise<void> {
    for (const loaded of this.loadedTextDocs.values()) {
      await this.importLocalSnapshot(loaded.docId, Y.encodeStateAsUpdate(loaded.doc), reason)
    }
  }

  private async importLocalSnapshot(
    docId: DocId,
    updateBytes: Uint8Array,
    reason: string,
  ): Promise<void> {
    if (docId.kind === 'meta' && !metadataWritesEnabled(this)) return
    const setup = requireSetupMetadata(this)
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) throw new Error('snapshot-import-token-missing')
    const response = await fetch(this.snapshotImportUrl(setup, docId), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: encodeBase64(updateBytes),
        ...(docId.kind === 'meta' ? { metadataSchemaVersion: 2 } : {}),
      }),
    })
    if (!response.ok) {
      console.warn('[kuroflare] local snapshot import failed', {
        status: response.status,
        docId,
        reason,
      })
      throw new Error('snapshot-import-http-failed')
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!v.is(SnapshotImportResponseSchema, body)) {
      throw new Error('snapshot-import-response-invalid')
    }
  }

  private async fetchLatestSnapshotPayload(
    docId: DocId,
    reason: string,
  ): Promise<{
    readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
    readonly verifiedBytes: VerifiedFullSnapshotBytes
  } | null> {
    const setup = requireSetupMetadata(this)
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) return null
    const response = await fetch(this.latestSnapshotUrl(setup, docId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      console.warn('[kuroflare] latest snapshot fetch failed', {
        status: response.status,
        reason,
        docId,
      })
      return null
    }
    const body: unknown = await response.json().catch(() => undefined)
    const schema =
      docId.kind === 'meta' ? MetaLatestSnapshotResponseSchema : DocLatestSnapshotResponseSchema
    if (!v.is(schema, body)) return null
    const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
    if (!decoded.ok) return null
    return { response: body, verifiedBytes: decoded }
  }

  private async applyLatestSnapshot(
    docId: DocId,
    snapshot: {
      readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
      readonly verifiedBytes: VerifiedFullSnapshotBytes
    },
    _reason: string,
  ): Promise<void> {
    const setup = requireSetupMetadata(this)
    const db = await openLocalStoreDatabase(this, setup.vaultId)
    const localStore = await readOutboxWorkerSnapshot(db)
    const plan = planFullSnapshotApplyRuntime({
      requestedDocId: docId,
      response: snapshot.response,
      verifiedBytes: snapshot.verifiedBytes,
      hasPendingLocalUpdates: hasPendingRunnableOutboxUpdate(localStore.outboxRecords, docId),
      activeEditorBound: docId.kind === 'file' && sameDocId(docId, await activeDocId(this)),
      currentOutboxRecords: localStore.outboxRecords,
      currentLeaseRows: localStore.leaseRows,
    })
    if (!plan.ok) {
      console.warn('[kuroflare] latest snapshot apply deferred', {
        action: plan.action,
        reason: plan.reason,
        docId,
      })
      throw new Error(`latest-snapshot-apply:${plan.action}:${plan.reason}`)
    }
    await commitFullSnapshotApplyIndexedDbTransaction({
      database: createFullSnapshotApplyIndexedDbDatabasePort(db),
      transaction: plan.indexedDbWriteTransaction,
    })
    if (docId.kind === 'meta') {
      await this.replaceMetaDoc(plan.updateBytes)
      return
    }
    const wasActiveTextDoc = this.activeTextDoc?.docId.ydocId === docId.ydocId
    const loaded = await replaceTextDoc(this, docId, plan.updateBytes, WORKER_ORIGIN)
    if (wasActiveTextDoc) {
      activateLoadedTextDoc(this, loaded)
    }
    await this.resolvePendingRemoteTextFile(loaded)
    if (sameDocId(docId, await activeDocId(this))) {
      await flushYTextToDisk(this, 'full-snapshot')
    }
  }

  private latestSnapshotUrl(setup: LocalSetupMetadata, docId: DocId): string {
    const url = new URL(setup.endpoint)
    url.pathname =
      docId.kind === 'meta'
        ? `/vaults/${encodeURIComponent(setup.vaultId)}/meta/latest`
        : `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(docId.ydocId)}/latest`
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private snapshotImportUrl(setup: LocalSetupMetadata, docId: DocId): string {
    const url = new URL(setup.endpoint)
    url.pathname =
      docId.kind === 'meta'
        ? `/vaults/${encodeURIComponent(setup.vaultId)}/meta/snapshot`
        : `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(docId.ydocId)}/snapshot`
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private async enqueueMissingDownloads(): Promise<void> {
    if (!this.startupSideEffectGate.canSendNetwork()) return
    await this.reconcileAndMaterializeMeta()
    await requestPendingRemoteTextFilesFromWorker(this, 'startup:enqueue-missing-downloads')
    await this.enqueueMissingRemoteBinaryDownloads('startup:enqueue-missing-downloads')
    console.info('[kuroflare] enqueued missing remote text downloads', {
      pending: this.pendingRemoteTextFiles.size,
    })
  }

  private async reconcileAndMaterializeMeta(): Promise<void> {
    if (!this.startupSideEffectGate.canSendNetwork()) return
    if (metadataWritesEnabled(this)) {
      const restorableBinaryFileIds = await this.findRestorableBinaryFileIdsForReconcile()
      const textDeletionEvidence = await this.findTextDeletionEvidenceForReconcile()
      const reconciled = reconcileMetaDoc(this.metaDoc.getMap<unknown>('meta'), {
        updatedAt: Date.now(),
        updatedBy: REPAIR_DEVICE,
        restorableBinaryFileIds,
        textDeletionEvidence,
        origin: REPAIR_ORIGIN,
      })
      await this.recordMetaRepairLog(reconciled.repairs, reconciled.invalidFileIds)
      await this.clearResolvedDeleteDeferrals(reconciled.repairs)
    } else if (this.metadataAccess === 'read-write') {
      const invalidFileIds: string[] = []
      for (const [fileId, value] of metaMap(this).entries()) {
        if (decodeMetaValue(value, fileId).disposition === 'invalid') {
          invalidFileIds.push(fileId)
        }
      }
      await this.recordMetaRepairLog([], invalidFileIds)
    }
    await this.materializeMetaRenames()
    this.materializeMetaDeletes()
    await this.enqueueMissingRemoteBinaryDownloads('meta-reconcile')
  }

  async findTextDeletionEvidenceForReconcile(): Promise<ReadonlyMap<FileId, TextDeletionEvidence>> {
    const evidence = new Map<FileId, TextDeletionEvidence>()
    const inspectedEntries = new Map<FileId, Extract<MetaFile, { type: 'text'; deleted: true }>>()
    for (const [fileId] of metaMap(this).entries()) {
      const value = readMetaFile(metaMap(this), fileId)
      if (
        value === undefined ||
        !value.deleted ||
        value.type !== 'text' ||
        value.deletedContentVersion?.kind !== 'text'
      ) {
        continue
      }
      const wasLoaded = this.loadedTextDocs.has(value.ydocId)
      let loaded = this.loadedTextDocs.get(value.ydocId)
      if (loaded === undefined) {
        loaded = await loadTextDoc(this, { kind: 'file', ydocId: value.ydocId })
      }
      if (!this.textDeletionEvidenceEntryMatches(fileId, value)) continue
      if (!wasLoaded) {
        await this.requestTextDeletionEvidence(loaded)
        continue
      }
      const stateVectorBase64 = encodeBase64(Y.encodeStateVector(loaded.doc))
      const contentSha256 = await hashCanonicalText(loaded.text.toJSON())
      if (!this.textDeletionEvidenceEntryMatches(fileId, value)) continue
      evidence.set(value.fileId, { stateVectorBase64, contentSha256 })
      inspectedEntries.set(fileId, value)
      if (!stateVectorDominates(loaded.doc, value.deletedContentVersion.stateVectorBase64)) {
        await this.requestTextDeletionEvidence(loaded)
      }
    }
    const validatedEvidence = new Map<FileId, TextDeletionEvidence>()
    for (const [fileId, currentEvidence] of evidence) {
      const inspected = inspectedEntries.get(fileId)
      if (inspected !== undefined && this.textDeletionEvidenceEntryMatches(fileId, inspected)) {
        validatedEvidence.set(fileId, currentEvidence)
      }
    }
    return validatedEvidence
  }

  private textDeletionEvidenceEntryMatches(
    fileId: FileId,
    inspected: Extract<MetaFile, { type: 'text'; deleted: true }>,
  ): boolean {
    const current = readMetaFile(metaMap(this), fileId)
    return (
      current !== undefined &&
      current.deleted &&
      current.type === 'text' &&
      current.ydocId === inspected.ydocId &&
      JSON.stringify(current.deletedContentVersion) ===
        JSON.stringify(inspected.deletedContentVersion)
    )
  }

  private binaryDeletionEvidenceEntryMatches(
    fileId: FileId,
    inspected: Extract<MetaFile, { type: 'binary'; deleted: true }>,
  ): boolean {
    const current = readMetaFile(metaMap(this), fileId)
    return (
      current !== undefined &&
      current.deleted &&
      current.type === 'binary' &&
      current.blobManifestHash === inspected.blobManifestHash &&
      JSON.stringify(current.blobChunks) === JSON.stringify(inspected.blobChunks) &&
      JSON.stringify(current.deletedContentVersion) ===
        JSON.stringify(inspected.deletedContentVersion)
    )
  }

  private async requestTextDeletionEvidence(loaded: LoadedTextDoc): Promise<void> {
    const now = Date.now()
    const expiresAt = this.pendingTextDeletionEvidenceRequests.get(loaded.docId.ydocId)
    if (expiresAt !== undefined && expiresAt > now) return
    if (expiresAt !== undefined) this.clearTextDeletionEvidenceRequest(loaded.docId.ydocId)
    this.pendingTextDeletionEvidenceRequests.set(loaded.docId.ydocId, now + 10_000)
    try {
      const sent = await requestDocFromWorker(
        this,
        loaded.docId,
        Y.encodeStateVector(loaded.doc),
        'delete-reconcile-text-evidence',
      )
      if (!sent) {
        this.clearTextDeletionEvidenceRequest(loaded.docId.ydocId)
      } else {
        this.scheduleTextDeletionEvidenceRetry(loaded)
      }
    } catch (error: unknown) {
      this.clearTextDeletionEvidenceRequest(loaded.docId.ydocId)
      console.warn('[kuroflare] failed to request text deletion evidence', {
        docId: loaded.docId,
        error: safeLogError(error),
      })
    }
  }

  scheduleTextDeletionEvidenceRetry(loaded: LoadedTextDoc): void {
    const docId = loaded.docId.ydocId
    if (!this.pendingTextDeletionEvidenceRequests.has(docId)) return
    const existingTimer = this.pendingTextDeletionEvidenceRetryTimers.get(docId)
    if (existingTimer !== undefined) window.clearTimeout(existingTimer)
    const timer = window.setTimeout(() => {
      this.pendingTextDeletionEvidenceRetryTimers.delete(docId)
      if (!this.pendingTextDeletionEvidenceRequests.delete(docId)) return
      const current = this.loadedTextDocs.get(docId)
      if (current !== undefined) void this.requestTextDeletionEvidence(current)
    }, 10_000)
    this.pendingTextDeletionEvidenceRetryTimers.set(docId, timer)
  }

  private clearTextDeletionEvidenceRequest(docId: string): void {
    this.pendingTextDeletionEvidenceRequests.delete(docId)
    const timer = this.pendingTextDeletionEvidenceRetryTimers.get(docId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      this.pendingTextDeletionEvidenceRetryTimers.delete(docId)
    }
  }

  private async clearResolvedDeleteDeferrals(repairs: readonly MetaRepair[]): Promise<void> {
    const pending = new Set(
      repairs
        .filter(
          (repair): repair is Extract<MetaRepair, { action: 'defer-deletion' }> =>
            'action' in repair && repair.action === 'defer-deletion',
        )
        .map((repair) => repair.fileId),
    )
    const current = this.kuroflareSettings.repairLog ?? []
    const deferredReasons = new Set([
      'legacy-deletion-tombstone',
      'deletion-evidence-unavailable',
      'deletion-base-not-dominated',
      'invalid-deletion-evidence',
    ])
    const next = current.filter(
      (entry) =>
        !(
          entry.kind === 'delete-vs-edit' &&
          deferredReasons.has(entry.reason) &&
          !pending.has(entry.fileId)
        ),
    )
    if (next.length !== current.length) {
      await this.updateSettings({ repairLog: next })
    }
  }

  async findRestorableBinaryFileIdsForReconcile(): Promise<ReadonlySet<FileId>> {
    const setup = currentSetupMetadata(this)
    if (setup === undefined) return new Set()
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) return new Set()

    const restorable = new Set<FileId>()
    const inspectedEntries = new Map<FileId, Extract<MetaFile, { type: 'binary'; deleted: true }>>()
    for (const [fileId] of metaMap(this).entries()) {
      const value = readMetaFile(metaMap(this), fileId)
      if (value === undefined || !value.deleted || value.type !== 'binary') continue
      const manifest = await this.fetchBlobManifestForMeta(setup, accessToken, value)
      if (!this.binaryDeletionEvidenceEntryMatches(fileId, value)) continue
      if (
        manifest !== undefined &&
        (await this.remoteBlobChunksExist(setup, accessToken, manifest))
      ) {
        if (!this.binaryDeletionEvidenceEntryMatches(fileId, value)) continue
        restorable.add(value.fileId)
        inspectedEntries.set(fileId, value)
      }
    }
    const validatedRestorable = new Set<FileId>()
    for (const fileId of restorable) {
      const inspected = inspectedEntries.get(fileId)
      if (inspected !== undefined && this.binaryDeletionEvidenceEntryMatches(fileId, inspected)) {
        validatedRestorable.add(fileId)
      }
    }
    return validatedRestorable
  }

  private async enqueueMissingRemoteBinaryDownloads(reason: string): Promise<void> {
    if (!this.startupSideEffectGate.canSendNetwork()) return
    const setup = currentSetupMetadata(this)
    if (setup === undefined) return
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) return

    const db = await openLocalStoreDatabase(this, setup.vaultId)
    const snapshot = await readOutboxWorkerSnapshot(db)
    const records: LocalStoreOutboxRecord[] = []
    const now = Date.now()
    for (const [fileId] of metaMap(this).entries()) {
      const value = readMetaFile(metaMap(this), fileId)
      if (value === undefined || value.deleted || value.type !== 'binary') continue
      if (!v.is(VaultRelativePathSchema, value.path)) continue
      if (
        snapshot.outboxRecords.some(
          (record) =>
            record.fileId === value.fileId &&
            record.kind === 'materialize' &&
            record.status !== 'done' &&
            record.status !== 'failed',
        )
      )
        continue

      const manifest = await this.fetchBlobManifestForMeta(setup, accessToken, value)
      if (manifest === undefined) continue
      const existing = this.app.vault.getAbstractFileByPath(value.path)
      if (existing instanceof TFolder) continue
      if (existing instanceof TFile) {
        const currentBytes = new Uint8Array(await this.app.vault.adapter.readBinary(value.path))
        const currentHash = makeSha256Hex(await hashBytesSha256(currentBytes))
        if (currentHash === manifest.contentSha256) {
          this.lastMaterialized.set(value.path, {
            diskHash: manifest.contentSha256,
            ydocHash: manifest.contentSha256,
            path: value.path,
            writtenAt: now,
          })
          continue
        }
      }

      const prefix = `binary-download-${value.fileId}-${value.blobManifestHash}`
      const plan = buildBinaryDownloadOutboxPlan({
        fileId: value.fileId,
        expectedHash: manifest.contentSha256,
        chunks: manifest.chunks.map((chunk, index) => ({
          id: requireOutboxPlanItemId(`${prefix}-chunk-${index.toString(36)}`),
          sha256: chunk.sha256,
          localCacheKey: binaryBlobCacheKey(chunk.sha256),
          size: chunk.size,
        })),
        materializeId: requireOutboxPlanItemId(`${prefix}-materialize`),
      })
      if (!plan.ok) continue
      for (const item of plan.plan.items) {
        const base = {
          id: item.id,
          kind: item.kind,
          status: 'pending',
          dependsOn: item.dependsOn,
          nextAttemptAt: undefined,
          fileId: item.fileId,
          createdAt: now,
        } as const
        if (item.kind === 'blob-get') {
          records.push({
            ...base,
            blobSha256: item.sha256,
            localCacheKey: item.localCacheKey,
            blobSize: item.size,
          })
        } else if (item.kind === 'materialize') {
          records.push({
            ...base,
            blobManifestHash: value.blobManifestHash,
            blobManifest: manifest,
            materializeChunks: manifest.chunks.map((chunk) => ({
              sha256: chunk.sha256,
              localCacheKey: binaryBlobCacheKey(chunk.sha256),
              size: chunk.size,
            })),
            expectedHash: item.expectedHash,
            targetPath: value.path,
            lastMaterialized:
              existing instanceof TFile ? this.lastMaterialized.get(value.path) : undefined,
          })
        }
      }
      this.materializedPaths.set(value.fileId, value.path)
    }
    if (records.length === 0) return
    await putOutboxRecords(db, records)
    void runOutboxWorkerTick(this, reason)
  }

  private async fetchBlobManifestForMeta(
    setup: LocalSetupMetadata,
    accessToken: string,
    value: BinaryMetaFile,
  ): Promise<BlobManifest | undefined> {
    const url = new URL(setup.endpoint)
    url.pathname = `/blob-manifests/${encodeURIComponent(value.blobManifestHash)}.json`
    let response: Response
    try {
      response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } })
    } catch {
      this.binaryRestoreCheckDetail = {
        fileId: value.fileId,
        path: value.path,
        checkedAt: Date.now(),
        reason: 'manifest-unavailable',
      }
      return undefined
    }
    if (!response.ok) {
      this.binaryRestoreCheckDetail = {
        fileId: value.fileId,
        path: value.path,
        checkedAt: Date.now(),
        reason: 'manifest-unavailable',
      }
      return undefined
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!v.is(BlobManifestSchema, body) || !blobManifestMatchesMetaFile(body, value)) {
      this.binaryRestoreCheckDetail = {
        fileId: value.fileId,
        path: value.path,
        checkedAt: Date.now(),
        reason: 'manifest-unavailable',
      }
      return undefined
    }
    return body
  }

  private async remoteBlobChunksExist(
    setup: LocalSetupMetadata,
    accessToken: string,
    manifest: BlobManifest,
  ): Promise<boolean> {
    const hashes = manifest.chunks.map((chunk) => chunk.sha256)
    for (const [batchIndex, batch] of blobHeadHashBatches(hashes).entries()) {
      const start = batchIndex * MAX_BLOB_HEAD_HASHES_PER_REQUEST
      const url = new URL(setup.endpoint)
      url.pathname = '/blobs/head'
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ hashes: batch }),
        })
      } catch {
        return false
      }
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok || !v.is(BlobHeadResponseSchema, body)) return false
      for (const chunk of manifest.chunks.slice(start, start + batch.length)) {
        const entry = body.exists[chunk.sha256]
        if (!blobHeadEntryMatchesChunk(entry, chunk.size)) {
          return false
        }
      }
    }
    return true
  }

  private async recordMetaRepairLog(
    repairs: readonly MetaRepair[],
    invalidFileIds: readonly string[],
  ): Promise<void> {
    if (repairs.length === 0 && invalidFileIds.length === 0) return
    const createdAt = Date.now()
    const entries: KuroflareRepairLogEntry[] = [
      ...repairs.map(
        (repair): KuroflareRepairLogEntry => ({
          id:
            'action' in repair
              ? `delete-vs-edit:${repair.fileId}:${repair.action}`
              : 'reason' in repair
                ? `portable-path:${repair.fileId}`
                : `path-conflict:${repair.fileId}`,
          kind:
            'action' in repair
              ? 'delete-vs-edit'
              : 'reason' in repair
                ? 'portable-path'
                : 'path-conflict',
          fileId: repair.fileId,
          path: 'toPath' in repair ? repair.toPath : undefined,
          reason:
            'action' in repair
              ? repair.action === 'keep-deleted'
                ? 'missing-binary-content'
                : repair.action === 'defer-deletion'
                  ? repair.reason
                  : 'concurrent-edit-after-delete'
              : 'reason' in repair
                ? repair.reason
                : 'path-conflict-renamed',
          createdAt,
        }),
      ),
      ...invalidFileIds.map(
        (fileId): KuroflareRepairLogEntry => ({
          id: `invalid-meta:${fileId}`,
          kind: 'invalid-meta',
          fileId,
          reason: 'meta-schema-invalid',
          createdAt,
        }),
      ),
    ]
    await this.updateSettings({
      repairLog: mergeRepairLogEntries(this.kuroflareSettings.repairLog ?? [], entries),
    })
  }

  private async recordRemoteMaterializeBlocked(
    loaded: LoadedTextDoc,
    path: string,
    reason: 'invalid-path' | 'path-collision' | 'parent-collision',
  ): Promise<void> {
    const fileId = findMetaFileIdForDoc(this, loaded.docId)
    const entry: KuroflareRepairLogEntry = {
      id: `remote-materialize-blocked:${loaded.docId.ydocId}:${reason}`,
      kind: 'remote-materialize-blocked',
      fileId: fileId ?? loaded.docId.ydocId,
      path,
      reason,
      createdAt: Date.now(),
    }
    await this.updateSettings({
      repairLog: mergeRepairLogEntries(this.kuroflareSettings.repairLog ?? [], [entry]),
    })
  }

  private async removeRepairLogEntry(entryId: string): Promise<void> {
    await this.updateSettings({
      repairLog: (this.kuroflareSettings.repairLog ?? []).filter((entry) => entry.id !== entryId),
    })
  }

  private async materializeMetaRenames(): Promise<void> {
    for (const [fileId] of metaMap(this).entries()) {
      const value = readMetaFile(metaMap(this), fileId)
      if (value === undefined || value.deleted) continue
      this.activeRemoteDeletedFileIds.delete(value.fileId)
      const known = this.materializedPaths.get(value.fileId)
      if (known === value.path) continue
      if (known === undefined) {
        this.materializedPaths.set(value.fileId, value.path)
        if (value.type === 'text') {
          await requestMissingRemoteTextFile(this, value)
        }
        continue
      }
      const file = this.app.vault.getAbstractFileByPath(known)
      if (!(file instanceof TFile)) {
        this.materializedPaths.set(value.fileId, value.path)
        if (value.type === 'text') {
          await requestMissingRemoteTextFile(this, value)
        }
        continue
      }
      const target = markPendingFsRename(this.pendingFsRenames, value.path)
      try {
        await this.app.fileManager.renameFile(file, value.path)
        this.materializedPaths.set(value.fileId, value.path)
        clearPendingFsRename(this.pendingFsRenames, target)
      } catch (error: unknown) {
        clearPendingFsRename(this.pendingFsRenames, target)
        console.warn('[kuroflare] failed to materialize meta rename', {
          from: known,
          to: value.path,
          error: safeLogError(error),
        })
      }
    }
  }

  private materializeMetaDeletes(): void {
    for (const [fileId] of metaMap(this).entries()) {
      const value = readMetaFile(metaMap(this), fileId)
      if (value === undefined || !value.deleted) continue
      if (value.type === 'text') {
        this.pendingRemoteTextFiles.delete(value.ydocId)
        this.clearTextDeletionEvidenceRequest(value.ydocId)
      }
      if (this.activeFile?.path !== value.path) continue
      if (this.activeRemoteDeletedFileIds.has(value.fileId)) continue
      this.activeRemoteDeletedFileIds.add(value.fileId)
      this.syncStatusEl?.setText(`Kuroflare sync: remote tombstone ${value.path}`)
      new Notice('Kuroflare sync: active file was deleted remotely; local editor kept open')
    }
  }

  async resolvePendingRemoteTextFile(loaded: LoadedTextDoc): Promise<void> {
    const path = this.pendingRemoteTextFiles.get(loaded.docId.ydocId)
    if (path === undefined) return
    if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      return
    }
    if (!v.is(VaultRelativePathSchema, path)) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'invalid-path')
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      return
    }
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.resolveJoinAdoptionHashCheck(existing, loaded)
      return
    }
    if (existing !== null) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
      return
    }
    const createdFolders: string[] = []
    const slash = path.lastIndexOf('/')
    if (slash !== -1) {
      const parts = path.slice(0, slash).split('/')
      let current = ''
      for (const part of parts) {
        current = current.length === 0 ? part : `${current}/${part}`
        if (this.app.vault.getAbstractFileByPath(current) === null) {
          if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
            this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
            return
          }
          try {
            await this.app.vault.createFolder(current)
            createdFolders.push(current)
            if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
              this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
              await this.cleanupRemoteMaterializeFolders(createdFolders)
              return
            }
          } catch {
            const existingFolder = this.app.vault.getAbstractFileByPath(current)
            if (!(existingFolder instanceof TFolder)) {
              await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision')
              this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
              await this.cleanupRemoteMaterializeFolders(createdFolders)
              return
            }
            if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
              this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
              await this.cleanupRemoteMaterializeFolders(createdFolders)
              return
            }
          }
        } else if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
          await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision')
          return
        }
      }
    }
    if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }
    const content = loaded.text.toJSON()
    const contentHash = await hashCanonicalText(content)
    if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }
    try {
      await this.app.vault.create(path, content)
    } catch (error: unknown) {
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      try {
        await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
      } catch (repairError: unknown) {
        console.warn('[kuroflare] failed to record a remote materialization collision', {
          path,
          error: safeLogError(repairError),
        })
      }
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      console.warn('[kuroflare] remote text materialization collided with a local file', {
        path,
        competingPathPresent: this.app.vault.getAbstractFileByPath(path) !== null,
        error: safeLogError(error),
      })
      return
    }
    if (!this.pendingRemoteTextMatchesMeta(loaded, path)) {
      await this.compensateRemoteTextMaterialization(loaded, path, contentHash, createdFolders)
      return
    }
    this.lastMaterialized.set(path, {
      diskHash: contentHash,
      ydocHash: contentHash,
      path,
      writtenAt: Date.now(),
    })
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
  }

  private async cleanupRemoteMaterializeFolders(paths: readonly string[]): Promise<void> {
    for (const path of [...paths].reverse()) {
      const folder = this.app.vault.getAbstractFileByPath(path)
      if (!(folder instanceof TFolder) || folder.children.length !== 0) continue
      try {
        await this.app.vault.delete(folder)
      } catch (error: unknown) {
        console.warn('[kuroflare] failed to clean up an empty materialization folder', {
          path,
          error: safeLogError(error),
        })
      }
    }
  }

  private async compensateRemoteTextMaterialization(
    loaded: LoadedTextDoc,
    path: string,
    expectedHash: string,
    createdFolders: readonly string[],
  ): Promise<void> {
    const tombstoned = this.remoteTextTombstoneMatchesMeta(loaded, path)
    if (!tombstoned) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }

    const created = this.app.vault.getAbstractFileByPath(path)
    if (!(created instanceof TFile)) {
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }
    let actualHash: string
    try {
      actualHash = await hashCanonicalText(await this.app.vault.read(created))
    } catch (error: unknown) {
      console.warn('[kuroflare] could not verify a raced remote text materialization', {
        path,
        error: safeLogError(error),
      })
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }

    if (!this.remoteTextTombstoneMatchesMeta(loaded, path) || actualHash !== expectedHash) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
      new Notice(
        `Kuroflare sync: preserved a raced local edit at ${path}; resolve the remote materialization repair manually.`,
      )
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }

    this.pendingFsDeletes.add(path)
    try {
      await this.app.vault.delete(created)
    } catch (error: unknown) {
      this.pendingFsDeletes.delete(path)
      console.warn('[kuroflare] failed to compensate a raced remote text materialization', {
        path,
        error: safeLogError(error),
      })
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
    } finally {
      this.pendingFsDeletes.delete(path)
    }
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    await this.cleanupRemoteMaterializeFolders(createdFolders)
  }

  private pendingRemoteTextMatchesMeta(loaded: LoadedTextDoc, path: string): boolean {
    const fileId = findMetaFileIdForDoc(this, loaded.docId)
    if (fileId === undefined) return false
    const value = readMetaFile(metaMap(this), fileId)
    return (
      value !== undefined &&
      !value.deleted &&
      value.type === 'text' &&
      value.ydocId === loaded.docId.ydocId &&
      value.path === path
    )
  }

  private remoteTextTombstoneMatchesMeta(loaded: LoadedTextDoc, path: string): boolean {
    const fileId = findMetaFileIdForDoc(this, loaded.docId)
    if (fileId === undefined) return false
    const value = readMetaFile(metaMap(this), fileId)
    return (
      value !== undefined &&
      value.deleted &&
      value.type === 'text' &&
      value.ydocId === loaded.docId.ydocId &&
      value.path === path
    )
  }

  async resolveJoinAdoptionHashCheck(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path)) {
      this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
      return
    }
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    const fileId = findActiveFileId(this, file.path)
    if (fileId === undefined) return

    const remoteContentHash = await hashCanonicalText(loaded.text.toJSON())
    const localContentHash = await hashCanonicalText(await this.app.vault.read(file))
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path)) return
    const decision = decideJoinFileAdoption({
      remoteEntry: { fileId, contentHash: remoteContentHash },
      localContentHash,
    })
    if (decision.action === 'adopt-matching-content') {
      this.lastMaterialized.set(file.path, {
        diskHash: localContentHash,
        ydocHash: remoteContentHash,
        path: file.path,
        writtenAt: Date.now(),
        diskMtimeMs: file.stat.mtime,
        diskSize: file.stat.size,
      })
      return
    }
    await this.importJoinAdoptionTextIfActive(file, loaded)
  }

  private async importJoinAdoptionTextIfActive(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path)) return
    const diskText = await this.app.vault.read(file)
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path)) return
    const canonicalText = canonicalizeTextForYText(diskText)
    const textHash = await hashCanonicalText(canonicalText)
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path)) return
    replaceYText(loaded.doc, loaded.text, canonicalText, DISK_ORIGIN)
    this.lastMaterialized.set(file.path, {
      diskHash: textHash,
      ydocHash: textHash,
      path: file.path,
      writtenAt: Date.now(),
      diskMtimeMs: file.stat.mtime,
      diskSize: file.stat.size,
    })
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path)) return
    await sendDocUpdateToWorker(
      this,
      loaded.docId,
      Y.encodeStateAsUpdate(loaded.doc),
      'join-adoption-hash-mismatch',
    )
  }

  async handleWorkerSyncUpdate(message: SyncUpdate): Promise<void> {
    if (message.docId.kind === 'meta') {
      await this.startMetadataMigrationAfterHello()
      await this.reconcileAndMaterializeMeta()
      await bindActiveMarkdownView(this, 'meta-update')
      return
    }
    const loaded = await loadTextDoc(this, message.docId)
    this.clearTextDeletionEvidenceRequest(message.docId.ydocId)
    await this.resolvePendingRemoteTextFile(loaded)
    await this.reconcileAndMaterializeMeta()
    if (sameDocId(message.docId, await activeDocId(this))) {
      await flushYTextToDisk(this, 'worker-update')
    }
  }

  async clearRepairLogEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: cleared ${entry.kind}`)
  }

  async retryPathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict' && entry.kind !== 'portable-path') return
    if (!metadataWritesEnabled(this)) return
    await this.materializeMetaRenames()
    if (this.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN) {
      await openWorkerWebSocket(this)
    }
    // The rename that produced this entry already synced incrementally through
    // metaDoc's own `update` listener; resending the full doc here duplicated
    // that update and could quarantine the sync-update on the server, because
    // `Y.encodeStateAsUpdate(doc)` re-emits every delete this device has ever
    // observed (including ones from other actors this device hasn't durably
    // synced yet), not just what changed since the last send.
    await waitForOutboundUpdates(this, 120_000)
    await this.removeRepairLogEntry(entry.id)
  }

  async retryKeepDeletedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'delete-vs-edit' || entry.reason !== 'missing-binary-content') return
    if (!metadataWritesEnabled(this)) return

    const current = readMetaFile(metaMap(this), entry.fileId)
    if (current === undefined || !current.deleted || current.type !== 'binary') {
      await this.removeRepairLogEntry(entry.id)
      return
    }

    await this.reconcileAndMaterializeMeta()
    const reconciled = readMetaFile(metaMap(this), entry.fileId)
    if (reconciled === undefined || reconciled.deleted) return
    await this.removeRepairLogEntry(entry.id)
  }

  async resolvePathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict' && entry.kind !== 'portable-path') return
    if (!metadataWritesEnabled(this)) return
    const current = readMetaFile(metaMap(this), entry.fileId)
    const plan = planPathConflictAutoResolve({
      entry,
      current,
      isPathAvailable: (path) => this.app.vault.getAbstractFileByPath(path) === null,
    })
    if (plan.action === 'rename-meta-path') {
      this.metaDoc.transact(() => {
        const value = readMetaFile(metaMap(this), entry.fileId)
        if (value === undefined) return
        updateMetaFile(metaMap(this), {
          ...value,
          path: plan.toPath,
          canonicalPath: plan.toCanonicalPath,
          updatedAt: Date.now(),
          updatedBy: REPAIR_DEVICE,
        })
      }, REPAIR_ORIGIN)
      await this.materializeMetaRenames()
    }
    await this.removeRepairLogEntry(entry.id)
  }

  async retryRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'remote-materialize-blocked') return
    const current = readMetaFile(metaMap(this), entry.fileId)
    if (current === undefined || current.deleted) {
      await this.removeRepairLogEntry(entry.id)
      return
    }
    if (current.type === 'text') {
      await requestMissingRemoteTextFile(this, current)
    } else {
      await this.enqueueMissingRemoteBinaryDownloads('repair:remote-materialize-retry')
    }
    await this.removeRepairLogEntry(entry.id)
  }

  async resolveRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'remote-materialize-blocked') return
    if (!metadataWritesEnabled(this)) return
    const current = readMetaFile(metaMap(this), entry.fileId)
    const plan = planRemoteMaterializeBlockedAutoResolve({
      entry,
      current,
      isPathAvailable: (path) => this.app.vault.getAbstractFileByPath(path) === null,
    })
    if (
      plan.action === 'rename-meta-path' &&
      current !== undefined &&
      !current.deleted &&
      current.type === 'text'
    ) {
      this.metaDoc.transact(() => {
        const value = readMetaFile(metaMap(this), entry.fileId)
        if (value === undefined) return
        updateMetaFile(metaMap(this), {
          ...value,
          path: plan.toPath,
          canonicalPath: plan.toCanonicalPath,
          updatedAt: Date.now(),
          updatedBy: REPAIR_DEVICE,
        })
      }, REPAIR_ORIGIN)
      await requestMissingRemoteTextFile(this, {
        type: current.type,
        path: plan.toPath,
        ydocId: current.ydocId,
      })
    }
    await this.removeRepairLogEntry(entry.id)
  }

  async inspectInvalidMetaRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'invalid-meta') return
    const plan = planInvalidMetaIsolationDetail({
      entry,
      current: metaMap(this).get(entry.fileId),
      inspectedAt: Date.now(),
    })
    if (plan.action === 'isolate') {
      this.invalidMetaIsolationDetail = plan.detail
    }
  }

  async discardInvalidMetaRepairEntry(
    entry: KuroflareRepairLogEntry,
    confirmation: string,
  ): Promise<void> {
    if (entry.kind !== 'invalid-meta') return
    const current = metaMap(this).get(entry.fileId)
    if (
      !canDiscardInvalidMetaRepairEntry({
        metadataAccess: this.metadataAccess,
        fileId: entry.fileId,
        current,
        confirmation,
      })
    ) {
      return
    }
    const decoded = decodeMetaValue(current, entry.fileId)
    if (current === undefined || decoded.disposition !== 'invalid') {
      if (this.invalidMetaIsolationDetail?.fileId === entry.fileId) {
        this.invalidMetaIsolationDetail = null
      }
      await this.removeRepairLogEntry(entry.id)
      return
    }
    // This transaction's own `update` event already syncs the deletion
    // incrementally (see `attachMetaDocObservers`); resending the full doc
    // here duplicated that update and could quarantine the sync-update on
    // the server, because `Y.encodeStateAsUpdate(doc)` re-emits every delete
    // this device has ever observed, not just what changed since the last send.
    this.metaDoc.transact(() => {
      metaMap(this).delete(entry.fileId)
    }, REPAIR_ORIGIN)
    if (this.invalidMetaIsolationDetail?.fileId === entry.fileId) {
      this.invalidMetaIsolationDetail = null
    }
    await this.removeRepairLogEntry(entry.id)
  }

  /** Reads one normalized metadata entry for concrete integration adapters. */
  readMetaEntry(fileId: string): MetaFile | undefined {
    return readMetaFile(metaMap(this), fileId)
  }

  /** Writes one grouped metadata entry, preserving the identity write gate. */
  writeMetaEntry(value: MetaFile): boolean {
    if (!metadataWritesEnabled(this)) return false
    const map = metaMap(this)
    if (updateMetaFile(map, value)) return true
    if (map.has(value.fileId)) return false
    insertMetaFile(map, value)
    return true
  }

  setStatus(status: string): void {
    this.statusEl?.setText(`Kuroflare: ${status}`)
  }
}

function stateVectorDominates(doc: Y.Doc, base64: string): boolean {
  try {
    const binary = atob(base64)
    const base = Y.decodeStateVector(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )
    const current = Y.decodeStateVector(Y.encodeStateVector(doc))
    for (const [clientId, clock] of base) {
      if ((current.get(clientId) ?? 0) < clock) return false
    }
    return true
  } catch {
    return false
  }
}

function decodeBase64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}
