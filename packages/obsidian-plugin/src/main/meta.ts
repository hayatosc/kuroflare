import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type { FileDocId, LoadedTextDoc } from '../main-types'
import { DISK_ORIGIN, REMOTE_ORIGIN, WORKER_ORIGIN, SPIKE_TEXT_NAME } from './constants'
import type KuroflareSpikePlugin from './plugin'
import { sendDocUpdateToWorker } from './sync-websocket'

export function metaMap(plugin: KuroflareSpikePlugin): Y.Map<unknown> {
  return plugin.metaDoc.getMap<unknown>('meta')
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

export function setActiveTextDoc(plugin: KuroflareSpikePlugin, loaded: LoadedTextDoc): void {
  plugin.activeTextDoc = loaded
  plugin.ydoc = loaded.doc
  plugin.ytext = loaded.text
}
