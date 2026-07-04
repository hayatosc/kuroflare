import { Compartment, type Extension } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import {
  assembleBlobBytes,
  blobManifestMatchesMetaFile,
  BlobManifestSchema,
  buildBinaryUploadOutboxPlan,
  buildBinaryDownloadOutboxPlan,
  buildBlobManifest,
  canonicalizeTextForYText,
  DEFAULT_LOCAL_STORE_OBJECT_STORES,
  decideJoinFileAdoption,
  decideMaterializeWrite,
  decideWatcherHashGate,
  decideWatcherStatPrefilter,
  hashCanonicalText,
  hashBytesSha256,
  decodeFullSnapshotBytesFromResponse,
  BlobHeadResponseSchema,
  BlobUploadUrlResponseSchema,
  DeviceTokenClaimsSchema,
  DocLatestSnapshotResponseSchema,
  LocalOutboxRepairEvidenceResponseSchema,
  MetaLatestSnapshotResponseSchema,
  QuarantinedUpdateActionDryRunResponseSchema,
  QuarantinedUpdateActionResponseSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  RevokeDeviceResponseSchema,
  SnapshotImportResponseSchema,
  type LastMaterializedRecord,
  type DocLatestSnapshotResponse,
  type MetaLatestSnapshotResponse,
  type SnapshotImportResponse,
  type LocalOutboxRepairEvidenceResponse,
  type QuarantinedUpdateActionDryRunResponse,
  type QuarantinedUpdateActionRequest,
  type QuarantinedUpdateDetailResponse,
  type QuarantinedUpdateEntry,
} from '@kuroflare/core'
import {
  canonicalizeVaultPath,
  isMetaFile,
  makeDeviceId,
  makeFileId,
  makeOutboxPlanItemId,
  makeSha256Hex,
  makeYDocId,
  VaultRelativePathSchema,
  VaultIdSchema,
  type OutboxRunningLease,
  type Ack,
  type BinaryMetaFile,
  type DeviceId,
  type DocId,
  type NeedFullSnapshot,
  type FileId,
  type MetaFile,
  type MetaRepair,
  type BlobManifest,
  type ClientAuthMetadata,
  type DeviceTokenClaims,
  type DeviceTokenRefreshRequest,
  type MessageId,
  type OutboxAuthRefreshRequestDecision,
  type OutboxAuthRefreshState,
  type OutboxRunError,
  type OutboxResumeEvent,
  type OutboxSchedulerAuthGateInput,
  type Sha256Hex,
  type SetupExchangeResponse,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  TFolder,
  type EventRef,
  type SecretStorage,
} from 'obsidian'
import * as v from 'valibot'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type {
  KuroflareSettings,
  KuroflareRepairLogEntry,
  KuroflareLocalRepairExportMetadata,
  FileDocId,
  LoadedTextDoc,
} from './main-types'
import {
  createYTextEditorExtension,
  dispatchFullDocumentReplace,
  getEditorView,
  replaceYText,
} from './obsidian/editor-binding'
import { KuroflareSettingTab } from './obsidian/settings-tab'
import {
  recoverStaleAuthRefreshStart,
  runAuthRefreshAttempt,
  persistAuthRefreshStart,
  type AuthRefreshHttpResult,
  type AuthRefreshMetadataPort,
  type AuthRefreshSecretStoragePort,
} from './sync/auth/refresh'
import {
  persistLocalDeviceRevoke,
  type AuthRevokeMetadataPort,
  type AuthRevokeSecretStoragePort,
} from './sync/auth/revoke'
import { type SyncRuntimeStartupStepEffectPort } from './sync/engine/actuation'
import {
  createSyncRuntimeIndexedDbLocalStoreEffectPort,
  createSyncRuntimeLocalStoreRebuildReplanPort,
  createSyncRuntimeStartupStepEffectPort,
  createSyncRuntimeSetupPersistStepPort,
} from './sync/engine/actuation'
import {
  createLocalSetupPersistIndexedDbMetadataPort,
  type LocalSetupPersistSecretStoragePort,
} from './sync/engine/persist'
import { planOutboundQueueTick } from './sync/engine/queue'
import {
  LOCAL_SETUP_METADATA_KEY,
  type LocalSetupMetadata,
  type LocalSetupMetadataPutOperation,
} from './sync/engine/setup'
import {
  commitFullSnapshotApplyIndexedDbTransaction,
  createFullSnapshotApplyIndexedDbDatabasePort,
  planFullSnapshotApplyRuntime,
  type VerifiedFullSnapshotBytes,
} from './sync/engine/snapshot'
import {
  createBrowserSyncRuntimeWebSocketFactory,
  createSyncRuntimeWebSocketOutboxCompletionPort,
  createSyncRuntimeWebSocketOutboxSendPort,
  createSyncRuntimeWebSocketRemoteUpdateApplyPort,
  createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort,
  createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort,
  createSyncRuntimeWebSocketSession,
  createSyncRuntimeWebSocketStartupStepPort,
  createSyncRuntimeWebSocketSyncRequestAnswerPort,
  createSyncRuntimeWebSocketSyncRequestSendPort,
  createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort,
  dispatchSyncRuntimeWebSocketInboundMessage,
  type SyncRuntimeWebSocketInboundMessage,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketStartupStepPort,
} from './sync/engine/websocket'
import {
  classifyOutboxWorkerSideEffectCompletionEvidence,
  planOutboxWorkerCompletionIndexedDbWriteTransaction,
  planOutboxWorkerFailureCompletion,
  planOutboxWorkerSideEffect,
  planOutboxWorkerSuccessCompletion,
  planOutboxWorkerTick,
  planOutboxWorkerTickIndexedDbWriteTransactions,
  type OutboxWorkerBlobGetSideEffectPlan,
  type OutboxWorkerBlobPutSideEffectPlan,
  type OutboxWorkerManifestPutSideEffectPlan,
  type OutboxWorkerMaterializeSideEffectPlan,
  type OutboxWorkerSideEffectResultEvidence,
  type OutboxWorkerIndexedDbWriteTransaction,
} from './sync/engine/worker'
import { reconcileMetaDoc } from './sync/meta/reconcile'
import { applyFileCreate, applyFileDelete, applyFileRename } from './sync/meta/tree'
import {
  createSyncRuntimeObsidianComposition,
  type SyncRuntimeObsidianComposition,
} from './sync/obsidian/composition'
import { type SyncRuntimeObsidianRepairPresentation } from './sync/obsidian/presentation'
import { createSyncRuntimeObsidianSetupExchangeEvidenceReader } from './sync/obsidian/settings'
import {
  createEvidenceBackedHttpSyncRuntimeSetupExchangePort,
  type SetupExchangeStartupEffect,
} from './sync/setup-exchange-http'
import {
  createBrowserLocalStoreIndexedDbFactoryPort,
  commitLocalStoreIndexedDbConcreteWriteTransaction,
  commitLocalStoreIndexedDbDatabaseTransaction,
  commitLocalStoreIndexedDbMetadataTransaction,
  createLocalStoreIndexedDbDatabasePort,
  createLocalStoreIndexedDbMetadataDatabasePort,
  planLocalStoreIndexedDbMetadataWrites,
  readLocalStoreIndexedDbMetadataSnapshot,
} from './sync/store/indexeddb'
import {
  buildLocalStoreRepairExport,
  localStoreRepairExportPath,
  planLocalStoreRepairImport,
  planLocalStoreRepairImportStageTransaction,
  planLocalStoreRepairImportResume,
  planLocalStoreRepairImportResumeTransaction,
  readLocalStoreRepairExportFile,
  type LocalStoreRepairImportedOutboxRecord,
  writeLocalStoreRepairExportFile,
} from './sync/store/repair'
import { LOCAL_STORE_INDEXEDDB_TARGET_VERSION, localStoreIndexedDbName } from './sync/store/schema'
import { type LocalStoreOutboxRecord } from './sync/store/store'

const SPIKE_TEXT_NAME = 'fixed-file'
const META_DOC_NAME = 'kuroflare-meta'
const META_SYNC_DOC_ID = { kind: 'meta' } satisfies DocId
const DISK_ORIGIN = 'kuroflare:disk'
const REMOTE_ORIGIN = 'kuroflare:remote-simulated'
const WORKER_ORIGIN = 'kuroflare:worker'
const FILE_TREE_ORIGIN = 'kuroflare:file-tree'
const BINARY_UPLOAD_ORIGIN = 'kuroflare:binary-upload'
const REPAIR_ORIGIN = 'kuroflare:repair'
const REPAIR_DEVICE = makeDeviceId('repair')
const MARKDOWN_EXTENSION = 'md'
const OUTBOX_WORKER_LEASE_DURATION_MS = 30_000
const OUTBOX_WORKER_MAX_STARTS = 4
const AUTH_REFRESH_MARGIN_MS = 60_000
const AUTH_REFRESH_ESTIMATED_DURATION_MS = 10_000
const AUTH_REFRESH_STALE_AFTER_MS = 120_000
const MAX_REPAIR_LOG_ENTRIES = 50
export const LOCAL_STORE_REBUILD_CONFIRMATION = 'REBUILD LOCAL STORE'
export const LOCAL_STORE_DISCARD_CONFIRMATION = 'DISCARD LOCAL OUTBOX'
const QUARANTINE_DISCARD_CONFIRMATION = 'DISCARD QUARANTINE'
const QUARANTINE_FORCE_APPLY_CONFIRMATION = 'FORCE APPLY QUARANTINE'
export const DEVICE_REVOKE_CONFIRMATION = 'REVOKE THIS DEVICE'
export const INVALID_META_DISCARD_CONFIRMATION = 'DISCARD INVALID META'

type LatestSnapshotPayload = {
  readonly response: MetaLatestSnapshotResponse | DocLatestSnapshotResponse
  readonly verifiedBytes: VerifiedFullSnapshotBytes
}

type LocalOutboxRepairEvidenceQueryItem = {
  readonly docId: DocId
  readonly messageId: MessageId
  readonly updateSha256?: Sha256Hex | undefined
}

export type QuarantineAdminAction = QuarantinedUpdateActionRequest['action']

type QuarantineAdminPendingAction = {
  readonly action: QuarantineAdminAction
  readonly id: string
  readonly confirmationToken: string
  readonly effects: QuarantinedUpdateActionDryRunResponse['effects']
  readonly preparedAt: number
}

const DEFAULT_SETTINGS: KuroflareSettings = {
  endpoint: 'http://127.0.0.1:8787',
  setupVaultId: '',
  setupToken: '',
  requestedDeviceName: 'Obsidian',
  setupBootstrapMode: 'new-vault',
}

function isPartialSettings(value: unknown): value is Partial<KuroflareSettings> {
  return typeof value === 'object' && value !== null
}

function isKuroflareRepairLogEntry(value: unknown): value is KuroflareRepairLogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const id = Reflect.get(value, 'id')
  const kind = Reflect.get(value, 'kind')
  const fileId = Reflect.get(value, 'fileId')
  const reason = Reflect.get(value, 'reason')
  const createdAt = Reflect.get(value, 'createdAt')
  const path = Reflect.get(value, 'path')
  return (
    typeof id === 'string' &&
    (kind === 'path-conflict' ||
      kind === 'delete-vs-edit' ||
      kind === 'invalid-meta' ||
      kind === 'remote-materialize-blocked') &&
    typeof fileId === 'string' &&
    typeof reason === 'string' &&
    Number.isSafeInteger(createdAt) &&
    (path === undefined || typeof path === 'string')
  )
}

function isKuroflareLocalRepairExportMetadata(
  value: unknown,
): value is KuroflareLocalRepairExportMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const path = Reflect.get(value, 'path')
  const exportedAt = Reflect.get(value, 'exportedAt')
  const pendingOutboxCount = Reflect.get(value, 'pendingOutboxCount')
  return (
    typeof path === 'string' &&
    Number.isSafeInteger(exportedAt) &&
    exportedAt >= 0 &&
    Number.isSafeInteger(pendingOutboxCount) &&
    pendingOutboxCount >= 0
  )
}

function mergeRepairLogEntries(
  current: readonly KuroflareRepairLogEntry[],
  next: readonly KuroflareRepairLogEntry[],
): readonly KuroflareRepairLogEntry[] {
  const byId = new Map<string, KuroflareRepairLogEntry>()
  for (const entry of current) {
    byId.set(entry.id, entry)
  }
  for (const entry of next) {
    byId.set(entry.id, entry)
  }
  return [...byId.values()]
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_REPAIR_LOG_ENTRIES)
}

export function repairLogDescription(entry: KuroflareRepairLogEntry): string {
  const timestamp = new Date(entry.createdAt).toISOString()
  return entry.path === undefined
    ? `${entry.reason} at ${timestamp}`
    : `${entry.reason}: ${entry.path} at ${timestamp}`
}

function safeLogError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactSecretText(error.message),
    }
  }
  return {
    name: typeof error,
    message: redactSecretText(String(error)),
  }
}

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'Bearer [redacted]')
    .replace(
      /kuroflare-token\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      'kuroflare-token.[redacted]',
    )
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/([?&](?:setupToken|accessToken|refreshToken|token)=)[^&#\s]+/gi, '$1[redacted]')
}

export function docIdLabel(docId: DocId): string {
  return docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
}

export function quarantineActionConfirmationText(action: QuarantineAdminAction): string {
  return action === 'discard'
    ? QUARANTINE_DISCARD_CONFIRMATION
    : QUARANTINE_FORCE_APPLY_CONFIRMATION
}

export function quarantineActionLabel(action: QuarantineAdminAction): string {
  return action === 'discard' ? 'Discard' : 'Force apply'
}

function sameLocalSetupMetadata(
  left: LocalSetupMetadata | undefined,
  right: LocalSetupMetadata,
): boolean {
  return (
    left !== undefined &&
    left.endpoint === right.endpoint &&
    left.vaultId === right.vaultId &&
    left.deviceId === right.deviceId &&
    left.yClientId === right.yClientId &&
    left.protocolVersion === right.protocolVersion &&
    left.bootstrapMode === right.bootstrapMode &&
    left.tokenVersion === right.tokenVersion
  )
}

/** Obsidian plugin entrypoint for the local editor, Yjs, and sync runtime. */
export default class KuroflareSpikePlugin extends Plugin {
  private ydoc = new Y.Doc()
  private ytext = this.ydoc.getText(SPIKE_TEXT_NAME)
  private readonly cmCompartment = new Compartment()
  private readonly lastMaterialized = new Map<string, LastMaterializedRecord>()
  private readonly loadedTextDocs = new Map<string, LoadedTextDoc>()
  private activeTextDoc: LoadedTextDoc | null = null
  private statusEl: HTMLElement | null = null
  private syncStatusEl: HTMLElement | null = null
  private syncRuntime: SyncRuntimeObsidianComposition | null = null
  private syncRepairEntries: readonly SyncRuntimeObsidianRepairPresentation[] = []
  private syncRetryEnabled = false
  private quarantineAdminEntries: readonly QuarantinedUpdateEntry[] = []
  private quarantineAdminDetail: QuarantinedUpdateDetailResponse | null = null
  private quarantineAdminPendingAction: QuarantineAdminPendingAction | null = null
  private kuroflareSettings: KuroflareSettings = DEFAULT_SETTINGS
  private readonly workerWebSocketSession: SyncRuntimeWebSocketSessionPort =
    createSyncRuntimeWebSocketSession()
  private readonly outboxWorkerOwnerId = `obsidian-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`
  private workerWebSocketStartupPort: SyncRuntimeWebSocketStartupStepPort | null = null
  private outboxWorkerRunning = false
  private outboxWorkerRetryTimeout: number | null = null
  private authRefreshRunning = false
  private authRefreshRetryTimeout: number | null = null
  private pendingOutboxResumeEvents: OutboxResumeEvent[] = []
  private syncStoppedByAuth: ClientAuthMetadata['authState'] | null = null
  private foregroundResumeRunning = false
  private workerHelloAccepted = false
  private workerMessageCounter = 0
  private activeFile: TFile | null = null
  private activeView: EditorView | null = null
  private targetPath: string | null = null
  private fileModifyRef: EventRef | null = null

  // File-tree subsystem (MVP-2): the meta YDoc holds fileId -> MetaFile for the whole vault.
  private readonly metaDoc = new Y.Doc()
  private metaPersistence: IndexeddbPersistence | null = null
  private localStoreDb: IDBDatabase | null = null
  private localStoreDbName: string | null = null
  // Last on-disk path materialized per file ID, so a converged meta rename can move the real file.
  private readonly materializedPaths = new Map<FileId, string>()
  // Remote text files discovered from meta before their file YDoc has arrived.
  private readonly pendingRemoteTextFiles = new Map<string, string>()
  private startupScannedMarkdownFiles: readonly TFile[] = []
  // Canonical paths whose vault rename we initiated, to ignore the resulting watcher echo.
  private readonly pendingFsRenames = new Set<string>()
  // Remote tombstones for the currently bound editor are shown once; the editor buffer stays open.
  private readonly activeRemoteDeletedFileIds = new Set<FileId>()
  private pendingRemoteMetaSnapshot: LatestSnapshotPayload | null = null
  private pendingSetupResponse: SetupExchangeResponse | null = null
  private trustedSetupMetadata: LocalSetupMetadata | null = null

  /** Set up the plugin lifecycle. */
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

  /** Tear down Yjs observers and persistence. */
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

  private async loadSettings(): Promise<void> {
    const loaded = await this.loadData()
    const loadedSettings = isPartialSettings(loaded) ? loaded : {}
    this.kuroflareSettings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
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
  }

  private get metaMap(): Y.Map<unknown> {
    return this.metaDoc.getMap<unknown>('meta')
  }

  private async loadTextDoc(docId: FileDocId): Promise<LoadedTextDoc> {
    const existing = this.loadedTextDocs.get(docId.ydocId)
    if (existing !== undefined) {
      return existing
    }

    const doc = new Y.Doc()
    const text = doc.getText(SPIKE_TEXT_NAME)
    const loaded: LoadedTextDoc = { docId, doc, text, persistence: null }
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === DISK_ORIGIN || origin === REMOTE_ORIGIN || origin === WORKER_ORIGIN) {
        return
      }
      void this.sendDocUpdateToWorker(docId, update, 'local-update')
    })
    const persistence = new IndexeddbPersistence(`kuroflare-file:${docId.ydocId}`, doc)
    loaded.persistence = persistence
    this.loadedTextDocs.set(docId.ydocId, loaded)
    await persistence.whenSynced
    return loaded
  }

  private setActiveTextDoc(loaded: LoadedTextDoc): void {
    this.activeTextDoc = loaded
    this.ydoc = loaded.doc
    this.ytext = loaded.text
  }

  private async openMetaPersistence(): Promise<void> {
    this.metaPersistence = new IndexeddbPersistence(META_DOC_NAME, this.metaDoc)
    await this.metaPersistence.whenSynced
    for (const [fileId, value] of this.metaMap.entries()) {
      if (isMetaFile(value, fileId) && !value.deleted) {
        this.materializedPaths.set(value.fileId, value.path)
      }
    }
    await this.reconcileAndMaterializeMeta()
  }

  private fileTreeDeviceId(): DeviceId {
    return makeDeviceId(this.currentSetupMetadata()?.deviceId ?? 'local-device')
  }

  private registerFileTreeWatcher(): void {
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
          this.handleVaultCreate(file)
          return
        }
        if (file instanceof TFile) {
          void this.enqueueBinaryUploadFromVaultFile(file, 'binary-create')
        }
      }),
    )
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension !== MARKDOWN_EXTENSION) {
          void this.enqueueBinaryUploadFromVaultFile(file, 'binary-modify')
        }
      }),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
          this.handleVaultRename(file, oldPath)
          return
        }
        if (file instanceof TFile) {
          void this.handleBinaryVaultRename(file, oldPath)
        }
      }),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) {
          this.handleVaultDelete(file)
        }
      }),
    )
  }

  private handleVaultCreate(file: TFile): void {
    if (this.findActiveFileId(file.path) !== undefined) {
      return
    }
    const fileId = makeFileId(crypto.randomUUID())
    const activeYDocId =
      this.activeFile?.path === file.path ? this.activeTextDoc?.docId.ydocId : undefined
    applyFileCreate(this.metaMap, {
      fileId,
      path: file.path,
      ydocId: activeYDocId ?? makeYDocId(`file-${fileId}`),
      deviceId: this.fileTreeDeviceId(),
      now: Date.now(),
      origin: FILE_TREE_ORIGIN,
    })
    this.materializedPaths.set(fileId, file.path)
  }

  private scanLocalVaultForStartup(): void {
    this.startupScannedMarkdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => v.is(VaultRelativePathSchema, file.path))
    console.info('[kuroflare] scanned local vault for startup', {
      markdownFiles: this.startupScannedMarkdownFiles.length,
    })
  }

  private async createLocalMetaYDocFromStartupScan(reason: string): Promise<void> {
    const files =
      this.startupScannedMarkdownFiles.length === 0
        ? this.app.vault.getMarkdownFiles()
        : this.startupScannedMarkdownFiles
    let created = 0
    for (const file of files) {
      if (!v.is(VaultRelativePathSchema, file.path)) {
        console.warn('[kuroflare] skipped startup file with invalid vault path', {
          path: file.path,
        })
        continue
      }
      if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) {
        continue
      }
      if (this.findActiveFileId(file.path) !== undefined) {
        continue
      }
      const text = await this.app.vault.read(file)
      const fileId = makeFileId(crypto.randomUUID())
      const ydocId =
        this.activeFile?.path === file.path && this.activeTextDoc !== null
          ? this.activeTextDoc.docId.ydocId
          : makeYDocId(`file-${fileId}`)
      const docId: FileDocId = { kind: 'file', ydocId }
      const now = Date.now()
      applyFileCreate(this.metaMap, {
        fileId,
        path: file.path,
        ydocId,
        deviceId: this.fileTreeDeviceId(),
        now,
        origin: FILE_TREE_ORIGIN,
      })
      this.materializedPaths.set(fileId, file.path)
      await this.importFileTextIntoDoc(file, docId, text)
      created += 1
    }
    console.info('[kuroflare] created local meta YDoc from startup scan', { created, reason })
  }

  private async adoptLocalFilesAfterRemoteMeta(): Promise<void> {
    let adopted = 0
    for (const file of this.app.vault.getMarkdownFiles()) {
      const remoteFileId = this.findActiveFileId(file.path)
      if (remoteFileId !== undefined) {
        // A path that already exists in remote meta must adopt the remote
        // fileId and never mint a second one for the same path. Whether the
        // content matches is unknown here because the
        // remote YText hasn't been fetched yet (the WebSocket opens later in
        // the join sequence), so the hash comparison is deferred until that
        // content arrives; see resolvePendingRemoteTextFile.
        await this.queueJoinAdoptionHashCheck(file, remoteFileId)
        continue
      }
      const fileId = makeFileId(crypto.randomUUID())
      const ydocId =
        this.activeFile?.path === file.path && this.activeTextDoc !== null
          ? this.activeTextDoc.docId.ydocId
          : makeYDocId(`file-${fileId}`)
      const docId: FileDocId = { kind: 'file', ydocId }
      const now = Date.now()
      applyFileCreate(this.metaMap, {
        fileId,
        path: file.path,
        ydocId,
        deviceId: this.fileTreeDeviceId(),
        now,
        origin: FILE_TREE_ORIGIN,
      })
      this.materializedPaths.set(fileId, file.path)
      await this.importFileTextIntoDocAndSend(
        file,
        docId,
        `startup:adopt-local-files-after-remote-meta`,
      )
      adopted += 1
    }
    if (adopted > 0) {
      await this.sendMetaDocToWorker('startup:adopt-local-files-after-remote-meta')
    }
    console.info('[kuroflare] adopted local files after remote meta', { adopted })
  }

  /**
   * Registers a local file that shares a path with a remote text meta entry
   * so its content hash is compared against the remote YText once fetched.
   * Reuses the same `pendingRemoteTextFiles` queue and request machinery as
   * "materialize a remote file missing locally" (`requestPendingRemoteTextFilesFromWorker`,
   * driven from hello-accepted / foreground-resume / enqueue-missing-downloads),
   * so no new fetch scheduling path is introduced.
   */
  private async queueJoinAdoptionHashCheck(file: TFile, fileId: FileId): Promise<void> {
    const value = this.metaMap.get(fileId)
    if (!isMetaFile(value, fileId) || value.deleted || value.type !== 'text') {
      return
    }
    this.materializedPaths.set(fileId, file.path)
    const docId: FileDocId = { kind: 'file', ydocId: value.ydocId }
    await this.loadTextDoc(docId)
    this.pendingRemoteTextFiles.set(docId.ydocId, file.path)
  }

  private async enqueueBinaryUploadFromVaultFile(
    file: TFile,
    reason: string,
    existingFileIdOverride?: FileId,
  ): Promise<void> {
    if (!v.is(VaultRelativePathSchema, file.path)) {
      console.warn('[kuroflare] skipped binary upload for invalid vault path', { path: file.path })
      return
    }
    const existingFileId = existingFileIdOverride ?? this.findActiveFileId(file.path)
    const existing = existingFileId === undefined ? undefined : this.metaMap.get(existingFileId)
    if (existingFileId !== undefined && !isMetaFile(existing, existingFileId)) {
      return
    }
    if (
      existingFileId !== undefined &&
      existing !== undefined &&
      isMetaFile(existing, existingFileId) &&
      existing.type === 'text'
    ) {
      console.warn('[kuroflare] skipped binary upload over text meta entry', { path: file.path })
      return
    }

    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      return
    }
    const fileId = existingFileId ?? makeFileId(crypto.randomUUID())
    const now = Date.now()
    const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(file.path))
    if (bytes.byteLength === 0) {
      console.warn('[kuroflare] skipped empty binary file upload', { path: file.path })
      return
    }

    const built = await buildBlobManifest(fileId, bytes, this.fileTreeDeviceId(), now)
    for (const chunk of built.chunks) {
      await this.writeBlobCacheBytes(binaryBlobCacheKey(chunk.sha256), chunk.bytes)
    }

    const metaUpdate = await this.planBinaryMetaUpdate({
      fileId,
      path: file.path,
      previous:
        existing && isMetaFile(existing, fileId) && existing.type === 'binary'
          ? existing
          : undefined,
      manifestHash: built.manifestHash,
      chunkHashes: built.manifest.chunks.map((chunk) => chunk.sha256),
      now,
    })
    const outboxPrefix = `binary-${fileId}-${built.manifestHash}-${now.toString(36)}`
    const uploadPlan = buildBinaryUploadOutboxPlan({
      fileId,
      blobManifestHash: built.manifestHash,
      chunks: built.chunks.map((chunk, index) => ({
        id: requireOutboxPlanItemId(`${outboxPrefix}-chunk-${index.toString(36)}`),
        sha256: chunk.sha256,
        localCacheKey: binaryBlobCacheKey(chunk.sha256),
        size: chunk.bytes.byteLength,
      })),
      manifestPutId: requireOutboxPlanItemId(`${outboxPrefix}-manifest`),
      metaRefUpdateId: requireOutboxPlanItemId(`${outboxPrefix}-meta`),
    })
    if (!uploadPlan.ok) {
      console.warn('[kuroflare] skipped binary upload outbox plan', {
        path: file.path,
        reason: uploadPlan.reason,
      })
      return
    }

    const messageId = this.nextWorkerMessageId()
    const updateBytesBase64 = encodeBase64(metaUpdate)
    const updateSha256 = makeSha256Hex(await this.sha256Hex(metaUpdate))
    const records: LocalStoreOutboxRecord[] = uploadPlan.plan.items.map((item) => {
      const base = {
        id: item.id,
        kind: item.kind,
        status: 'pending',
        dependsOn: item.dependsOn,
        nextAttemptAt: undefined,
        fileId: item.fileId,
        createdAt: now,
      } satisfies LocalStoreOutboxRecord
      switch (item.kind) {
        case 'blob-put':
          return {
            ...base,
            blobSha256: item.sha256,
            localCacheKey: item.localCacheKey,
            blobSize: item.size,
          } satisfies LocalStoreOutboxRecord
        case 'manifest-put':
          return {
            ...base,
            blobManifestHash: item.blobManifestHash,
            blobManifest: built.manifest,
          } satisfies LocalStoreOutboxRecord
        case 'meta-ref-update':
          return {
            ...base,
            blobManifestHash: item.blobManifestHash,
            blobManifest: built.manifest,
            docId: META_SYNC_DOC_ID,
            messageId,
            updateSha256,
            updateBytesBase64,
          } satisfies LocalStoreOutboxRecord
        case 'blob-get':
        case 'materialize':
          throw new Error(`unexpected-binary-upload-item:${item.kind}`)
      }
    })

    const db = await this.openLocalStoreDatabase(setup.vaultId)
    await this.putOutboxRecords(db, records)
    Y.applyUpdate(this.metaDoc, metaUpdate, BINARY_UPLOAD_ORIGIN)
    void this.runOutboxWorkerTick(reason)
  }

  private async handleBinaryVaultRename(file: TFile, oldPath: string): Promise<void> {
    const oldFileId = this.findActiveFileId(oldPath)
    if (oldFileId === undefined) {
      await this.enqueueBinaryUploadFromVaultFile(file, 'binary-rename')
      return
    }
    const oldEntry = this.metaMap.get(oldFileId)
    if (!isMetaFile(oldEntry, oldFileId) || oldEntry.type !== 'binary') {
      return
    }
    await this.enqueueBinaryUploadFromVaultFile(file, 'binary-rename', oldFileId)
  }

  private async planBinaryMetaUpdate(input: {
    readonly fileId: FileId
    readonly path: string
    readonly previous: BinaryMetaFile | undefined
    readonly manifestHash: NonNullable<LocalStoreOutboxRecord['blobManifestHash']>
    readonly chunkHashes: readonly NonNullable<LocalStoreOutboxRecord['blobSha256']>[]
    readonly now: number
  }): Promise<Uint8Array> {
    const tempDoc = new Y.Doc()
    try {
      Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(this.metaDoc), WORKER_ORIGIN)
      const before = Y.encodeStateVector(tempDoc)
      const entry: BinaryMetaFile = {
        schemaVersion: 1,
        fileId: input.fileId,
        path: input.path,
        canonicalPath: canonicalizeVaultPath(input.path),
        type: 'binary',
        blobManifestHash: input.manifestHash,
        blobChunks: [...input.chunkHashes],
        deleted: false,
        createdAt: input.previous?.createdAt ?? input.now,
        createdBy: input.previous?.createdBy ?? this.fileTreeDeviceId(),
        contentUpdatedAt: input.now,
        contentUpdatedBy: this.fileTreeDeviceId(),
        updatedAt: input.now,
        updatedBy: this.fileTreeDeviceId(),
        mtime: input.now,
      }
      tempDoc.getMap<unknown>('meta').set(input.fileId, entry)
      return Y.encodeStateAsUpdate(tempDoc, before)
    } finally {
      tempDoc.destroy()
    }
  }

  private handleVaultRename(file: TFile, oldPath: string): void {
    // Ignore the watcher echo from a rename we materialized ourselves.
    if (this.pendingFsRenames.delete(canonicalizeVaultPath(file.path))) {
      return
    }
    const result = applyFileRename(this.metaMap, {
      fromPath: oldPath,
      toPath: file.path,
      deviceId: this.fileTreeDeviceId(),
      now: Date.now(),
      origin: FILE_TREE_ORIGIN,
    })
    if (result.action === 'renamed') {
      this.materializedPaths.set(result.fileId, file.path)
    }
  }

  private handleVaultDelete(file: TFile): void {
    const result = applyFileDelete(this.metaMap, {
      path: file.path,
      deviceId: this.fileTreeDeviceId(),
      now: Date.now(),
      origin: FILE_TREE_ORIGIN,
    })
    if (result.action === 'deleted') {
      this.materializedPaths.delete(result.fileId)
    }
  }

  private findActiveFileId(path: string): FileId | undefined {
    const canonical = canonicalizeVaultPath(path)
    for (const [fileId, value] of this.metaMap.entries()) {
      if (isMetaFile(value, fileId) && !value.deleted && value.canonicalPath === canonical) {
        return value.fileId
      }
    }
    return undefined
  }

  private findMetaFileIdForDoc(docId: FileDocId): FileId | undefined {
    for (const [fileId, value] of this.metaMap.entries()) {
      if (isMetaFile(value, fileId) && value.ydocId === docId.ydocId) {
        return value.fileId
      }
    }
    return undefined
  }

  private async reconcileAndMaterializeMeta(): Promise<void> {
    const restorableBinaryFileIds = await this.findRestorableBinaryFileIdsForReconcile()
    const reconciled = reconcileMetaDoc(this.metaMap, {
      updatedAt: Date.now(),
      updatedBy: REPAIR_DEVICE,
      restorableBinaryFileIds,
      origin: REPAIR_ORIGIN,
    })
    await this.recordMetaRepairLog(reconciled.repairs, reconciled.invalidFileIds)
    await this.materializeMetaRenames()
    this.materializeMetaDeletes()
  }

  private async recordMetaRepairLog(
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

  private async recordRemoteMaterializeBlocked(
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

  private async removeRepairLogEntry(entryId: string): Promise<void> {
    await this.updateSettings({
      repairLog: (this.kuroflareSettings.repairLog ?? []).filter((entry) => entry.id !== entryId),
    })
  }

  async clearRepairLogEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: cleared ${entry.kind}`)
  }

  async retryRemoteMaterializeBlockedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'remote-materialize-blocked') {
      new Notice('Kuroflare repair: only remote materialize entries can be retried here')
      return
    }

    const current = this.metaMap.get(entry.fileId)
    if (!isMetaFile(current, entry.fileId) || current.deleted) {
      await this.removeRepairLogEntry(entry.id)
      new Notice('Kuroflare repair: stale remote materialize entry cleared')
      return
    }

    if (current.type === 'text') {
      await this.requestMissingRemoteTextFile(current)
    } else {
      await this.enqueueMissingRemoteBinaryDownloads('repair:remote-materialize-retry')
    }
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: remote materialize retry queued (${current.path})`)
  }

  async retryPathConflictRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'path-conflict') {
      new Notice('Kuroflare repair: only path conflict entries can be retried here')
      return
    }
    const current = this.metaMap.get(entry.fileId)
    if (!isMetaFile(current, entry.fileId) || current.deleted) {
      await this.removeRepairLogEntry(entry.id)
      new Notice('Kuroflare repair: stale path conflict entry cleared')
      return
    }

    await this.materializeMetaRenames()
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: path materialize retried (${current.path})`)
  }

  async retryKeepDeletedRepairEntry(entry: KuroflareRepairLogEntry): Promise<void> {
    if (entry.kind !== 'delete-vs-edit' || entry.reason !== 'missing-binary-content') {
      new Notice('Kuroflare repair: only missing binary delete-vs-edit entries can be retried here')
      return
    }
    const current = this.metaMap.get(entry.fileId)
    if (!isMetaFile(current, entry.fileId) || !current.deleted || current.type !== 'binary') {
      await this.removeRepairLogEntry(entry.id)
      new Notice('Kuroflare repair: stale keep-deleted entry cleared')
      return
    }

    await this.reconcileAndMaterializeMeta()
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: binary restore check retried (${current.path})`)
  }

  async discardInvalidMetaRepairEntry(
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

    const current = this.metaMap.get(entry.fileId)
    if (current === undefined || isMetaFile(current, entry.fileId)) {
      await this.removeRepairLogEntry(entry.id)
      new Notice('Kuroflare repair: stale invalid meta entry cleared')
      return
    }

    this.metaDoc.transact(() => {
      this.metaMap.delete(entry.fileId)
    }, REPAIR_ORIGIN)
    await this.removeRepairLogEntry(entry.id)
    new Notice(`Kuroflare repair: invalid meta discarded (${entry.fileId})`)
  }

  private repairLogEntryFromMetaRepair(
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

  private async findRestorableBinaryFileIdsForReconcile(): Promise<ReadonlySet<FileId>> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      return new Set()
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      return new Set()
    }

    const restorable = new Set<FileId>()
    for (const [fileId, value] of this.metaMap.entries()) {
      if (!isMetaFile(value, fileId) || !value.deleted || value.type !== 'binary') {
        continue
      }
      const manifest = await this.fetchBlobManifestForMeta(setup, accessToken, value)
      if (manifest === undefined) {
        continue
      }
      if (await this.remoteBlobChunksExist(setup, accessToken, manifest)) {
        restorable.add(value.fileId)
      }
    }
    return restorable
  }

  private async enqueueMissingDownloads(): Promise<void> {
    await this.reconcileAndMaterializeMeta()
    await this.requestPendingRemoteTextFilesFromWorker('startup:enqueue-missing-downloads')
    await this.enqueueMissingRemoteBinaryDownloads('startup:enqueue-missing-downloads')
    console.info('[kuroflare] enqueued missing remote text downloads', {
      pending: this.pendingRemoteTextFiles.size,
    })
  }

  private async enqueueMissingRemoteBinaryDownloads(reason: string): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      return
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      console.warn('[kuroflare] skipped remote binary downloads without access token', { reason })
      return
    }

    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const snapshot = await this.readOutboxWorkerSnapshot(db)
    const records: LocalStoreOutboxRecord[] = []
    const now = Date.now()
    for (const [fileId, value] of this.metaMap.entries()) {
      if (!isMetaFile(value, fileId) || value.deleted || value.type !== 'binary') {
        continue
      }
      if (!v.is(VaultRelativePathSchema, value.path)) {
        console.warn('[kuroflare] skipped remote binary download for invalid path', {
          path: value.path,
        })
        continue
      }
      if (
        snapshot.outboxRecords.some(
          (record) =>
            record.fileId === value.fileId &&
            record.kind === 'materialize' &&
            record.status !== 'done' &&
            record.status !== 'failed',
        )
      ) {
        continue
      }
      const manifest = await this.fetchBlobManifestForMeta(setup, accessToken, value)
      if (manifest === undefined) {
        continue
      }
      const existing = this.app.vault.getAbstractFileByPath(value.path)
      if (existing instanceof TFolder) {
        console.warn('[kuroflare] skipped remote binary download over folder path', {
          path: value.path,
        })
        continue
      }
      if (existing instanceof TFile) {
        const currentBytes = new Uint8Array(await this.app.vault.adapter.readBinary(value.path))
        const currentHash = makeSha256Hex(await this.sha256Hex(currentBytes))
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

      const outboxPrefix = `binary-download-${value.fileId}-${value.blobManifestHash}`
      const downloadPlan = buildBinaryDownloadOutboxPlan({
        fileId: value.fileId,
        expectedHash: manifest.contentSha256,
        chunks: manifest.chunks.map((chunk, index) => ({
          id: requireOutboxPlanItemId(`${outboxPrefix}-chunk-${index.toString(36)}`),
          sha256: chunk.sha256,
          localCacheKey: binaryBlobCacheKey(chunk.sha256),
          size: chunk.size,
        })),
        materializeId: requireOutboxPlanItemId(`${outboxPrefix}-materialize`),
      })
      if (!downloadPlan.ok) {
        console.warn('[kuroflare] skipped remote binary download outbox plan', {
          path: value.path,
          reason: downloadPlan.reason,
        })
        continue
      }
      for (const item of downloadPlan.plan.items) {
        const base = {
          id: item.id,
          kind: item.kind,
          status: 'pending',
          dependsOn: item.dependsOn,
          nextAttemptAt: undefined,
          fileId: item.fileId,
          createdAt: now,
        } satisfies LocalStoreOutboxRecord
        if (item.kind === 'blob-get') {
          records.push({
            ...base,
            blobSha256: item.sha256,
            localCacheKey: item.localCacheKey,
            blobSize: item.size,
          } satisfies LocalStoreOutboxRecord)
          continue
        }
        if (item.kind === 'materialize') {
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
          } satisfies LocalStoreOutboxRecord)
        }
      }
      this.materializedPaths.set(value.fileId, value.path)
    }
    if (records.length === 0) {
      return
    }
    await this.putOutboxRecords(db, records)
    void this.runOutboxWorkerTick(reason)
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
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      })
    } catch (error: unknown) {
      console.warn('[kuroflare] blob manifest fetch failed before HTTP response', {
        path: value.path,
        error: safeLogError(error),
      })
      return undefined
    }
    if (!response.ok) {
      console.warn('[kuroflare] blob manifest fetch failed', {
        path: value.path,
        status: response.status,
        code: await responseErrorCode(response),
      })
      return undefined
    }
    const body = await response.json().catch(() => undefined)
    if (!v.is(BlobManifestSchema, body) || !blobManifestMatchesMetaFile(body, value)) {
      console.warn('[kuroflare] blob manifest rejected by guard', { path: value.path })
      return undefined
    }
    return body
  }

  private async remoteBlobChunksExist(
    setup: LocalSetupMetadata,
    accessToken: string,
    manifest: BlobManifest,
  ): Promise<boolean> {
    const url = new URL(setup.endpoint)
    url.pathname = '/blobs/head'
    const head = await this.fetchJsonSideEffect({
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
      return false
    }
    const body = head.body
    return manifest.chunks.every((chunk) => {
      const entry = body.exists[chunk.sha256]
      return entry?.found === true && (entry.size === undefined || entry.size === chunk.size)
    })
  }

  /** Moves real vault files to match meta entries whose path converged elsewhere. */
  private async materializeMetaRenames(): Promise<void> {
    for (const [fileId, value] of this.metaMap.entries()) {
      if (!isMetaFile(value, fileId) || value.deleted) {
        continue
      }
      this.activeRemoteDeletedFileIds.delete(value.fileId)
      const known = this.materializedPaths.get(value.fileId)
      if (known === value.path) {
        continue
      }
      if (known === undefined) {
        this.materializedPaths.set(value.fileId, value.path)
        await this.requestMissingRemoteTextFile(value)
        continue
      }
      const file = this.app.vault.getAbstractFileByPath(known)
      if (!(file instanceof TFile)) {
        this.materializedPaths.set(value.fileId, value.path)
        continue
      }
      const wasActive = this.isActiveMetaEntry(value, known)
      const canonicalTarget = canonicalizeVaultPath(value.path)
      this.pendingFsRenames.add(canonicalTarget)
      try {
        await this.app.fileManager.renameFile(file, value.path)
        this.materializedPaths.set(value.fileId, value.path)
        if (wasActive) {
          this.targetPath = value.path
          const renamed = this.app.vault.getAbstractFileByPath(value.path)
          this.activeFile = renamed instanceof TFile ? renamed : file
          this.setStatus(`bound: ${this.activeFile.basename}`)
          console.info('[kuroflare] active file followed remote rename', {
            from: known,
            to: value.path,
            fileId: value.fileId,
          })
        }
      } catch (error: unknown) {
        this.pendingFsRenames.delete(canonicalTarget)
        console.error('[kuroflare] failed to materialize meta rename', {
          from: known,
          to: value.path,
          error: safeLogError(error),
        })
      }
    }
  }

  private materializeMetaDeletes(): void {
    for (const [fileId, value] of this.metaMap.entries()) {
      if (!isMetaFile(value, fileId) || !value.deleted) {
        continue
      }
      const known = this.materializedPaths.get(value.fileId)
      if (!this.isActiveMetaEntry(value, known)) {
        continue
      }
      this.materializedPaths.set(value.fileId, value.path)
      this.showActiveRemoteDeleteNotice(value)
    }
  }

  private isActiveMetaEntry(value: MetaFile, knownPath: string | undefined): boolean {
    const activePath = this.activeFile?.path
    if (activePath !== undefined && (knownPath === activePath || value.path === activePath)) {
      return true
    }
    const activeYDocId = this.activeTextDoc?.docId.ydocId
    return value.type === 'text' && activeYDocId !== undefined && value.ydocId === activeYDocId
  }

  private showActiveRemoteDeleteNotice(value: MetaFile): void {
    if (this.activeRemoteDeletedFileIds.has(value.fileId)) {
      return
    }
    this.activeRemoteDeletedFileIds.add(value.fileId)
    this.syncStatusEl?.setText(`Kuroflare sync: remote tombstone ${value.path}`)
    new Notice('Kuroflare sync: active file was deleted remotely; local editor kept open')
    console.warn('[kuroflare] active file kept open after remote tombstone', {
      path: value.path,
      fileId: value.fileId,
      deletedAt: 'deletedAt' in value ? value.deletedAt : undefined,
      deletedBy: 'deletedBy' in value ? value.deletedBy : undefined,
    })
  }

  private async requestMissingRemoteTextFile(value: {
    readonly type: unknown
    readonly path: string
    readonly ydocId?: unknown
  }): Promise<void> {
    if (value.type !== 'text' || typeof value.ydocId !== 'string') {
      return
    }
    if (!v.is(VaultRelativePathSchema, value.path)) {
      console.warn('[kuroflare] skipped remote text request for invalid path', { path: value.path })
      return
    }
    if (this.app.vault.getAbstractFileByPath(value.path) instanceof TFile) {
      return
    }
    const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(value.ydocId) }
    const loaded = await this.loadTextDoc(docId)
    this.pendingRemoteTextFiles.set(docId.ydocId, value.path)
    await this.requestDocFromWorker(
      docId,
      Y.encodeStateVector(loaded.doc),
      'meta-missing-text-file',
    )
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'kuroflare-spike-bind-active-editor',
      name: 'Kuroflare spike: bind active editor',
      callback: () => {
        void this.bindActiveMarkdownView('command')
      },
    })

    this.addCommand({
      id: 'kuroflare-spike-flush-ytext-to-disk',
      name: 'Kuroflare spike: flush YText to disk',
      callback: () => {
        void this.flushYTextToDisk('command')
      },
    })

    this.addCommand({
      id: 'kuroflare-spike-simulate-remote-insert',
      name: 'Kuroflare spike: simulate remote insert',
      callback: () => {
        this.ydoc.transact(() => {
          this.ytext.insert(this.ytext.length, `\nremote ${new Date().toISOString()}`)
        }, REMOTE_ORIGIN)
      },
    })

    this.addCommand({
      id: 'kuroflare-spike-log-state',
      name: 'Kuroflare spike: log state',
      callback: () => {
        void this.logState()
      },
    })

    this.addCommand({
      id: 'kuroflare-sync-run-startup-tick',
      name: 'Kuroflare sync: run startup tick',
      callback: () => {
        void this.runSyncStartupTick('command')
      },
    })

    this.addCommand({
      id: 'kuroflare-sync-send-active-file-update',
      name: 'Kuroflare sync: send active file update',
      callback: () => {
        void this.sendCurrentYDocToWorker('command')
      },
    })

    this.addCommand({
      id: 'kuroflare-sync-import-and-send-active-file',
      name: 'Kuroflare sync: import and send active file',
      callback: () => {
        void this.importActiveFileFromDiskAndSend('command')
      },
    })
  }

  private async logState(): Promise<void> {
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

  private createSyncRuntime(): SyncRuntimeObsidianComposition {
    const settingsReader = {
      readSettings: async () => ({
        endpoint: this.kuroflareSettings.endpoint,
        setupVaultId: this.kuroflareSettings.setupVaultId,
        setupToken: this.kuroflareSettings.setupToken,
        requestedDeviceName: this.kuroflareSettings.requestedDeviceName,
        setupBootstrapMode: this.kuroflareSettings.setupBootstrapMode,
        existingDeviceId: this.currentSetupDeviceId(),
      }),
    }
    const setupEvidenceReader = createSyncRuntimeObsidianSetupExchangeEvidenceReader({
      readSettings: (_effect: SetupExchangeStartupEffect) => ({
        endpoint: this.kuroflareSettings.endpoint,
        setupVaultId: this.kuroflareSettings.setupVaultId,
        setupToken: this.kuroflareSettings.setupToken,
        requestedDeviceName: this.kuroflareSettings.requestedDeviceName,
        setupBootstrapMode: this.kuroflareSettings.setupBootstrapMode,
        existingDeviceId: this.currentSetupDeviceId(),
      }),
    })
    const setupExchange = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
      fetch: (input, init) => fetch(input, init),
      readEvidence: (effect) => setupEvidenceReader.readEvidence(effect),
      scheduleReplan: async (request) => {
        this.pendingSetupResponse = request.response
        await this.updateSettings({
          endpoint: request.response.endpoint,
          setupVaultId: request.response.vaultId,
          setupToken: '',
          setupMetadata: localSetupMetadataFromSetupResponse(request.response),
        })
      },
    })

    return createSyncRuntimeObsidianComposition({
      settings: settingsReader,
      local: {
        readLocalEvidence: async () => ({
          metadataSnapshot: await this.readLocalSetupMetadataSnapshot(),
          hasMetaYDoc: this.metaMap.size > 0,
          hasLocalVaultFiles: this.app.vault.getMarkdownFiles().length > 0,
          setupResponse: this.pendingSetupResponse ?? undefined,
        }),
      },
      setupExchange,
      localStore: createSyncRuntimeIndexedDbLocalStoreEffectPort({
        indexedDb: createBrowserLocalStoreIndexedDbFactoryPort(indexedDB),
      }),
      localStoreRebuild: createSyncRuntimeLocalStoreRebuildReplanPort({
        scheduleReplan: async () => {
          await this.runSyncStartupTick('local-store-rebuild')
        },
      }),
      startupStep: this.createStartupStepPort(),
      ui: {
        setStatusText: (text) => {
          this.syncStatusEl?.setText(text)
        },
        showNotice: (text) => {
          new Notice(text)
        },
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
          this.scanLocalVaultForStartup()
        },
        createLocalMetaYDoc: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.createLocalMetaYDocFromStartupScan(`startup:${effect.step}`)
        },
        adoptLocalFilesAfterRemoteMeta: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.adoptLocalFilesAfterRemoteMeta()
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
          this.pendingRemoteMetaSnapshot = await this.fetchLatestSnapshotPayload(
            META_SYNC_DOC_ID,
            `startup:${effect.step}`,
          )
        },
        applyRemoteMetaSnapshot: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          if (this.pendingRemoteMetaSnapshot === null) {
            return
          }
          await this.applyLatestSnapshot(
            META_SYNC_DOC_ID,
            this.pendingRemoteMetaSnapshot,
            `startup:${effect.step}`,
          )
          this.pendingRemoteMetaSnapshot = null
        },
        syncMetaStateVector: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.requestMetaDocFromWorker(`startup:${effect.step}`)
        },
        syncActiveFileStateVector: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.requestActiveFileFromWorker(`startup:${effect.step}`)
        },
      },
      localStore: {
        loadIndexedDbYDocs: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.loadIndexedDbYDocs()
        },
      },
      websocket: {
        openWebSocket: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.openWorkerWebSocket()
        },
        sendClientHello: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.sendWorkerHello()
        },
      },
      outbox: {
        sendMetaUpdate: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.sendMetaDocToWorker(`startup:${effect.step}`)
        },
        enqueueMissingDownloads: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.enqueueMissingDownloads()
        },
        resumeBackgroundQueues: async (effect) => {
          logStep(effect.step, effect.phase, effect.vaultId)
          await this.runOutboxWorkerTick(`startup:${effect.step}`)
        },
      },
    })
  }

  private async runSyncStartupTick(reason: string): Promise<void> {
    const runtime = this.syncRuntime
    if (runtime === null) {
      return
    }

    const result = await runtime.lifecycle.runStartupTick()
    console.info('[kuroflare] sync startup tick', {
      reason,
      status: result.driver.state.shell.status,
      repairEntries: this.syncRepairEntries,
      retryEnabled: this.syncRetryEnabled,
      setupExchangeCompleted: result.driver.setupExchangeReplan !== undefined,
      completedEffects: result.driver.state.shell.completedEffects.length,
    })
  }

  private async handleLifecycleResume(reason: string): Promise<void> {
    if (document.hidden || this.syncStoppedByAuth !== null) {
      return
    }
    await this.runSyncStartupTick(reason)
    await this.handleForegroundResume(reason)
    void this.runOutboxWorkerTick(`lifecycle:${reason}`)
  }

  private async persistPendingSetupResponse(): Promise<void> {
    const response = this.pendingSetupResponse
    if (response === null) {
      throw new Error('setup-response-missing')
    }
    const accessTokenExpiresAt = accessTokenExpiresAtFromJwt(response.accessToken)
    if (accessTokenExpiresAt === undefined) {
      throw new Error('setup-access-token-expiry-missing')
    }
    const db = await this.openLocalStoreDatabase(response.vaultId)
    const port = createSyncRuntimeSetupPersistStepPort({
      response,
      accessTokenExpiresAt,
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
    this.pendingSetupResponse = null
    const setupMetadata = localSetupMetadataFromSetupResponse(response)
    this.trustedSetupMetadata = setupMetadata
    await this.updateSettings({
      endpoint: response.endpoint,
      setupVaultId: response.vaultId,
      setupToken: '',
      setupMetadata,
    })
  }

  private async readLocalSetupMetadataSnapshot() {
    const vaultId = this.currentSetupVaultIdHint()
    if (vaultId === undefined) {
      return undefined
    }
    try {
      const db = await this.openLocalStoreDatabase(vaultId)
      const snapshot = await readLocalStoreIndexedDbMetadataSnapshot({
        database: createLocalStoreIndexedDbMetadataDatabasePort(db),
      })
      if (snapshot.ok) {
        this.trustedSetupMetadata = snapshot.snapshot.setup
        if (
          !sameLocalSetupMetadata(this.kuroflareSettings.setupMetadata, snapshot.snapshot.setup)
        ) {
          await this.updateSettings({ setupMetadata: snapshot.snapshot.setup })
        }
      }
      return snapshot
    } catch (error: unknown) {
      console.warn('[kuroflare] failed to read local setup metadata', {
        error: safeLogError(error),
      })
      return undefined
    }
  }

  private async loadIndexedDbYDocs(): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      return
    }
    const db = await this.openLocalStoreDatabase(setup.vaultId)
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
      if (!isStoredYDocRecord(record) || record.docId.kind !== 'file') {
        continue
      }
      const loaded = await this.loadTextDoc(record.docId)
      Y.applyUpdate(loaded.doc, record.updateBytes, WORKER_ORIGIN)
    }
  }

  private async openWorkerWebSocket(): Promise<void> {
    if (this.syncStoppedByAuth !== null) {
      return
    }
    const snapshot = this.workerWebSocketSession.snapshot()
    if (snapshot.readyState === WebSocket.OPEN) {
      if (!this.workerHelloAccepted) {
        await this.sendWorkerHello()
      }
      return
    }
    this.workerHelloAccepted = false
    this.workerWebSocketSession.close(1000, 'reconnect')
    this.workerWebSocketStartupPort = this.createWorkerWebSocketStartupPort()
    await this.workerWebSocketStartupPort.openWebSocket({
      kind: 'run-startup-step',
      vaultId: this.requireSetupMetadata().vaultId,
      step: 'open-websocket',
      phase: 'websocket',
    })
    await this.sendWorkerHello()
  }

  private async sendWorkerHello(): Promise<void> {
    if (this.workerHelloAccepted) {
      return
    }
    const setup = this.requireSetupMetadata()
    const port = this.workerWebSocketStartupPort ?? this.createWorkerWebSocketStartupPort()
    this.workerWebSocketStartupPort = port
    await port.sendClientHello({
      kind: 'run-startup-step',
      vaultId: setup.vaultId,
      step: 'send-client-hello',
      phase: 'websocket',
    })
    this.workerHelloAccepted = true
    this.syncStatusEl?.setText(`Kuroflare sync: connected ${setup.vaultId}`)
    await this.requestMetaDocFromWorker('hello-accepted')
    await this.requestActiveFileFromWorker('hello-accepted')
    await this.requestPendingRemoteTextFilesFromWorker('hello-accepted')
    void this.runOutboxWorkerTick('hello-accepted')
  }

  private createWorkerWebSocketStartupPort(): SyncRuntimeWebSocketStartupStepPort {
    const setup = this.requireSetupMetadata()
    return createSyncRuntimeWebSocketStartupStepPort({
      metadata: {
        setup,
        accessTokenSecretKey: accessTokenSecretKeyForSetup(setup),
      },
      tokenReader: {
        getAccessToken: async (key) => {
          return await this.readAccessToken(key)
        },
      },
      webSocket: createBrowserSyncRuntimeWebSocketFactory(WebSocket),
      capabilities: [],
      session: this.workerWebSocketSession,
      onInboundMessage: (message) => {
        void this.handleWorkerInboundMessage(message)
      },
    })
  }

  private async sendCurrentYDocToWorker(reason: string): Promise<void> {
    const loaded = this.activeTextDoc
    if (loaded === null) {
      return
    }
    await this.sendDocUpdateToWorker(loaded.docId, Y.encodeStateAsUpdate(loaded.doc), reason)
  }

  private async publishInitialFileSnapshots(reason: string): Promise<void> {
    for (const loaded of this.loadedTextDocs.values()) {
      await this.importLocalSnapshot(loaded.docId, Y.encodeStateAsUpdate(loaded.doc), reason)
    }
    console.info('[kuroflare] initial file snapshots imported', {
      reason,
      files: this.loadedTextDocs.size,
    })
  }

  private async sendMetaDocToWorker(reason: string): Promise<void> {
    await this.sendDocUpdateToWorker(META_SYNC_DOC_ID, Y.encodeStateAsUpdate(this.metaDoc), reason)
  }

  private async requestActiveFileFromWorker(reason: string): Promise<void> {
    const loaded = this.activeTextDoc
    if (loaded === null) {
      return
    }
    await this.requestDocFromWorker(loaded.docId, Y.encodeStateVector(loaded.doc), reason)
  }

  private async requestMetaDocFromWorker(reason: string): Promise<void> {
    await this.requestDocFromWorker(META_SYNC_DOC_ID, Y.encodeStateVector(this.metaDoc), reason)
  }

  private async requestPendingRemoteTextFilesFromWorker(reason: string): Promise<void> {
    for (const ydocId of this.pendingRemoteTextFiles.keys()) {
      const docId: FileDocId = { kind: 'file', ydocId: makeYDocId(ydocId) }
      const loaded = await this.loadTextDoc(docId)
      await this.requestDocFromWorker(docId, Y.encodeStateVector(loaded.doc), reason)
    }
  }

  private async requestDocFromWorker(
    docId: DocId,
    stateVector: Uint8Array,
    reason: string,
  ): Promise<void> {
    if (
      !this.workerHelloAccepted ||
      this.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN
    ) {
      return
    }
    const setup = this.requireSetupMetadata()
    const sender = createSyncRuntimeWebSocketSyncRequestSendPort({
      session: this.workerWebSocketSession,
    })
    const sent = await sender.sendSyncRequest({
      vaultId: setup.vaultId,
      deviceId: setup.deviceId,
      messageId: this.nextWorkerMessageId(),
      docId,
      stateVector,
    })
    console.info('[kuroflare] requested worker sync state', {
      reason,
      messageId: sent.message.messageId,
      docId,
    })
  }

  private async sendYjsUpdateToWorker(update: Uint8Array, reason: string): Promise<void> {
    const loaded = this.activeTextDoc
    if (loaded === null) {
      return
    }
    await this.sendDocUpdateToWorker(loaded.docId, update, reason)
  }

  private async sendDocUpdateToWorker(
    docId: DocId,
    update: Uint8Array,
    reason: string,
  ): Promise<void> {
    const setup = this.requireSetupMetadata()
    const messageId = this.nextWorkerMessageId()
    const updateSha256 = makeSha256Hex(await this.sha256Hex(update))
    const updateBytesBase64 = encodeBase64(update)
    try {
      await this.persistOutboundYUpdate({
        vaultId: setup.vaultId,
        docId,
        messageId,
        updateSha256,
        updateBytesBase64,
      })
    } catch (error: unknown) {
      console.error('[kuroflare] failed to persist outbound update before send', {
        reason,
        docId,
        messageId,
        error: safeLogError(error),
      })
      return
    }
    void this.runOutboxWorkerTick(reason)
    console.info('[kuroflare] enqueued worker sync update', {
      reason,
      messageId,
      docId,
      bytes: update.byteLength,
    })
  }

  private async persistOutboundYUpdate(input: {
    readonly vaultId: LocalSetupMetadata['vaultId']
    readonly docId: DocId
    readonly messageId: SyncUpdate['messageId']
    readonly updateSha256: NonNullable<SyncUpdate['updateSha256']>
    readonly updateBytesBase64: string
  }): Promise<void> {
    const record: LocalStoreOutboxRecord = {
      id: input.messageId,
      kind: 'y-update',
      status: 'pending',
      dependsOn: [],
      nextAttemptAt: undefined,
      docId: input.docId,
      messageId: input.messageId,
      updateSha256: input.updateSha256,
      updateBytesBase64: input.updateBytesBase64,
      createdAt: Date.now(),
    }
    const db = await this.openLocalStoreDatabase(input.vaultId)
    await this.putOutboxRecord(db, record)
  }

  private async completeOutboundYUpdateFromWorker(message: Ack | NeedFullSnapshot): Promise<void> {
    const setup = this.requireSetupMetadata()
    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const port = createSyncRuntimeWebSocketOutboxCompletionPort({
      ownerId: this.outboxWorkerOwnerId,
      now: () => Date.now(),
      snapshot: {
        read: async () => await this.readOutboxWorkerSnapshot(db),
      },
      commit: {
        commit: async (plan) => {
          await this.commitOutboxWorkerIndexedDbWriteTransaction(
            db,
            planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
          )
        },
      },
    })
    await port.completeOutbox(message)
  }

  private async openLocalStoreDatabase(
    vaultId: LocalSetupMetadata['vaultId'],
  ): Promise<IDBDatabase> {
    const dbName = localStoreIndexedDbName(vaultId)
    if (this.localStoreDb !== null && this.localStoreDbName === dbName) {
      return this.localStoreDb
    }
    this.localStoreDb?.close()
    this.localStoreDb = null
    this.localStoreDbName = null

    const request = indexedDB.open(dbName, LOCAL_STORE_INDEXEDDB_TARGET_VERSION)
    request.onupgradeneeded = () => {
      for (const storeName of DEFAULT_LOCAL_STORE_OBJECT_STORES) {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName)
        }
      }
    }
    const db = await waitForIndexedDbRequest(request)
    this.localStoreDb = db
    this.localStoreDbName = dbName
    return db
  }

  private async rebuildLocalStoreDatabase(vaultId: LocalSetupMetadata['vaultId']): Promise<void> {
    const dbName = localStoreIndexedDbName(vaultId)
    if (this.localStoreDbName === dbName) {
      this.localStoreDb?.close()
      this.localStoreDb = null
      this.localStoreDbName = null
    }
    await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(dbName))
    await this.openLocalStoreDatabase(vaultId)
  }

  private async runOutboxWorkerTick(reason: string): Promise<void> {
    if (this.syncStoppedByAuth !== null) {
      return
    }
    if (document.hidden) {
      return
    }
    if (this.outboxWorkerRunning) {
      return
    }
    if (
      !this.workerHelloAccepted ||
      this.workerWebSocketSession.snapshot().readyState !== WebSocket.OPEN
    ) {
      return
    }
    this.outboxWorkerRunning = true
    try {
      const setup = this.requireSetupMetadata()
      const db = await this.openLocalStoreDatabase(setup.vaultId)
      const snapshot = await this.readOutboxWorkerSnapshot(db)
      const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
        database: createLocalStoreIndexedDbMetadataDatabasePort(db),
      })
      const authMetadata = metadataSnapshot.ok ? metadataSnapshot.snapshot.auth : undefined
      if (authMetadata?.refreshState === 'refreshing') {
        await this.recoverStaleAuthRefreshStart(db, authMetadata)
      }
      const currentMetadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
        database: createLocalStoreIndexedDbMetadataDatabasePort(db),
      })
      const currentAuthMetadata = currentMetadataSnapshot.ok
        ? currentMetadataSnapshot.snapshot.auth
        : undefined
      if (currentAuthMetadata !== undefined && currentAuthMetadata.authState !== 'active') {
        this.stopLocalSyncAfterAuthBlocked(currentAuthMetadata.authState)
        return
      }
      const now = Date.now()
      const resumeEvents = this.consumePendingOutboxResumeEvents()
      const tick = planOutboundQueueTick({
        items: snapshot.outboxRecords,
        now,
        profile: 'desktop',
        resumeEvents,
        leases: snapshot.leaseRows,
        maxStarts: OUTBOX_WORKER_MAX_STARTS,
        auth: schedulerAuthGateFromMetadata(currentAuthMetadata),
        authRefreshState: outboxAuthRefreshStateFromMetadata(currentAuthMetadata),
      })
      if (!tick.ok) {
        console.warn('[kuroflare] outbox queue tick skipped', {
          reason,
          failure: tick.reason,
          id: tick.id,
        })
        return
      }
      const workerTick = planOutboxWorkerTick({
        tick,
        currentOutboxRecords: snapshot.outboxRecords,
        currentLeaseRows: snapshot.leaseRows,
        ownerId: this.outboxWorkerOwnerId,
        now,
        leaseDurationMs: OUTBOX_WORKER_LEASE_DURATION_MS,
      })
      if (!workerTick.ok) {
        console.warn('[kuroflare] outbox worker tick skipped', {
          reason,
          phase: workerTick.phase,
          failure: workerTick.reason,
        })
        return
      }
      for (const transaction of planOutboxWorkerTickIndexedDbWriteTransactions(workerTick)) {
        await this.commitOutboxWorkerIndexedDbWriteTransaction(db, transaction)
      }
      if (tick.authRefresh.action === 'request-refresh') {
        await this.runAuthRefreshRequest(tick.authRefresh)
      }
      const nextSnapshot = await this.readOutboxWorkerSnapshot(db)
      const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
      const sender = createSyncRuntimeWebSocketOutboxSendPort({
        session: this.workerWebSocketSession,
      })
      for (const effect of workerTick.starts) {
        const record = nextSnapshot.outboxRecords.find(
          (candidate) => candidate.id === effect.start.id,
        )
        if (record === undefined) {
          continue
        }
        if (record.kind === 'y-update') {
          const send = await sender.sendSyncUpdate({
            record,
            vaultId: setup.vaultId,
            deviceId: setup.deviceId,
          })
          if (!send.ok) {
            console.warn('[kuroflare] outbox websocket send rejected', {
              reason: send.reason,
              itemId: effect.start.id,
            })
            await this.completeLeasedOutboxFailure(db, record, { kind: 'invalid-payload' })
          }
          continue
        }
        const sideEffect = planOutboxWorkerSideEffect({
          effect,
          record,
          endpoint: setup.endpoint,
          accessToken,
        })
        if (!sideEffect.ok) {
          console.warn('[kuroflare] outbox side effect skipped', {
            reason: sideEffect.reason,
            itemId: effect.start.id,
          })
          await this.completeLeasedOutboxFailure(
            db,
            record,
            sideEffect.reason === 'missing-access-token'
              ? { kind: 'auth' }
              : { kind: 'invalid-payload' },
          )
          continue
        }
        if (sideEffect.action === 'blob-put') {
          const result = await this.runBlobPutSideEffect(sideEffect)
          await this.completeNonAckSideEffect(db, record, result)
          continue
        }
        if (sideEffect.action === 'blob-get') {
          const result = await this.runBlobGetSideEffect(sideEffect)
          await this.completeNonAckSideEffect(db, record, result)
          continue
        }
        if (sideEffect.action === 'manifest-put') {
          const result = await this.runManifestPutSideEffect(sideEffect)
          await this.completeNonAckSideEffect(db, record, result)
          continue
        }
        if (sideEffect.action === 'materialize') {
          const result = await this.runMaterializeSideEffect(sideEffect)
          await this.completeNonAckSideEffect(db, record, result)
          continue
        }
        if (sideEffect.action !== 'meta-ref-update') {
          continue
        }
        const send = await sender.sendSyncUpdate({
          record,
          vaultId: setup.vaultId,
          deviceId: setup.deviceId,
        })
        if (!send.ok) {
          console.warn('[kuroflare] outbox websocket send rejected', {
            reason: send.reason,
            itemId: effect.start.id,
          })
          await this.completeLeasedOutboxFailure(db, record, { kind: 'invalid-payload' })
        }
      }
      if (workerTick.starts.length > 0) {
        this.scheduleOutboxWorkerTick(OUTBOX_WORKER_LEASE_DURATION_MS + 250, 'lease-expiry-retry')
      }
    } catch (error: unknown) {
      console.error('[kuroflare] outbox worker tick failed', { reason, error: safeLogError(error) })
    } finally {
      this.outboxWorkerRunning = false
    }
  }

  private scheduleOutboxWorkerTick(delayMs: number, reason: string): void {
    if (this.outboxWorkerRetryTimeout !== null) {
      return
    }
    this.outboxWorkerRetryTimeout = window.setTimeout(() => {
      this.outboxWorkerRetryTimeout = null
      void this.runOutboxWorkerTick(reason)
    }, delayMs)
  }

  private async handleForegroundResume(reason: string): Promise<void> {
    if (this.foregroundResumeRunning || this.syncStoppedByAuth !== null || document.hidden) {
      return
    }
    if (this.currentSetupMetadata() === undefined) {
      return
    }
    this.foregroundResumeRunning = true
    try {
      await this.bindActiveMarkdownView(`foreground-resume:${reason}`)
      await this.openWorkerWebSocket()
      await this.requestMetaDocFromWorker(`foreground-resume:${reason}`)
      await this.requestActiveFileFromWorker(`foreground-resume:${reason}`)
      await this.requestPendingRemoteTextFilesFromWorker(`foreground-resume:${reason}`)
      void this.runOutboxWorkerTick(`foreground-resume:${reason}`)
    } catch (error: unknown) {
      console.warn('[kuroflare] foreground resume failed', { reason, error: safeLogError(error) })
    } finally {
      this.foregroundResumeRunning = false
    }
  }

  private consumePendingOutboxResumeEvents(): readonly OutboxResumeEvent[] {
    const events = this.pendingOutboxResumeEvents
    this.pendingOutboxResumeEvents = []
    return events
  }

  private async recoverStaleAuthRefreshStart(
    db: IDBDatabase,
    metadata: ClientAuthMetadata,
  ): Promise<void> {
    const recovery = await recoverStaleAuthRefreshStart({
      metadata,
      now: Date.now(),
      staleAfterMs: AUTH_REFRESH_STALE_AFTER_MS,
      metadataStore: createAuthRefreshMetadataPort(db, this.requireSetupMetadata()),
    })
    if (!recovery.ok && recovery.phase !== 'recovery') {
      console.warn('[kuroflare] stale auth refresh recovery failed', { phase: recovery.phase })
    }
  }

  private async runAuthRefreshRequest(request: OutboxAuthRefreshRequestDecision): Promise<void> {
    if (request.action !== 'request-refresh' || this.authRefreshRunning) {
      return
    }
    this.authRefreshRunning = true
    try {
      const setup = this.requireSetupMetadata()
      const db = await this.openLocalStoreDatabase(setup.vaultId)
      const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
        database: createLocalStoreIndexedDbMetadataDatabasePort(db),
      })
      if (!metadataSnapshot.ok) {
        console.warn('[kuroflare] auth refresh skipped without trusted metadata', {
          reason: metadataSnapshot.reason,
        })
        return
      }

      const metadataStore = createAuthRefreshMetadataPort(db, metadataSnapshot.snapshot.setup)
      const start = await persistAuthRefreshStart({
        metadata: metadataSnapshot.snapshot.auth,
        request,
        metadataStore,
      })
      if (!start.ok) {
        console.warn('[kuroflare] auth refresh start rejected', { phase: start.phase })
        return
      }

      const attempt = await runAuthRefreshAttempt({
        endpoint: setup.endpoint,
        vaultId: setup.vaultId,
        metadata: start.refreshStart.metadata,
        requiredScopes: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
        now: Date.now(),
        secretStorage: createObsidianAuthRefreshSecretStoragePort(this.app.secretStorage),
        http: createAuthRefreshHttpPort(setup),
        verifier: {
          async verify(accessToken) {
            return parseAccessTokenClaimsFromJwt(accessToken)
          },
        },
        metadataStore,
      })
      if (attempt.ok) {
        this.syncStoppedByAuth = null
        this.pendingOutboxResumeEvents.push(attempt.emitResumeEvent)
        const refreshedSetup = { ...setup, tokenVersion: attempt.response.tokenVersion }
        this.trustedSetupMetadata = refreshedSetup
        await this.updateSettings({
          setupMetadata: refreshedSetup,
        })
        this.syncStatusEl?.setText(`Kuroflare sync: auth refreshed ${setup.vaultId}`)
        this.scheduleOutboxWorkerTick(0, 'auth-refresh')
        return
      }
      console.warn('[kuroflare] auth refresh attempt failed', { phase: attempt.phase })
      if (
        'metadataPatch' in attempt &&
        attempt.metadataPatch?.action === 'apply' &&
        attempt.metadataPatch.metadata.authState !== 'active'
      ) {
        this.stopLocalSyncAfterAuthBlocked(attempt.metadataPatch.metadata.authState)
        return
      }
      const nextAllowedRefreshAt = nextAllowedRefreshAtFromFailedAuthRefresh(attempt)
      if (nextAllowedRefreshAt !== undefined) {
        this.scheduleAuthRefreshRetry(Math.max(0, nextAllowedRefreshAt - Date.now()))
      }
    } finally {
      this.authRefreshRunning = false
    }
  }

  private scheduleAuthRefreshRetry(delayMs: number): void {
    if (this.authRefreshRetryTimeout !== null) {
      return
    }
    this.authRefreshRetryTimeout = window.setTimeout(() => {
      this.authRefreshRetryTimeout = null
      void this.runOutboxWorkerTick('auth-refresh-backoff')
    }, delayMs)
  }

  async revokeCurrentDeviceAfterConfirmation(confirmation: string): Promise<void> {
    if (confirmation.trim() !== DEVICE_REVOKE_CONFIRMATION) {
      new Notice(`Kuroflare auth: type ${DEVICE_REVOKE_CONFIRMATION} to revoke this device`)
      return
    }
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare auth: setup metadata is missing')
      return
    }
    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const metadataSnapshot = await readLocalStoreIndexedDbMetadataSnapshot({
      database: createLocalStoreIndexedDbMetadataDatabasePort(db),
    })
    if (!metadataSnapshot.ok) {
      new Notice('Kuroflare auth: local auth metadata is missing')
      console.warn('[kuroflare] device revoke skipped without trusted metadata', {
        reason: metadataSnapshot.reason,
      })
      return
    }
    const accessTokenSecretKey = metadataSnapshot.snapshot.auth.accessTokenSecretKey
    const accessToken =
      accessTokenSecretKey === undefined
        ? undefined
        : await this.readAccessToken(accessTokenSecretKey)
    if (accessToken === undefined) {
      new Notice('Kuroflare auth: access token is missing')
      return
    }

    const response = await fetch(deviceRevokeUrl(setup), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'obsidian-plugin-self-revoke' }),
    })
    if (!response.ok) {
      new Notice(`Kuroflare auth: revoke failed (${response.status})`)
      console.warn('[kuroflare] device revoke failed', { status: response.status })
      return
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!v.is(RevokeDeviceResponseSchema, body)) {
      new Notice('Kuroflare auth: invalid revoke response')
      console.warn('[kuroflare] device revoke response rejected by guard')
      return
    }

    await this.persistLocalDeviceRevoke(
      db,
      metadataSnapshot.snapshot.auth,
      body,
      metadataSnapshot.snapshot.setup,
    )
  }

  private async persistLocalDeviceRevoke(
    db: IDBDatabase,
    metadata: ClientAuthMetadata,
    response: unknown,
    setup: LocalSetupMetadata,
  ): Promise<void> {
    const result = await persistLocalDeviceRevoke({
      response,
      metadata,
      secretStorage: createObsidianAuthRevokeSecretStoragePort(this.app.secretStorage),
      metadataStore: createAuthRevokeMetadataPort(db, setup),
    })
    if (!result.ok) {
      new Notice(`Kuroflare auth: local revoke failed (${result.phase})`)
      console.warn('[kuroflare] local device revoke failed', { phase: result.phase })
      return
    }
    const revokedSetup = { ...setup, tokenVersion: result.response.tokenVersion }
    this.trustedSetupMetadata = revokedSetup
    await this.updateSettings({
      setupMetadata: revokedSetup,
    })
    this.stopLocalSyncAfterAuthBlocked('revoked')
    new Notice('Kuroflare auth: this device was revoked and sync is stopped')
  }

  private stopLocalSyncAfterAuthBlocked(reason: ClientAuthMetadata['authState']): void {
    this.workerWebSocketSession.close(1000, reason)
    this.syncStoppedByAuth = reason
    this.workerHelloAccepted = false
    this.workerWebSocketStartupPort = null
    this.pendingOutboxResumeEvents = []
    if (this.outboxWorkerRetryTimeout !== null) {
      window.clearTimeout(this.outboxWorkerRetryTimeout)
      this.outboxWorkerRetryTimeout = null
    }
    if (this.authRefreshRetryTimeout !== null) {
      window.clearTimeout(this.authRefreshRetryTimeout)
      this.authRefreshRetryTimeout = null
    }
    this.syncStatusEl?.setText(`Kuroflare sync: ${reason}`)
  }

  private async runManifestPutSideEffect(
    sideEffect: OutboxWorkerManifestPutSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    try {
      const response = await fetch(sideEffect.putManifestRequest.url, {
        method: sideEffect.putManifestRequest.method,
        headers: sideEffect.putManifestRequest.headers,
        body: JSON.stringify(sideEffect.putManifestRequest.bodyJson),
      })
      if (response.ok) {
        return { kind: 'success' }
      }
      return {
        kind: 'http-response',
        status: response.status,
        retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
        code: await responseErrorCode(response),
      }
    } catch (error: unknown) {
      console.warn('[kuroflare] manifest put failed before HTTP response', {
        itemId: sideEffect.itemId,
        error: safeLogError(error),
      })
      return { kind: 'network-error' }
    }
  }

  private async runBlobPutSideEffect(
    sideEffect: OutboxWorkerBlobPutSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    const bytes = await this.readBlobCacheBytes(
      sideEffect.readLocalCache.key,
      sideEffect.readLocalCache.expectedSha256,
      sideEffect.readLocalCache.expectedSize,
    )
    if (bytes === undefined) {
      return { kind: 'invalid-payload', code: 'local-cache-read-failed' }
    }

    const head = await this.fetchJsonSideEffect(sideEffect.headRequest)
    if (head.kind !== 'success') {
      return head
    }
    if (!v.is(BlobHeadResponseSchema, head.body)) {
      return { kind: 'invalid-payload', code: 'blob-head-response-invalid' }
    }
    const entry = head.body.exists[sideEffect.blob.sha256]
    if (entry?.found === true) {
      if (entry.size !== undefined && entry.size !== sideEffect.blob.size) {
        return { kind: 'invalid-payload', code: 'blob-head-size-mismatch' }
      }
      return { kind: 'success' }
    }

    const uploadUrl = await this.fetchJsonSideEffect(sideEffect.uploadUrlRequest)
    if (uploadUrl.kind !== 'success') {
      return uploadUrl
    }
    if (!v.is(BlobUploadUrlResponseSchema, uploadUrl.body)) {
      return { kind: 'invalid-payload', code: 'blob-upload-url-response-invalid' }
    }
    if (uploadUrl.body.kind === 'already-exists') {
      return { kind: 'success' }
    }
    if (uploadUrl.body.kind === 'multipart') {
      return { kind: 'invalid-payload', code: 'blob-upload-multipart-unimplemented' }
    }

    try {
      const response = await fetch(uploadUrl.body.url, {
        method: sideEffect.uploadPut.method,
        headers: {
          ...uploadUrl.body.headers,
          authorization: sideEffect.uploadUrlRequest.headers.authorization ?? '',
        },
        body: arrayBufferFromBytes(bytes),
      })
      if (response.ok) {
        return { kind: 'success' }
      }
      return await this.httpFailureResult(response)
    } catch (error: unknown) {
      console.warn('[kuroflare] blob put failed before HTTP response', {
        itemId: sideEffect.itemId,
        error: safeLogError(error),
      })
      return { kind: 'network-error' }
    }
  }

  private async runBlobGetSideEffect(
    sideEffect: OutboxWorkerBlobGetSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    let response: Response
    try {
      response = await fetch(sideEffect.downloadRequest.url, {
        method: sideEffect.downloadRequest.method,
        headers: sideEffect.downloadRequest.headers,
      })
    } catch (error: unknown) {
      console.warn('[kuroflare] blob get failed before HTTP response', {
        itemId: sideEffect.itemId,
        error: safeLogError(error),
      })
      return { kind: 'network-error' }
    }
    if (!response.ok) {
      return await this.httpFailureResult(response)
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (
      !(await this.blobBytesMatch(
        bytes,
        sideEffect.writeLocalCache.expectedSha256,
        sideEffect.writeLocalCache.expectedSize,
      ))
    ) {
      return { kind: 'invalid-payload', code: 'blob-download-mismatch' }
    }
    await this.writeBlobCacheBytes(sideEffect.writeLocalCache.key, bytes)
    return { kind: 'success' }
  }

  private async runMaterializeSideEffect(
    sideEffect: OutboxWorkerMaterializeSideEffectPlan,
  ): Promise<OutboxWorkerSideEffectResultEvidence> {
    const chunks = new Map<NonNullable<LocalStoreOutboxRecord['blobSha256']>, Uint8Array>()
    for (const chunk of sideEffect.readChunks) {
      const bytes = await this.readBlobCacheBytes(chunk.key, chunk.sha256, chunk.expectedSize)
      if (bytes === undefined) {
        return { kind: 'invalid-payload', code: 'materialize-cache-read-failed' }
      }
      chunks.set(chunk.sha256, bytes)
    }

    let assembled: Uint8Array
    try {
      assembled = await assembleBlobBytes(sideEffect.manifest, chunks)
    } catch {
      return { kind: 'invalid-payload', code: 'materialize-assembly-failed' }
    }
    if (
      !(await this.blobBytesMatch(
        assembled,
        sideEffect.assemble.expectedContentSha256,
        sideEffect.assemble.expectedSize,
      ))
    ) {
      return { kind: 'invalid-payload', code: 'materialize-assembled-mismatch' }
    }

    const existing = this.app.vault.getAbstractFileByPath(sideEffect.diskCas.path)
    if (existing instanceof TFolder) {
      return { kind: 'local-conflict' }
    }
    if (existing instanceof TFile) {
      const currentDiskBytes = new Uint8Array(
        await this.app.vault.adapter.readBinary(sideEffect.diskCas.path),
      )
      const decision = decideMaterializeWrite({
        path: sideEffect.diskCas.path,
        activeFilePath: this.activeFile?.path,
        currentDiskHash: makeSha256Hex(await this.sha256Hex(currentDiskBytes)),
        lastMaterialized: sideEffect.diskCas.lastMaterialized,
      })
      if (decision.action !== 'write') {
        return { kind: 'local-conflict' }
      }
    } else if (!(await this.ensureVaultParentFolders(sideEffect.writeVaultFile.path))) {
      return { kind: 'local-conflict' }
    }

    await this.app.vault.adapter.writeBinary(
      sideEffect.writeVaultFile.path,
      arrayBufferFromBytes(assembled),
    )
    this.lastMaterialized.set(sideEffect.writeVaultFile.path, {
      diskHash: sideEffect.expectedContentSha256,
      ydocHash: sideEffect.expectedContentSha256,
      path: sideEffect.writeVaultFile.path,
      writtenAt: Date.now(),
    })
    return { kind: 'success' }
  }

  private async fetchJsonSideEffect(
    request: OutboxWorkerManifestPutSideEffectPlan['putManifestRequest'],
  ): Promise<
    | { readonly kind: 'success'; readonly body: unknown }
    | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
  > {
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      }
      if (request.bodyJson !== undefined) {
        init.body = JSON.stringify(request.bodyJson)
      }
      const response = await fetch(request.url, init)
      if (!response.ok) {
        return await this.httpFailureResult(response)
      }
      return { kind: 'success', body: await response.json().catch(() => undefined) }
    } catch (error: unknown) {
      console.warn('[kuroflare] JSON side effect failed before HTTP response', {
        error: safeLogError(error),
      })
      return { kind: 'network-error' }
    }
  }

  private async httpFailureResult(
    response: Response,
  ): Promise<Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>> {
    return {
      kind: 'http-response',
      status: response.status,
      retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
      code: await responseErrorCode(response),
    }
  }

  private async readBlobCacheBytes(
    key: string,
    expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
    expectedSize: number,
  ): Promise<Uint8Array | undefined> {
    try {
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(key))
      return (await this.blobBytesMatch(bytes, expectedSha256, expectedSize)) ? bytes : undefined
    } catch {
      return undefined
    }
  }

  private async writeBlobCacheBytes(key: string, bytes: Uint8Array): Promise<void> {
    await this.ensureAdapterParentFolders(key)
    await this.app.vault.adapter.writeBinary(key, arrayBufferFromBytes(bytes))
  }

  private async ensureAdapterParentFolders(path: string): Promise<void> {
    const segments = path.split('/').slice(0, -1)
    let current = ''
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current)
      }
    }
  }

  private async ensureVaultParentFolders(path: string): Promise<boolean> {
    const segments = path.split('/').slice(0, -1)
    let current = ''
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      const existing = this.app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFolder) {
        continue
      }
      if (existing !== null) {
        return false
      }
      await this.app.vault.adapter.mkdir(current)
    }
    return true
  }

  private async blobBytesMatch(
    bytes: Uint8Array,
    expectedSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
    expectedSize: number,
  ): Promise<boolean> {
    return (
      bytes.byteLength === expectedSize &&
      makeSha256Hex(await this.sha256Hex(bytes)) === expectedSha256
    )
  }

  private async completeNonAckSideEffect(
    db: IDBDatabase,
    record: LocalStoreOutboxRecord,
    result: OutboxWorkerSideEffectResultEvidence,
  ): Promise<void> {
    const snapshot = await this.readOutboxWorkerSnapshot(db)
    const currentRecord =
      snapshot.outboxRecords.find((candidate) => candidate.id === record.id) ?? record
    const evidence = classifyOutboxWorkerSideEffectCompletionEvidence({
      itemId: currentRecord.id,
      kind: currentRecord.kind,
      status: currentRecord.status,
      retryCount: currentRecord.retryCount ?? 0,
      result,
    })
    const plan = evidence.ok
      ? planOutboxWorkerSuccessCompletion({
          itemId: evidence.itemId,
          kind: evidence.kind,
          status: evidence.status,
          ownerId: this.outboxWorkerOwnerId,
          now: Date.now(),
          currentOutboxRecords: snapshot.outboxRecords,
          currentLeaseRows: snapshot.leaseRows,
        })
      : planOutboxWorkerFailureCompletion({
          itemId: evidence.itemId,
          kind: evidence.kind,
          retryCount: evidence.retryCount,
          error: evidence.error,
          ownerId: this.outboxWorkerOwnerId,
          now: Date.now(),
          currentOutboxRecords: snapshot.outboxRecords,
          currentLeaseRows: snapshot.leaseRows,
        })
    if (!plan.ok) {
      console.warn('[kuroflare] outbox side effect completion rejected', {
        itemId: currentRecord.id,
        reason: plan.reason,
      })
      return
    }
    await this.commitOutboxWorkerIndexedDbWriteTransaction(
      db,
      planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
    )
    if (plan.action === 'retry-after-failure') {
      this.scheduleOutboxWorkerTick(1_000, 'side-effect-retry')
    }
  }

  private async completeLeasedOutboxFailure(
    db: IDBDatabase,
    record: LocalStoreOutboxRecord,
    error: OutboxRunError,
  ): Promise<void> {
    const snapshot = await this.readOutboxWorkerSnapshot(db)
    const currentRecord =
      snapshot.outboxRecords.find((candidate) => candidate.id === record.id) ?? record
    const plan = planOutboxWorkerFailureCompletion({
      itemId: currentRecord.id,
      kind: currentRecord.kind,
      retryCount: currentRecord.retryCount ?? 0,
      error,
      ownerId: this.outboxWorkerOwnerId,
      now: Date.now(),
      currentOutboxRecords: snapshot.outboxRecords,
      currentLeaseRows: snapshot.leaseRows,
    })
    if (!plan.ok) {
      console.warn('[kuroflare] outbox failure completion rejected', {
        itemId: currentRecord.id,
        reason: plan.reason,
      })
      return
    }
    await this.commitOutboxWorkerIndexedDbWriteTransaction(
      db,
      planOutboxWorkerCompletionIndexedDbWriteTransaction(plan),
    )
    if (plan.action === 'retry-after-failure') {
      this.scheduleOutboxWorkerTick(1_000, 'side-effect-retry')
    }
  }

  private async readOutboxWorkerSnapshot(db: IDBDatabase): Promise<{
    readonly outboxRecords: readonly LocalStoreOutboxRecord[]
    readonly leaseRows: readonly OutboxRunningLease[]
  }> {
    const transaction = db.transaction(['outbox', 'running-leases'], 'readonly')
    const outboxRequest = transaction.objectStore('outbox').getAll()
    const leasesRequest = transaction.objectStore('running-leases').getAll()
    const [outboxValues, leaseValues] = await Promise.all([
      waitForIndexedDbRequest(outboxRequest),
      waitForIndexedDbRequest(leasesRequest),
    ])
    await waitForIndexedDbTransaction(transaction)
    return {
      outboxRecords: outboxValues.filter(isLocalStoreOutboxRecord),
      leaseRows: leaseValues.filter(isOutboxRunningLease),
    }
  }

  private async commitOutboxWorkerIndexedDbWriteTransaction(
    db: IDBDatabase,
    transaction: OutboxWorkerIndexedDbWriteTransaction,
  ): Promise<void> {
    await commitLocalStoreIndexedDbConcreteWriteTransaction({
      database: createLocalStoreIndexedDbDatabasePort(db),
      writes: transaction.writes,
    })
  }

  private async putOutboxRecord(db: IDBDatabase, record: LocalStoreOutboxRecord): Promise<void> {
    const transaction = db.transaction(['outbox'], 'readwrite')
    const request = transaction.objectStore('outbox').put(record, record.id)
    await waitForIndexedDbRequest(request)
    await waitForIndexedDbTransaction(transaction)
  }

  private async putOutboxRecords(
    db: IDBDatabase,
    records: readonly LocalStoreOutboxRecord[],
  ): Promise<void> {
    const transaction = db.transaction(['outbox'], 'readwrite')
    const store = transaction.objectStore('outbox')
    await Promise.all(
      records.map((record) => waitForIndexedDbRequest(store.put(record, record.id))),
    )
    await waitForIndexedDbTransaction(transaction)
  }

  private async handleWorkerInboundMessage(
    inbound: SyncRuntimeWebSocketInboundMessage,
  ): Promise<void> {
    const setup = this.requireSetupMetadata()
    await dispatchSyncRuntimeWebSocketInboundMessage({
      inbound,
      vaultId: setup.vaultId,
      deviceId: setup.deviceId,
      ports: {
        completeOutbox: async (message) => {
          if (message.type === 'need-full-snapshot') {
            await this.completeOutboundYUpdateFromWorker(message).catch((error: unknown) => {
              console.error('[kuroflare] failed to pause outbound update for full snapshot', {
                docId: message.docId,
                error: safeLogError(error),
              })
            })
            await this.fetchAndApplyFullSnapshot(message)
            return
          }
          console.info('[kuroflare] worker ack', {
            messageId: message.messageId,
            durableSeq: message.durableSeq,
          })
          await this.completeOutboundYUpdateFromWorker(message).catch((error: unknown) => {
            console.error('[kuroflare] failed to mark outbound update acked', {
              messageId: message.messageId,
              error: safeLogError(error),
            })
          })
          void this.runOutboxWorkerTick('ack')
          this.syncStatusEl?.setText(`Kuroflare sync: ack ${message.durableSeq}`)
        },
        applyRemoteUpdate: async (message) => {
          await this.applyWorkerSyncUpdate(message)
        },
        answerSyncRequest: async (message) => {
          await this.answerWorkerSyncRequest(message)
        },
        drop: async (route) => {
          console.warn('[kuroflare] dropped worker websocket message', { reason: route.reason })
        },
      },
    })
  }

  private async fetchAndApplyFullSnapshot(message: NeedFullSnapshot): Promise<void> {
    console.warn('[kuroflare] worker requested full snapshot', {
      reason: message.reason,
      docId: message.docId,
    })
    const snapshot = await this.fetchLatestSnapshotPayload(message.docId, message.reason)
    if (snapshot === null) {
      return
    }
    await this.applyLatestSnapshot(message.docId, snapshot, message.reason)
  }

  private async publishLocalMetaSnapshot(reason: string): Promise<SnapshotImportResponse> {
    const body = await this.importLocalSnapshot(
      META_SYNC_DOC_ID,
      Y.encodeStateAsUpdate(this.metaDoc),
      reason,
    )
    console.info('[kuroflare] local meta snapshot imported', {
      reason,
      snapshotSeq: body.snapshotSeq,
    })
    return body
  }

  private async importLocalSnapshot(
    docId: DocId,
    updateBytes: Uint8Array,
    reason: string,
  ): Promise<SnapshotImportResponse> {
    const setup = this.requireSetupMetadata()
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      throw new Error('snapshot-import-token-missing')
    }

    const response = await fetch(this.snapshotImportUrl(setup, docId), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: encodeBase64(updateBytes),
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
    return body
  }

  private async applyLatestSnapshot(
    docId: DocId,
    snapshot: LatestSnapshotPayload,
    reason: string,
  ): Promise<void> {
    const setup = this.requireSetupMetadata()
    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const localStore = await this.readOutboxWorkerSnapshot(db)
    const plan = planFullSnapshotApplyRuntime({
      requestedDocId: docId,
      response: snapshot.response,
      verifiedBytes: snapshot.verifiedBytes,
      hasPendingLocalUpdates: hasPendingRunnableOutboxUpdate(localStore.outboxRecords, docId),
      activeEditorBound: docId.kind === 'file' && sameDocId(docId, await this.activeDocId()),
      currentOutboxRecords: localStore.outboxRecords,
      currentLeaseRows: localStore.leaseRows,
    })
    if (!plan.ok) {
      console.warn('[kuroflare] latest snapshot apply deferred', {
        action: plan.action,
        reason: plan.reason,
        docId,
      })
      return
    }

    await commitFullSnapshotApplyIndexedDbTransaction({
      database: createFullSnapshotApplyIndexedDbDatabasePort(db),
      transaction: plan.indexedDbWriteTransaction,
    })
    if (docId.kind === 'meta') {
      Y.applyUpdate(this.metaDoc, plan.updateBytes, WORKER_ORIGIN)
      void this.runOutboxWorkerTick(`snapshot:${reason}`)
      return
    }

    const loaded = await this.loadTextDoc(docId)
    Y.applyUpdate(loaded.doc, plan.updateBytes, WORKER_ORIGIN)
    await this.resolvePendingRemoteTextFile(loaded)
    if (sameDocId(docId, await this.activeDocId())) {
      await this.flushYTextToDisk('full-snapshot')
    }
    void this.runOutboxWorkerTick(`snapshot:${reason}`)
  }

  private async fetchLatestSnapshotPayload(
    docId: DocId,
    reason: string,
  ): Promise<LatestSnapshotPayload | null> {
    const setup = this.requireSetupMetadata()
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      console.warn('[kuroflare] latest snapshot fetch skipped without access token', {
        reason,
        docId,
      })
      return null
    }
    const response = await fetch(this.latestSnapshotUrl(setup, docId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
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
    if (!v.is(schema, body)) {
      console.warn('[kuroflare] latest snapshot response rejected by guard', {
        docId,
      })
      return null
    }

    const snapshotResponse = body
    const decoded = await decodeFullSnapshotBytesFromResponse({ response: snapshotResponse })
    if (!decoded.ok) {
      console.warn('[kuroflare] latest snapshot payload rejected', {
        reason: decoded.reason,
        docId,
      })
      return null
    }
    return { response: snapshotResponse, verifiedBytes: decoded }
  }

  private latestSnapshotUrl(setup: LocalSetupMetadata, docId: DocId): string {
    const url = new URL(setup.endpoint)
    if (docId.kind === 'meta') {
      url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/meta/latest`
    } else {
      url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(
        docId.ydocId,
      )}/latest`
    }
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private snapshotImportUrl(setup: LocalSetupMetadata, docId: DocId): string {
    const url = new URL(setup.endpoint)
    if (docId.kind === 'meta') {
      url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/meta/snapshot`
    } else {
      url.pathname = `/vaults/${encodeURIComponent(setup.vaultId)}/files/${encodeURIComponent(
        docId.ydocId,
      )}/snapshot`
    }
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private localOutboxRepairEvidenceUrl(setup: LocalSetupMetadata): string {
    const url = new URL(setup.endpoint)
    url.pathname = '/repair/local-outbox/evidence'
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private quarantineAdminUrl(setup: LocalSetupMetadata, id?: string): string {
    const url = new URL(setup.endpoint)
    url.pathname =
      id === undefined ? '/admin/quarantine' : `/admin/quarantine/${encodeURIComponent(id)}`
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private quarantineAdminActionUrl(
    setup: LocalSetupMetadata,
    id: string,
    action: QuarantineAdminAction,
  ): string {
    const url = new URL(setup.endpoint)
    url.pathname = `/admin/quarantine/${encodeURIComponent(id)}/${action}`
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  private async fetchLocalOutboxRepairEvidence(
    setup: LocalSetupMetadata,
    items: readonly LocalOutboxRepairEvidenceQueryItem[],
  ): Promise<LocalOutboxRepairEvidenceResponse | null> {
    if (items.length === 0) {
      return { durableMessages: [], quarantinedMessages: [] }
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      new Notice('Kuroflare repair: access token is missing')
      return null
    }

    const response = await fetch(this.localOutboxRepairEvidenceUrl(setup), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: items.map((item) =>
          item.updateSha256 === undefined
            ? { docId: item.docId, messageId: item.messageId }
            : { docId: item.docId, messageId: item.messageId, updateSha256: item.updateSha256 },
        ),
      }),
    })
    if (!response.ok) {
      console.warn('[kuroflare] repair evidence fetch failed', { status: response.status })
      new Notice('Kuroflare repair: failed to fetch server evidence')
      return null
    }

    const body: unknown = await response.json().catch(() => undefined)
    if (!v.is(LocalOutboxRepairEvidenceResponseSchema, body)) {
      console.warn('[kuroflare] repair evidence response rejected by guard')
      new Notice('Kuroflare repair: invalid server evidence response')
      return null
    }
    return body
  }

  private async applyWorkerSyncUpdate(message: SyncUpdate): Promise<void> {
    if (message.docId.kind === 'file') {
      await this.loadTextDoc(message.docId)
    }
    const setup = this.requireSetupMetadata()
    const db = await this.openLocalStoreDatabase(setup.vaultId)
    let applied = false
    const ydocPort = createSyncRuntimeWebSocketYjsRemoteUpdateApplyPort({
      registry: {
        getYDoc: (docId) => {
          if (docId.kind === 'meta') {
            return this.metaDoc
          }
          return this.loadedTextDocs.get(docId.ydocId)?.doc
        },
      },
      origin: WORKER_ORIGIN,
    })
    const port = createSyncRuntimeWebSocketRemoteUpdateApplyPort({
      ydoc: {
        applyRemoteUpdate: async (input) => {
          const state = await ydocPort.applyRemoteUpdate(input)
          applied = true
          return state
        },
      },
      commit: createSyncRuntimeWebSocketRemoteUpdateIndexedDbCommitPort(
        createSyncRuntimeWebSocketRemoteUpdateIndexedDbDatabasePort(db),
      ),
      reject: {
        rejectRemoteUpdate: async (rejected, reason) => {
          console.warn('[kuroflare] dropped worker sync update', {
            reason,
            docId: rejected.docId,
            messageId: rejected.messageId,
          })
        },
      },
    })
    await port.applyRemoteUpdate(message)
    if (!applied) {
      return
    }
    if (message.docId.kind === 'meta') {
      return
    }
    const loaded = await this.loadTextDoc(message.docId)
    await this.resolvePendingRemoteTextFile(loaded)
    if (sameDocId(message.docId, await this.activeDocId())) {
      await this.flushYTextToDisk('worker-update')
    }
  }

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
  private async resolvePendingRemoteTextFile(loaded: LoadedTextDoc): Promise<void> {
    const path = this.pendingRemoteTextFiles.get(loaded.docId.ydocId)
    if (path === undefined) {
      return
    }
    if (!v.is(VaultRelativePathSchema, path)) {
      console.warn('[kuroflare] skipped remote text resolution for invalid path', { path })
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
      console.warn('[kuroflare] skipped remote text materialize due to path collision', { path })
      await this.recordRemoteMaterializeBlocked(loaded, path, 'path-collision')
      return
    }

    const content = loaded.text.toJSON()
    if (!(await this.ensureVaultParentFolders(path))) {
      console.warn('[kuroflare] skipped remote text materialize due to parent collision', { path })
      await this.recordRemoteMaterializeBlocked(loaded, path, 'parent-collision')
      return
    }
    await this.app.vault.create(path, content)
    const textHash = await hashCanonicalText(content)
    this.lastMaterialized.set(path, {
      diskHash: textHash,
      ydocHash: textHash,
      path,
      writtenAt: Date.now(),
    })
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    console.info('[kuroflare] materialized remote text file', { path, docId: loaded.docId })
  }

  /** Applies the join adoption decision once remote content is known. */
  private async resolveJoinAdoptionHashCheck(file: TFile, loaded: LoadedTextDoc): Promise<void> {
    const fileId = this.findActiveFileId(file.path)
    this.pendingRemoteTextFiles.delete(loaded.docId.ydocId)
    if (fileId === undefined) {
      console.warn('[kuroflare] skipped join adoption hash check for unknown meta entry', {
        path: file.path,
      })
      return
    }

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
      console.info('[kuroflare] adopted local file matching remote content', {
        path: file.path,
        fileId,
      })
      return
    }

    console.warn('[kuroflare] adopting local file with divergent remote content', {
      path: file.path,
      fileId,
    })
    await this.importFileTextIntoDocAndSend(file, loaded.docId, 'join-adoption-hash-mismatch')
  }

  private async answerWorkerSyncRequest(message: SyncRequest): Promise<void> {
    const setup = this.requireSetupMetadata()
    const port = createSyncRuntimeWebSocketSyncRequestAnswerPort({
      deviceId: setup.deviceId,
      session: this.workerWebSocketSession,
      registry: {
        getYDoc: (docId) => {
          if (docId.kind === 'meta') {
            return this.metaDoc
          }
          return this.loadedTextDocs.get(docId.ydocId)?.doc
        },
      },
      reject: {
        rejectSyncRequestAnswer: async (request, reason) => {
          console.warn('[kuroflare] skipped sync-request answer', {
            reason,
            docId: request.docId,
            messageId: request.messageId,
          })
        },
      },
    })
    await port.answerSyncRequest(message)
  }

  private currentSetupDeviceId(): DeviceId | undefined {
    return this.currentSetupMetadata()?.deviceId
  }

  private currentSetupVaultIdHint(): LocalSetupMetadata['vaultId'] | undefined {
    if (this.pendingSetupResponse !== null) {
      return this.pendingSetupResponse.vaultId
    }
    if (this.trustedSetupMetadata !== null) {
      return this.trustedSetupMetadata.vaultId
    }
    if (this.kuroflareSettings.setupMetadata !== undefined) {
      return this.kuroflareSettings.setupMetadata.vaultId
    }
    return v.is(VaultIdSchema, this.kuroflareSettings.setupVaultId)
      ? this.kuroflareSettings.setupVaultId
      : undefined
  }

  private currentSetupMetadata(): LocalSetupMetadata | undefined {
    if (this.pendingSetupResponse !== null) {
      return localSetupMetadataFromSetupResponse(this.pendingSetupResponse)
    }
    return this.trustedSetupMetadata ?? this.kuroflareSettings.setupMetadata
  }

  private requireSetupMetadata(): LocalSetupMetadata {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      throw new Error('setup-metadata-missing')
    }
    return setup
  }

  private async readAccessToken(key: string): Promise<string | undefined> {
    const value = this.app.secretStorage.getSecret(obsidianSecretIdForKey(key))
    return value !== null && value.length > 0 ? value : undefined
  }

  private async activeDocId(): Promise<DocId> {
    const path = this.activeFile?.path ?? this.targetPath ?? 'active-file.md'
    return await this.fileDocIdForPath(path)
  }

  private async fileDocIdForPath(path: string): Promise<FileDocId> {
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

  private nextWorkerMessageId(): string {
    this.workerMessageCounter += 1
    return `msg-${Date.now().toString(36)}-${this.workerMessageCounter.toString(36)}`
  }

  getSettingsSnapshot(): KuroflareSettings {
    return this.kuroflareSettings
  }

  getSyncRepairEntriesSnapshot(): readonly SyncRuntimeObsidianRepairPresentation[] {
    return this.syncRepairEntries
  }

  getQuarantineAdminSnapshot(): {
    readonly entries: readonly QuarantinedUpdateEntry[]
    readonly detail: QuarantinedUpdateDetailResponse | null
    readonly pendingAction: QuarantineAdminPendingAction | null
  } {
    return {
      entries: this.quarantineAdminEntries,
      detail: this.quarantineAdminDetail,
      pendingAction: this.quarantineAdminPendingAction,
    }
  }

  async refreshQuarantineAdminEntries(): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare quarantine: setup metadata is missing')
      return
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      new Notice('Kuroflare quarantine: access token is missing')
      return
    }

    const response = await fetch(this.quarantineAdminUrl(setup), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      new Notice(`Kuroflare quarantine: list failed (${response.status})`)
      console.warn('[kuroflare] quarantine list fetch failed', { status: response.status })
      return
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!v.is(QuarantinedUpdateListResponseSchema, body)) {
      new Notice('Kuroflare quarantine: invalid list response')
      console.warn('[kuroflare] quarantine list response rejected by guard')
      return
    }

    this.quarantineAdminEntries = body.entries
    if (
      this.quarantineAdminDetail !== null &&
      !body.entries.some((entry) => entry.id === this.quarantineAdminDetail?.entry.id)
    ) {
      this.quarantineAdminDetail = null
    }
    new Notice(`Kuroflare quarantine entries: ${body.entries.length}`)
  }

  async inspectQuarantineAdminEntry(id: string): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare quarantine: setup metadata is missing')
      return
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      new Notice('Kuroflare quarantine: access token is missing')
      return
    }

    const response = await fetch(this.quarantineAdminUrl(setup, id), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      new Notice(`Kuroflare quarantine: inspect failed (${response.status})`)
      console.warn('[kuroflare] quarantine detail fetch failed', { id, status: response.status })
      return
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!v.is(QuarantinedUpdateDetailResponseSchema, body)) {
      new Notice('Kuroflare quarantine: invalid detail response')
      console.warn('[kuroflare] quarantine detail response rejected by guard', { id })
      return
    }

    this.quarantineAdminDetail = body
    new Notice(`Kuroflare quarantine inspected: ${id}`)
  }

  async prepareQuarantineAdminAction(id: string, action: QuarantineAdminAction): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare quarantine: setup metadata is missing')
      return
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      new Notice('Kuroflare quarantine: access token is missing')
      return
    }

    const response = await fetch(this.quarantineAdminActionUrl(setup, id, action), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'dry-run' }),
    })
    if (!response.ok) {
      new Notice(`Kuroflare quarantine: ${action} dry-run failed (${response.status})`)
      console.warn('[kuroflare] quarantine action dry-run failed', {
        id,
        action,
        status: response.status,
      })
      return
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (
      !v.is(QuarantinedUpdateActionDryRunResponseSchema, body) ||
      body.id !== id ||
      body.action !== action
    ) {
      new Notice('Kuroflare quarantine: invalid dry-run response')
      console.warn('[kuroflare] quarantine action dry-run response rejected by guard', {
        id,
        action,
      })
      return
    }

    this.quarantineAdminPendingAction = {
      action: body.action,
      id: body.id,
      confirmationToken: body.confirmationToken,
      effects: body.effects,
      preparedAt: Date.now(),
    }
    new Notice(`Kuroflare quarantine ${action} prepared: ${id}`)
  }

  async executeQuarantineAdminAction(
    id: string,
    action: QuarantineAdminAction,
    confirmation: string,
  ): Promise<void> {
    const requiredConfirmation = quarantineActionConfirmationText(action)
    if (confirmation.trim() !== requiredConfirmation) {
      new Notice(`Kuroflare quarantine: type ${requiredConfirmation} to execute`)
      return
    }
    const pending = this.quarantineAdminPendingAction
    if (pending === null || pending.id !== id || pending.action !== action) {
      new Notice('Kuroflare quarantine: run dry-run first')
      return
    }
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare quarantine: setup metadata is missing')
      return
    }
    const accessToken = await this.readAccessToken(accessTokenSecretKeyForSetup(setup))
    if (accessToken === undefined) {
      new Notice('Kuroflare quarantine: access token is missing')
      return
    }

    const response = await fetch(this.quarantineAdminActionUrl(setup, id, action), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'execute',
        confirmationToken: pending.confirmationToken,
        reason: 'obsidian-plugin-admin',
      }),
    })
    if (!response.ok) {
      new Notice(`Kuroflare quarantine: ${action} execute failed (${response.status})`)
      console.warn('[kuroflare] quarantine action execute failed', {
        id,
        action,
        status: response.status,
      })
      return
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (
      !v.is(QuarantinedUpdateActionResponseSchema, body) ||
      body.id !== id ||
      body.action !== action
    ) {
      new Notice('Kuroflare quarantine: invalid action response')
      console.warn('[kuroflare] quarantine action response rejected by guard', { id, action })
      return
    }

    this.quarantineAdminEntries = this.quarantineAdminEntries.filter((entry) => entry.id !== id)
    if (this.quarantineAdminDetail?.entry.id === id) {
      this.quarantineAdminDetail = null
    }
    this.quarantineAdminPendingAction = null
    new Notice(`Kuroflare quarantine ${action} applied: ${id}`)
  }

  async exportLocalOutboxRepair(): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare repair: setup metadata is missing')
      return
    }
    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const snapshot = await this.readOutboxWorkerSnapshot(db)
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
    await this.ensureAdapterParentFolders(path)
    await writeLocalStoreRepairExportFile({
      adapter: this.app.vault.adapter,
      path,
      exportFile: exportPlan.exportFile,
    })
    await this.updateSettings({
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

  async rebuildLocalStoreAfterConfirmation(confirmation: string): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare repair: setup metadata is missing')
      return
    }

    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const snapshot = await this.readOutboxWorkerSnapshot(db)
    const pendingOutboxCount = snapshot.outboxRecords.filter(
      (record) => record.status !== 'done',
    ).length
    const exportMetadata = this.kuroflareSettings.localRepairExport
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

    await this.rebuildLocalStoreDatabase(setup.vaultId)
    await this.updateSettings({ localRepairExport: undefined })
    new Notice(`Kuroflare local store rebuilt (${pendingOutboxCount} pending entries discarded)`)
    void this.runSyncStartupTick('local-store-rebuild')
  }

  async stageLocalOutboxRepairImport(path: string): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare repair: setup metadata is missing')
      return
    }
    if (path.length === 0) {
      new Notice('Kuroflare repair: export path is required')
      return
    }

    const exportRead = await readLocalStoreRepairExportFile({
      adapter: this.app.vault.adapter,
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

    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const snapshot = await this.readOutboxWorkerSnapshot(db)
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
    const evidence = await this.fetchLocalOutboxRepairEvidence(setup, evidenceItems)
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

  async resumeStagedRepairImports(): Promise<void> {
    const setup = this.currentSetupMetadata()
    if (setup === undefined) {
      new Notice('Kuroflare repair: setup metadata is missing')
      return
    }
    const db = await this.openLocalStoreDatabase(setup.vaultId)
    const snapshot = await this.readOutboxWorkerSnapshot(db)
    const candidates = snapshot.outboxRecords.filter(isStagedRepairImportRecord)
    if (candidates.length === 0) {
      new Notice('Kuroflare repair: no staged repair imports')
      return
    }
    const evidence = await this.fetchLocalOutboxRepairEvidence(
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
      void this.runOutboxWorkerTick('repair-import-resume')
    }
  }

  private async sha256Hex(bytes: Uint8Array): Promise<string> {
    return await hashBytesSha256(bytes)
  }

  private registerWorkspaceEvents(): void {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        void this.bindActiveMarkdownView('active-leaf-change')
      }),
    )

    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        void this.bindActiveMarkdownView('file-open')
      }),
    )

    this.registerDomEvent(window, 'focus', () => {
      void this.handleLifecycleResume('window-focus')
    })
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!document.hidden) {
        void this.handleLifecycleResume('visibilitychange')
      }
    })
    this.registerDomEvent(window, 'online', () => {
      void this.handleLifecycleResume('online')
    })
  }

  private registerVaultWatcher(): void {
    this.fileModifyRef = this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || file.extension !== MARKDOWN_EXTENSION) {
        return
      }

      if (this.activeFile?.path === file.path) {
        void this.handleDiskModify(file)
        return
      }

      // Non-active files are hashed too, but a cheap mtime/size prefilter
      // skips the hash read for the common case where nothing actually changed.
      const prefilter = decideWatcherStatPrefilter({
        currentMtimeMs: file.stat.mtime,
        currentSize: file.stat.size,
        lastMaterialized: this.lastMaterialized.get(file.path),
      })
      if (prefilter.action === 'skip-unchanged-stat') {
        return
      }

      void this.handleBackgroundDiskModify(file)
    })

    this.registerEvent(this.fileModifyRef)
  }

  private async bindActiveMarkdownView(reason: string): Promise<void> {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView)
    const file = markdownView?.file

    if (!markdownView || !file) {
      this.setStatus('no active md')
      return
    }

    const editorView = getEditorView(markdownView)
    if (!editorView) {
      this.setStatus('no cm view')
      new Notice('Kuroflare spike: could not find CodeMirror EditorView')
      return
    }

    const docId = await this.fileDocIdForPath(file.path)
    const loaded = await this.loadTextDoc(docId)
    this.setActiveTextDoc(loaded)
    this.targetPath = file.path
    this.activeFile = file
    this.activeView = editorView
    await this.seedYTextFromDiskIfNeeded(file, editorView)
    editorView.dispatch({
      effects: this.cmCompartment.reconfigure(this.createEditorExtension()),
    })
    await this.requestActiveFileFromWorker(`bind:${reason}`)

    this.setStatus(`bound: ${file.basename}`)
    console.info('[kuroflare] bound active editor', { path: file.path, docId, reason })
  }

  private createEditorExtension(): Extension {
    return createYTextEditorExtension(this.ytext)
  }

  private async seedYTextFromDiskIfNeeded(file: TFile, editorView: EditorView): Promise<void> {
    const diskText = await this.app.vault.read(file)
    const diskHash = await hashCanonicalText(diskText)
    const currentYText = this.ytext.toJSON()

    this.lastMaterialized.set(file.path, {
      diskHash,
      ydocHash: await hashCanonicalText(currentYText),
      path: file.path,
      writtenAt: Date.now(),
    })

    if (this.ytext.length === 0) {
      this.replaceYText(canonicalizeTextForYText(diskText), DISK_ORIGIN)
      return
    }

    // yCollab does not rewrite an already-created EditorState on install; align
    // Obsidian's buffer once before installing the binding.
    if (currentYText !== editorView.state.doc.toString()) {
      dispatchFullDocumentReplace(editorView, currentYText)
    }
  }

  private replaceYText(nextText: string, origin: string): void {
    replaceYText(this.ydoc, this.ytext, nextText, origin)
  }

  private async handleDiskModify(file: TFile): Promise<void> {
    const diskText = await this.app.vault.read(file)
    const diskHash = await hashCanonicalText(diskText)
    const yText = this.ytext.toJSON()
    const yTextHash = await hashCanonicalText(yText)
    const last = this.lastMaterialized.get(file.path)

    const decision = decideWatcherHashGate({
      currentDiskHash: diskHash,
      currentYDocHash: yTextHash,
      lastMaterialized: last,
    })

    if (decision.action === 'ignore-own-write') {
      console.debug('[kuroflare] watcher ignored self write', { path: file.path })
      return
    }

    if (decision.action === 'ignore-converged-write') {
      console.debug('[kuroflare] watcher ignored converged write', { path: file.path })
      this.lastMaterialized.set(file.path, {
        diskHash,
        ydocHash: yTextHash,
        path: file.path,
        writtenAt: Date.now(),
      })
      return
    }

    console.warn('[kuroflare] importing external disk edit', { path: file.path })
    await this.importFileTextAndSend(file, diskText, 'disk-modify')
  }

  /**
   * Same hash-gate decision as {@link handleDiskModify}, but for a file that
   * is not bound to the active editor. It reads the file's own YDoc so
   * background external edits are imported into the correct document.
   */
  private async handleBackgroundDiskModify(file: TFile): Promise<void> {
    const docId = await this.fileDocIdForPath(file.path)
    const loaded = await this.loadTextDoc(docId)
    const diskText = await this.app.vault.read(file)
    const diskHash = await hashCanonicalText(diskText)
    const yTextHash = await hashCanonicalText(loaded.text.toJSON())
    const last = this.lastMaterialized.get(file.path)

    const decision = decideWatcherHashGate({
      currentDiskHash: diskHash,
      currentYDocHash: yTextHash,
      lastMaterialized: last,
    })

    if (decision.action === 'ignore-own-write') {
      console.debug('[kuroflare] background watcher ignored self write', { path: file.path })
      return
    }

    if (decision.action === 'ignore-converged-write') {
      console.debug('[kuroflare] background watcher ignored converged write', {
        path: file.path,
      })
      this.lastMaterialized.set(file.path, {
        diskHash,
        ydocHash: yTextHash,
        path: file.path,
        writtenAt: Date.now(),
        diskMtimeMs: file.stat.mtime,
        diskSize: file.stat.size,
      })
      return
    }

    console.warn('[kuroflare] importing external disk edit for background file', {
      path: file.path,
    })
    await this.importFileTextIntoDocAndSend(file, docId, 'background-disk-modify')
  }

  private async importActiveFileFromDiskAndSend(reason: string): Promise<void> {
    const file = this.activeFile
    if (file === null) {
      new Notice('Kuroflare sync: no active file')
      return
    }
    await this.importFileTextAndSend(file, await this.app.vault.read(file), reason)
  }

  private async importFileTextAndSend(file: TFile, text: string, reason: string): Promise<void> {
    this.replaceYText(canonicalizeTextForYText(text), DISK_ORIGIN)
    const textHash = await hashCanonicalText(this.ytext.toJSON())
    this.lastMaterialized.set(file.path, {
      diskHash: textHash,
      ydocHash: textHash,
      path: file.path,
      writtenAt: Date.now(),
    })
    await this.sendCurrentYDocToWorker(reason)
  }

  private async importFileTextIntoDocAndSend(
    file: TFile,
    docId: FileDocId,
    reason: string,
  ): Promise<void> {
    await this.importFileTextIntoDoc(file, docId, await this.app.vault.read(file))
    const loaded = await this.loadTextDoc(docId)
    await this.sendDocUpdateToWorker(docId, Y.encodeStateAsUpdate(loaded.doc), reason)
  }

  private async importFileTextIntoDoc(
    file: TFile,
    docId: FileDocId,
    textContent: string,
  ): Promise<void> {
    const loaded = await this.loadTextDoc(docId)
    const text = canonicalizeTextForYText(textContent)
    replaceYText(loaded.doc, loaded.text, text, DISK_ORIGIN)
    const textHash = await hashCanonicalText(loaded.text.toJSON())
    this.lastMaterialized.set(file.path, {
      diskHash: textHash,
      ydocHash: textHash,
      path: file.path,
      writtenAt: Date.now(),
      diskMtimeMs: file.stat.mtime,
      diskSize: file.stat.size,
    })
  }

  private async flushYTextToDisk(reason: string): Promise<void> {
    const file = this.activeFile
    if (!file) {
      new Notice('Kuroflare spike: no active file')
      return
    }

    const yText = this.ytext.toJSON()
    const yTextHash = await hashCanonicalText(yText)
    const diskText = await this.app.vault.read(file)
    const diskHash = await hashCanonicalText(diskText)
    const last = this.lastMaterialized.get(file.path)
    const decision = decideMaterializeWrite({
      path: file.path,
      activeFilePath: this.activeFile?.path,
      currentDiskHash: diskHash,
      lastMaterialized: last,
    })

    if (decision.action === 'block-conflict') {
      const conflictPath = await this.createConflictCopy(file, diskText)
      console.warn('[kuroflare] materialize CAS blocked write', {
        path: file.path,
        conflictPath,
        casReason: decision.reason,
        reason,
      })
      this.replaceYText(canonicalizeTextForYText(diskText), DISK_ORIGIN)
      new Notice('Kuroflare spike: disk changed, conflict copy created')
      return
    }

    if (decision.action === 'skip-active-editor') {
      console.debug('[kuroflare] materialize skipped active editor', { path: file.path, reason })
      return
    }

    await this.app.vault.modify(file, yText)
    this.lastMaterialized.set(file.path, {
      diskHash: yTextHash,
      ydocHash: yTextHash,
      path: file.path,
      writtenAt: Date.now(),
    })

    console.info('[kuroflare] flushed YText to disk', { path: file.path, reason })
    new Notice('Kuroflare spike: flushed YText to disk')
  }

  private async createConflictCopy(file: TFile, content: string): Promise<string> {
    const path = await this.allocateConflictPath(file)
    await this.app.vault.create(path, content)
    return path
  }

  private async allocateConflictPath(file: TFile): Promise<string> {
    const extension = file.extension ? `.${file.extension}` : ''
    const parentPath = file.parent?.path
    const basePath = parentPath && parentPath !== '/' ? `${parentPath}/` : ''
    const baseName = file.basename
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')

    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? '' : `-${index}`
      const path = `${basePath}${baseName} (kuroflare conflict ${stamp}${suffix})${extension}`
      if (!this.app.vault.getAbstractFileByPath(path)) {
        return path
      }
    }

    throw new Error('Unable to allocate conflict path')
  }

  private setStatus(status: string): void {
    if (this.statusEl) {
      this.statusEl.setText(`Kuroflare: ${status}`)
    }
  }
}

// KuroflareSettingTab is defined in ./obsidian/settings-tab

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function waitForIndexedDbRequest<Result>(request: IDBRequest<Result>): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

async function waitForIndexedDbDeleteDatabase(request: IDBOpenDBRequest): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      resolve()
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB deleteDatabase failed'))
    }
    request.onblocked = () => {
      reject(new Error('IndexedDB deleteDatabase blocked by an open connection'))
    }
  })
}

async function waitForIndexedDbTransaction(transaction: IDBTransaction): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    }
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

function isLocalStoreOutboxRecord(value: unknown): value is LocalStoreOutboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const id = Reflect.get(value, 'id')
  const kind = Reflect.get(value, 'kind')
  const status = Reflect.get(value, 'status')
  const dependsOn = Reflect.get(value, 'dependsOn')
  return (
    typeof id === 'string' &&
    typeof kind === 'string' &&
    typeof status === 'string' &&
    Array.isArray(dependsOn)
  )
}

function isOutboxRunningLease(value: unknown): value is OutboxRunningLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const itemId = Reflect.get(value, 'itemId')
  const kind = Reflect.get(value, 'kind')
  const ownerId = Reflect.get(value, 'ownerId')
  const leaseExpiresAt = Reflect.get(value, 'leaseExpiresAt')
  return (
    typeof itemId === 'string' &&
    typeof kind === 'string' &&
    typeof ownerId === 'string' &&
    Number.isSafeInteger(leaseExpiresAt)
  )
}

function isStagedRepairImportRecord(
  record: LocalStoreOutboxRecord,
): record is LocalStoreRepairImportedOutboxRecord {
  return (
    record.kind === 'y-update' &&
    record.status === 'paused' &&
    record.reason === 'imported-repair-export' &&
    record.resumeOn === 'manual' &&
    record.docId !== undefined &&
    record.messageId !== undefined &&
    record.updateSha256 !== undefined &&
    record.updateBytesBase64 !== undefined &&
    record.createdAt !== undefined &&
    (record.retryCount ?? 0) === 0
  )
}

function retryAfterMsFromHeader(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  return Math.max(0, timestamp - Date.now())
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const code = Reflect.get(body, 'code')
  if (typeof code === 'string' && code.length > 0) {
    return code
  }
  const error = Reflect.get(body, 'error')
  return typeof error === 'string' && error.length > 0 ? error : undefined
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function binaryBlobCacheKey(sha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>): string {
  return `blob-cache/${sha256}`
}

function requireOutboxPlanItemId(value: string): LocalStoreOutboxRecord['id'] {
  const id = makeOutboxPlanItemId(value)
  if (id === null) {
    throw new Error('outbox-plan-item-id-empty')
  }
  return id
}

function hasPendingRunnableOutboxUpdate(
  records: readonly LocalStoreOutboxRecord[],
  docId: DocId,
): boolean {
  return records.some(
    (record) =>
      (record.status === 'pending' || record.status === 'retrying') &&
      (record.kind === 'y-update' || record.kind === 'meta-ref-update') &&
      record.docId !== undefined &&
      sameDocId(record.docId, docId),
  )
}

function isStoredYDocRecord(value: unknown): value is {
  readonly docId: DocId
  readonly updateBytes: Uint8Array
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const docId = Reflect.get(value, 'docId')
  const updateBytes = Reflect.get(value, 'updateBytes')
  return isDocIdLike(docId) && updateBytes instanceof Uint8Array
}

function isDocIdLike(value: unknown): value is DocId {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const kind = Reflect.get(value, 'kind')
  if (kind === 'meta') {
    return true
  }
  return kind === 'file' && typeof Reflect.get(value, 'ydocId') === 'string'
}

function localSetupMetadataFromSetupResponse(response: SetupExchangeResponse): LocalSetupMetadata {
  return {
    endpoint: response.endpoint,
    vaultId: response.vaultId,
    deviceId: response.deviceId,
    yClientId: response.yClientId,
    protocolVersion: response.protocolVersion,
    bootstrapMode: response.bootstrapMode,
    tokenVersion: response.tokenVersion,
  }
}

function accessTokenSecretKeyForSetup(setup: LocalSetupMetadata): string {
  return `kuroflare:${setup.vaultId}:${setup.deviceId}:access-token`
}

function deviceRevokeUrl(setup: LocalSetupMetadata): string {
  const url = new URL(setup.endpoint)
  url.pathname = `/devices/${encodeURIComponent(setup.deviceId)}/revoke`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function schedulerAuthGateFromMetadata(
  metadata: ClientAuthMetadata | undefined,
): OutboxSchedulerAuthGateInput | undefined {
  if (metadata?.authState !== 'active') {
    return undefined
  }
  return {
    tokenExpiresAt: metadata.accessTokenExpiresAt ?? 0,
    refreshMarginMs: AUTH_REFRESH_MARGIN_MS,
    defaultEstimatedDurationMs: AUTH_REFRESH_ESTIMATED_DURATION_MS,
  }
}

function outboxAuthRefreshStateFromMetadata(
  metadata: ClientAuthMetadata | undefined,
): OutboxAuthRefreshState {
  if (metadata?.authState !== 'active') {
    return { status: 'idle' }
  }
  if (metadata.refreshState === 'refreshing') {
    return { status: 'refreshing' }
  }
  if (metadata.refreshState === 'backing-off' && metadata.nextAllowedRefreshAt !== undefined) {
    return { status: 'backing-off', nextAllowedRefreshAt: metadata.nextAllowedRefreshAt }
  }
  return { status: 'idle' }
}

function createAuthRefreshMetadataPort(
  db: IDBDatabase,
  setup: LocalSetupMetadata,
): AuthRefreshMetadataPort {
  const database = createLocalStoreIndexedDbMetadataDatabasePort(db)
  return {
    async commit(write) {
      const setupWrite: LocalSetupMetadataPutOperation = {
        kind: 'put-metadata-record',
        key: LOCAL_SETUP_METADATA_KEY,
        value: { ...setup, tokenVersion: write.value.tokenVersion },
      }
      await commitLocalStoreIndexedDbMetadataTransaction({
        database,
        writes: planLocalStoreIndexedDbMetadataWrites([setupWrite, write]),
      })
    },
  }
}

function createAuthRevokeMetadataPort(
  db: IDBDatabase,
  setup: LocalSetupMetadata,
): AuthRevokeMetadataPort {
  const database = createLocalStoreIndexedDbMetadataDatabasePort(db)
  return {
    async commit(write) {
      const setupWrite: LocalSetupMetadataPutOperation = {
        kind: 'put-metadata-record',
        key: LOCAL_SETUP_METADATA_KEY,
        value: { ...setup, tokenVersion: write.value.tokenVersion },
      }
      await commitLocalStoreIndexedDbMetadataTransaction({
        database,
        writes: planLocalStoreIndexedDbMetadataWrites([setupWrite, write]),
      })
    },
  }
}

function createObsidianAuthRevokeSecretStoragePort(
  secretStorage: SecretStorage,
): AuthRevokeSecretStoragePort {
  return {
    async delete(key) {
      secretStorage.setSecret(obsidianSecretIdForKey(key), '')
    },
  }
}

function createObsidianAuthRefreshSecretStoragePort(
  secretStorage: SecretStorage,
): AuthRefreshSecretStoragePort {
  return {
    async get(key) {
      const value = secretStorage.getSecret(obsidianSecretIdForKey(key))
      return value !== null && value.length > 0 ? value : undefined
    },
    async set(key, value) {
      secretStorage.setSecret(obsidianSecretIdForKey(key), value)
    },
    async delete(key) {
      secretStorage.setSecret(obsidianSecretIdForKey(key), '')
    },
  }
}

function createAuthRefreshHttpPort(setup: LocalSetupMetadata) {
  return {
    async refresh(request: DeviceTokenRefreshRequest): Promise<AuthRefreshHttpResult> {
      const url = new URL(setup.endpoint)
      url.pathname = '/auth/refresh'
      url.search = ''
      url.hash = ''
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      if (!response.ok) {
        return await authRefreshHttpFailure(response)
      }
      return { ok: true, response: await response.json().catch(() => undefined) }
    },
  }
}

async function authRefreshHttpFailure(response: Response): Promise<AuthRefreshHttpResult> {
  const retryAfterMs = retryAfterMsFromHeader(response.headers.get('Retry-After'))
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { ok: false, reason: 'server-retryable', retryAfterMs }
  }
  const code = await responseErrorCode(response)
  if (code?.includes('device-revoked') === true) {
    return { ok: false, reason: 'device-revoked' }
  }
  if (response.status === 400) {
    return { ok: false, reason: 'invalid-refresh-response' }
  }
  return { ok: false, reason: 'refresh-token-rejected' }
}

function parseAccessTokenClaimsFromJwt(accessToken: string): DeviceTokenClaims | undefined {
  const payload = accessToken.split('.')[1]
  if (payload === undefined) {
    return undefined
  }
  const bytes = decodeBase64Url(payload)
  if (bytes === null) {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return undefined
  }
  return v.is(DeviceTokenClaimsSchema, value) ? value : undefined
}

function nextAllowedRefreshAtFromFailedAuthRefresh(
  plan: Exclude<Awaited<ReturnType<typeof runAuthRefreshAttempt>>, { readonly ok: true }>,
): number | undefined {
  if (!('metadataPatch' in plan) || plan.metadataPatch?.action !== 'apply') {
    return undefined
  }
  return plan.metadataPatch.metadata.nextAllowedRefreshAt
}

function createObsidianSecretStoragePort(
  secretStorage: SecretStorage,
): LocalSetupPersistSecretStoragePort {
  return {
    async set(key, value) {
      secretStorage.setSecret(obsidianSecretIdForKey(key), value)
    },
    async delete(key) {
      // Obsidian SecretStorage has no delete API; blanking removes reusable token material.
      secretStorage.setSecret(obsidianSecretIdForKey(key), '')
    },
  }
}

function obsidianSecretIdForKey(key: string): string {
  return `kuroflare-${hexEncode(new TextEncoder().encode(key))}`
}

function accessTokenExpiresAtFromJwt(token: string): number | undefined {
  return parseAccessTokenClaimsFromJwt(token)?.exp
}

function decodeBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - (normalized.length % 4)) % 4
  return decodeBase64(`${normalized}${'='.repeat(padding)}`)
}

function hexEncode(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function sameDocId(left: DocId, right: DocId): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'meta' || right.kind === 'meta') {
    return true
  }
  return left.ydocId === right.ydocId
}
