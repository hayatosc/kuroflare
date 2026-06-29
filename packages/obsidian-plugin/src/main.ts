import { Compartment, type Extension } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import {
  canonicalizeTextForYText,
  decideMaterializeWrite,
  decideWatcherHashGate,
  hashCanonicalText,
  hashBytesSha256,
  type LastMaterializedRecord,
} from '@kuroflare/core'
import {
  canonicalizeVaultPath,
  CURRENT_PROTOCOL_VERSION,
  isMetaFile,
  makeDeviceId,
  makeFileId,
  makeYDocId,
  parseControlMessage,
  type DeviceId,
  type DocId,
  type FileId,
  type SetupExchangeResponse,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/protocol'
import {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type App,
  type EventRef,
} from 'obsidian'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import {
  createYTextEditorExtension,
  dispatchFullDocumentReplace,
  getEditorView,
  replaceYText,
} from './obsidian/editor-binding.js'
import { applyFileCreate, applyFileDelete, applyFileRename } from './sync/meta-file-tree.js'
import { reconcileMetaDoc } from './sync/meta-reconcile.js'
import {
  createSyncRuntimeObsidianComposition,
  type SyncRuntimeObsidianComposition,
} from './sync/obsidian-runtime-composition.js'
import { type SyncRuntimeObsidianRepairPresentation } from './sync/obsidian-shell-presentation.js'
import { createSyncRuntimeObsidianSetupExchangeEvidenceReader } from './sync/obsidian-startup-settings.js'
import {
  createEvidenceBackedHttpSyncRuntimeSetupExchangePort,
  type SetupExchangeStartupEffect,
} from './sync/setup-exchange-http.js'
import { type SyncRuntimeStartupStepEffectPort } from './sync/startup-actuation.js'

const SPIKE_DOC_NAME = 'kuroflare-cm6-spike'
const SPIKE_TEXT_NAME = 'fixed-file'
const META_DOC_NAME = 'kuroflare-meta'
const DISK_ORIGIN = 'kuroflare:disk'
const REMOTE_ORIGIN = 'kuroflare:remote-simulated'
const WORKER_ORIGIN = 'kuroflare:worker'
const FILE_TREE_ORIGIN = 'kuroflare:file-tree'
const REPAIR_ORIGIN = 'kuroflare:repair'
const REPAIR_DEVICE = makeDeviceId('repair')
const MARKDOWN_EXTENSION = 'md'

interface KuroflareSettings {
  readonly endpoint: string
  readonly setupVaultId: string
  readonly setupToken: string
  readonly requestedDeviceName: string
  readonly setupBootstrapMode: 'new-vault' | 'join-existing'
  readonly setupResponse?: SetupExchangeResponse | undefined
  readonly accessToken?: string | undefined
  readonly refreshToken?: string | undefined
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

/** Spike-only Obsidian plugin for validating CM6/Yjs/disk behavior. */
export default class KuroflareSpikePlugin extends Plugin {
  private readonly ydoc = new Y.Doc()
  private readonly ytext = this.ydoc.getText(SPIKE_TEXT_NAME)
  private readonly cmCompartment = new Compartment()
  private readonly lastMaterialized = new Map<string, LastMaterializedRecord>()
  private persistence: IndexeddbPersistence | null = null
  private statusEl: HTMLElement | null = null
  private syncStatusEl: HTMLElement | null = null
  private syncRuntime: SyncRuntimeObsidianComposition | null = null
  private syncRepairEntries: readonly SyncRuntimeObsidianRepairPresentation[] = []
  private syncRetryEnabled = false
  private kuroflareSettings: KuroflareSettings = DEFAULT_SETTINGS
  private workerSocket: WebSocket | null = null
  private workerHelloAccepted = false
  private workerMessageCounter = 0
  private activeFile: TFile | null = null
  private activeView: EditorView | null = null
  private targetPath: string | null = null
  private fileModifyRef: EventRef | null = null

  // File-tree subsystem (MVP-2): the meta YDoc holds fileId -> MetaFile for the whole vault.
  private readonly metaDoc = new Y.Doc()
  private metaPersistence: IndexeddbPersistence | null = null
  // Last on-disk path materialized per file ID, so a converged meta rename can move the real file.
  private readonly materializedPaths = new Map<FileId, string>()
  // Canonical paths whose vault rename we initiated, to ignore the resulting watcher echo.
  private readonly pendingFsRenames = new Set<string>()

  /** Set up the CM6 spike lifecycle. */
  override async onload(): Promise<void> {
    await this.loadSettings()
    this.statusEl = this.addStatusBarItem()
    this.syncStatusEl = this.addStatusBarItem()
    this.setStatus('loading')
    this.syncStatusEl.setText('Kuroflare sync: not started')

    this.addSettingTab(new KuroflareSettingTab(this.app, this))
    this.registerEditorExtension(this.cmCompartment.of([]))
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === DISK_ORIGIN || origin === REMOTE_ORIGIN || origin === WORKER_ORIGIN) {
        return
      }
      void this.sendYjsUpdateToWorker(update, 'local-update')
    })
    void this.openPersistence().catch((error: unknown) => {
      console.error('[kuroflare] failed to open IndexedDB persistence', error)
      this.setStatus('persistence error')
    })
    void this.openMetaPersistence().catch((error: unknown) => {
      console.error('[kuroflare] failed to open meta IndexedDB persistence', error)
    })
    // Repair + materialize whenever the meta YDoc converges from a non-repair source.
    this.metaDoc.on('afterTransaction', (transaction: Y.Transaction) => {
      if (transaction.origin === REPAIR_ORIGIN) {
        return
      }
      void this.reconcileAndMaterializeMeta()
    })
    this.syncRuntime = this.createSyncRuntime()
    this.registerCommands()
    this.registerVaultWatcher()
    this.registerFileTreeWatcher()
    this.registerWorkspaceEvents()

    this.app.workspace.onLayoutReady(() => {
      void this.bindActiveMarkdownView('layout-ready')
    })

    this.setStatus('ready')
    console.info('[kuroflare] CM6 spike loaded')
  }

  /** Tear down Yjs observers and persistence. */
  override onunload(): void {
    if (this.fileModifyRef) {
      this.app.vault.offref(this.fileModifyRef)
      this.fileModifyRef = null
    }

    void this.persistence?.destroy()
    this.persistence = null
    void this.metaPersistence?.destroy()
    this.metaPersistence = null
    this.workerSocket?.close(1000, 'plugin-unload')
    this.workerSocket = null
    this.ydoc.destroy()
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
  }

  private async openPersistence(): Promise<void> {
    this.persistence = new IndexeddbPersistence(SPIKE_DOC_NAME, this.ydoc)
    await this.persistence.whenSynced
  }

  private get metaMap(): Y.Map<unknown> {
    return this.metaDoc.getMap<unknown>('meta')
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
    return makeDeviceId(this.kuroflareSettings.setupResponse?.deviceId ?? 'local-device')
  }

  private registerFileTreeWatcher(): void {
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
          this.handleVaultCreate(file)
        }
      }),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
          this.handleVaultRename(file, oldPath)
        }
      }),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === MARKDOWN_EXTENSION) {
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
    applyFileCreate(this.metaMap, {
      fileId,
      path: file.path,
      ydocId: makeYDocId(`file-${fileId}`),
      deviceId: this.fileTreeDeviceId(),
      now: Date.now(),
      origin: FILE_TREE_ORIGIN,
    })
    this.materializedPaths.set(fileId, file.path)
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

  private async reconcileAndMaterializeMeta(): Promise<void> {
    reconcileMetaDoc(this.metaMap, {
      updatedAt: Date.now(),
      updatedBy: REPAIR_DEVICE,
      origin: REPAIR_ORIGIN,
    })
    await this.materializeMetaRenames()
  }

  /** Moves real vault files to match meta entries whose path converged elsewhere. */
  private async materializeMetaRenames(): Promise<void> {
    for (const [fileId, value] of this.metaMap.entries()) {
      if (!isMetaFile(value, fileId) || value.deleted) {
        continue
      }
      const known = this.materializedPaths.get(value.fileId)
      if (known === value.path) {
        continue
      }
      this.materializedPaths.set(value.fileId, value.path)
      if (known === undefined) {
        continue
      }
      const file = this.app.vault.getAbstractFileByPath(known)
      if (!(file instanceof TFile)) {
        continue
      }
      const canonicalTarget = canonicalizeVaultPath(value.path)
      this.pendingFsRenames.add(canonicalTarget)
      try {
        await this.app.fileManager.renameFile(file, value.path)
      } catch (error: unknown) {
        this.pendingFsRenames.delete(canonicalTarget)
        console.error('[kuroflare] failed to materialize meta rename', {
          from: known,
          to: value.path,
          error,
        })
      }
    }
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
        existingDeviceId: this.kuroflareSettings.setupResponse?.deviceId,
      }),
    }
    const setupEvidenceReader = createSyncRuntimeObsidianSetupExchangeEvidenceReader({
      readSettings: (_effect: SetupExchangeStartupEffect) => ({
        endpoint: this.kuroflareSettings.endpoint,
        setupVaultId: this.kuroflareSettings.setupVaultId,
        setupToken: this.kuroflareSettings.setupToken,
        requestedDeviceName: this.kuroflareSettings.requestedDeviceName,
        setupBootstrapMode: this.kuroflareSettings.setupBootstrapMode,
        existingDeviceId: this.kuroflareSettings.setupResponse?.deviceId,
      }),
    })
    const setupExchange = createEvidenceBackedHttpSyncRuntimeSetupExchangePort({
      fetch: (input, init) => fetch(input, init),
      readEvidence: (effect) => setupEvidenceReader.readEvidence(effect),
      scheduleReplan: async (request) => {
        await this.updateSettings({
          setupToken: '',
          setupResponse: request.response,
          accessToken: request.response.accessToken,
          refreshToken: request.response.refreshToken,
        })
      },
    })

    return createSyncRuntimeObsidianComposition({
      settings: settingsReader,
      local: {
        readLocalEvidence: async () => ({
          metadataSnapshot:
            this.kuroflareSettings.setupResponse === undefined
              ? undefined
              : {
                  ok: true,
                  snapshot: {
                    setup: {
                      endpoint: this.kuroflareSettings.setupResponse.endpoint,
                      vaultId: this.kuroflareSettings.setupResponse.vaultId,
                      deviceId: this.kuroflareSettings.setupResponse.deviceId,
                      yClientId: this.kuroflareSettings.setupResponse.yClientId,
                      protocolVersion: this.kuroflareSettings.setupResponse.protocolVersion,
                      bootstrapMode: this.kuroflareSettings.setupResponse.bootstrapMode,
                      tokenVersion: this.kuroflareSettings.setupResponse.tokenVersion,
                    },
                    auth: {
                      deviceId: this.kuroflareSettings.setupResponse.deviceId,
                      tokenVersion: this.kuroflareSettings.setupResponse.tokenVersion,
                      authState: 'active',
                      refreshState: 'idle',
                      retryCount: 0,
                      accessTokenSecretKey: 'kuroflare:settings:access-token',
                      refreshTokenSecretKey: 'kuroflare:settings:refresh-token',
                    },
                  },
                },
          hasMetaYDoc: this.ydoc.getMap('meta').size > 0,
          hasLocalVaultFiles: this.app.vault.getMarkdownFiles().length > 0,
          setupResponse: this.kuroflareSettings.setupResponse,
        }),
      },
      setupExchange,
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
    return {
      run: async (effect) => {
        console.info('[kuroflare] startup step', {
          step: effect.step,
          phase: effect.phase,
          vaultId: effect.vaultId,
        })
        switch (effect.step) {
          case 'persist-setup-response':
            if (this.kuroflareSettings.setupResponse === undefined) {
              throw new Error('setup-response-missing')
            }
            await this.saveData(this.kuroflareSettings)
            return
          case 'open-websocket':
            await this.openWorkerWebSocket()
            return
          case 'send-client-hello':
            await this.sendWorkerHello()
            return
          case 'sync-active-file-state-vector':
            await this.requestActiveFileFromWorker(`startup:${effect.step}`)
            return
          case 'send-meta-update':
          case 'enqueue-initial-file-uploads':
            await this.sendCurrentYDocToWorker(`startup:${effect.step}`)
            return
          case 'scan-local-vault':
          case 'create-local-meta-ydoc':
          case 'fetch-remote-meta-snapshot':
          case 'apply-remote-meta-snapshot':
          case 'adopt-local-files-after-remote-meta':
          case 'enqueue-missing-downloads':
          case 'load-indexeddb-ydocs':
          case 'sync-meta-state-vector':
          case 'resume-background-queues':
            return
        }
      },
    }
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

  private async openWorkerWebSocket(): Promise<void> {
    if (this.workerSocket !== null && this.workerSocket.readyState === WebSocket.OPEN) {
      if (!this.workerHelloAccepted) {
        await this.sendWorkerHello()
      }
      return
    }
    const setup = this.requireSetupResponse()
    const accessToken = this.kuroflareSettings.accessToken ?? setup.accessToken
    const url = this.workerWebSocketUrl(setup, accessToken)
    this.workerHelloAccepted = false
    this.workerSocket?.close(1000, 'reconnect')

    const socket = new WebSocket(url)
    this.workerSocket = socket
    socket.onmessage = (event) => {
      void this.handleWorkerMessage(event.data)
    }
    socket.onclose = (event) => {
      this.workerHelloAccepted = false
      this.syncStatusEl?.setText(`Kuroflare sync: websocket closed ${event.code}`)
      console.warn('[kuroflare] worker websocket closed', {
        code: event.code,
        reason: event.reason,
      })
    }
    socket.onerror = () => {
      this.workerHelloAccepted = false
      this.syncStatusEl?.setText('Kuroflare sync: websocket error')
    }

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        resolve()
      }
      socket.onerror = () => {
        reject(new Error('worker-websocket-open-failed'))
      }
      socket.onclose = (event) => {
        reject(new Error(`worker-websocket-closed-before-open:${event.code}:${event.reason}`))
      }
    })
    await this.sendWorkerHello()
  }

  private async sendWorkerHello(): Promise<void> {
    const setup = this.requireSetupResponse()
    const socket = this.requireOpenWorkerSocket()
    const accepted = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('worker-hello-timeout'))
      }, 5000)
      const previous = socket.onmessage
      const previousClose = socket.onclose
      const previousError = socket.onerror
      socket.onmessage = (event) => {
        const message = parseControlMessage(event.data)
        if (
          message?.type === 'hello-accepted' &&
          message.vaultId === setup.vaultId &&
          message.deviceId === setup.deviceId &&
          message.yClientId === setup.yClientId
        ) {
          window.clearTimeout(timeout)
          this.workerHelloAccepted = true
          socket.onmessage = (nextEvent) => {
            void this.handleWorkerMessage(nextEvent.data)
          }
          resolve()
          return
        }
        previous?.call(socket, event)
      }
      socket.onerror = (event) => {
        window.clearTimeout(timeout)
        socket.onerror = previousError
        reject(new Error('worker-hello-error'))
        previousError?.call(socket, event)
      }
      socket.onclose = (event) => {
        window.clearTimeout(timeout)
        socket.onclose = previousClose
        reject(new Error(`worker-hello-closed:${event.code}:${event.reason}`))
        previousClose?.call(socket, event)
      }
    })
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: setup.vaultId,
        deviceId: setup.deviceId,
        yClientId: setup.yClientId,
        capabilities: [],
      }),
    )
    await accepted
    this.syncStatusEl?.setText(`Kuroflare sync: connected ${setup.vaultId}`)
    await this.requestActiveFileFromWorker('hello-accepted')
  }

  private async sendCurrentYDocToWorker(reason: string): Promise<void> {
    await this.sendYjsUpdateToWorker(Y.encodeStateAsUpdate(this.ydoc), reason)
  }

  private async requestActiveFileFromWorker(reason: string): Promise<void> {
    if (!this.workerHelloAccepted || this.workerSocket?.readyState !== WebSocket.OPEN) {
      return
    }
    const setup = this.requireSetupResponse()
    const docId = await this.activeDocId()
    const stateVector = Y.encodeStateVector(this.ydoc)
    const message: SyncRequest = {
      type: 'sync-request',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: setup.vaultId,
      deviceId: setup.deviceId,
      messageId: this.nextWorkerMessageId(),
      docId,
      stateVector: encodeBase64(stateVector),
    }
    this.workerSocket.send(JSON.stringify(message))
    console.info('[kuroflare] requested worker sync state', {
      reason,
      messageId: message.messageId,
      docId,
    })
  }

  private async sendYjsUpdateToWorker(update: Uint8Array, reason: string): Promise<void> {
    if (!this.workerHelloAccepted || this.workerSocket?.readyState !== WebSocket.OPEN) {
      return
    }
    const setup = this.requireSetupResponse()
    const docId = await this.activeDocId()
    const updateSha256 = await this.sha256Hex(update)
    const message: SyncUpdate = {
      type: 'sync-update',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: setup.vaultId,
      deviceId: setup.deviceId,
      messageId: this.nextWorkerMessageId(),
      docId,
      update: encodeBase64(update),
      updateSha256,
    }
    this.workerSocket.send(JSON.stringify(message))
    console.info('[kuroflare] sent worker sync update', {
      reason,
      messageId: message.messageId,
      docId,
      bytes: update.byteLength,
    })
  }

  private async handleWorkerMessage(data: unknown): Promise<void> {
    const message = typeof data === 'string' ? parseControlMessage(data) : null
    if (message === null) {
      console.warn('[kuroflare] dropped invalid worker websocket message')
      return
    }
    switch (message.type) {
      case 'ack':
        console.info('[kuroflare] worker ack', {
          messageId: message.messageId,
          durableSeq: message.durableSeq,
        })
        this.syncStatusEl?.setText(`Kuroflare sync: ack ${message.durableSeq}`)
        return
      case 'sync-update':
        await this.applyWorkerSyncUpdate(message)
        return
      case 'sync-request':
        await this.answerWorkerSyncRequest(message)
        return
      case 'need-full-snapshot':
        console.warn('[kuroflare] worker requested full snapshot', { reason: message.reason })
        return
      case 'hello':
      case 'hello-accepted':
        return
    }
  }

  private async applyWorkerSyncUpdate(message: SyncUpdate): Promise<void> {
    if (!sameDocId(message.docId, await this.activeDocId())) {
      return
    }
    const update = decodeBase64(message.update)
    if (update === null) {
      console.warn('[kuroflare] dropped invalid base64 worker update')
      return
    }
    Y.applyUpdate(this.ydoc, update, WORKER_ORIGIN)
    await this.flushYTextToDisk('worker-update')
  }

  private async answerWorkerSyncRequest(message: SyncRequest): Promise<void> {
    const socket = this.workerSocket
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return
    }
    if (!sameDocId(message.docId, await this.activeDocId())) {
      return
    }
    const stateVector = decodeBase64(message.stateVector)
    if (stateVector === null) {
      return
    }
    const update = Y.encodeStateAsUpdate(this.ydoc, stateVector)
    const setup = this.requireSetupResponse()
    socket.send(
      JSON.stringify({
        type: 'sync-update',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: setup.vaultId,
        deviceId: setup.deviceId,
        messageId: message.messageId,
        docId: message.docId,
        update: encodeBase64(update),
        updateSha256: await this.sha256Hex(update),
        baseStateVector: message.stateVector,
      } satisfies SyncUpdate),
    )
  }

  private requireSetupResponse(): SetupExchangeResponse {
    const setup = this.kuroflareSettings.setupResponse
    if (setup === undefined) {
      throw new Error('setup-response-missing')
    }
    return setup
  }

  private requireOpenWorkerSocket(): WebSocket {
    const socket = this.workerSocket
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error('worker-websocket-not-open')
    }
    return socket
  }

  private workerWebSocketUrl(setup: SetupExchangeResponse, accessToken: string): string {
    const url = new URL(setup.endpoint)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `/ws/${encodeURIComponent(setup.vaultId)}`
    url.searchParams.set('access_token', accessToken)
    url.hash = ''
    return url.toString()
  }

  private async activeDocId(): Promise<DocId> {
    const path = this.activeFile?.path ?? this.targetPath ?? 'active-file.md'
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
  }

  private registerVaultWatcher(): void {
    this.fileModifyRef = this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile)) {
        return
      }

      if (this.activeFile?.path !== file.path) {
        return
      }

      void this.handleDiskModify(file)
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

    if (this.targetPath && this.targetPath !== file.path) {
      this.activeFile = null
      this.activeView = null
      this.setStatus('different file')
      console.info('[kuroflare] skipped non-target file', {
        path: file.path,
        targetPath: this.targetPath,
        reason,
      })
      return
    }

    const editorView = getEditorView(markdownView)
    if (!editorView) {
      this.setStatus('no cm view')
      new Notice('Kuroflare spike: could not find CodeMirror EditorView')
      return
    }

    this.targetPath = file.path
    this.activeFile = file
    this.activeView = editorView
    await this.seedYTextFromDiskIfNeeded(file, editorView)
    editorView.dispatch({
      effects: this.cmCompartment.reconfigure(this.createEditorExtension()),
    })

    this.setStatus(`bound: ${file.basename}`)
    console.info('[kuroflare] bound active editor', { path: file.path, reason })
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
      activeEditorBound: false,
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

class KuroflareSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: KuroflareSpikePlugin,
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    const settings = this.plugin.getSettingsSnapshot()
    containerEl.empty()

    new Setting(containerEl).setName('Worker endpoint').addText((text) => {
      text
        .setPlaceholder('http://127.0.0.1:8787')
        .setValue(settings.endpoint)
        .onChange((value) => {
          void this.plugin.updateSettings({ endpoint: value.trim() })
        })
    })

    new Setting(containerEl).setName('Vault ID').addText((text) => {
      text.setValue(settings.setupVaultId).onChange((value) => {
        void this.plugin.updateSettings({ setupVaultId: value.trim() })
      })
    })

    new Setting(containerEl).setName('Setup token').addText((text) => {
      text.setValue(settings.setupToken).onChange((value) => {
        void this.plugin.updateSettings({ setupToken: value.trim() })
      })
    })

    new Setting(containerEl).setName('Device name').addText((text) => {
      text.setValue(settings.requestedDeviceName).onChange((value) => {
        void this.plugin.updateSettings({ requestedDeviceName: value.trim() })
      })
    })

    new Setting(containerEl).setName('Bootstrap mode').addDropdown((dropdown) => {
      dropdown
        .addOption('new-vault', 'New vault')
        .addOption('join-existing', 'Join existing')
        .setValue(settings.setupBootstrapMode)
        .onChange((value) => {
          if (value === 'new-vault' || value === 'join-existing') {
            void this.plugin.updateSettings({ setupBootstrapMode: value })
          }
        })
    })
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
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
