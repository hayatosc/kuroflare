import type { EditorView } from '@codemirror/view'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Y } from 'yjs'

import type KuroflareSpikePlugin from './plugin'

export function registerCommands(plugin: KuroflareSpikePlugin): void {
  plugin.addCommand({
    id: 'kuroflare-spike-bind-active-editor',
    name: 'Kuroflare spike: bind active editor',
    callback: () => {
      void plugin.bindActiveMarkdownView('command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-spike-flush-ytext-to-disk',
    name: 'Kuroflare spike: flush YText to disk',
    callback: () => {
      void plugin.flushYTextToDisk('command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-spike-simulate-remote-insert',
    name: 'Kuroflare spike: simulate remote insert',
    callback: () => {
      plugin.ydoc.transact(() => {
        plugin.ytext.insert(plugin.ytext.length, `\nremote ${new Date().toISOString()}`)
      }, REMOTE_ORIGIN)
    },
  })

  plugin.addCommand({
    id: 'kuroflare-spike-log-state',
    name: 'Kuroflare spike: log state',
    callback: () => {
      void plugin.logState()
    },
  })

  plugin.addCommand({
    id: 'kuroflare-sync-run-startup-tick',
    name: 'Kuroflare sync: run startup tick',
    callback: () => {
      void plugin.runSyncStartupTick('command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-sync-send-active-file-update',
    name: 'Kuroflare sync: send active file update',
    callback: () => {
      void plugin.sendCurrentYDocToWorker('command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-sync-import-and-send-active-file',
    name: 'Kuroflare sync: import and send active file',
    callback: () => {
      void plugin.importActiveFileFromDiskAndSend('command')
    },
  })
}

export function registerWorkspaceEvents(plugin: KuroflareSpikePlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('active-leaf-change', () => {
      void plugin.bindActiveMarkdownView('active-leaf-change')
    }),
  )

  plugin.registerEvent(
    plugin.app.workspace.on('file-open', () => {
      void plugin.bindActiveMarkdownView('file-open')
    }),
  )

  plugin.registerDomEvent(window, 'focus', () => {
    void plugin.handleLifecycleResume('window-focus')
  })
  plugin.registerDomEvent(document, 'visibilitychange', () => {
    if (!document.hidden) {
      void plugin.handleLifecycleResume('visibilitychange')
    }
  })
  plugin.registerDomEvent(window, 'online', () => {
    void plugin.handleLifecycleResume('online')
  })
}

export function registerVaultWatcher(plugin: KuroflareSpikePlugin): void {
  plugin.fileModifyRef = plugin.app.vault.on('modify', (file) => {
    if (!(file instanceof TFile) || file.extension !== MARKDOWN_EXTENSION) {
      return
    }

    if (plugin.activeFile?.path === file.path) {
      void plugin.handleDiskModify(file)
      return
    }

    // Non-active files are hashed too, but a cheap mtime/size prefilter
    // skips the hash read for the common case where nothing actually changed.
    const prefilter = decideWatcherStatPrefilter({
      currentMtimeMs: file.stat.mtime,
      currentSize: file.stat.size,
      lastMaterialized: plugin.lastMaterialized.get(file.path),
    })
    if (prefilter.action === 'skip-unchanged-stat') {
      return
    }

    void plugin.handleBackgroundDiskModify(file)
  })

  plugin.registerEvent(plugin.fileModifyRef)
}

export async function bindActiveMarkdownView(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView)
  const file = markdownView?.file

  if (!markdownView || !file) {
    plugin.setStatus('no active md')
    return
  }

  const editorView = getEditorView(markdownView)
  if (!editorView) {
    plugin.setStatus('no cm view')
    new Notice('Kuroflare spike: could not find CodeMirror EditorView')
    return
  }

  // Startup and foreground-resume can both call this in quick succession
  // for the same still-active file (e.g. the automatic layout-ready resume
  // firing right after the explicit startup bind). Re-running the full
  // bind would reconfigure a second, independent yCollab CM6 extension on
  // the same YText and re-send a duplicate sync-request, racing the first
  // extension's remote-update observer and corrupting the merge.
  if (plugin.activeFile?.path === file.path && plugin.activeView === editorView) {
    return
  }

  // Claim this bind attempt synchronously, before any `await`. The identity check above
  // cannot catch two overlapping calls on its own, because `plugin.activeFile`/`plugin.activeView`
  // are only assigned further down, after the first await. A monotonic generation token closes
  // that race: whichever call is newest wins, and every older call aborts -- without seeding,
  // dispatching, or reconfiguring anything -- the next time it checks in below.
  const generation = ++plugin.bindGeneration

  const docId = await plugin.fileDocIdForPath(file.path)
  if (generation !== plugin.bindGeneration) {
    return
  }

  const loaded = await plugin.loadTextDoc(docId)
  if (generation !== plugin.bindGeneration) {
    return
  }

  plugin.setActiveTextDoc(loaded)
  plugin.targetPath = file.path
  plugin.activeFile = file
  plugin.activeView = editorView

  if (plugin.yCollabBoundViews.has(editorView)) {
    // This EditorView is being rebound to a *different* file's Y.Text (Obsidian can reuse the
    // same EditorView across a file switch within one leaf), but it still has the previous
    // file's yCollab binding live. Detach that binding before seeding/realigning below: while
    // it is live, y-sync mirrors any doc-changed transaction straight back into whichever
    // Y.Text it is bound to, so a realignment dispatch here would otherwise corrupt the
    // *previous* file's Y.Text instead of just repainting the buffer for the new one.
    editorView.dispatch({ effects: plugin.cmCompartment.reconfigure([]) })
    plugin.yCollabBoundViews.delete(editorView)
  }

  await plugin.seedYTextFromDiskIfNeeded(file, editorView, generation)
  if (generation !== plugin.bindGeneration) {
    return
  }

  editorView.dispatch({
    effects: plugin.cmCompartment.reconfigure(plugin.createEditorExtension()),
  })
  plugin.yCollabBoundViews.add(editorView)
  await plugin.requestActiveFileFromWorker(`bind:${reason}`)

  plugin.setStatus(`bound: ${file.basename}`)
  console.info('[kuroflare] bound active editor', { path: file.path, docId, reason })
}

export function createEditorExtension(plugin: KuroflareSpikePlugin): Extension {
  return createYTextEditorExtension(plugin.ytext)
}

export async function seedYTextFromDiskIfNeeded(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  editorView: EditorView,
  generation: number,
): Promise<void> {
  const diskText = await plugin.app.vault.read(file)
  const diskHash = await hashCanonicalText(diskText)
  const currentYText = plugin.ytext.toJSON()

  plugin.lastMaterialized.set(file.path, {
    diskHash,
    ydocHash: await hashCanonicalText(currentYText),
    path: file.path,
    writtenAt: Date.now(),
  })

  if (generation !== plugin.bindGeneration) {
    // A newer bind call has already taken over; seeding or realigning on behalf of a
    // superseded call could stomp a merge that landed while we were awaiting above.
    return
  }

  if (plugin.ytext.length === 0) {
    plugin.replaceYText(canonicalizeTextForYText(diskText), DISK_ORIGIN)
    return
  }

  // yCollab does not rewrite an already-created EditorState on install; align Obsidian's
  // buffer once before installing the binding. Never do this once yCollab is already bound to
  // this view: y-codemirror.next's ySync plugin mirrors any doc-changed transaction straight
  // back into the Y.Text as a real local edit, which would discard whatever the Y.Text has
  // accumulated since (e.g. a remote merge) in favor of this stale snapshot.
  if (
    !plugin.yCollabBoundViews.has(editorView) &&
    currentYText !== editorView.state.doc.toString()
  ) {
    dispatchFullDocumentReplace(editorView, currentYText)
  }
}

export function replaceYText_Method(
  plugin: KuroflareSpikePlugin,
  nextText: string,
  origin: string,
): void {
  replaceYText(plugin.ydoc, plugin.ytext, nextText, origin)
}

export async function handleDiskModify(plugin: KuroflareSpikePlugin, file: TFile): Promise<void> {
  const diskText = await plugin.app.vault.read(file)
  const diskHash = await hashCanonicalText(diskText)
  const yText = plugin.ytext.toJSON()
  const yTextHash = await hashCanonicalText(yText)
  const last = plugin.lastMaterialized.get(file.path)

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
    plugin.lastMaterialized.set(file.path, {
      diskHash,
      ydocHash: yTextHash,
      path: file.path,
      writtenAt: Date.now(),
    })
    return
  }

  console.warn('[kuroflare] importing external disk edit', { path: file.path })
  await plugin.importFileTextAndSend(file, diskText, 'disk-modify')
}

export async function handleBackgroundDiskModify(
  plugin: KuroflareSpikePlugin,
  file: TFile,
): Promise<void> {
  const docId = await plugin.fileDocIdForPath(file.path)
  const loaded = await plugin.loadTextDoc(docId)
  const diskText = await plugin.app.vault.read(file)
  const diskHash = await hashCanonicalText(diskText)
  const yTextHash = await hashCanonicalText(loaded.text.toJSON())
  const last = plugin.lastMaterialized.get(file.path)

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
    plugin.lastMaterialized.set(file.path, {
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
  await plugin.importFileTextIntoDocAndSend(file, docId, 'background-disk-modify')
}

export async function importActiveFileFromDiskAndSend(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const file = plugin.activeFile
  if (file === null) {
    new Notice('Kuroflare sync: no active file')
    return
  }
  await plugin.importFileTextAndSend(file, await plugin.app.vault.read(file), reason)
}

export async function importFileTextAndSend(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  text: string,
  reason: string,
): Promise<void> {
  plugin.replaceYText(canonicalizeTextForYText(text), DISK_ORIGIN)
  const textHash = await hashCanonicalText(plugin.ytext.toJSON())
  plugin.lastMaterialized.set(file.path, {
    diskHash: textHash,
    ydocHash: textHash,
    path: file.path,
    writtenAt: Date.now(),
  })
  await plugin.sendCurrentYDocToWorker(reason)
}

export async function importFileTextIntoDocAndSend(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  docId: FileDocId,
  reason: string,
): Promise<void> {
  await plugin.importFileTextIntoDoc(file, docId, await plugin.app.vault.read(file))
  const loaded = await plugin.loadTextDoc(docId)
  await plugin.sendDocUpdateToWorker(docId, Y.encodeStateAsUpdate(loaded.doc), reason)
}

export async function importFileTextIntoDoc(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  docId: FileDocId,
  textContent: string,
): Promise<void> {
  const loaded = await plugin.loadTextDoc(docId)
  const text = canonicalizeTextForYText(textContent)
  replaceYText(loaded.doc, loaded.text, text, DISK_ORIGIN)
  const textHash = await hashCanonicalText(loaded.text.toJSON())
  plugin.lastMaterialized.set(file.path, {
    diskHash: textHash,
    ydocHash: textHash,
    path: file.path,
    writtenAt: Date.now(),
    diskMtimeMs: file.stat.mtime,
    diskSize: file.stat.size,
  })
}

export async function flushYTextToDisk(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const file = plugin.activeFile
  if (!file) {
    new Notice('Kuroflare spike: no active file')
    return
  }

  const yText = plugin.ytext.toJSON()
  const yTextHash = await hashCanonicalText(yText)
  const diskText = await plugin.app.vault.read(file)
  const diskHash = await hashCanonicalText(diskText)
  const last = plugin.lastMaterialized.get(file.path)
  const decision = decideMaterializeWrite({
    path: file.path,
    // This flush always targets the plugin's own active file, so the
    // active-editor guard (meant to protect files open elsewhere from
    // background writes) must not compare against itself here.
    activeFilePath: undefined,
    currentDiskHash: diskHash,
    lastMaterialized: last,
  })

  if (decision.action === 'block-conflict') {
    const conflictPath = await plugin.createConflictCopy(file, diskText)
    console.warn('[kuroflare] materialize CAS blocked write', {
      path: file.path,
      conflictPath,
      casReason: decision.reason,
      reason,
    })
    plugin.replaceYText(canonicalizeTextForYText(diskText), DISK_ORIGIN)
    new Notice('Kuroflare spike: disk changed, conflict copy created')
    return
  }

  if (decision.action === 'skip-active-editor') {
    console.debug('[kuroflare] materialize skipped active editor', { path: file.path, reason })
    return
  }

  await plugin.app.vault.modify(file, yText)
  plugin.lastMaterialized.set(file.path, {
    diskHash: yTextHash,
    ydocHash: yTextHash,
    path: file.path,
    writtenAt: Date.now(),
  })

  console.info('[kuroflare] flushed YText to disk', { path: file.path, reason })
  new Notice('Kuroflare spike: flushed YText to disk')
}

export async function createConflictCopy(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  content: string,
): Promise<string> {
  const path = await plugin.allocateConflictPath(file)
  if (await plugin.app.vault.adapter.exists(path)) {
    throw new Error(`Allocated conflict path already exists: ${path}`)
  }
  await plugin.app.vault.create(path, content)
  return path
}

export async function allocateConflictPath(
  plugin: KuroflareSpikePlugin,
  file: TFile,
): Promise<string> {
  const extension = file.extension ? `.${file.extension}` : ''
  const parentPath = file.parent?.path
  const basePath = parentPath && parentPath !== '/' ? `${parentPath}/` : ''
  const baseName = file.basename
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`
    const path = `${basePath}${baseName} (kuroflare conflict ${stamp}${suffix})${extension}`
    if (
      !plugin.app.vault.getAbstractFileByPath(path) &&
      !(await plugin.app.vault.adapter.exists(path))
    ) {
      return path
    }
  }

  throw new Error('Unable to allocate conflict path')
}

export async function loadTextDoc(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
): Promise<LoadedTextDoc> {
  const existing = plugin.loadedTextDocs.get(docId.ydocId)
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
    void plugin.sendDocUpdateToWorker(docId, update, 'local-update')
  })
  const persistence = new IndexeddbPersistence(`kuroflare-file:${docId.ydocId}`, doc)
  loaded.persistence = persistence
  plugin.loadedTextDocs.set(docId.ydocId, loaded)
  await persistence.whenSynced
  return loaded
}

export function setActiveTextDoc(plugin: KuroflareSpikePlugin, loaded: LoadedTextDoc): void {
  plugin.activeTextDoc = loaded
  plugin.ydoc = loaded.doc
  plugin.ytext = loaded.text
}

export async function openMetaPersistence(plugin: KuroflareSpikePlugin): Promise<void> {
  plugin.metaPersistence = new IndexeddbPersistence(META_DOC_NAME, plugin.metaDoc)
  await plugin.metaPersistence.whenSynced
  for (const [fileId, value] of plugin.metaMap.entries()) {
    if (isMetaFile(value, fileId) && !value.deleted) {
      plugin.materializedPaths.set(value.fileId, value.path)
    }
  }
  await plugin.reconcileAndMaterializeMeta()
}
