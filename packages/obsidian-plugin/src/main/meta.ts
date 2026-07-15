import type { Compartment } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  decodeMetaValue,
  groupedEntryFromMetaFile,
  type MetaFile,
  type MetaGroupedEntry,
} from '@kuroflare/core'
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

export type MetaGroupName = 'identity' | 'location' | 'content' | 'deletion'

export function readMetaFile(metaMap: Y.Map<unknown>, fileId: string): MetaFile | undefined {
  return decodeMetaValue(metaMap.get(fileId), fileId).metaFile
}

export function readMetaEntries(metaMap: Y.Map<unknown>): readonly MetaFile[] {
  const entries: MetaFile[] = []
  for (const [fileId, value] of metaMap.entries()) {
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.metaFile !== undefined) entries.push(decoded.metaFile)
  }
  return entries
}

/** Local metadata writes are safe only when every root value is grouped v2. */
export function metaDocWritable(doc: Y.Doc): boolean {
  if (hasUnresolvedYjsState(doc)) return false
  const root = doc.getMap<unknown>('meta')
  for (const [fileId, value] of root.entries()) {
    if (decodeMetaValue(value, fileId).disposition !== 'supported-v2') return false
  }
  return true
}

/** Returns true when Yjs retained pending structs or delete ranges beyond its state vector. */
function hasUnresolvedYjsState(doc: Y.Doc): boolean {
  try {
    const stateVector = Y.encodeStateVector(doc)
    const state = Y.decodeStateVector(stateVector)
    const remainder = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, stateVector))
    if (remainder.structs.length > 0) return true
    for (const [clientId, ranges] of remainder.ds.clients) {
      const coveredClock = state.get(clientId) ?? 0
      for (const range of ranges) {
        if (coveredClock < range.clock + range.len) return true
      }
    }
    return false
  } catch {
    return true
  }
}

/** Combines negotiated server access with the local grouped-document invariant. */
export function metadataWritesEnabled(input: {
  readonly metadataAccess?: 'read-only' | 'read-write'
  readonly metaDoc: Y.Doc
}): boolean {
  return input.metadataAccess !== 'read-only' && metaDocWritable(input.metaDoc)
}

export function metaDocLegacyOnly(doc: Y.Doc): boolean {
  const root = doc.getMap<unknown>('meta')
  if (root.size === 0) return false
  for (const [fileId, value] of root.entries()) {
    if (decodeMetaValue(value, fileId).disposition !== 'legacy-v1') return false
  }
  return true
}

/** Allows remote-v2 adoption only when every local normalized entry is represented unchanged. */
export function metaDocEntriesRepresented(local: Y.Doc, remote: Y.Doc): boolean {
  const localRoot = local.getMap<unknown>('meta')
  const remoteRoot = remote.getMap<unknown>('meta')
  for (const [fileId, value] of localRoot.entries()) {
    const localEntry = decodeMetaValue(value, fileId).metaFile
    const remoteEntry = decodeMetaValue(remoteRoot.get(fileId), fileId).metaFile
    if (
      localEntry === undefined ||
      remoteEntry === undefined ||
      stableMetaFileJson(localEntry) !== stableMetaFileJson(remoteEntry)
    ) {
      return false
    }
  }
  return true
}

/** Remote v2 adoption is safe only for a non-empty grouped document that preserves local entries. */
export function shouldAdoptRemoteMetadata(local: Y.Doc, remote: Y.Doc): boolean {
  return (
    remote.getMap<unknown>('meta').size > 0 &&
    metaDocWritable(remote) &&
    metaDocEntriesRepresented(local, remote)
  )
}

function stableMetaFileJson(value: MetaFile): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  )
}

/** Returns whether an inbound metadata state needs the deferred v1 CAS migration. */
export function shouldPrepareMetadataMigration(input: {
  readonly metadataAccess: 'read-only' | 'read-write'
  readonly migrationPending: boolean
  readonly metaDoc: Y.Doc
}): boolean {
  return (
    input.metadataAccess === 'read-write' &&
    input.migrationPending &&
    input.metaDoc.getMap<unknown>('meta').size > 0 &&
    !metaDocWritable(input.metaDoc)
  )
}

function isNestedMetaMap(value: unknown): value is Y.Map<unknown> {
  return value instanceof Y.Map
}

/** Inserts one new grouped entry. A child map is integrated exactly once. */
export function insertMetaFile(metaMap: Y.Map<unknown>, value: MetaFile): void {
  const grouped = groupedEntryFromMetaFile(value)
  const child = new Y.Map<unknown>()
  child.set('identity', grouped.identity)
  child.set('location', grouped.location)
  child.set('content', grouped.content)
  child.set('deletion', grouped.deletion)
  metaMap.set(value.fileId, child)
}

/** Updates only changed grouped children, preserving concurrent writes to other groups. */
export function updateMetaFile(metaMap: Y.Map<unknown>, value: MetaFile): boolean {
  const child = metaMap.get(value.fileId)
  if (!isNestedMetaMap(child)) return false
  const current = decodeMetaValue(child, value.fileId).grouped
  if (current === undefined) return false
  const next = groupedEntryFromMetaFile(value)
  if (JSON.stringify(current.identity) !== JSON.stringify(next.identity)) return false
  for (const group of ['location', 'content', 'deletion'] as const) {
    if (JSON.stringify(current[group]) !== JSON.stringify(next[group])) {
      child.set(group, next[group])
    }
  }
  return true
}

export function updateMetaGroup(
  metaMap: Y.Map<unknown>,
  fileId: string,
  group: MetaGroupName,
  value: MetaGroupedEntry[MetaGroupName],
): boolean {
  const child = metaMap.get(fileId)
  if (!isNestedMetaMap(child)) return false
  child.set(group, value)
  return true
}

/** Migrates a local all-v1 document before any metadata network write is emitted. */
export function migrateLegacyMetaDoc(doc: Y.Doc): boolean {
  const root = doc.getMap<unknown>('meta')
  if (root.size === 0) return true
  const entries: Array<[string, MetaFile]> = []
  for (const [fileId, value] of root.entries()) {
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.disposition !== 'legacy-v1' || decoded.metaFile === undefined) return false
    entries.push([fileId, decoded.metaFile])
  }
  doc.transact(() => {
    for (const [fileId, value] of entries) {
      if (root.has(fileId)) root.delete(fileId)
      insertMetaFile(root, value)
    }
  }, 'metadata-schema-v2-migration')
  return true
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
