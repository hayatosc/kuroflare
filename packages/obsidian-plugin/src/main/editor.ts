import { type EditorView } from '@codemirror/view'
import {
  canonicalizeTextForYText,
  hashCanonicalText,
  decideMaterializeWrite,
  decideWatcherHashGate,
  decideWatcherStatPrefilter,
} from '@kuroflare/core'
import { MarkdownView, Notice, TFile } from 'obsidian'
import * as Y from 'yjs'

import type { FileDocId } from '../main-types'
import {
  createYTextEditorExtension,
  dispatchFullDocumentReplace,
  getEditorView,
  replaceYText,
} from '../obsidian/editor-binding'
import { fileDocIdForPath } from './auth'
import { DISK_ORIGIN, MARKDOWN_EXTENSION } from './constants'
import { loadTextDoc, setActiveTextDoc } from './meta'
import type KuroflareSpikePlugin from './plugin'
import { handleLifecycleResume, runSyncStartupTick } from './sync-runtime'
import {
  requestActiveFileFromWorker,
  sendCurrentYDocToWorker,
  sendDocUpdateToWorker,
} from './sync-websocket'

export function registerCommands(plugin: KuroflareSpikePlugin): void {
  plugin.addCommand({
    id: 'kuroflare-spike-bind-active-editor',
    name: 'Kuroflare spike: bind active editor',
    callback: () => {
      void bindActiveMarkdownView(plugin, 'command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-spike-flush-ytext-to-disk',
    name: 'Kuroflare spike: flush YText to disk',
    callback: () => {
      void flushYTextToDisk(plugin, 'command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-spike-simulate-remote-insert',
    name: 'Kuroflare spike: simulate remote insert',
    callback: () => {
      plugin.ydoc.transact(() => {
        plugin.ytext.insert(plugin.ytext.length, `\nremote ${new Date().toISOString()}`)
      }, 'kuroflare:remote-simulated')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-spike-log-state',
    name: 'Kuroflare spike: log state',
    callback: () => {
      void logState(plugin)
    },
  })

  plugin.addCommand({
    id: 'kuroflare-sync-run-startup-tick',
    name: 'Kuroflare sync: run startup tick',
    callback: () => {
      void runSyncStartupTick(plugin, 'command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-sync-send-active-file-update',
    name: 'Kuroflare sync: send active file update',
    callback: () => {
      void sendCurrentYDocToWorker(plugin, 'command')
    },
  })

  plugin.addCommand({
    id: 'kuroflare-sync-import-and-send-active-file',
    name: 'Kuroflare sync: import and send active file',
    callback: () => {
      void importActiveFileFromDiskAndSend(plugin, 'command')
    },
  })
}

async function logState(plugin: KuroflareSpikePlugin): Promise<void> {
  console.info('[kuroflare] state', {
    activePath: plugin.activeFile?.path,
    yTextLength: plugin.ytext.length,
    yTextHash: await hashCanonicalText(plugin.ytext.toJSON()),
    lastMaterialized: plugin.activeFile
      ? plugin.lastMaterialized.get(plugin.activeFile.path)
      : undefined,
  })
  new Notice('Kuroflare spike state logged to console')
}

export function registerWorkspaceEvents(plugin: KuroflareSpikePlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('active-leaf-change', () => {
      void bindActiveMarkdownView(plugin, 'active-leaf-change')
    }),
  )

  plugin.registerEvent(
    plugin.app.workspace.on('file-open', () => {
      void bindActiveMarkdownView(plugin, 'file-open')
    }),
  )

  plugin.registerDomEvent(window, 'focus', () => {
    void handleLifecycleResume(plugin, 'window-focus')
  })
  plugin.registerDomEvent(document, 'visibilitychange', () => {
    if (!document.hidden) {
      void handleLifecycleResume(plugin, 'visibilitychange')
    }
  })
  plugin.registerDomEvent(window, 'online', () => {
    void handleLifecycleResume(plugin, 'online')
  })
}

export function registerVaultWatcher(plugin: KuroflareSpikePlugin): void {
  plugin.fileModifyRef = plugin.app.vault.on('modify', (file) => {
    if (!(file instanceof TFile) || file.extension !== MARKDOWN_EXTENSION) {
      return
    }

    if (plugin.activeFile?.path === file.path) {
      void handleDiskModify(plugin, file)
      return
    }

    const prefilter = decideWatcherStatPrefilter({
      currentMtimeMs: file.stat.mtime,
      currentSize: file.stat.size,
      lastMaterialized: plugin.lastMaterialized.get(file.path),
    })
    if (prefilter.action === 'skip-unchanged-stat') {
      return
    }

    void handleBackgroundDiskModify(plugin, file)
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

  if (plugin.activeFile?.path === file.path && plugin.activeView === editorView) {
    return
  }

  const generation = ++plugin.bindGeneration
  const docId = await fileDocIdForPath(plugin, file.path)

  if (generation !== plugin.bindGeneration) return

  const loaded = await loadTextDoc(plugin, docId)
  if (generation !== plugin.bindGeneration) return

  setActiveTextDoc(plugin, loaded)
  plugin.targetPath = file.path
  plugin.activeFile = file
  plugin.activeView = editorView

  if (plugin.yCollabBoundViews.has(editorView)) {
    editorView.dispatch({ effects: plugin.cmCompartment.reconfigure([]) })
    plugin.yCollabBoundViews.delete(editorView)
  }

  await seedYTextFromDiskIfNeeded(plugin, file, editorView, generation)
  if (generation !== plugin.bindGeneration) return

  editorView.dispatch({
    effects: plugin.cmCompartment.reconfigure(createYTextEditorExtension(plugin.ytext)),
  })
  plugin.yCollabBoundViews.add(editorView)
  await requestActiveFileFromWorker(plugin, `bind:${reason}`)

  plugin.setStatus(`bound: ${file.basename}`)
  console.info('[kuroflare] bound active editor', { path: file.path, docId, reason })
}

async function seedYTextFromDiskIfNeeded(
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

  if (generation !== plugin.bindGeneration) return

  if (plugin.ytext.length === 0) {
    replaceYText(plugin.ydoc, plugin.ytext, canonicalizeTextForYText(diskText), DISK_ORIGIN)
    return
  }

  if (
    !plugin.yCollabBoundViews.has(editorView) &&
    currentYText !== editorView.state.doc.toString()
  ) {
    dispatchFullDocumentReplace(editorView, currentYText)
  }
}

async function handleDiskModify(plugin: KuroflareSpikePlugin, file: TFile): Promise<void> {
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
    plugin.lastMaterialized.set(file.path, {
      diskHash,
      ydocHash: yTextHash,
      path: file.path,
      writtenAt: Date.now(),
    })
    return
  }

  console.warn('[kuroflare] importing external disk edit', { path: file.path })
  await importFileTextAndSend(plugin, file, diskText, 'disk-modify')
}

async function handleBackgroundDiskModify(
  plugin: KuroflareSpikePlugin,
  file: TFile,
): Promise<void> {
  const docId = await fileDocIdForPath(plugin, file.path)
  const loaded = await loadTextDoc(plugin, docId)
  const diskText = await plugin.app.vault.read(file)
  const diskHash = await hashCanonicalText(diskText)
  const yTextHash = await hashCanonicalText(loaded.text.toJSON())
  const last = plugin.lastMaterialized.get(file.path)

  const decision = decideWatcherHashGate({
    currentDiskHash: diskHash,
    currentYDocHash: yTextHash,
    lastMaterialized: last,
  })

  if (decision.action === 'ignore-own-write') return
  if (decision.action === 'ignore-converged-write') {
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

  console.warn('[kuroflare] importing external disk edit for background file', { path: file.path })
  await importFileTextIntoDocAndSend(plugin, file, docId, 'background-disk-modify')
}

async function importActiveFileFromDiskAndSend(
  plugin: KuroflareSpikePlugin,
  reason: string,
): Promise<void> {
  const file = plugin.activeFile
  if (file === null) {
    new Notice('Kuroflare sync: no active file')
    return
  }
  await importFileTextAndSend(plugin, file, await plugin.app.vault.read(file), reason)
}

export async function importFileTextAndSend(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  text: string,
  reason: string,
): Promise<void> {
  replaceYText(plugin.ydoc, plugin.ytext, canonicalizeTextForYText(text), DISK_ORIGIN)
  const textHash = await hashCanonicalText(plugin.ytext.toJSON())
  plugin.lastMaterialized.set(file.path, {
    diskHash: textHash,
    ydocHash: textHash,
    path: file.path,
    writtenAt: Date.now(),
  })
  await sendCurrentYDocToWorker(plugin, reason)
}

export async function importFileTextIntoDocAndSend(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  docId: FileDocId,
  reason: string,
): Promise<void> {
  await importFileTextIntoDoc(plugin, file, docId, await plugin.app.vault.read(file))
  const loaded = await loadTextDoc(plugin, docId)
  await sendDocUpdateToWorker(plugin, docId, Y.encodeStateAsUpdate(loaded.doc), reason)
}

export async function importFileTextIntoDoc(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  docId: FileDocId,
  textContent: string,
): Promise<void> {
  const loaded = await loadTextDoc(plugin, docId)
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
    activeFilePath: undefined,
    currentDiskHash: diskHash,
    lastMaterialized: last,
  })

  if (decision.action === 'block-conflict') {
    const conflictPath = await createConflictCopy(plugin, file, diskText)
    console.warn('[kuroflare] materialize CAS blocked write', {
      path: file.path,
      conflictPath,
      casReason: decision.reason,
      reason,
    })
    replaceYText(plugin.ydoc, plugin.ytext, canonicalizeTextForYText(diskText), DISK_ORIGIN)
    new Notice('Kuroflare spike: disk changed, conflict copy created')
    return
  }

  if (decision.action === 'skip-active-editor') return

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

async function createConflictCopy(
  plugin: KuroflareSpikePlugin,
  file: TFile,
  content: string,
): Promise<string> {
  const path = await allocateConflictPath(plugin, file)
  if (await plugin.app.vault.adapter.exists(path)) {
    throw new Error(`Allocated conflict path already exists: ${path}`)
  }
  await plugin.app.vault.create(path, content)
  return path
}

async function allocateConflictPath(plugin: KuroflareSpikePlugin, file: TFile): Promise<string> {
  const ext = file.extension ? `.${file.extension}` : ''
  const parentPath = file.parent?.path
  const basePath = parentPath && parentPath !== '/' ? `${parentPath}/` : ''
  const baseName = file.basename
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`
    const path = `${basePath}${baseName} (kuroflare conflict ${stamp}${suffix})${ext}`
    if (
      !plugin.app.vault.getAbstractFileByPath(path) &&
      !(await plugin.app.vault.adapter.exists(path))
    ) {
      return path
    }
  }
  throw new Error('Unable to allocate conflict path')
}
