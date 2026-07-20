import { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
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
import { Notice, Plugin, type EventRef, type TFile } from 'obsidian'
import type { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { LocalAwareness } from '../editor/awareness'
import { KuroflareSettingTab } from '../editor/settings-tab'
import { clearTextDeletionEvidenceRequest } from '../metadata/evidence'
import type { MetadataReconcilePort, MetadataReconcileWriteContext } from '../metadata/evidence'
import { enqueueMissingRemoteBinaryDownloads } from '../metadata/materialize'
import { materializeMetaRenames, type MetadataMaterializationPort } from '../metadata/materialize'
import { reconcileAndMaterializeMeta } from '../metadata/reconcile'
import type { DocumentEpochRecoveryHost } from '../recovery/epoch-startup'
import {
  createSyncRuntimeIndexedDbLocalStoreEffectPort,
  createSyncRuntimeLocalStoreRebuildReplanPort,
  createSyncRuntimeStartupStepEffectPort,
  type SyncRuntimeStartupStepEffectPort,
} from '../sync/engine/actuation'
import { type LocalSetupMetadata } from '../sync/engine/setup'
import { type VerifiedFullSnapshotBytes } from '../sync/engine/snapshot'
import {
  createSyncRuntimeObsidianComposition,
  type SyncRuntimeObsidianComposition,
} from '../sync/obsidian/composition'
import { createSyncRuntimeObsidianResumePort } from '../sync/obsidian/lifecycle'
import type { SyncRuntimeObsidianRepairPresentation } from '../sync/obsidian/presentation'
import {
  listPausedRejectedUpdates,
  repairPausedRejectedUpdate,
  type RejectedUpdateRepairResult,
} from '../sync/obsidian/rejected-repair'
import { createSyncRuntimeObsidianSetupExchangeEvidenceReader } from '../sync/obsidian/settings'
import { createEvidenceBackedHttpSyncRuntimeSetupExchangePort } from '../sync/setup-exchange-http'
import { createWorkerClient } from '../sync/api-client'
import { createBrowserLocalStoreIndexedDbFactoryPort } from '../sync/store/indexeddb'
import type { LocalStoreOutboxRecord } from '../sync/store/store'
import {
  createSyncRuntimeWebSocketSession,
  type SyncRuntimeWebSocketSessionPort,
} from '../sync/transport/socket'
import type { SyncRuntimeWebSocketStartupStepPort } from '../sync/transport/startup'
import type {
  KuroflareSettings,
  KuroflareInvalidMetaIsolationDetail,
  KuroflareBinaryRestoreCheckDetail,
  LoadedTextDoc,
  KuroflareRepairLogEntry,
  GenerationMarkerOwner,
  TextDocumentOwner,
} from '../types'
import {
  activeDocId,
  cancelAuthRefreshStartupRetry,
  currentSetupDeviceId,
  currentSetupMetadata,
  readAccessToken,
  requireSetupMetadata,
} from './auth'
import { createStartupSideEffectGate } from './boot'
import {
  SPIKE_TEXT_NAME,
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
  BINARY_UPLOAD_ORIGIN,
  REPAIR_ORIGIN,
  DEFAULT_SETTINGS,
} from './constants'
import { flushYTextToDisk } from './editor'
import {
  registerCommands,
  registerWorkspaceEvents,
  registerVaultWatcher,
  bindActiveMarkdownView,
} from './editor'
import { handleLifecycleResume } from './editor'
import {
  adoptLocalFilesAfterRemoteMeta,
  createLocalMetaYDocFromStartupScan,
  requestMissingRemoteTextFile,
  scanLocalVaultForStartup,
} from './files'
import { registerFileTreeWatcher } from './files'
import { deferStartupReplan } from './guards'
import { accessTokenSecretKeyForSetup, safeLogError, sameDocId } from './helpers'
import { resolveJoinAdoptionHashCheck, resolvePendingRemoteTextFile } from './materialize'
import {
  establishInitialDocumentEpoch,
  loadTextDoc,
  insertMetaFile,
  metaMap,
  metadataWritesEnabled,
  readMetaFile,
  prepareDocumentProvider,
  updateMetaFile,
} from './meta'
import { prepareMetadataAfterHello, startMetadataMigrationAfterHello } from './meta-migration'
import { runOutboxWorkerTick } from './outbox/tick'
import {
  clearRepairLogEntry as clearRepairLogEntryCommand,
  discardInvalidMetaRepairEntry as discardInvalidMetaRepairEntryCommand,
  inspectInvalidMetaRepairEntry as inspectInvalidMetaRepairEntryCommand,
  resolvePathConflictRepairEntry as resolvePathConflictRepairEntryCommand,
  resolveRemoteMaterializeBlockedRepairEntry as resolveRemoteMaterializeBlockedRepairEntryCommand,
  retryKeepDeletedRepairEntry as retryKeepDeletedRepairEntryCommand,
  retryPathConflictRepairEntry as retryPathConflictRepairEntryCommand,
  retryRemoteMaterializeBlockedRepairEntry as retryRemoteMaterializeBlockedRepairEntryCommand,
  type RepairCommandsPort,
} from './repair'
import {
  applyLatestSnapshot,
  fetchLatestSnapshotPayload,
  publishInitialFileSnapshots,
  publishLocalMetaSnapshot,
  recoverFromNeedFullSnapshot,
} from './snapshot'
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
} from './socket'
import { sendDocUpdateToWorker } from './socket'
import { openLocalStoreDatabase, putOutboxRecords, readOutboxWorkerSnapshot } from './store'
import {
  captureVaultOperationContext as captureVaultOperationContextLifecycle,
  clearLoadedTextDocsForVaultTransition,
  createDocumentEpochRecoveryHost as createDocumentEpochRecoveryHostLifecycle,
  enqueueSettingsWrite,
  loadIndexedDbYDocs as loadIndexedDbYDocsLifecycle,
  loadVaultSettings,
  loadedTextDocStillCurrent as loadedTextDocStillCurrentLifecycle,
  metadataReconcileTransitionPending as metadataReconcileTransitionPendingLifecycle,
  openMetaPersistence as openMetaPersistenceLifecycle,
  persistPendingSetupResponse as persistPendingSetupResponseLifecycle,
  readLocalEvidence as readLocalEvidenceLifecycle,
  replaceMetaDoc as replaceMetaDocLifecycle,
  stagePendingSetupResponse as stagePendingSetupResponseLifecycle,
  updateVaultSettings,
  vaultOperationStillCurrent as vaultOperationStillCurrentLifecycle,
} from './vault'

export default class KuroflareSpikePlugin extends Plugin {
  ydoc = new Y.Doc()
  ytext = this.ydoc.getText(SPIKE_TEXT_NAME)
  /** Presence for the active editor binding, broadcast to peers (see docs/spec/operations.md §4). */
  readonly awareness = new LocalAwareness()
  readonly cmCompartment = new Compartment()
  readonly lastMaterialized = new Map<string, LastMaterializedRecord>()
  readonly loadedTextDocs = new Map<string, LoadedTextDoc>()
  readonly loadingTextDocs = new Map<string, Promise<LoadedTextDoc>>()
  /** Documents whose provider evidence requires guarded epoch recovery before startup resumes. */
  readonly documentRecoveryRequired = new Set<string>()
  readonly documentRecoveryHydrating = new Set<string>()
  readonly documentReplacementInProgress = new Set<string>()
  /** Documents currently running automatic NeedFullSnapshot fetch+apply recovery. */
  readonly needFullSnapshotRecoveryInProgress = new Set<string>()
  readonly needFullSnapshotRecoveryOwners = new Map<string, object>()
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
  outboxWorkerCompletionPromise: Promise<void> | null = null
  outboxWorkerRetryTimeout: number | null = null
  authRefreshRunning = false
  authRefreshCompletionPromise: Promise<void> | null = null
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
  metadataReconcileRetryTimeout: number | null = null
  metadataVaultGeneration = 0
  settingsWritePromise: Promise<void> | null = null
  metadataSetupStagingCount = 0
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
  readonly materializedPathOwners = new Map<FileId, GenerationMarkerOwner>()
  readonly pendingRemoteTextFiles = new Map<string, string>()
  readonly pendingRemoteTextFileOwners = new Map<string, GenerationMarkerOwner>()
  readonly remoteTextMaterializationOperations = new Set<Promise<void>>()
  readonly pendingTextDeletionEvidenceRequests = new Map<string, number>()
  readonly pendingTextDeletionEvidenceRetryTimers = new Map<string, number>()
  startupScannedMarkdownFiles: readonly TFile[] = []
  readonly pendingFsRenames = new Set<string>()
  readonly pendingFsDeletes = new Set<string>()
  readonly binaryMaterializationOwners = new Map<string, object>()
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
    if (this.metadataReconcileRetryTimeout !== null) {
      window.clearTimeout(this.metadataReconcileRetryTimeout)
      this.metadataReconcileRetryTimeout = null
    }
    cancelAuthRefreshStartupRetry(this)
    this.metaDoc.destroy()
  }

  async updateSettings(patch: Partial<KuroflareSettings>): Promise<void> {
    await updateVaultSettings(this, patch)
  }

  private async loadSettings(): Promise<void> {
    await loadVaultSettings(this)
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
      http: createWorkerClient(setup.endpoint),
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

  scheduleMetadataReconcileRetry(): void {
    if (this.metadataReconcileRetryTimeout !== null) return
    if (this.metadataReconcileTransitionPending()) return
    const setup = currentSetupMetadata(this)
    if (setup === undefined) return
    const capturedGeneration = this.metadataVaultGeneration
    const capturedVaultId = setup.vaultId
    const capturedMetaDoc = this.metaDoc
    this.metadataReconcileRetryTimeout = window.setTimeout(() => {
      this.metadataReconcileRetryTimeout = null
      if (
        !this.startupSideEffectGate.canSendNetwork() ||
        this.metadataReconcileTransitionPending() ||
        this.metadataVaultGeneration !== capturedGeneration ||
        this.metaDoc !== capturedMetaDoc ||
        currentSetupMetadata(this)?.vaultId !== capturedVaultId
      ) {
        return
      }
      void reconcileAndMaterializeMeta(
        metadataReconcilePort(this),
        metadataMaterializationPort(this),
      )
    }, 0)
  }

  async updateMetadataReconcileSettings(
    update: (current: KuroflareSettings) => Partial<KuroflareSettings>,
    context: MetadataReconcileWriteContext,
  ): Promise<boolean> {
    return this.enqueueSettingsWrite(async () => {
      if (!metadataReconcileWriteContextStillStable(this, context)) return false
      const previousRepairLog = this.kuroflareSettings.repairLog
      const patch = update(this.kuroflareSettings)
      const next = { ...this.kuroflareSettings, ...patch }
      this.kuroflareSettings = next
      await this.saveData(next)
      if (metadataReconcileWriteContextStillStable(this, context)) return true
      if (this.kuroflareSettings.repairLog === next.repairLog) {
        const rolledBack = { ...this.kuroflareSettings, repairLog: previousRepairLog }
        this.kuroflareSettings = rolledBack
        await this.saveData(rolledBack)
      }
      return false
    })
  }

  private async enqueueSettingsWrite<Result>(operation: () => Promise<Result>): Promise<Result> {
    return enqueueSettingsWrite(this, operation)
  }

  async stagePendingSetupResponse(response: SetupExchangeResponse): Promise<void> {
    await stagePendingSetupResponseLifecycle(this, response)
  }

  metadataReconcileTransitionPending(): boolean {
    return metadataReconcileTransitionPendingLifecycle(this)
  }

  captureTextDocumentOwner(): TextDocumentOwner | undefined {
    return this.captureVaultOperationContext()
  }

  captureVaultOperationContext(): TextDocumentOwner | undefined {
    return captureVaultOperationContextLifecycle(this)
  }

  textDocumentOwnerStillCurrent(owner: TextDocumentOwner): boolean {
    return this.vaultOperationStillCurrent(owner)
  }

  vaultOperationStillCurrent(owner: TextDocumentOwner): boolean {
    return vaultOperationStillCurrentLifecycle(this, owner)
  }

  loadedTextDocStillCurrent(loaded: LoadedTextDoc, owner: TextDocumentOwner): boolean {
    return loadedTextDocStillCurrentLifecycle(this, loaded, owner)
  }

  private clearLoadedTextDocsForVaultTransition(): Promise<void> {
    return clearLoadedTextDocsForVaultTransition(this)
  }

  attachMetaDocObservers(): void {
    this.metaDoc.on('afterTransaction', (transaction: Y.Transaction) => {
      if (
        transaction.origin === REPAIR_ORIGIN ||
        transaction.origin === WORKER_ORIGIN ||
        transaction.origin === BINARY_UPLOAD_ORIGIN
      ) {
        return
      }
      if (!this.startupSideEffectGate.canSendNetwork()) return
      if (this.metadataReconcileTransitionPending()) return
      void reconcileAndMaterializeMeta(
        metadataReconcilePort(this),
        metadataMaterializationPort(this),
      )
    })
    this.metaDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === WORKER_ORIGIN || origin === BINARY_UPLOAD_ORIGIN) return
      const context = this.captureVaultOperationContext()
      const observedMetaDoc = this.metaDoc
      if (context === undefined) return
      void sendDocUpdateToWorker(
        this,
        META_SYNC_DOC_ID,
        update,
        'meta-update',
        () => this.vaultOperationStillCurrent(context) && this.metaDoc === observedMetaDoc,
      )
    })
  }

  private async removeRepairLogEntry(
    entryId: string,
    context: MetadataReconcileWriteContext,
  ): Promise<boolean> {
    return this.updateMetadataReconcileSettings(
      (current) => ({
        repairLog: (current.repairLog ?? []).filter((entry) => entry.id !== entryId),
      }),
      context,
    )
  }

  private async openMetaPersistence(): Promise<void> {
    await openMetaPersistenceLifecycle(this)
  }

  private async replaceMetaDoc(
    updateBytes: Uint8Array,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    await replaceMetaDocLifecycle(this, updateBytes, isCurrent)
  }

  async prepareMetadataAfterHello(): Promise<void> {
    await prepareMetadataAfterHello(this)
  }

  startMetadataMigrationAfterHello(): Promise<void> {
    return startMetadataMigrationAfterHello(this)
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
      readEvidence: (effect) => setupEvidenceReader.readEvidence(effect),
      scheduleReplan: async (request) => {
        await this.stagePendingSetupResponse(request.response)
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
    await persistPendingSetupResponseLifecycle(this)
  }

  private async readLocalEvidence() {
    return await readLocalEvidenceLifecycle(this)
  }

  openLocalStoreDatabase(
    vaultId: LocalSetupMetadata['vaultId'],
    isCurrent: () => boolean = () => true,
  ): Promise<IDBDatabase> {
    return openLocalStoreDatabase(this, vaultId, isCurrent)
  }

  loadTextDocument(docId: Extract<DocId, { readonly kind: 'file' }>): Promise<LoadedTextDoc> {
    return loadTextDoc(this, docId)
  }

  prepareDocumentProvider(
    docId: DocId,
    providerDbName: string,
  ): Promise<Awaited<ReturnType<typeof prepareDocumentProvider>>> {
    return prepareDocumentProvider(this, docId, providerDbName)
  }

  establishInitialDocumentEpoch(docId: DocId, providerDbName: string): Promise<void> {
    return establishInitialDocumentEpoch(this, docId, providerDbName)
  }

  readAccessToken(setup: LocalSetupMetadata): Promise<string | undefined> {
    return readAccessToken(this, accessTokenSecretKeyForSetup(setup))
  }

  createDocumentEpochRecoveryHost(
    isCurrent: () => boolean = () => true,
  ): DocumentEpochRecoveryHost {
    return createDocumentEpochRecoveryHostLifecycle(this, isCurrent)
  }

  private async loadIndexedDbYDocs(vaultId?: LocalSetupMetadata['vaultId']): Promise<void> {
    await loadIndexedDbYDocsLifecycle(this, vaultId)
  }

  private async publishLocalMetaSnapshot(reason: string): Promise<void> {
    await publishLocalMetaSnapshot(this, reason)
  }

  private async publishInitialFileSnapshots(reason: string): Promise<void> {
    await publishInitialFileSnapshots(this, reason)
  }

  private async fetchLatestSnapshotPayload(
    docId: DocId,
    reason: string,
    isCurrent: () => boolean = () => true,
  ): Promise<{
    readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
    readonly verifiedBytes: VerifiedFullSnapshotBytes
  } | null> {
    return fetchLatestSnapshotPayload(this, docId, reason, isCurrent)
  }

  private async applyLatestSnapshot(
    docId: DocId,
    snapshot: {
      readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
      readonly verifiedBytes: VerifiedFullSnapshotBytes
    },
    reason: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    await applyLatestSnapshot(this, docId, snapshot, reason, isCurrent)
  }

  async recoverFromNeedFullSnapshot(docId: DocId, reason: NeedFullSnapshotReason): Promise<void> {
    await recoverFromNeedFullSnapshot(this, docId, reason)
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

  resolvePendingRemoteTextFile(loaded: LoadedTextDoc): Promise<void> {
    return resolvePendingRemoteTextFile(this, loaded)
  }

  async resolveJoinAdoptionHashCheck(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    await resolveJoinAdoptionHashCheck(this, file, loaded)
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
    const owner = { vaultId: loaded.vaultId, generation: loaded.vaultGeneration }
    const isCurrent = () => this.loadedTextDocStillCurrent(loaded, owner)
    if (!isCurrent()) return
    clearTextDeletionEvidenceRequest(metadataReconcilePort(this), message.docId.ydocId)
    await this.resolvePendingRemoteTextFile(loaded)
    if (!isCurrent()) return
    await reconcileAndMaterializeMeta(
      metadataReconcilePort(this),
      metadataMaterializationPort(this),
    )
    if (!isCurrent()) return
    if (sameDocId(message.docId, await activeDocId(this))) {
      if (!isCurrent()) return
      await flushYTextToDisk(this, 'worker-update')
    }
  }

  async clearRepairLogEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await clearRepairLogEntryCommand(entry, repairCommandsPort(this))
  }

  async retryPathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await retryPathConflictRepairEntryCommand(entry, repairCommandsPort(this))
  }

  async retryKeepDeletedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await retryKeepDeletedRepairEntryCommand(entry, repairCommandsPort(this))
  }

  async resolvePathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await resolvePathConflictRepairEntryCommand(entry, repairCommandsPort(this))
  }

  async retryRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await retryRemoteMaterializeBlockedRepairEntryCommand(entry, repairCommandsPort(this))
  }

  async resolveRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await resolveRemoteMaterializeBlockedRepairEntryCommand(entry, repairCommandsPort(this))
  }

  async inspectInvalidMetaRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await inspectInvalidMetaRepairEntryCommand(entry, repairCommandsPort(this))
  }

  async discardInvalidMetaRepairEntry(
    entry: KuroflareRepairLogEntry,
    confirmation: string,
  ): Promise<void> {
    await discardInvalidMetaRepairEntryCommand(entry, confirmation, repairCommandsPort(this))
    return
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

function repairCommandsPort(plugin: KuroflareSpikePlugin): RepairCommandsPort {
  return {
    captureContext: () => {
      if (plugin.metadataReconcileTransitionPending()) return undefined
      const setup = currentSetupMetadata(plugin)
      if (setup === undefined || !plugin.startupSideEffectGate.canSendNetwork()) {
        return undefined
      }
      return {
        metaDoc: plugin.metaDoc,
        generation: plugin.metadataVaultGeneration,
        vaultId: setup.vaultId,
      }
    },
    contextStillStable: (context) => metadataReconcileWriteContextStillStable(plugin, context),
    metadataWritesEnabled: () => metadataWritesEnabled(plugin),
    metadataReconcileTransitionPending: () => plugin.metadataReconcileTransitionPending(),
    metadataMaterializationPort: () => metadataMaterializationPort(plugin),
    metadataReconcilePort: () => metadataReconcilePort(plugin),
    getMetaValue: (fileId) => metaMap(plugin).get(fileId),
    getMetaEntry: (fileId) => readMetaFile(metaMap(plugin), fileId),
    getMetadataAccess: () => plugin.metadataAccess,
    isPathAvailable: (path) => plugin.app.vault.getAbstractFileByPath(path) === null,
    materializeMetaRenames,
    reconcileAndMaterializeMeta,
    requestMissingRemoteTextFile: (value) => requestMissingRemoteTextFile(plugin, value),
    enqueueMissingRemoteBinaryDownloads: (reconcile, materialize, reason) =>
      enqueueMissingRemoteBinaryDownloads(reconcile, materialize, reason),
    websocketReadyState: () => plugin.workerWebSocketSession.snapshot().readyState ?? -1,
    openWorkerWebSocket: () => openWorkerWebSocket(plugin),
    waitForOutboundUpdates: (timeoutMs) => waitForOutboundUpdates(plugin, timeoutMs),
    removeRepairLogEntry: (entryId, context) =>
      plugin.updateMetadataReconcileSettings(
        (current) => ({
          repairLog: (current.repairLog ?? []).filter((entry) => entry.id !== entryId),
        }),
        context,
      ),
    notify: (message) => new Notice(message),
    getInvalidMetaIsolationDetail: () => plugin.invalidMetaIsolationDetail,
    setInvalidMetaIsolationDetail: (detail) => {
      plugin.invalidMetaIsolationDetail = detail
    },
  }
}

function metadataReconcilePort(plugin: KuroflareSpikePlugin): MetadataReconcilePort {
  return {
    canSendNetwork: () => plugin.startupSideEffectGate.canSendNetwork(),
    scheduleReconcileRetry: () => plugin.scheduleMetadataReconcileRetry(),
    getVaultGeneration: () => plugin.metadataVaultGeneration,
    isVaultTransitionPending: () => plugin.metadataReconcileTransitionPending(),
    getMetaDoc: () => plugin.metaDoc,
    getMetadataAccess: () => plugin.metadataAccess,
    loadedTextDocs: plugin.loadedTextDocs,
    pendingTextDeletionEvidenceRequests: plugin.pendingTextDeletionEvidenceRequests,
    pendingTextDeletionEvidenceRetryTimers: plugin.pendingTextDeletionEvidenceRetryTimers,
    loadTextDoc: (ydocId) => loadTextDoc(plugin, { kind: 'file', ydocId }),
    requestDocFromWorker: (loaded, stateVector, reason) => {
      const owner = { vaultId: loaded.vaultId, generation: loaded.vaultGeneration }
      return requestDocFromWorker(plugin, loaded.docId, stateVector, reason, () =>
        plugin.loadedTextDocStillCurrent(loaded, owner),
      )
    },
    getSettings: () => plugin.kuroflareSettings,
    updateSettings: (patch, context) => plugin.updateMetadataReconcileSettings(patch, context),
    currentSetup: () => currentSetupMetadata(plugin),
    readAccessToken: (setup) => readAccessToken(plugin, accessTokenSecretKeyForSetup(setup)),
    setBinaryRestoreCheckDetail: (detail) => {
      plugin.binaryRestoreCheckDetail = detail
    },
  }
}

export function metadataReconcileWriteContextStillStable(
  plugin: KuroflareSpikePlugin,
  context: MetadataReconcileWriteContext,
): boolean {
  return (
    !plugin.metadataReconcileTransitionPending() &&
    plugin.metaDoc === context.metaDoc &&
    plugin.metadataVaultGeneration === context.generation &&
    currentSetupMetadata(plugin)?.vaultId === context.vaultId &&
    plugin.startupSideEffectGate.canSendNetwork()
  )
}

function metadataMaterializationPort(plugin: KuroflareSpikePlugin): MetadataMaterializationPort {
  return {
    getMetaDoc: () => plugin.metaDoc,
    getVaultGeneration: () => plugin.metadataVaultGeneration,
    isVaultTransitionPending: () => plugin.metadataReconcileTransitionPending(),
    getVaultId: () => currentSetupMetadata(plugin)?.vaultId,
    vault: plugin.app.vault,
    fileManager: plugin.app.fileManager,
    lastMaterialized: plugin.lastMaterialized,
    materializedPaths: plugin.materializedPaths,
    materializedPathOwners: plugin.materializedPathOwners,
    pendingRemoteTextFiles: plugin.pendingRemoteTextFiles,
    pendingRemoteTextFileOwners: plugin.pendingRemoteTextFileOwners,
    pendingFsRenames: plugin.pendingFsRenames,
    activeRemoteDeletedFileIds: plugin.activeRemoteDeletedFileIds,
    getActiveFile: () => plugin.activeFile,
    setSyncStatusText: (text) => plugin.syncStatusEl?.setText(text),
    notify: (message) => new Notice(message),
    clearTextDeletionEvidenceRequest: (docId) =>
      clearTextDeletionEvidenceRequest(metadataReconcilePort(plugin), docId),
    requestMissingRemoteTextFile: (value) => requestMissingRemoteTextFile(plugin, value),
    openLocalStoreDatabase: (vaultId, isCurrent) =>
      openLocalStoreDatabase(plugin, vaultId, isCurrent),
    readOutboxWorkerSnapshot: (db) => readOutboxWorkerSnapshot(db),
    putOutboxRecords: (db, records) => putOutboxRecords(db, records),
    runOutboxWorkerTick: (reason) => runOutboxWorkerTick(plugin, reason),
  }
}
