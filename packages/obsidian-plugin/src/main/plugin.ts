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
import type { IndexeddbPersistence } from 'y-indexeddb'
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
  GenerationMarkerOwner,
  TextDocumentOwner,
} from '../main-types'
import { enqueueMissingRemoteBinaryDownloads } from '../plugin/metadata-binary-restore'
import {
  materializeMetaRenames,
  type MetadataMaterializationPort,
} from '../plugin/metadata-materialization'
import {
  reconcileAndMaterializeMeta,
  type MetadataReconcilePort,
  type MetadataReconcileWriteContext,
} from '../plugin/metadata-reconcile'
import { clearTextDeletionEvidenceRequest } from '../plugin/metadata-text-evidence'
import { documentEpochMetadataKey } from '../recovery/epoch'
import type { DocumentEpochRecoveryHost } from '../recovery/epoch-startup'
import {
  createSyncRuntimeIndexedDbLocalStoreEffectPort,
  createSyncRuntimeLocalStoreRebuildReplanPort,
  createSyncRuntimeStartupStepEffectPort,
  type SyncRuntimeStartupStepEffectPort,
} from '../sync/engine/actuation'
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
import { createSyncRuntimeObsidianSetupExchangeEvidenceReader } from '../sync/obsidian/settings'
import { createEvidenceBackedHttpSyncRuntimeSetupExchangePort } from '../sync/setup-exchange-http'
import { createBrowserLocalStoreIndexedDbFactoryPort } from '../sync/store/indexeddb'
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
  accessTokenSecretKeyForSetup,
  encodeBase64,
  mergeRepairLogEntries,
  safeLogError,
  sameDocId,
  hasPendingRunnableOutboxUpdate,
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
import { runOutboxWorkerTick } from './outbox/tick'
import { claimOwnedPathMarker, clearOwnedPathMarker, deferStartupReplan } from './runtime-guards'
import {
  openLocalStoreDatabase,
  putOutboxRecords,
  readOutboxWorkerSnapshot,
  readRemoteCursorSeq,
} from './store'
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
} from './vault-lifecycle'

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

  private async recordRemoteMaterializeBlocked(
    loaded: LoadedTextDoc,
    path: string,
    reason: 'invalid-path' | 'path-collision' | 'parent-collision',
    context: MetadataReconcileWriteContext,
  ): Promise<void> {
    if (!metadataReconcileWriteContextStillStable(this, context)) return
    const fileId = findMetaFileIdForDoc(this, loaded.docId)
    const entry: KuroflareRepairLogEntry = {
      id: `remote-materialize-blocked:${loaded.docId.ydocId}:${reason}`,
      kind: 'remote-materialize-blocked',
      fileId: fileId ?? loaded.docId.ydocId,
      path,
      reason,
      createdAt: Date.now(),
    }
    await this.updateMetadataReconcileSettings(
      (current) => ({
        repairLog: mergeRepairLogEntries(current.repairLog ?? [], [entry]),
      }),
      context,
    )
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

  /** Performs the legacy-to-v2 transition through the snapshot-import CAS endpoint. */
  async prepareMetadataAfterHello(): Promise<void> {
    const context = this.captureVaultOperationContext()
    const migrationMetaDoc = this.metaDoc
    if (context === undefined) return
    const isCurrent = () =>
      this.vaultOperationStillCurrent(context) && this.metaDoc === migrationMetaDoc
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
      latest = await this.fetchLatestSnapshotPayload(
        META_SYNC_DOC_ID,
        'metadata-migration',
        isCurrent,
      )
      if (!isCurrent()) return
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = new Y.Doc()
        try {
          if (latest !== null) {
            Y.applyUpdate(candidate, latest.verifiedBytes.updateBytes)
            const candidateRoot = candidate.getMap<unknown>('meta')
            if (shouldAdoptRemoteMetadata(this.metaDoc, candidate)) {
              this.metadataMigrationPending = false
              await this.replaceMetaDoc(latest.verifiedBytes.updateBytes, isCurrent)
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
          if (!isCurrent()) return
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
          if (!isCurrent()) return
          if (response.ok) {
            this.metadataMigrationPending = false
            await this.replaceMetaDoc(Y.encodeStateAsUpdate(candidate), isCurrent)
            return
          }
          if (response.status !== 409) break
          latest = await this.fetchLatestSnapshotPayload(
            META_SYNC_DOC_ID,
            'metadata-migration-retry',
            isCurrent,
          )
          if (!isCurrent()) return
        } finally {
          candidate.destroy()
        }
      }
    } catch (error: unknown) {
      if (!isCurrent()) return
      console.warn('[kuroflare] metadata migration CAS failed', { error: safeLogError(error) })
    }
    if (!isCurrent()) return
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
    await this.importLocalSnapshot(META_SYNC_DOC_ID, Y.encodeStateAsUpdate(this.metaDoc), reason)
  }

  private async publishInitialFileSnapshots(reason: string): Promise<void> {
    for (const loaded of this.loadedTextDocs.values()) {
      const owner = { vaultId: loaded.vaultId, generation: loaded.vaultGeneration }
      const isCurrent = () => this.loadedTextDocStillCurrent(loaded, owner)
      if (!isCurrent()) return
      await this.importLocalSnapshot(
        loaded.docId,
        Y.encodeStateAsUpdate(loaded.doc),
        reason,
        isCurrent,
      )
    }
  }

  private async importLocalSnapshot(
    docId: DocId,
    updateBytes: Uint8Array,
    reason: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (!isCurrent()) return
    if (docId.kind === 'meta' && !metadataWritesEnabled(this)) return
    const setup = requireSetupMetadata(this)
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (!isCurrent()) return
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
    if (!isCurrent()) return
    if (!response.ok) {
      console.warn('[kuroflare] local snapshot import failed', {
        status: response.status,
        docId,
        reason,
      })
      throw new Error('snapshot-import-http-failed')
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!isCurrent()) return
    if (!v.is(SnapshotImportResponseSchema, body)) {
      throw new Error('snapshot-import-response-invalid')
    }
  }

  private async fetchLatestSnapshotPayload(
    docId: DocId,
    reason: string,
    isCurrent: () => boolean = () => true,
  ): Promise<{
    readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
    readonly verifiedBytes: VerifiedFullSnapshotBytes
  } | null> {
    if (!isCurrent()) return null
    const setup = requireSetupMetadata(this)
    const accessToken = await readAccessToken(this, accessTokenSecretKeyForSetup(setup))
    if (!isCurrent()) return null
    if (accessToken === undefined) return null
    const response = await fetch(this.latestSnapshotUrl(setup, docId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!isCurrent()) return null
    if (!response.ok) {
      console.warn('[kuroflare] latest snapshot fetch failed', {
        status: response.status,
        reason,
        docId,
      })
      return null
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!isCurrent()) return null
    const schema =
      docId.kind === 'meta' ? MetaLatestSnapshotResponseSchema : DocLatestSnapshotResponseSchema
    if (!v.is(schema, body)) return null
    const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
    if (!isCurrent()) return null
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
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (!isCurrent()) return
    const setup = requireSetupMetadata(this)
    const db = await openLocalStoreDatabase(this, setup.vaultId, isCurrent)
    if (!isCurrent()) return
    const localStore = await readOutboxWorkerSnapshot(db)
    if (!isCurrent()) return
    const currentSnapshotSeq = await readRemoteCursorSeq(db, docId)
    if (!isCurrent()) return
    const activeEditorBound = docId.kind === 'file' && sameDocId(docId, await activeDocId(this))
    if (!isCurrent()) return
    const plan = planFullSnapshotApplyRuntime({
      requestedDocId: docId,
      response: snapshot.response,
      verifiedBytes: snapshot.verifiedBytes,
      currentSnapshotSeq,
      hasPendingLocalUpdates: hasPendingRunnableOutboxUpdate(localStore.outboxRecords, docId),
      activeEditorBound,
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
    const cursorSeqBeforeCommit = await readRemoteCursorSeq(db, docId)
    if (!isCurrent()) return
    if (cursorSeqBeforeCommit !== currentSnapshotSeq) {
      throw new Error('latest-snapshot-apply:wait:remote-cursor-advanced')
    }
    const committed = await commitFullSnapshotApplyIndexedDbTransaction({
      database: createFullSnapshotApplyIndexedDbDatabasePort(db),
      transaction: plan.indexedDbWriteTransaction,
      remoteCursorCas: { expectedRemoteCursorSeq: currentSnapshotSeq },
    })
    if (!committed) throw new Error('latest-snapshot-apply:wait:remote-cursor-advanced')
    if (!isCurrent()) return
    if (docId.kind === 'meta') {
      await this.replaceMetaDoc(plan.updateBytes, isCurrent)
      return
    }
    const wasActiveTextDoc = this.activeTextDoc?.docId.ydocId === docId.ydocId
    const loaded = await replaceTextDoc(this, docId, plan.updateBytes, WORKER_ORIGIN)
    if (!isCurrent()) return
    if (wasActiveTextDoc) {
      activateLoadedTextDoc(this, loaded)
    }
    await this.resolvePendingRemoteTextFile(loaded)
    if (!isCurrent()) return
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
    const initialContext = this.captureVaultOperationContext()
    if (initialContext === undefined) return
    let context: TextDocumentOwner = initialContext
    const isCurrent = () => this.vaultOperationStillCurrent(context)
    const epochKey = documentEpochMetadataKey(docId)
    if (
      this.needFullSnapshotRecoveryInProgress.has(epochKey) ||
      this.documentRecoveryRequired.has(epochKey) ||
      this.documentReplacementInProgress.has(epochKey)
    ) {
      return
    }
    const owner = {}
    this.needFullSnapshotRecoveryInProgress.add(epochKey)
    this.needFullSnapshotRecoveryOwners.set(epochKey, owner)
    this.documentReplacementInProgress.add(epochKey)
    try {
      const result = await runNeedFullSnapshotRecovery(
        {
          fetchSnapshot: async () => {
            if (!isCurrent()) return null
            return await this.fetchLatestSnapshotPayload(
              docId,
              `need-full-snapshot:${reason}`,
              isCurrent,
            )
          },
          applySnapshot: async (payload) => {
            if (!isCurrent()) return false
            try {
              await this.applyLatestSnapshot(
                docId,
                payload,
                `need-full-snapshot:${reason}`,
                isCurrent,
              )
              if (
                docId.kind === 'meta' &&
                this.pendingSetupResponse === null &&
                currentSetupMetadata(this)?.vaultId === context.vaultId
              ) {
                context = { ...context, generation: this.metadataVaultGeneration }
              }
              return isCurrent()
            } catch (error: unknown) {
              console.warn('[kuroflare] need-full-snapshot auto-recovery apply attempt failed', {
                docId,
                reason,
                error: safeLogError(error),
              })
              return false
            }
          },
          wait: async (delayMs) => {
            await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
          },
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
      if (this.needFullSnapshotRecoveryOwners.get(epochKey) === owner) {
        this.needFullSnapshotRecoveryOwners.delete(epochKey)
        this.needFullSnapshotRecoveryInProgress.delete(epochKey)
      }
      this.documentReplacementInProgress.delete(epochKey)
    }
    if (isCurrent()) {
      const recoveredDoc =
        docId.kind === 'meta' ? this.metaDoc : this.loadedTextDocs.get(docId.ydocId)?.doc
      if (recoveredDoc !== undefined) {
        await requestDocFromWorker(
          this,
          docId,
          Y.encodeStateVector(recoveredDoc),
          'need-full-snapshot:post-recovery-catch-up',
          isCurrent,
        )
      }
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

  resolvePendingRemoteTextFile(loaded: LoadedTextDoc): Promise<void> {
    const operation = this.resolvePendingRemoteTextFileOperation(loaded)
    this.remoteTextMaterializationOperations.add(operation)
    void operation.then(
      () => this.remoteTextMaterializationOperations.delete(operation),
      () => this.remoteTextMaterializationOperations.delete(operation),
    )
    return operation
  }

  private async resolvePendingRemoteTextFileOperation(loaded: LoadedTextDoc): Promise<void> {
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    if (!this.loadedTextDocMatchesMetadataContext(loaded, context)) return
    const path = this.pendingRemoteTextFiles.get(loaded.docId.ydocId)
    if (path === undefined) return
    if (!metadataReconcileWriteContextStillStable(this, context)) return
    const markerOwner = claimOwnedPathMarker(
      this.pendingRemoteTextFiles,
      this.pendingRemoteTextFileOwners,
      loaded.docId.ydocId,
      path,
      this.metadataVaultGeneration,
    )
    if (markerOwner === undefined) return
    if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      return
    }
    if (!v.is(VaultRelativePathSchema, path)) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'invalid-path', context)
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      return
    }
    const existing = this.app.vault.getAbstractFileByPath(path)
    if (existing instanceof TFile) {
      await this.resolveJoinAdoptionHashCheck(existing, loaded)
      return
    }
    if (existing !== null) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision', context)
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
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
          if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
            this.clearPendingRemoteTextFile(loaded, path, markerOwner)
            return
          }
          try {
            await this.app.vault.createFolder(current)
            createdFolders.push(current)
            if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
              this.clearPendingRemoteTextFile(loaded, path, markerOwner)
              await this.cleanupRemoteMaterializeFolders(createdFolders)
              return
            }
          } catch {
            const existingFolder = this.app.vault.getAbstractFileByPath(current)
            if (!(existingFolder instanceof TFolder)) {
              await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision', context)
              this.clearPendingRemoteTextFile(loaded, path, markerOwner)
              await this.cleanupRemoteMaterializeFolders(createdFolders)
              return
            }
            if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
              this.clearPendingRemoteTextFile(loaded, path, markerOwner)
              await this.cleanupRemoteMaterializeFolders(createdFolders)
              return
            }
          }
        } else if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
          await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision', context)
          this.clearPendingRemoteTextFile(loaded, path, markerOwner)
          return
        }
      }
    }
    if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }
    const content = loaded.text.toJSON()
    const contentHash = await hashCanonicalText(content)
    if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      await this.cleanupRemoteMaterializeFolders(createdFolders)
      return
    }
    let createdFile: TFile
    try {
      createdFile = await this.app.vault.create(path, content)
    } catch (error: unknown) {
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      try {
        await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision', context)
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
    if (!this.pendingRemoteTextMatchesMeta(loaded, path, markerOwner, context)) {
      await this.compensateRemoteTextMaterialization(
        loaded,
        path,
        contentHash,
        createdFolders,
        createdFile,
        markerOwner,
        context,
      )
      return
    }
    this.lastMaterialized.set(path, {
      diskHash: contentHash,
      ydocHash: contentHash,
      path,
      writtenAt: Date.now(),
    })
    this.clearPendingRemoteTextFile(loaded, path, markerOwner)
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
    createdFile: TFile,
    markerOwner: GenerationMarkerOwner,
    context: MetadataReconcileWriteContext,
  ): Promise<void> {
    const stillOwnsMarker = () =>
      this.pendingRemoteTextFiles.get(loaded.docId.ydocId) === path &&
      this.pendingRemoteTextFileOwners.get(loaded.docId.ydocId) === markerOwner
    if (!stillOwnsMarker() || this.app.vault.getAbstractFileByPath(path) !== createdFile) {
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      return
    }
    let actualHash: string
    try {
      actualHash = await hashCanonicalText(await this.app.vault.read(createdFile))
    } catch (error: unknown) {
      console.warn('[kuroflare] could not verify a raced remote text materialization', {
        path,
        error: safeLogError(error),
      })
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision', context)
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      return
    }

    if (
      !stillOwnsMarker() ||
      this.app.vault.getAbstractFileByPath(path) !== createdFile ||
      actualHash !== expectedHash
    ) {
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision', context)
      new Notice(
        `Kuroflare sync: preserved a raced local edit at ${path}; resolve the remote materialization repair manually.`,
      )
      this.clearPendingRemoteTextFile(loaded, path, markerOwner)
      return
    }

    this.pendingFsDeletes.add(path)
    try {
      await this.app.vault.delete(createdFile)
    } catch (error: unknown) {
      this.pendingFsDeletes.delete(path)
      console.warn('[kuroflare] failed to compensate a raced remote text materialization', {
        path,
        error: safeLogError(error),
      })
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision', context)
    } finally {
      this.pendingFsDeletes.delete(path)
    }
    this.clearPendingRemoteTextFile(loaded, path, markerOwner)
    await this.cleanupRemoteMaterializeFolders(createdFolders)
  }

  private clearPendingRemoteTextFile(
    loaded: LoadedTextDoc,
    path: string,
    markerOwner: GenerationMarkerOwner,
  ): void {
    clearOwnedPathMarker(
      this.pendingRemoteTextFiles,
      this.pendingRemoteTextFileOwners,
      loaded.docId.ydocId,
      path,
      markerOwner,
    )
  }

  private captureMetadataMaterializationContext(): MetadataReconcileWriteContext | undefined {
    if (this.metadataReconcileTransitionPending()) return undefined
    const setup = currentSetupMetadata(this)
    if (setup === undefined || !this.startupSideEffectGate.canSendNetwork()) return undefined
    return {
      metaDoc: this.metaDoc,
      generation: this.metadataVaultGeneration,
      vaultId: setup.vaultId,
    }
  }

  private pendingRemoteTextMatchesMeta(
    loaded: LoadedTextDoc,
    path: string,
    markerOwner: GenerationMarkerOwner,
    context: MetadataReconcileWriteContext,
  ): boolean {
    if (!metadataReconcileWriteContextStillStable(this, context)) return false
    if (!this.loadedTextDocMatchesMetadataContext(loaded, context)) return false
    if (this.pendingRemoteTextFileOwners.get(loaded.docId.ydocId) !== markerOwner) return false
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

  private loadedTextDocMatchesMetadataContext(
    loaded: LoadedTextDoc,
    context: MetadataReconcileWriteContext,
  ): boolean {
    if (context.vaultId === undefined) return false
    return this.loadedTextDocStillCurrent(loaded, {
      vaultId: context.vaultId,
      generation: context.generation,
    })
  }

  async resolveJoinAdoptionHashCheck(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    if (!this.loadedTextDocMatchesMetadataContext(loaded, context)) return
    const markerPath = this.pendingRemoteTextFiles.get(loaded.docId.ydocId)
    if (markerPath === undefined) return
    if (!metadataReconcileWriteContextStillStable(this, context)) return
    const markerOwner = claimOwnedPathMarker(
      this.pendingRemoteTextFiles,
      this.pendingRemoteTextFileOwners,
      loaded.docId.ydocId,
      markerPath,
      this.metadataVaultGeneration,
    )
    if (markerOwner === undefined) return
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path, markerOwner, context)) {
      this.clearPendingRemoteTextFile(loaded, markerPath, markerOwner)
      return
    }
    const fileId = findActiveFileId(this, file.path)
    if (fileId === undefined) {
      this.clearPendingRemoteTextFile(loaded, markerPath, markerOwner)
      return
    }

    const remoteContentHash = await hashCanonicalText(loaded.text.toJSON())
    const localContentHash = await hashCanonicalText(await this.app.vault.read(file))
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path, markerOwner, context)) {
      this.clearPendingRemoteTextFile(loaded, markerPath, markerOwner)
      return
    }
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
      this.clearPendingRemoteTextFile(loaded, markerPath, markerOwner)
      return
    }
    try {
      await this.importJoinAdoptionTextIfActive(file, loaded, markerOwner, context)
    } finally {
      this.clearPendingRemoteTextFile(loaded, markerPath, markerOwner)
    }
  }

  private async importJoinAdoptionTextIfActive(
    file: TFile,
    loaded: LoadedTextDoc,
    markerOwner: GenerationMarkerOwner,
    context: MetadataReconcileWriteContext,
  ): Promise<void> {
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path, markerOwner, context)) return
    const diskText = await this.app.vault.read(file)
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path, markerOwner, context)) return
    const canonicalText = canonicalizeTextForYText(diskText)
    const textHash = await hashCanonicalText(canonicalText)
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path, markerOwner, context)) return
    replaceYText(loaded.doc, loaded.text, canonicalText, DISK_ORIGIN)
    this.lastMaterialized.set(file.path, {
      diskHash: textHash,
      ydocHash: textHash,
      path: file.path,
      writtenAt: Date.now(),
      diskMtimeMs: file.stat.mtime,
      diskSize: file.stat.size,
    })
    if (!this.pendingRemoteTextMatchesMeta(loaded, file.path, markerOwner, context)) return
    await sendDocUpdateToWorker(
      this,
      loaded.docId,
      Y.encodeStateAsUpdate(loaded.doc),
      'join-adoption-hash-mismatch',
      () => this.loadedTextDocMatchesMetadataContext(loaded, context),
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
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    if (await this.removeRepairLogEntry(entry.id, context)) {
      new Notice(`Kuroflare repair: cleared ${entry.kind}`)
    }
  }

  async retryPathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict' && entry.kind !== 'portable-path') return
    if (!metadataWritesEnabled(this)) return
    if (this.metadataReconcileTransitionPending()) return
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    if (!(await materializeMetaRenames(metadataMaterializationPort(this)))) return
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
    await this.removeRepairLogEntry(entry.id, context)
  }

  async retryKeepDeletedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'delete-vs-edit' || entry.reason !== 'missing-binary-content') return
    if (!metadataWritesEnabled(this)) return
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return

    const current = readMetaFile(metaMap(this), entry.fileId)
    if (current === undefined || !current.deleted || current.type !== 'binary') {
      await this.removeRepairLogEntry(entry.id, context)
      return
    }

    await reconcileAndMaterializeMeta(
      metadataReconcilePort(this),
      metadataMaterializationPort(this),
    )
    const reconciled = readMetaFile(metaMap(this), entry.fileId)
    if (reconciled === undefined || reconciled.deleted) return
    await this.removeRepairLogEntry(entry.id, context)
  }

  async resolvePathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict' && entry.kind !== 'portable-path') return
    if (!metadataWritesEnabled(this)) return
    if (this.metadataReconcileTransitionPending()) return
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    if (!metadataReconcileWriteContextStillStable(this, context)) return
    const current = readMetaFile(metaMap(this), entry.fileId)
    const plan = planPathConflictAutoResolve({
      entry,
      current,
      isPathAvailable: (path) => this.app.vault.getAbstractFileByPath(path) === null,
    })
    if (plan.action === 'rename-meta-path') {
      if (!metadataReconcileWriteContextStillStable(this, context)) return
      const contextMeta = metaMap({ metaDoc: context.metaDoc })
      context.metaDoc.transact(() => {
        const value = readMetaFile(contextMeta, entry.fileId)
        if (value === undefined) return
        updateMetaFile(contextMeta, {
          ...value,
          path: plan.toPath,
          canonicalPath: plan.toCanonicalPath,
          updatedAt: Date.now(),
          updatedBy: REPAIR_DEVICE,
        })
      }, REPAIR_ORIGIN)
      if (!metadataReconcileWriteContextStillStable(this, context)) return
      if (!(await materializeMetaRenames(metadataMaterializationPort(this)))) return
    }
    await this.removeRepairLogEntry(entry.id, context)
  }

  async retryRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'remote-materialize-blocked') return
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    const current = readMetaFile(metaMap(this), entry.fileId)
    if (current === undefined || current.deleted) {
      await this.removeRepairLogEntry(entry.id, context)
      return
    }
    if (current.type === 'text') {
      if (!(await requestMissingRemoteTextFile(this, current))) return
    } else {
      const completedFileIds = await enqueueMissingRemoteBinaryDownloads(
        metadataReconcilePort(this),
        metadataMaterializationPort(this),
        'repair:remote-materialize-retry',
      )
      if (!completedFileIds.has(current.fileId)) return
    }
    await this.removeRepairLogEntry(entry.id, context)
  }

  async resolveRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'remote-materialize-blocked') return
    if (!metadataWritesEnabled(this)) return
    if (this.metadataReconcileTransitionPending()) return
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
    if (!metadataReconcileWriteContextStillStable(this, context)) return
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
      if (!metadataReconcileWriteContextStillStable(this, context)) return
      const contextMeta = metaMap({ metaDoc: context.metaDoc })
      context.metaDoc.transact(() => {
        const value = readMetaFile(contextMeta, entry.fileId)
        if (value === undefined) return
        updateMetaFile(contextMeta, {
          ...value,
          path: plan.toPath,
          canonicalPath: plan.toCanonicalPath,
          updatedAt: Date.now(),
          updatedBy: REPAIR_DEVICE,
        })
      }, REPAIR_ORIGIN)
      if (!metadataReconcileWriteContextStillStable(this, context)) return
      const updated = readMetaFile(contextMeta, entry.fileId)
      if (updated !== undefined && !updated.deleted && updated.type === 'text') {
        if (!(await requestMissingRemoteTextFile(this, updated))) return
      }
    } else {
      return
    }
    await this.removeRepairLogEntry(entry.id, context)
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
    const context = this.captureMetadataMaterializationContext()
    if (context === undefined) return
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
      await this.removeRepairLogEntry(entry.id, context)
      return
    }
    // This transaction's own `update` event already syncs the deletion
    // incrementally (see `attachMetaDocObservers`); resending the full doc
    // here duplicated that update and could quarantine the sync-update on
    // the server, because `Y.encodeStateAsUpdate(doc)` re-emits every delete
    // this device has ever observed, not just what changed since the last send.
    if (!metadataReconcileWriteContextStillStable(this, context)) return
    const contextMeta = metaMap({ metaDoc: context.metaDoc })
    context.metaDoc.transact(() => {
      contextMeta.delete(entry.fileId)
    }, REPAIR_ORIGIN)
    if (!metadataReconcileWriteContextStillStable(this, context)) return
    if (this.invalidMetaIsolationDetail?.fileId === entry.fileId) {
      this.invalidMetaIsolationDetail = null
    }
    await this.removeRepairLogEntry(entry.id, context)
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

function metadataReconcileWriteContextStillStable(
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
