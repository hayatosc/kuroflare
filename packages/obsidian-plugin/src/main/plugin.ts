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
  type BlobManifest,
} from '@kuroflare/core'
import { VaultRelativePathSchema, isMetaFile, type MetaRepair } from '@kuroflare/core'
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
import { KuroflareSettingTab } from '../obsidian/settings-tab'
import {
  createSyncRuntimeIndexedDbLocalStoreEffectPort,
  createSyncRuntimeLocalStoreRebuildReplanPort,
  createVerifiedSyncRuntimeSetupPersistStepPort,
  createSyncRuntimeStartupStepEffectPort,
  type SyncRuntimeStartupStepEffectPort,
} from '../sync/engine/actuation'
import { createLocalSetupPersistIndexedDbMetadataPort } from '../sync/engine/persist'
import { isLocalSetupMetadata, type LocalSetupMetadata } from '../sync/engine/setup'
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
import { planInvalidMetaIsolationDetail } from '../sync/obsidian/invalid-meta-isolation'
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
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
  BINARY_UPLOAD_ORIGIN,
  REPAIR_ORIGIN,
  REPAIR_DEVICE,
  INVALID_META_DISCARD_CONFIRMATION,
  DEFAULT_SETTINGS,
} from './constants'
import { flushYTextToDisk, importFileTextIntoDocAndSend } from './editor'
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
  sameLocalSetupMetadata,
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
import { activateLoadedTextDoc, loadTextDoc, metaMap, replaceTextDoc } from './meta'
import { createFreshMetaDocForVaultSwitch } from './meta-namespace'
import { runOutboxWorkerTick } from './outbox'
import {
  blobHeadHashBatches,
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
  requestPendingRemoteTextFilesFromWorker,
  sendMetaDocToWorker,
  sendWorkerHello,
  waitForOutboundUpdates,
} from './sync-websocket'
import { sendDocUpdateToWorker } from './sync-websocket'

export default class KuroflareSpikePlugin extends Plugin {
  ydoc = new Y.Doc()
  ytext = this.ydoc.getText(SPIKE_TEXT_NAME)
  readonly cmCompartment = new Compartment()
  readonly lastMaterialized = new Map<string, LastMaterializedRecord>()
  readonly loadedTextDocs = new Map<string, LoadedTextDoc>()
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
  startupScannedMarkdownFiles: readonly TFile[] = []
  readonly pendingFsRenames = new Set<string>()
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
    if (
      isLocalSetupMetadata(this.kuroflareSettings.setupMetadata) &&
      this.kuroflareSettings.setupToken.trim().length === 0
    ) {
      this.kuroflareSettings = {
        ...this.kuroflareSettings,
        setupBootstrapMode: undefined,
      }
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
      this.metaPersistence = new IndexeddbPersistence(name, this.metaDoc)
      this.metaPersistenceName = name
      await this.metaPersistence.whenSynced
      for (const [fileId, value] of metaMap(this).entries()) {
        if (isMetaFile(value, fileId) && !value.deleted) {
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
    const setupMetadata = localSetupMetadataFromSetupResponse(response)
    this.trustedSetupMetadata = setupMetadata
    await this.updateSettings({
      endpoint: response.endpoint,
      setupVaultId: response.vaultId,
      setupToken: '',
      setupMetadata,
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
      await this.openMetaPersistence()
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
      if (
        !sameLocalSetupMetadata(
          this.kuroflareSettings.setupMetadata,
          metadataSnapshot.snapshot.setup,
        )
      ) {
        await this.updateSettings({
          setupMetadata: metadataSnapshot.snapshot.setup,
          setupBootstrapMode: undefined,
          setupToken: '',
        })
      }
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
    const setup = requireSetupMetadata(this)
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) throw new Error('snapshot-import-token-missing')
    const response = await fetch(this.snapshotImportUrl(setup, docId), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ updateBytesBase64: encodeBase64(updateBytes) }),
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
    const restorableBinaryFileIds = await this.findRestorableBinaryFileIdsForReconcile()
    const reconciled = reconcileMetaDoc(this.metaDoc.getMap<unknown>('meta'), {
      updatedAt: Date.now(),
      updatedBy: REPAIR_DEVICE,
      restorableBinaryFileIds,
      origin: REPAIR_ORIGIN,
    })
    await this.recordMetaRepairLog(reconciled.repairs, reconciled.invalidFileIds)
    await this.materializeMetaRenames()
    this.materializeMetaDeletes()
    await this.enqueueMissingRemoteBinaryDownloads('meta-reconcile')
  }

  private async findRestorableBinaryFileIdsForReconcile(): Promise<ReadonlySet<FileId>> {
    const setup = currentSetupMetadata(this)
    if (setup === undefined) return new Set()
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) return new Set()

    const restorable = new Set<FileId>()
    for (const [fileId, value] of metaMap(this).entries()) {
      if (!isMetaFile(value, fileId) || !value.deleted || value.type !== 'binary') continue
      const manifest = await this.fetchBlobManifestForMeta(setup, accessToken, value)
      if (
        manifest !== undefined &&
        (await this.remoteBlobChunksExist(setup, accessToken, manifest))
      ) {
        restorable.add(value.fileId)
      }
    }
    return restorable
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
    for (const [fileId, value] of metaMap(this).entries()) {
      if (!isMetaFile(value, fileId) || value.deleted || value.type !== 'binary') continue
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
        if (entry?.found !== true || (entry.size !== undefined && entry.size !== chunk.size)) {
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
              : `path-conflict:${repair.fileId}`,
          kind: 'action' in repair ? 'delete-vs-edit' : 'path-conflict',
          fileId: repair.fileId,
          path: 'toPath' in repair ? repair.toPath : undefined,
          reason:
            'action' in repair
              ? repair.action === 'keep-deleted'
                ? 'missing-binary-content'
                : 'concurrent-edit-after-delete'
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
    for (const [fileId, value] of metaMap(this).entries()) {
      if (!isMetaFile(value, fileId) || value.deleted) continue
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
    for (const [fileId, value] of metaMap(this).entries()) {
      if (!isMetaFile(value, fileId) || !value.deleted) continue
      if (this.activeFile?.path !== value.path) continue
      if (this.activeRemoteDeletedFileIds.has(value.fileId)) continue
      this.activeRemoteDeletedFileIds.add(value.fileId)
      this.syncStatusEl?.setText(`Kuroflare sync: remote tombstone ${value.path}`)
      new Notice('Kuroflare sync: active file was deleted remotely; local editor kept open')
    }
  }

  private async resolvePendingRemoteTextFile(loaded: LoadedTextDoc): Promise<void> {
    const path = this.pendingRemoteTextFiles.get(loaded.docId.ydocId)
    if (path === undefined) return
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
    const slash = path.lastIndexOf('/')
    if (slash !== -1) {
      const parts = path.slice(0, slash).split('/')
      let current = ''
      for (const part of parts) {
        current = current.length === 0 ? part : `${current}/${part}`
        if (this.app.vault.getAbstractFileByPath(current) === null) {
          try {
            await this.app.vault.createFolder(current)
          } catch {
            if (this.app.vault.getAbstractFileByPath(current) === null) {
              await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision')
              return
            }
          }
        } else if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
          await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision')
          return
        }
      }
    }
    const content = loaded.text.toJSON()
    await this.app.vault.create(path, content)
    const textHash = await hashCanonicalText(content)
    this.lastMaterialized.set(path, {
      diskHash: textHash,
      ydocHash: textHash,
      path,
      writtenAt: Date.now(),
    })
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
  }

  private async resolveJoinAdoptionHashCheck(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    const fileId = findActiveFileId(this, file.path)
    if (fileId === undefined) return

    const remoteContentHash = await hashCanonicalText(loaded.text.toJSON())
    const localContentHash = await hashCanonicalText(await this.app.vault.read(file))
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
    await importFileTextIntoDocAndSend(this, file, loaded.docId, 'join-adoption-hash-mismatch')
  }

  async handleWorkerSyncUpdate(message: SyncUpdate): Promise<void> {
    if (message.docId.kind === 'meta') {
      await this.reconcileAndMaterializeMeta()
      await bindActiveMarkdownView(this, 'meta-update')
      return
    }
    const loaded = await loadTextDoc(this, message.docId)
    await this.resolvePendingRemoteTextFile(loaded)
    if (sameDocId(message.docId, await activeDocId(this))) {
      await flushYTextToDisk(this, 'worker-update')
    }
  }

  async clearRepairLogEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: cleared ${entry.kind}`)
  }

  async retryPathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict') return
    await this.materializeMetaRenames()
    if (this.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN) {
      await openWorkerWebSocket(this)
    }
    await sendMetaDocToWorker(this, 'repair:path-conflict-retry')
    await waitForOutboundUpdates(this, 120_000)
    await this.removeRepairLogEntry(entry.id)
  }

  async retryKeepDeletedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'delete-vs-edit' || entry.reason !== 'missing-binary-content') return

    const current = metaMap(this).get(entry.fileId)
    if (!isMetaFile(current, entry.fileId) || !current.deleted || current.type !== 'binary') {
      await this.removeRepairLogEntry(entry.id)
      return
    }

    await this.reconcileAndMaterializeMeta()
    const reconciled = metaMap(this).get(entry.fileId)
    if (!isMetaFile(reconciled, entry.fileId) || reconciled.deleted) return
    await this.removeRepairLogEntry(entry.id)
  }

  async resolvePathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict') return
    const current = metaMap(this).get(entry.fileId)
    const plan = planPathConflictAutoResolve({
      entry,
      current,
      isPathAvailable: (path) => this.app.vault.getAbstractFileByPath(path) === null,
    })
    if (plan.action === 'rename-meta-path') {
      this.metaDoc.transact(() => {
        const value = metaMap(this).get(entry.fileId)
        if (!isMetaFile(value, entry.fileId)) return
        metaMap(this).set(entry.fileId, {
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
    const current = metaMap(this).get(entry.fileId)
    if (!isMetaFile(current, entry.fileId) || current.deleted) {
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
    const current = metaMap(this).get(entry.fileId)
    const plan = planRemoteMaterializeBlockedAutoResolve({
      entry,
      current,
      isPathAvailable: (path) => this.app.vault.getAbstractFileByPath(path) === null,
    })
    if (
      plan.action === 'rename-meta-path' &&
      isMetaFile(current, entry.fileId) &&
      !current.deleted &&
      current.type === 'text'
    ) {
      this.metaDoc.transact(() => {
        const value = metaMap(this).get(entry.fileId)
        if (!isMetaFile(value, entry.fileId)) return
        metaMap(this).set(entry.fileId, {
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
    if (confirmation.trim() !== INVALID_META_DISCARD_CONFIRMATION) return
    const current = metaMap(this).get(entry.fileId)
    if (current === undefined || isMetaFile(current, entry.fileId)) {
      if (this.invalidMetaIsolationDetail?.fileId === entry.fileId) {
        this.invalidMetaIsolationDetail = null
      }
      await this.removeRepairLogEntry(entry.id)
      return
    }
    this.metaDoc.transact(() => {
      metaMap(this).delete(entry.fileId)
    }, REPAIR_ORIGIN)
    if (this.invalidMetaIsolationDetail?.fileId === entry.fileId) {
      this.invalidMetaIsolationDetail = null
    }
    await this.removeRepairLogEntry(entry.id)
  }

  setStatus(status: string): void {
    this.statusEl?.setText(`Kuroflare: ${status}`)
  }
}
