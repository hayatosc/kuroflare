import { Compartment, type Extension } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import {
  hashBytesSha256,
  hashCanonicalText,
  isMetaFile,
  makeDeviceId,
  type Ack,
  type BinaryMetaFile,
  type BlobManifest,
  type ClientAuthMetadata,
  type DeviceId,
  type DocId,
  type DocLatestSnapshotResponse,
  type FileId,
  type LastMaterializedRecord,
  type LocalOutboxRepairEvidenceResponse,
  type MessageId,
  type MetaFile,
  type MetaLatestSnapshotResponse,
  type MetaRepair,
  type NeedFullSnapshot,
  type OutboxAuthRefreshRequestDecision,
  type OutboxResumeEvent,
  type OutboxRunError,
  type OutboxRunningLease,
  type QuarantinedUpdateActionDryRunResponse,
  type QuarantinedUpdateDetailResponse,
  type QuarantinedUpdateEntry,
  type SetupExchangeResponse,
  type Sha256Hex,
  type SnapshotImportResponse,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import { Notice, Plugin, type TFile, type EventRef } from 'obsidian'
import type { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type {
  FileDocId,
  KuroflareBinaryRestoreCheckDetail,
  KuroflareInvalidMetaIsolationDetail,
  KuroflareRepairLogEntry,
  KuroflareSettings,
  LoadedTextDoc,
} from '../main-types'
import { KuroflareSettingTab } from '@packages/obsidian-plugin/obsidian/settings-tab'
import { type SyncRuntimeStartupStepEffectPort } from '@packages/obsidian-plugin/sync/engine/actuation'
import { type LocalSetupMetadata } from '@packages/obsidian-plugin/sync/engine/setup'
import { type VerifiedFullSnapshotBytes } from '@packages/obsidian-plugin/sync/engine/snapshot'
import {
  createSyncRuntimeWebSocketSession,
  type SyncRuntimeWebSocketInboundMessage,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketStartupStepPort,
} from '@packages/obsidian-plugin/sync/engine/websocket'
import {
  type OutboxWorkerBlobGetSideEffectPlan,
  type OutboxWorkerBlobPutSideEffectPlan,
  type OutboxWorkerIndexedDbWriteTransaction,
  type OutboxWorkerManifestPutSideEffectPlan,
  type OutboxWorkerMaterializeSideEffectPlan,
  type OutboxWorkerSideEffectResultEvidence,
} from '@packages/obsidian-plugin/sync/engine/worker'
import { type SyncRuntimeObsidianComposition } from '@packages/obsidian-plugin/sync/obsidian/composition'
import { type SyncRuntimeObsidianRepairPresentation } from '@packages/obsidian-plugin/sync/obsidian/presentation'
import { type QuarantineAdminAction } from '@packages/obsidian-plugin/sync/obsidian/quarantine-admin'
import { planSyncRuntimeObsidianLegacySettingsSecretCleanup } from '@packages/obsidian-plugin/sync/obsidian/settings'
import { type LocalStoreOutboxRecord } from '@packages/obsidian-plugin/sync/store/store'
import {
  BINARY_UPLOAD_ORIGIN,
  DEFAULT_SETTINGS,
  META_SYNC_DOC_ID,
  REPAIR_ORIGIN,
  SPIKE_TEXT_NAME,
  WORKER_ORIGIN,
} from './constants'
import {
  isKuroflareLocalRepairExportMetadata,
  isKuroflareRepairLogEntry,
  isPartialSettings,
} from './guards'
import { mergeRepairLogEntries, safeLogError } from './helpers'

type LatestSnapshotPayload = {
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly verifiedBytes: VerifiedFullSnapshotBytes
}

type LocalOutboxRepairEvidenceQueryItem = {
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: Sha256Hex | undefined
}

type QuarantineAdminPendingAction = {
  readonly action: QuarantineAdminAction
  readonly id: string
  readonly confirmationToken: string
  readonly effects: QuarantinedUpdateActionDryRunResponse['effects']
  readonly preparedAt: number
}

/** Obsidian plugin entrypoint for the local editor, Yjs, and sync runtime. */

import {
  currentSetupDeviceId,
  currentSetupMetadata,
  currentSetupVaultIdHint,
  findActiveFileId,
  findMetaFileIdForDoc,
  loadIndexedDbYDocs,
  persistPendingSetupResponse,
  readAccessToken,
  readLocalSetupMetadataSnapshot,
  requireSetupMetadata,
  revokeCurrentDeviceAfterConfirmation,
  runAuthRefreshRequest,
  scheduleAuthRefreshRetry,
  stopLocalSyncAfterAuthBlocked,
} from './auth'
import {
  allocateConflictPath,
  bindActiveMarkdownView,
  createConflictCopy,
  createEditorExtension,
  flushYTextToDisk,
  handleBackgroundDiskModify,
  handleDiskModify,
  importActiveFileFromDiskAndSend,
  importFileTextAndSend,
  importFileTextIntoDoc,
  importFileTextIntoDocAndSend,
  loadTextDoc,
  openMetaPersistence,
  registerCommands,
  registerVaultWatcher,
  registerWorkspaceEvents,
  seedYTextFromDiskIfNeeded,
  setActiveTextDoc,
} from './editor'
import {
  adoptLocalFilesAfterRemoteMeta,
  createLocalMetaYDocFromStartupScan,
  enqueueBinaryUploadFromVaultFile,
  enqueueMissingDownloads,
  enqueueMissingRemoteBinaryDownloads,
  fetchBlobManifestForMeta,
  handleBinaryVaultRename,
  handleVaultCreate,
  handleVaultDelete,
  handleVaultRename,
  planBinaryMetaUpdate,
  queueJoinAdoptionHashCheck,
  registerFileTreeWatcher,
  requestMissingRemoteTextFile,
  scanLocalVaultForStartup,
} from './file-tree'
import {
  checkDeletedBinaryRestoreAvailability,
  clearRepairLogEntry,
  discardInvalidMetaRepairEntry,
  exportLocalOutboxRepair,
  findRestorableBinaryFileIdsForReconcile,
  getBinaryRestoreCheckSnapshot,
  getInvalidMetaIsolationSnapshot,
  getSettingsSnapshot,
  getSyncRepairEntriesSnapshot,
  inspectInvalidMetaRepairEntry,
  isActiveMetaEntry,
  materializeMetaDeletes,
  materializeMetaRenames,
  rebuildLocalStoreAfterConfirmation,
  reconcileAndMaterializeMeta,
  removeRepairLogEntry,
  repairLogEntryFromMetaRepair,
  resolvePathConflictRepairEntry,
  resolveRemoteMaterializeBlockedRepairEntry,
  resumeStagedRepairImports,
  retryKeepDeletedRepairEntry,
  retryPathConflictRepairEntry,
  retryRemoteMaterializeBlockedRepairEntry,
  showActiveRemoteDeleteNotice,
  stageLocalOutboxRepairImport,
} from './meta'
import {
  blobBytesMatch,
  commitOutboxWorkerIndexedDbWriteTransaction,
  completeLeasedOutboxFailure,
  completeNonAckSideEffect,
  consumePendingOutboxResumeEvents,
  ensureAdapterParentFolders,
  ensureVaultParentFolders,
  fetchJsonSideEffect,
  handleForegroundResume,
  httpFailureResult,
  isRepairConflictPathAvailable,
  putOutboxRecord,
  putOutboxRecords,
  readBlobCacheBytes,
  readOutboxWorkerSnapshot,
  runBlobGetSideEffect,
  runBlobPutSideEffect,
  runManifestPutSideEffect,
  runMaterializeSideEffect,
  runOutboxWorkerTick,
  scheduleOutboxWorkerTick,
  writeBlobCacheBytes,
} from './outbox'
import {
  executeQuarantineAdminAction,
  getQuarantineAdminSnapshot,
  inspectQuarantineAdminEntry,
  prepareQuarantineAdminAction,
  refreshQuarantineAdminEntries,
} from './repair'
import {
  applyLatestSnapshot,
  fetchAndApplyFullSnapshot,
  fetchLatestSnapshotPayload,
  fetchLocalOutboxRepairEvidence,
  importLocalSnapshot,
  latestSnapshotUrl,
  localOutboxRepairEvidenceUrl,
  publishLocalMetaSnapshot,
  snapshotImportUrl,
} from './snapshot'
import { openLocalStoreDatabase, rebuildLocalStoreDatabase } from './store'
import {
  completeOutboundYUpdateFromWorker,
  createStartupStepPort,
  createSyncRuntime,
  createWorkerWebSocketStartupPort,
  handleLifecycleResume,
  handleWorkerInboundMessage,
  openWorkerWebSocket,
  persistOutboundYUpdate,
  publishInitialFileSnapshots,
  requestActiveFileFromWorker,
  requestDocFromWorker,
  requestMetaDocFromWorker,
  requestPendingRemoteTextFilesFromWorker,
  runSyncStartupTick,
  sendCurrentYDocToWorker,
  sendDocUpdateToWorker,
  sendMetaDocToWorker,
  sendWorkerHello,
  sendYjsUpdateToWorker,
} from './sync'
import {
  answerWorkerSyncRequest,
  applyWorkerSyncUpdate,
  resolveJoinAdoptionHashCheck,
  resolvePendingRemoteTextFile,
} from './websocket'

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
  syncRetryEnabled = false
  quarantineAdminEntries: readonly QuarantinedUpdateEntry[] = []
  quarantineAdminDetail: QuarantinedUpdateDetailResponse | null = null
  quarantineAdminPendingAction: QuarantineAdminPendingAction | null = null
  invalidMetaIsolationDetail: KuroflareInvalidMetaIsolationDetail | null = null
  binaryRestoreCheckDetail: KuroflareBinaryRestoreCheckDetail | null = null
  kuroflareSettings: KuroflareSettings = DEFAULT_SETTINGS
  readonly workerWebSocketSession: SyncRuntimeWebSocketSessionPort =
    createSyncRuntimeWebSocketSession()
  readonly outboxWorkerOwnerId = `obsidian-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`
  workerWebSocketStartupPort: SyncRuntimeWebSocketStartupStepPort | null = null
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
  // Monotonic token claimed synchronously at the top of each bindActiveMarkdownView call, so a
  // newer call can supersede an older, still-in-flight one (see bindActiveMarkdownView).
  bindGeneration = 0
  // EditorViews that currently have yCollab installed via cmCompartment.reconfigure. Entries are
  // removed in bindActiveMarkdownView when the same EditorView is rebound to a different file
  // (Obsidian can reuse one EditorView across a file switch within a leaf); a view destroyed by
  // Obsidian without ever being rebound is simply dropped, since this is a WeakSet.
  readonly yCollabBoundViews = new WeakSet<EditorView>()

  // File-tree subsystem: the meta YDoc holds fileId -> MetaFile for the whole vault.
  readonly metaDoc = new Y.Doc()
  metaPersistence: IndexeddbPersistence | null = null
  localStoreDb: IDBDatabase | null = null
  localStoreDbName: string | null = null
  // Last on-disk path materialized per file ID, so a converged meta rename can move the real file.
  readonly materializedPaths = new Map<FileId, string>()
  // Remote text files discovered from meta before their file YDoc has arrived.
  readonly pendingRemoteTextFiles = new Map<string, string>()
  startupScannedMarkdownFiles: readonly TFile[] = []
  // Canonical paths whose vault rename we initiated, to ignore the resulting watcher echo.
  readonly pendingFsRenames = new Set<string>()
  // Remote tombstones for the currently bound editor are shown once; the editor buffer stays open.
  readonly activeRemoteDeletedFileIds = new Set<FileId>()
  pendingRemoteMetaSnapshot: LatestSnapshotPayload | null = null
  pendingSetupResponse: SetupExchangeResponse | null = null
  trustedSetupMetadata: LocalSetupMetadata | null = null

  /** Set up the plugin lifecycle. */

  /** Tear down Yjs observers and persistence. */

  /**
   * Registers a local file that shares a path with a remote text meta entry
   * so its content hash is compared against the remote YText once fetched.
   * Reuses the same `pendingRemoteTextFiles` queue and request machinery as
   * "materialize a remote file missing locally" (`requestPendingRemoteTextFilesFromWorker`,
   * driven from hello-accepted / foreground-resume / enqueue-missing-downloads),
   * so no new fetch scheduling path is introduced.
   */

  public async recordMetaRepairLog(
    repairs: readonly MetaRepair[],
    invalidFileIds: readonly string[],
  ): Promise<void> {
    if (repairs.length === 0 && invalidFileIds.length === 0) {
      return
    }
    const createdAt = Date.now()
    const entries: KuroflareRepairLogEntry[] = [
      ...repairs.map((repair) => this.repairLogEntryFromMetaRepair(repair, createdAt)),
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

  public async recordRemoteMaterializeBlocked(
    loaded: LoadedTextDoc,
    path: string,
    reason: 'invalid-path' | 'path-collision' | 'parent-collision',
  ): Promise<void> {
    const fileId = this.findMetaFileIdForDoc(loaded.docId)
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

  public async recordRenameMaterializeBlocked(
    fileId: string,
    path: string,
    reason: 'rename-materialize-failed',
  ): Promise<void> {
    const entry: KuroflareRepairLogEntry = {
      id: `path-conflict:${fileId}:${reason}`,
      kind: 'path-conflict',
      fileId,
      path,
      reason,
      createdAt: Date.now(),
    }
    await this.updateSettings({
      repairLog: mergeRepairLogEntries(this.kuroflareSettings.repairLog ?? [], [entry]),
    })
  }

  /** Moves real vault files to match meta entries whose path converged elsewhere. */

  /**
   * Resolves a file queued in `pendingRemoteTextFiles` once its remote YText
   * content has actually arrived (via sync update or full snapshot apply).
   *
   * Two distinct queue reasons share this map and this resolution point:
   * - the remote file has no local counterpart yet, so it is materialized
   *   onto disk (original behaviour);
   * - a local file already exists at the same path (queued by
   *   `queueJoinAdoptionHashCheck` during join), so the content hashes are
   *   compared and, if they differ, the local content is imported as an
   *   ordinary external edit instead of being silently dropped.
   */

  /** Applies the join adoption decision once remote content is known. */

  /**
   * Same hash-gate decision as {@link handleDiskModify}, but for a file that
   * is not bound to the active editor. It reads the file's own YDoc so
   * background external edits are imported into the correct document.
   */

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.statusEl = this.addStatusBarItem()
    this.syncStatusEl = this.addStatusBarItem()
    this.setStatus('loading')
    this.syncStatusEl.setText('Kuroflare sync: not started')

    this.addSettingTab(new KuroflareSettingTab(this.app, this))
    this.registerEditorExtension(this.cmCompartment.of([]))
    void this.openMetaPersistence().catch((error: unknown) => {
      console.error('[kuroflare] failed to open meta IndexedDB persistence', safeLogError(error))
    })
    // Repair + materialize whenever the meta YDoc converges from a non-repair source.
    this.metaDoc.on('afterTransaction', (transaction: Y.Transaction) => {
      if (transaction.origin === REPAIR_ORIGIN) {
        return
      }
      void this.reconcileAndMaterializeMeta()
    })
    this.metaDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === WORKER_ORIGIN || origin === BINARY_UPLOAD_ORIGIN) {
        return
      }
      void this.sendDocUpdateToWorker(META_SYNC_DOC_ID, update, 'meta-update')
    })
    this.syncRuntime = this.createSyncRuntime()
    this.registerCommands()
    this.registerVaultWatcher()
    this.registerFileTreeWatcher()
    this.registerWorkspaceEvents()

    this.app.workspace.onLayoutReady(() => {
      void this.bindActiveMarkdownView('layout-ready')
      void this.handleLifecycleResume('layout-ready')
    })

    this.setStatus('ready')
    console.info('[kuroflare] plugin loaded')
  }

  override onunload(): void {
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
    this.localStoreDb?.close()
    this.localStoreDb = null
    this.localStoreDbName = null
    this.workerWebSocketSession.close(1000, 'plugin-unload')
    this.workerWebSocketStartupPort = null
    if (this.outboxWorkerRetryTimeout !== null) {
      window.clearTimeout(this.outboxWorkerRetryTimeout)
      this.outboxWorkerRetryTimeout = null
    }
    if (this.authRefreshRetryTimeout !== null) {
      window.clearTimeout(this.authRefreshRetryTimeout)
      this.authRefreshRetryTimeout = null
    }
    this.metaDoc.destroy()
  }

  async updateSettings(patch: Partial<KuroflareSettings>): Promise<void> {
    this.kuroflareSettings = { ...this.kuroflareSettings, ...patch }
    await this.saveData(this.kuroflareSettings)
  }

  public async loadSettings(): Promise<void> {
    const loaded = await this.loadData()
    const loadedSettings = isPartialSettings(loaded) ? loaded : {}
    // Security guard: pre-migration data.json may still carry plaintext token fields.
    // Token material now lives in SecretStorage/IndexedDB metadata only, so drop any
    // legacy fields here and persist the sanitized settings back immediately.
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

  public get metaMap(): Y.Map<unknown> {
    return this.metaDoc.getMap<unknown>('meta')
  }

  public fileTreeDeviceId(): DeviceId {
    return makeDeviceId(this.currentSetupMetadata()?.deviceId ?? 'local-device')
  }

  public async logState(): Promise<void> {
    console.info('[kuroflare] state', {
      activePath: this.activeFile?.path,
      yTextLength: this.ytext.length,
      yTextHash: await hashCanonicalText(this.ytext.toJSON()),
      lastMaterialized: this.activeFile
        ? this.lastMaterialized.get(this.activeFile.path)
        : undefined,
    })
    new Notice('Kuroflare spike state logged to console')
  }

  public async activeDocId(): Promise<DocId> {
    const path = this.activeFile?.path ?? this.targetPath ?? 'active-file.md'
    return await this.fileDocIdForPath(path)
  }

  public async fileDocIdForPath(path: string): Promise<FileDocId> {
    const fileId = this.findActiveFileId(path)
    if (fileId !== undefined) {
      const value = this.metaMap.get(fileId)
      if (isMetaFile(value, fileId) && value.type === 'text') {
        return { kind: 'file', ydocId: value.ydocId }
      }
    }
    const hash = await this.sha256Hex(new TextEncoder().encode(path))
    return { kind: 'file', ydocId: `file-${hash.slice(0, 32)}` }
  }

  public nextWorkerMessageId(): string {
    this.workerMessageCounter += 1
    return `msg-${Date.now().toString(36)}-${this.workerMessageCounter.toString(36)}`
  }

  public async sha256Hex(bytes: Uint8Array): Promise<string> {
    return await hashBytesSha256(bytes)
  }

  public setStatus(status: string): void {
    if (this.statusEl) {
      this.statusEl.setText(`Kuroflare: ${status}`)
    }
  }

  public async runAuthRefreshRequest(request: OutboxAuthRefreshRequestDecision): Promise<void> {
    return runAuthRefreshRequest(this, request)
  }

  public scheduleAuthRefreshRetry(delayMs: number): void {
    return scheduleAuthRefreshRetry(this, delayMs)
  }

  async revokeCurrentDeviceAfterConfirmation(confirmation: string): Promise<void> {
    return revokeCurrentDeviceAfterConfirmation(this, confirmation)
  }

  public async persistLocalDeviceRevoke(
    db: IDBDatabase,
    metadata: ClientAuthMetadata,
    response: unknown,
    setup: LocalSetupMetadata,
  ): Promise<void> {
    return persistLocalDeviceRevoke_Method(this, db, metadata, response, setup)
  }

  public stopLocalSyncAfterAuthBlocked(reason: ClientAuthMetadata['authState']): void {
    return stopLocalSyncAfterAuthBlocked(this, reason)
  }

  public async readAccessToken(key: string): Promise<string | undefined> {
    return readAccessToken(this, key)
  }

  public currentSetupMetadata(): LocalSetupMetadata | undefined {
    return currentSetupMetadata(this)
  }

  public requireSetupMetadata(): LocalSetupMetadata {
    return requireSetupMetadata(this)
  }

  public currentSetupDeviceId(): DeviceId | undefined {
    return currentSetupDeviceId(this)
  }

  public currentSetupVaultIdHint(): LocalSetupMetadata['vaultId'] | undefined {
    return currentSetupVaultIdHint(this)
  }

  public async readLocalSetupMetadataSnapshot() {
    return readLocalSetupMetadataSnapshot(this)
  }

  public async persistPendingSetupResponse(): Promise<void> {
    return persistPendingSetupResponse(this)
  }

  public async loadIndexedDbYDocs(): Promise<void> {
    return loadIndexedDbYDocs(this)
  }

  public async recoverStaleAuthRefreshStart(
    db: IDBDatabase,
    metadata: ClientAuthMetadata,
  ): Promise<void> {
    return recoverStaleAuthRefreshStart_Method(this, db, metadata)
  }

  public findActiveFileId(path: string): FileId | undefined {
    return findActiveFileId(this, path)
  }

  public findMetaFileIdForDoc(docId: FileDocId): FileId | undefined {
    return findMetaFileIdForDoc(this, docId)
  }

  public registerCommands(): void {
    return registerCommands(this)
  }

  public registerWorkspaceEvents(): void {
    return registerWorkspaceEvents(this)
  }

  public registerVaultWatcher(): void {
    return registerVaultWatcher(this)
  }

  public async bindActiveMarkdownView(reason: string): Promise<void> {
    return bindActiveMarkdownView(this, reason)
  }

  public createEditorExtension(): Extension {
    return createEditorExtension(this)
  }

  public async seedYTextFromDiskIfNeeded(
    file: TFile,
    editorView: EditorView,
    generation: number,
  ): Promise<void> {
    return seedYTextFromDiskIfNeeded(this, file, editorView, generation)
  }

  public replaceYText(nextText: string, origin: string): void {
    return replaceYText_Method(this, nextText, origin)
  }

  public async handleDiskModify(file: TFile): Promise<void> {
    return handleDiskModify(this, file)
  }

  public async handleBackgroundDiskModify(file: TFile): Promise<void> {
    return handleBackgroundDiskModify(this, file)
  }

  public async importActiveFileFromDiskAndSend(reason: string): Promise<void> {
    return importActiveFileFromDiskAndSend(this, reason)
  }

  public async importFileTextAndSend(file: TFile, text: string, reason: string): Promise<void> {
    return importFileTextAndSend(this, file, text, reason)
  }

  public async importFileTextIntoDocAndSend(
    file: TFile,
    docId: FileDocId,
    reason: string,
  ): Promise<void> {
    return importFileTextIntoDocAndSend(this, file, docId, reason)
  }

  public async importFileTextIntoDoc(
    file: TFile,
    docId: FileDocId,
    textContent: string,
  ): Promise<void> {
    return importFileTextIntoDoc(this, file, docId, textContent)
  }

  public async flushYTextToDisk(reason: string): Promise<void> {
    return flushYTextToDisk(this, reason)
  }

  public async createConflictCopy(file: TFile, content: string): Promise<string> {
    return createConflictCopy(this, file, content)
  }

  public async allocateConflictPath(file: TFile): Promise<string> {
    return allocateConflictPath(this, file)
  }

  public async loadTextDoc(docId: FileDocId): Promise<LoadedTextDoc> {
    return loadTextDoc(this, docId)
  }

  public setActiveTextDoc(loaded: LoadedTextDoc): void {
    return setActiveTextDoc(this, loaded)
  }

  public async openMetaPersistence(): Promise<void> {
    return openMetaPersistence(this)
  }

  public registerFileTreeWatcher(): void {
    return registerFileTreeWatcher(this)
  }

  public handleVaultCreate(file: TFile): void {
    return handleVaultCreate(this, file)
  }

  public scanLocalVaultForStartup(): void {
    return scanLocalVaultForStartup(this)
  }

  public async createLocalMetaYDocFromStartupScan(reason: string): Promise<void> {
    return createLocalMetaYDocFromStartupScan(this, reason)
  }

  public async adoptLocalFilesAfterRemoteMeta(): Promise<void> {
    return adoptLocalFilesAfterRemoteMeta(this)
  }

  public async queueJoinAdoptionHashCheck(file: TFile, fileId: FileId): Promise<void> {
    return queueJoinAdoptionHashCheck(this, file, fileId)
  }

  public async enqueueBinaryUploadFromVaultFile(file: TFile, reason: string): Promise<void> {
    return enqueueBinaryUploadFromVaultFile(this, file, reason)
  }

  public async handleBinaryVaultRename(file: TFile, oldPath: string): Promise<void> {
    return handleBinaryVaultRename(this, file, oldPath)
  }

  public async planBinaryMetaUpdate(input: {
    readonly fileId: FileId
    readonly path: string
    readonly previous: BinaryMetaFile | undefined
    readonly manifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
    readonly chunkHashes: readonly NonNullable<LocalStoreOutboxRecord['blobSha256']>[]
    readonly now: number
  }): Promise<Uint8Array> {
    return planBinaryMetaUpdate(this, input)
  }

  public handleVaultRename(file: TFile, oldPath: string): void {
    return handleVaultRename(this, file, oldPath)
  }

  public handleVaultDelete(file: TFile): void {
    return handleVaultDelete(this, file)
  }

  public async requestMissingRemoteTextFile(value: {
    readonly type: unknown
    readonly path: string
    readonly ydocId?: unknown
  }): Promise<void> {
    return requestMissingRemoteTextFile(this, value)
  }

  public async enqueueMissingDownloads(): Promise<void> {
    return enqueueMissingDownloads(this)
  }

  public async enqueueMissingRemoteBinaryDownloads(reason: string): Promise<void> {
    return enqueueMissingRemoteBinaryDownloads(this, reason)
  }

  public async fetchBlobManifestForMeta(
    setup: LocalSetupMetadata,
    accessToken: string,
    value: BinaryMetaFile,
  ): Promise<BlobManifest | undefined> {
    return fetchBlobManifestForMeta(this, setup, accessToken, value)
  }

  public async reconcileAndMaterializeMeta(): Promise<void> {
    return reconcileAndMaterializeMeta(this)
  }

  public async removeRepairLogEntry(entryId: string): Promise<void> {
    return removeRepairLogEntry(this, entryId)
  }

  async clearRepairLogEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return clearRepairLogEntry(this, entry)
  }

  async retryRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return retryRemoteMaterializeBlockedRepairEntry(this, entry)
  }

  async resolveRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return resolveRemoteMaterializeBlockedRepairEntry(this, entry)
  }

  async retryPathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return retryPathConflictRepairEntry(this, entry)
  }

  async resolvePathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return resolvePathConflictRepairEntry(this, entry)
  }

  async retryKeepDeletedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return retryKeepDeletedRepairEntry(this, entry)
  }

  async discardInvalidMetaRepairEntry(
    entry: KuroflareRepairLogEntry,
    confirmation: string,
  ): Promise<void> {
    return discardInvalidMetaRepairEntry(this, entry, confirmation)
  }

  async inspectInvalidMetaRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    return inspectInvalidMetaRepairEntry(this, entry)
  }

  public async findRestorableBinaryFileIdsForReconcile(): Promise<ReadonlySet<FileId>> {
    return findRestorableBinaryFileIdsForReconcile(this)
  }

  public async checkDeletedBinaryRestoreAvailability(value: BinaryMetaFile): Promise<boolean> {
    return checkDeletedBinaryRestoreAvailability(this, value)
  }

  public async materializeMetaRenames(): Promise<void> {
    return materializeMetaRenames(this)
  }

  public materializeMetaDeletes(): void {
    return materializeMetaDeletes(this)
  }

  public isActiveMetaEntry(value: MetaFile, knownPath: string | undefined): boolean {
    return isActiveMetaEntry(this, value, knownPath)
  }

  public showActiveRemoteDeleteNotice(value: MetaFile): void {
    return showActiveRemoteDeleteNotice(this, value)
  }

  getSettingsSnapshot(): KuroflareSettings {
    return getSettingsSnapshot(this)
  }

  getSyncRepairEntriesSnapshot(): readonly SyncRuntimeObsidianRepairPresentation[] {
    return getSyncRepairEntriesSnapshot(this)
  }

  getInvalidMetaIsolationSnapshot(): KuroflareInvalidMetaIsolationDetail | null {
    return getInvalidMetaIsolationSnapshot(this)
  }

  getBinaryRestoreCheckSnapshot(): KuroflareBinaryRestoreCheckDetail | null {
    return getBinaryRestoreCheckSnapshot(this)
  }

  async exportLocalOutboxRepair(): Promise<void> {
    return exportLocalOutboxRepair(this)
  }

  async rebuildLocalStoreAfterConfirmation(confirmation: string): Promise<void> {
    return rebuildLocalStoreAfterConfirmation(this, confirmation)
  }

  async stageLocalOutboxRepairImport(path: string): Promise<void> {
    return stageLocalOutboxRepairImport(this, path)
  }

  async resumeStagedRepairImports(): Promise<void> {
    return resumeStagedRepairImports(this)
  }

  public repairLogEntryFromMetaRepair(
    repair: MetaRepair,
    createdAt: number,
  ): KuroflareRepairLogEntry {
    return repairLogEntryFromMetaRepair(this, repair, createdAt)
  }

  public async runOutboxWorkerTick(reason: string): Promise<void> {
    return runOutboxWorkerTick(this, reason)
  }

  public scheduleOutboxWorkerTick(delayMs: number, reason: string): void {
    return scheduleOutboxWorkerTick(this, delayMs, reason)
  }

  public async handleForegroundResume(reason: string): Promise<void> {
    return handleForegroundResume(this, reason)
  }

  public consumePendingOutboxResumeEvents(): readonly OutboxResumeEvent[] {
    return consumePendingOutboxResumeEvents(this)
  }

  public async runManifestPutSideEffect(
    sideEffect: OutboxWorkerManifestPutSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    return runManifestPutSideEffect(this, sideEffect)
  }

  public async runBlobPutSideEffect(
    sideEffect: OutboxWorkerBlobPutSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    return runBlobPutSideEffect(this, sideEffect)
  }

  public async runBlobGetSideEffect(
    sideEffect: OutboxWorkerBlobGetSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    return runBlobGetSideEffect(this, sideEffect)
  }

  public async runMaterializeSideEffect(
    sideEffect: OutboxWorkerMaterializeSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    return runMaterializeSideEffect(this, sideEffect)
  }

  public async fetchJsonSideEffect(
    request: OutboxWorkerManifestPutSideEffectPlan['putManifestRequest'],
  ): Promise<
    | { readonly kind: 'success'; readonly body: unknown }
    | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
  > {
    return fetchJsonSideEffect(this, request)
  }

  public async httpFailureResult(
    response: Response,
  ): Promise<Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>> {
    return httpFailureResult(this, response)
  }

  public async readBlobCacheBytes(
    key: string,
    expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
    expectedSize: number,
  ): Promise<Uint8Array | undefined> {
    return readBlobCacheBytes(this, key, expectedSha256, expectedSize)
  }

  public async writeBlobCacheBytes(key: string, bytes: Uint8Array): Promise<void> {
    return writeBlobCacheBytes(this, key, bytes)
  }

  public async blobBytesMatch(
    bytes: Uint8Array,
    expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
    expectedSize: number,
  ): Promise<boolean> {
    return blobBytesMatch(this, bytes, expectedSha256, expectedSize)
  }

  public async completeNonAckSideEffect(
    db: IDBDatabase,
    record: LocalStoreOutboxRecord,
    result: OutboxWorkerSideEffectResultEvidence,
  ): Promise<void> {
    return completeNonAckSideEffect(this, db, record, result)
  }

  public async completeLeasedOutboxFailure(
    db: IDBDatabase,
    record: LocalStoreOutboxRecord,
    error: OutboxRunError,
  ): Promise<void> {
    return completeLeasedOutboxFailure(this, db, record, error)
  }

  public async readOutboxWorkerSnapshot(db: IDBDatabase): Promise<{
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  }> {
    return readOutboxWorkerSnapshot(this, db)
  }

  public async commitOutboxWorkerIndexedDbWriteTransaction(
    db: IDBDatabase,
    transaction: OutboxWorkerIndexedDbWriteTransaction,
  ): Promise<void> {
    return commitOutboxWorkerIndexedDbWriteTransaction(this, db, transaction)
  }

  public async putOutboxRecord(db: IDBDatabase, record: LocalStoreOutboxRecord): Promise<void> {
    return putOutboxRecord(this, db, record)
  }

  public async putOutboxRecords(
    db: IDBDatabase,
    records: readonly LocalStoreOutboxRecord[],
  ): Promise<void> {
    return putOutboxRecords(this, db, records)
  }

  public async ensureAdapterParentFolders(path: string): Promise<void> {
    return ensureAdapterParentFolders(this, path)
  }

  public async ensureVaultParentFolders(path: string): Promise<boolean> {
    return ensureVaultParentFolders(this, path)
  }

  public isRepairConflictPathAvailable(path: string): boolean {
    return isRepairConflictPathAvailable(this, path)
  }

  async refreshQuarantineAdminEntries(): Promise<void> {
    return refreshQuarantineAdminEntries(this)
  }

  async inspectQuarantineAdminEntry(id: string): Promise<void> {
    return inspectQuarantineAdminEntry(this, id)
  }

  async prepareQuarantineAdminAction(id: string, action: QuarantineAdminAction): Promise<void> {
    return prepareQuarantineAdminAction(this, id, action)
  }

  getQuarantineAdminSnapshot(): {
    readonly entries: readonly QuarantinedUpdateEntry[]
    readonly detail: QuarantinedUpdateDetailResponse | null
    readonly pendingAction: QuarantineAdminPendingAction | null
  } {
    return getQuarantineAdminSnapshot(this)
  }

  async executeQuarantineAdminAction(
    id: string,
    action: QuarantineAdminAction,
    confirmation: string,
  ): Promise<void> {
    return executeQuarantineAdminAction(this, id, action, confirmation)
  }

  public async fetchAndApplyFullSnapshot(message: NeedFullSnapshot): Promise<void> {
    return fetchAndApplyFullSnapshot(this, message)
  }

  public async publishLocalMetaSnapshot(reason: string): Promise<SnapshotImportResponse> {
    return publishLocalMetaSnapshot(this, reason)
  }

  public async importLocalSnapshot(
    docId: DocId,
    updateBytes: Uint8Array,
    reason: string,
  ): Promise<SnapshotImportResponse> {
    return importLocalSnapshot(this, docId, updateBytes, reason)
  }

  public async applyLatestSnapshot(
    docId: DocId,
    snapshot: LatestSnapshotPayload,
    reason: string,
  ): Promise<void> {
    return applyLatestSnapshot(this, docId, snapshot, reason)
  }

  public async fetchLatestSnapshotPayload(
    docId: DocId,
    reason: string,
  ): Promise<LatestSnapshotPayload | null> {
    return fetchLatestSnapshotPayload(this, docId, reason)
  }

  public latestSnapshotUrl(setup: LocalSetupMetadata, docId: DocId): string {
    return latestSnapshotUrl(this, setup, docId)
  }

  public snapshotImportUrl(setup: LocalSetupMetadata, docId: DocId): string {
    return snapshotImportUrl(this, setup, docId)
  }

  public localOutboxRepairEvidenceUrl(setup: LocalSetupMetadata): string {
    return localOutboxRepairEvidenceUrl(this, setup)
  }

  public async fetchLocalOutboxRepairEvidence(
    setup: LocalSetupMetadata,
    items: readonly LocalOutboxRepairEvidenceQueryItem[],
  ): Promise<LocalOutboxRepairEvidenceResponse | null> {
    return fetchLocalOutboxRepairEvidence(this, setup, items)
  }

  public async openLocalStoreDatabase(
    vaultId: LocalSetupMetadata['vaultId'],
  ): Promise<IDBDatabase> {
    return openLocalStoreDatabase(this, vaultId)
  }

  public async rebuildLocalStoreDatabase(vaultId: LocalSetupMetadata['vaultId']): Promise<void> {
    return rebuildLocalStoreDatabase(this, vaultId)
  }

  public createSyncRuntime(): SyncRuntimeObsidianComposition {
    return createSyncRuntime(this)
  }

  public createStartupStepPort(): SyncRuntimeStartupStepEffectPort {
    return createStartupStepPort(this)
  }

  public async runSyncStartupTick(reason: string): Promise<void> {
    return runSyncStartupTick(this, reason)
  }

  public async handleLifecycleResume(reason: string): Promise<void> {
    return handleLifecycleResume(this, reason)
  }

  public async openWorkerWebSocket(): Promise<void> {
    return openWorkerWebSocket(this)
  }

  public async sendWorkerHello(): Promise<void> {
    return sendWorkerHello(this)
  }

  public createWorkerWebSocketStartupPort(): SyncRuntimeWebSocketStartupStepPort {
    return createWorkerWebSocketStartupPort(this)
  }

  public async sendCurrentYDocToWorker(reason: string): Promise<void> {
    return sendCurrentYDocToWorker(this, reason)
  }

  public async publishInitialFileSnapshots(reason: string): Promise<void> {
    return publishInitialFileSnapshots(this, reason)
  }

  public async sendMetaDocToWorker(reason: string): Promise<void> {
    return sendMetaDocToWorker(this, reason)
  }

  public async requestActiveFileFromWorker(reason: string): Promise<void> {
    return requestActiveFileFromWorker(this, reason)
  }

  public async requestMetaDocFromWorker(reason: string): Promise<void> {
    return requestMetaDocFromWorker(this, reason)
  }

  public async requestPendingRemoteTextFilesFromWorker(reason: string): Promise<void> {
    return requestPendingRemoteTextFilesFromWorker(this, reason)
  }

  public async requestDocFromWorker(
    docId: DocId,
    stateVector: Uint8Array,
    reason: string,
  ): Promise<void> {
    return requestDocFromWorker(this, docId, stateVector, reason)
  }

  public async sendYjsUpdateToWorker(update: Uint8Array, reason: string): Promise<void> {
    return sendYjsUpdateToWorker(this, update, reason)
  }

  public async sendDocUpdateToWorker(
    docId: DocId,
    update: Uint8Array,
    reason: string,
  ): Promise<void> {
    return sendDocUpdateToWorker(this, docId, update, reason)
  }

  public async persistOutboundYUpdate(input: {
    readonly vaultId: LocalSetupMetadata['vaultId']
    readonly docId: DocId
    readonly messageId: SyncUpdate['messageId']
    readonly updateSha256: NonNullable<SyncUpdate['updateSha256']>
    readonly updateBytesBase64: string
  }): Promise<void> {
    return persistOutboundYUpdate(this, input)
  }

  public async completeOutboundYUpdateFromWorker(message: Ack | NeedFullSnapshot): Promise<void> {
    return completeOutboundYUpdateFromWorker(this, message)
  }

  public async handleWorkerInboundMessage(
    inbound: SyncRuntimeWebSocketInboundMessage,
  ): Promise<void> {
    return handleWorkerInboundMessage(this, inbound)
  }

  public async applyWorkerSyncUpdate(message: SyncUpdate): Promise<void> {
    return applyWorkerSyncUpdate(this, message)
  }

  public async resolvePendingRemoteTextFile(loaded: LoadedTextDoc): Promise<void> {
    return resolvePendingRemoteTextFile(this, loaded)
  }

  public async resolveJoinAdoptionHashCheck(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    return resolveJoinAdoptionHashCheck(this, file, loaded)
  }

  public async answerWorkerSyncRequest(message: SyncRequest): Promise<void> {
    return answerWorkerSyncRequest(this, message)
  }
}
