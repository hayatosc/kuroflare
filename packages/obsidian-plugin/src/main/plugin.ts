import { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  SnapshotImportResponseSchema,
  decodeFullSnapshotBytesFromResponse,
  canonicalizeTextForYText,
  decideJoinFileAdoption,
  hashCanonicalText,
  type DocId,
  type LastMaterializedRecord,
  type DocLatestSnapshotResponse,
  type MetaLatestSnapshotResponse,
  type NeedFullSnapshotReason,
  type FileId,
  type MessageId,
  type OutboxResumeEvent,
  type ClientAuthMetadata,
  type SetupExchangeResponse,
  type SyncUpdate,
  type MetaFile,
  type MetadataAccess,
} from '@kuroflare/core'
import { VaultRelativePathSchema, decodeMetaValue } from '@kuroflare/core'
import { Notice, Plugin, TFile, TFolder, type EventRef } from 'obsidian'
import * as v from 'valibot'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { LocalAwareness } from '../editor/awareness'
import { replaceYText } from '../editor/editor-binding'
import { KuroflareSettingTab } from '../editor/settings-tab'
import type {
  KuroflareSettings,
  KuroflareInvalidMetaIsolationDetail,
  KuroflareBinaryRestoreCheckDetail,
  LoadedTextDoc,
  KuroflareRepairLogEntry,
} from '../main-types'
import {
  materializeMetaRenames,
  type MetadataMaterializationPort,
} from '../plugin/metadata-materialization'
import {
  clearTextDeletionEvidenceRequest,
  enqueueMissingRemoteBinaryDownloads,
  reconcileAndMaterializeMeta,
  type MetadataReconcilePort,
} from '../plugin/metadata-reconcile'
import { probeIndexedDbProvider, documentEpochMetadataKey } from '../recovery/epoch'
import { createYDocFromSnapshot } from '../recovery/epoch'
import { commitDocumentRecoveryTransaction } from '../recovery/epoch-repair'
import {
  recoverDocumentEpochsAtStartup,
  type DocumentEpochRecoveryHost,
} from '../recovery/epoch-startup'
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
  runNeedFullSnapshotRecovery,
  type VerifiedFullSnapshotBytes,
} from '../sync/engine/snapshot'
import {
  createSyncRuntimeObsidianComposition,
  type SyncRuntimeObsidianComposition,
} from '../sync/obsidian/composition'
import { createSyncRuntimeObsidianResumePort } from '../sync/obsidian/lifecycle'
import {
  canDiscardInvalidMetaRepairEntry,
  planInvalidMetaIsolationDetail,
} from '../sync/obsidian/meta-quarantine'
import type { SyncRuntimeObsidianRepairPresentation } from '../sync/obsidian/presentation'
import {
  listPausedRejectedUpdates,
  repairPausedRejectedUpdate,
  type RejectedUpdateRepairResult,
} from '../sync/obsidian/rejected-repair'
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
  createSyncRuntimeWebSocketSession,
  type SyncRuntimeWebSocketSessionPort,
} from '../sync/transport/socket'
import type { SyncRuntimeWebSocketStartupStepPort } from '../sync/transport/startup'
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
import { createStartupSideEffectGate } from './boot-guard'
import {
  SPIKE_TEXT_NAME,
  DISK_ORIGIN,
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
  BINARY_UPLOAD_ORIGIN,
  REPAIR_ORIGIN,
  REPAIR_DEVICE,
  DEFAULT_SETTINGS,
  NEED_FULL_SNAPSHOT_RECOVERY_BACKOFF_MS,
} from './constants'
import { flushYTextToDisk } from './editor'
import {
  registerCommands,
  registerWorkspaceEvents,
  registerVaultWatcher,
  bindActiveMarkdownView,
} from './editor'
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
} from './guards'
import {
  accessTokenSecretKeyForSetup,
  createObsidianSecretStoragePort,
  encodeBase64,
  localSetupMetadataFromSetupResponse,
  mergeRepairLogEntries,
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
import { createFreshMetaDocForVaultSwitch } from './meta'
import { runOutboxWorkerTick } from './outbox/tick'
import { metaPersistenceDatabaseName, deferStartupReplan } from './runtime-guards'
import { createRemoteSetupAccessTokenVerifier } from './setup-verifier'
import { openLocalStoreDatabase, putOutboxRecords, readOutboxWorkerSnapshot } from './store'
import { handleLifecycleResume } from './sync-bridge'
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
  /** Documents currently running automatic NeedFullSnapshot fetch+apply recovery. */
  readonly needFullSnapshotRecoveryInProgress = new Set<string>()
  activeTextDoc: LoadedTextDoc | null = null
  statusEl: HTMLElement | null = null
  syncStatusEl: HTMLElement | null = null
  syncRuntime: SyncRuntimeObsidianComposition | null = null
  syncRepairEntries: readonly SyncRuntimeObsidianRepairPresentation[] = []
  syncRejectedUpdateRepairEntries: readonly LocalStoreOutboxRecord[] = []
  syncRetryEnabled = false
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
      void reconcileAndMaterializeMeta(
        metadataReconcilePort(this),
        metadataMaterializationPort(this),
      )
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

  createDocumentEpochRecoveryHost(): DocumentEpochRecoveryHost {
    return {
      currentSetup: () => currentSetupMetadata(this),
      recoveryGate: this.startupSideEffectGate,
      recoveryRequired: this.documentRecoveryRequired,
      recoveryHydrating: this.documentRecoveryHydrating,
      probeProvider: (dbName) => probeIndexedDbProvider(indexedDB, dbName),
      resetProvider: async (docId, providerDbName) => {
        if (docId.kind === 'meta') {
          await this.metaPersistence?.destroy()
          this.metaPersistence = null
          this.metaPersistenceName = null
        } else {
          const loaded = this.loadedTextDocs.get(docId.ydocId)
          if (loaded !== undefined) {
            await loaded.persistence?.destroy()
            loaded.doc.destroy()
            this.loadedTextDocs.delete(docId.ydocId)
            if (this.activeTextDoc === loaded) this.activeTextDoc = null
          }
        }
        await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(providerDbName))
      },
      readAccessToken: async (setup) =>
        await readAccessToken(this, accessTokenSecretKeyForSetup(setup)),
      latestSnapshotUrl: (setup, docId) => this.latestSnapshotUrl(setup, docId),
      snapshotImportUrl: (setup, docId) => this.snapshotImportUrl(setup, docId),
      validateMetaCandidate: (doc) => metaDocWritable(doc),
      hydrateProvider: {
        create: async (docId) => {
          if (docId.kind === 'meta') {
            if (this.metaPersistence === null) await this.openMetaPersistence()
            return
          }
          await loadTextDoc(this, docId)
        },
        apply: async (docId, updateBytes) => {
          if (docId.kind === 'meta') {
            Y.applyUpdate(this.metaDoc, updateBytes, WORKER_ORIGIN)
            return
          }
          const loaded = this.loadedTextDocs.get(docId.ydocId)
          if (loaded === undefined) throw new Error('document-recovery-provider-missing')
          Y.applyUpdate(loaded.doc, updateBytes, WORKER_ORIGIN)
        },
        whenSynced: async (docId, epochId) => {
          if (docId.kind === 'meta') {
            await this.metaPersistence?.whenSynced
            await this.metaPersistence?.set('__kuroflare_epoch_barrier', epochId)
            return
          }
          const loaded = this.loadedTextDocs.get(docId.ydocId)
          await loaded?.persistence?.whenSynced
          await loaded?.persistence?.set('__kuroflare_epoch_barrier', epochId)
        },
      },
      commit: async (input) => await commitDocumentRecoveryTransaction(input),
    }
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
    await recoverDocumentEpochsAtStartup(
      this.createDocumentEpochRecoveryHost(),
      db,
      metaRecord,
      fileRecords,
    )
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

  /**
   * Automatically recovers from a NeedFullSnapshot response by fetching and applying a
   * replacement snapshot, which resumes the matching paused outbox item as a side effect
   * of {@link applyLatestSnapshot}. Bounded retries with backoff; exhausting them leaves
   * the outbox item in its existing paused/manual-recovery state (fail closed).
   */
  async recoverFromNeedFullSnapshot(docId: DocId, reason: NeedFullSnapshotReason): Promise<void> {
    const epochKey = documentEpochMetadataKey(docId)
    if (
      this.needFullSnapshotRecoveryInProgress.has(epochKey) ||
      this.documentRecoveryRequired.has(epochKey) ||
      this.documentReplacementInProgress.has(epochKey)
    ) {
      return
    }
    this.needFullSnapshotRecoveryInProgress.add(epochKey)
    try {
      const result = await runNeedFullSnapshotRecovery(
        {
          fetchSnapshot: async () =>
            await this.fetchLatestSnapshotPayload(docId, `need-full-snapshot:${reason}`),
          applySnapshot: async (payload) => {
            try {
              await this.applyLatestSnapshot(docId, payload, `need-full-snapshot:${reason}`)
              return true
            } catch (error: unknown) {
              console.warn('[kuroflare] need-full-snapshot auto-recovery apply attempt failed', {
                docId,
                reason,
                error: safeLogError(error),
              })
              return false
            }
          },
          wait: async (delayMs) =>
            await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)),
        },
        NEED_FULL_SNAPSHOT_RECOVERY_BACKOFF_MS,
      )
      if (!result.ok) {
        console.warn(
          '[kuroflare] need-full-snapshot auto-recovery exhausted retries; outbox item remains paused for manual recovery',
          { docId, reason, attempts: result.attempts },
        )
      }
    } finally {
      this.needFullSnapshotRecoveryInProgress.delete(epochKey)
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
    await reconcileAndMaterializeMeta(
      metadataReconcilePort(this),
      metadataMaterializationPort(this),
    )
    await requestPendingRemoteTextFilesFromWorker(this, 'startup:enqueue-missing-downloads')
    await enqueueMissingRemoteBinaryDownloads(
      metadataReconcilePort(this),
      metadataMaterializationPort(this),
      'startup:enqueue-missing-downloads',
    )
    console.info('[kuroflare] enqueued missing remote text downloads', {
      pending: this.pendingRemoteTextFiles.size,
    })
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
      await reconcileAndMaterializeMeta(
        metadataReconcilePort(this),
        metadataMaterializationPort(this),
      )
      await bindActiveMarkdownView(this, 'meta-update')
      return
    }
    const loaded = await loadTextDoc(this, message.docId)
    clearTextDeletionEvidenceRequest(metadataReconcilePort(this), message.docId.ydocId)
    await this.resolvePendingRemoteTextFile(loaded)
    await reconcileAndMaterializeMeta(
      metadataReconcilePort(this),
      metadataMaterializationPort(this),
    )
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
    await materializeMetaRenames(metadataMaterializationPort(this))
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

    await reconcileAndMaterializeMeta(
      metadataReconcilePort(this),
      metadataMaterializationPort(this),
    )
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
      await materializeMetaRenames(metadataMaterializationPort(this))
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
      await enqueueMissingRemoteBinaryDownloads(
        metadataReconcilePort(this),
        metadataMaterializationPort(this),
        'repair:remote-materialize-retry',
      )
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

function metadataReconcilePort(plugin: KuroflareSpikePlugin): MetadataReconcilePort {
  return {
    canSendNetwork: () => plugin.startupSideEffectGate.canSendNetwork(),
    getMetaDoc: () => plugin.metaDoc,
    getMetadataAccess: () => plugin.metadataAccess,
    loadedTextDocs: plugin.loadedTextDocs,
    pendingTextDeletionEvidenceRequests: plugin.pendingTextDeletionEvidenceRequests,
    pendingTextDeletionEvidenceRetryTimers: plugin.pendingTextDeletionEvidenceRetryTimers,
    loadTextDoc: (ydocId) => loadTextDoc(plugin, { kind: 'file', ydocId }),
    requestDocFromWorker: (loaded, stateVector, reason) =>
      requestDocFromWorker(plugin, loaded.docId, stateVector, reason),
    getSettings: () => plugin.kuroflareSettings,
    updateSettings: (patch) => plugin.updateSettings(patch),
    currentSetup: () => currentSetupMetadata(plugin),
    readAccessToken: (setup) => readAccessToken(plugin, accessTokenSecretKeyForSetup(setup)),
    setBinaryRestoreCheckDetail: (detail) => {
      plugin.binaryRestoreCheckDetail = detail
    },
  }
}

function metadataMaterializationPort(plugin: KuroflareSpikePlugin): MetadataMaterializationPort {
  return {
    getMetaDoc: () => plugin.metaDoc,
    vault: plugin.app.vault,
    fileManager: plugin.app.fileManager,
    lastMaterialized: plugin.lastMaterialized,
    materializedPaths: plugin.materializedPaths,
    pendingRemoteTextFiles: plugin.pendingRemoteTextFiles,
    pendingFsRenames: plugin.pendingFsRenames,
    activeRemoteDeletedFileIds: plugin.activeRemoteDeletedFileIds,
    getActiveFile: () => plugin.activeFile,
    setSyncStatusText: (text) => plugin.syncStatusEl?.setText(text),
    notify: (message) => new Notice(message),
    clearTextDeletionEvidenceRequest: (docId) =>
      clearTextDeletionEvidenceRequest(metadataReconcilePort(plugin), docId),
    requestMissingRemoteTextFile: (value) => requestMissingRemoteTextFile(plugin, value),
    openLocalStoreDatabase: (vaultId) => openLocalStoreDatabase(plugin, vaultId),
    readOutboxWorkerSnapshot: (db) => readOutboxWorkerSnapshot(db),
    putOutboxRecords: (db, records) => putOutboxRecords(db, records),
    runOutboxWorkerTick: (reason) => runOutboxWorkerTick(plugin, reason),
  }
}
