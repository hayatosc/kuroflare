import { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  type LastMaterializedRecord,
  type FileId,
  type MessageId,
  type OutboxResumeEvent,
  type ClientAuthMetadata,
  type SetupExchangeResponse,
  type QuarantinedUpdateEntry,
  type QuarantinedUpdateDetailResponse,
} from '@kuroflare/core'
import type { TFile } from 'obsidian'
import { Plugin, type EventRef } from 'obsidian'
import type { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type {
  KuroflareSettings,
  KuroflareInvalidMetaIsolationDetail,
  KuroflareBinaryRestoreCheckDetail,
  LoadedTextDoc,
} from '../main-types'
import { KuroflareSettingTab } from '../obsidian/settings-tab'
import { type LocalSetupMetadata } from '../sync/engine/setup'
import {
  createSyncRuntimeWebSocketSession,
  type SyncRuntimeWebSocketSessionPort,
  type SyncRuntimeWebSocketStartupStepPort,
} from '../sync/engine/websocket'
import { type SyncRuntimeObsidianComposition } from '../sync/obsidian/composition'
import type { SyncRuntimeObsidianRepairPresentation } from '../sync/obsidian/presentation'
import { planSyncRuntimeObsidianLegacySettingsSecretCleanup } from '../sync/obsidian/settings'
import {
  SPIKE_TEXT_NAME,
  META_SYNC_DOC_ID,
  WORKER_ORIGIN,
  BINARY_UPLOAD_ORIGIN,
  DEFAULT_SETTINGS,
} from './constants'
import {
  registerCommands,
  registerWorkspaceEvents,
  registerVaultWatcher,
  bindActiveMarkdownView,
} from './editor'
import { registerFileTreeWatcher } from './file-tree'
import {
  isPartialSettings,
  isKuroflareRepairLogEntry,
  isKuroflareLocalRepairExportMetadata,
} from './guards'
import { handleLifecycleResume } from './sync-runtime'
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
  readonly metaDoc = new Y.Doc()
  metaPersistence: IndexeddbPersistence | null = null
  localStoreDb: IDBDatabase | null = null
  localStoreDbName: string | null = null
  readonly materializedPaths = new Map<FileId, string>()
  readonly pendingRemoteTextFiles = new Map<string, string>()
  startupScannedMarkdownFiles: readonly TFile[] = []
  readonly pendingFsRenames = new Set<string>()
  readonly activeRemoteDeletedFileIds = new Set<FileId>()
  pendingSetupResponse: SetupExchangeResponse | null = null
  trustedSetupMetadata: LocalSetupMetadata | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.statusEl = this.addStatusBarItem()
    this.syncStatusEl = this.addStatusBarItem()
    this.setStatus('loading')
    this.syncStatusEl.setText('Kuroflare sync: not started')

    this.addSettingTab(new KuroflareSettingTab(this.app, this))
    this.registerEditorExtension(this.cmCompartment.of([]))

    this.metaDoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === WORKER_ORIGIN || origin === BINARY_UPLOAD_ORIGIN) return
      void sendDocUpdateToWorker(this, META_SYNC_DOC_ID, update, 'meta-update')
    })

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

  setStatus(status: string): void {
    this.statusEl?.setText(status)
  }
}
