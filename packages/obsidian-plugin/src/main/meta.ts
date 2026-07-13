import type { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type { FileDocId, LoadedTextDoc } from '../main-types'
import { createYTextEditorExtension, dispatchFullDocumentReplace } from '../obsidian/editor-binding'
import { DISK_ORIGIN, REMOTE_ORIGIN, WORKER_ORIGIN, SPIKE_TEXT_NAME } from './constants'
import { waitForIndexedDbDeleteDatabase } from './helpers'
import type KuroflareSpikePlugin from './plugin'
import { sendDocUpdateToWorker } from './sync-websocket'

export function metaMap(plugin: Pick<KuroflareSpikePlugin, 'metaDoc'>): Y.Map<unknown> {
  return plugin.metaDoc.getMap<unknown>('meta')
}

/** Minimal plugin surface required to activate a loaded text Y.Doc in the editor. */
export interface ActiveTextDocPlugin {
  activeTextDoc: LoadedTextDoc | null
  ydoc: Y.Doc
  ytext: Y.Text
  readonly activeView: EditorView | null
  readonly cmCompartment: Compartment
  readonly yCollabBoundViews: WeakSet<EditorView>
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
    void sendDocUpdateToWorker(plugin, docId, update, 'local-update')
  })
  const persistence = new IndexeddbPersistence(`kuroflare-file:${docId.ydocId}`, doc)
  loaded.persistence = persistence
  plugin.loadedTextDocs.set(docId.ydocId, loaded)
  await persistence.whenSynced
  return loaded
}

export async function replaceTextDoc(
  plugin: KuroflareSpikePlugin,
  docId: FileDocId,
  updateBytes: Uint8Array,
  origin: unknown,
): Promise<LoadedTextDoc> {
  const existing = plugin.loadedTextDocs.get(docId.ydocId)
  if (existing !== undefined) {
    await existing.persistence?.clearData()
    await waitForIndexedDbDeleteDatabase(indexedDB.deleteDatabase(`kuroflare-file:${docId.ydocId}`))
    existing.doc.destroy()
    plugin.loadedTextDocs.delete(docId.ydocId)
    if (plugin.activeTextDoc === existing) {
      plugin.activeTextDoc = null
    }
  }
  const loaded = await loadTextDoc(plugin, docId)
  Y.applyUpdate(loaded.doc, updateBytes, origin)
  return loaded
}

export function setActiveTextDoc(plugin: ActiveTextDocPlugin, loaded: LoadedTextDoc): void {
  plugin.activeTextDoc = loaded
  plugin.ydoc = loaded.doc
  plugin.ytext = loaded.text
}

/** Activates a replacement text document and rebinds the current CodeMirror view to it. */
export function activateLoadedTextDoc(plugin: ActiveTextDocPlugin, loaded: LoadedTextDoc): void {
  setActiveTextDoc(plugin, loaded)
  const editorView = plugin.activeView
  if (editorView === null) return

  if (plugin.yCollabBoundViews.has(editorView)) {
    editorView.dispatch({ effects: plugin.cmCompartment.reconfigure([]) })
    plugin.yCollabBoundViews.delete(editorView)
  }
  const replacementText = loaded.text.toJSON()
  if (editorView.state.doc.toString() !== replacementText) {
    dispatchFullDocumentReplace(editorView, replacementText)
  }
  editorView.dispatch({
    effects: plugin.cmCompartment.reconfigure(createYTextEditorExtension(loaded.text)),
  })
  plugin.yCollabBoundViews.add(editorView)
}
