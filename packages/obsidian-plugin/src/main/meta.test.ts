// @vitest-environment jsdom

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  hashCanonicalText,
  makeDeviceId,
  makeFileId,
  makeYDocId,
  type MetaFile,
} from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { LoadedTextDoc } from '../main-types'
import { flushYTextToDisk } from './editor'
import {
  activateLoadedTextDoc,
  insertMetaFile,
  metaDocWritable,
  metaDocEntriesRepresented,
  shouldAdoptRemoteMetadata,
  shouldPrepareMetadataMigration,
} from './meta'

test('active full-snapshot replacement rebinds editor, active doc, and disk to remote text', async () => {
  const compartment = new Compartment()
  const editorView = new EditorView({
    state: EditorState.create({
      doc: 'local',
      extensions: [compartment.of([])],
    }),
    parent: document.body,
  })

  const oldDoc = new Y.Doc()
  const oldText = oldDoc.getText('content')
  oldText.insert(0, 'local')
  const oldLoaded: LoadedTextDoc = {
    docId: { kind: 'file', ydocId: 'file-snapshot-replacement' },
    doc: oldDoc,
    text: oldText,
    persistence: null,
  }

  const remoteDoc = new Y.Doc()
  const remoteText = remoteDoc.getText('content')
  remoteText.insert(0, 'remote')
  const remoteLoaded: LoadedTextDoc = {
    docId: oldLoaded.docId,
    doc: remoteDoc,
    text: remoteText,
    persistence: null,
  }

  let diskText = 'local'
  const localHash = await hashCanonicalText(diskText)
  const plugin = {
    activeTextDoc: oldLoaded,
    ydoc: oldDoc,
    ytext: oldText,
    activeView: editorView,
    cmCompartment: compartment,
    yCollabBoundViews: new WeakSet<EditorView>([editorView]),
    activeFile: {
      path: 'note.md',
      basename: 'note',
      extension: 'md',
      parent: null,
    },
    lastMaterialized: new Map([
      [
        'note.md',
        {
          diskHash: localHash,
          ydocHash: localHash,
          path: 'note.md',
          writtenAt: 1,
        },
      ],
    ]),
    startupSideEffectGate: { canRun: () => true },
    app: {
      vault: {
        read: async () => diskText,
        modify: async (_file: unknown, text: string) => {
          diskText = text
        },
        create: async () => undefined,
        getAbstractFileByPath: () => null,
        adapter: { exists: async () => false },
      },
    },
  }

  activateLoadedTextDoc(plugin, remoteLoaded)
  assert.equal(plugin.activeTextDoc, remoteLoaded)
  assert.equal(plugin.ydoc, remoteDoc)
  assert.equal(plugin.ytext, remoteText)
  assert.equal(editorView.state.doc.toString(), 'remote')

  await flushYTextToDisk(plugin, 'full-snapshot-test')
  assert.equal(diskText, 'remote')

  editorView.destroy()
  oldDoc.destroy()
  remoteDoc.destroy()
})

test('deferred metadata migration starts after an empty hello receives legacy metadata', () => {
  const doc = new Y.Doc()
  assert.equal(
    shouldPrepareMetadataMigration({
      metadataAccess: 'read-write',
      migrationPending: true,
      metaDoc: doc,
    }),
    false,
  )

  const fileId = makeFileId('deferred-migration')
  doc.getMap('meta').set(fileId, legacyText(fileId))
  assert.equal(
    shouldPrepareMetadataMigration({
      metadataAccess: 'read-write',
      migrationPending: true,
      metaDoc: doc,
    }),
    true,
  )

  const grouped = new Y.Doc()
  insertMetaFile(grouped.getMap('meta'), legacyText(fileId))
  assert.equal(
    shouldPrepareMetadataMigration({
      metadataAccess: 'read-write',
      migrationPending: true,
      metaDoc: grouped,
    }),
    false,
  )
  doc.destroy()
  grouped.destroy()
})

test('remote v2 adoption is rejected when local legacy metadata would be lost or changed', () => {
  const fileId = makeFileId('adoption-check')
  const local = new Y.Doc()
  local.getMap('meta').set(fileId, legacyText(fileId))

  const equivalent = new Y.Doc()
  insertMetaFile(equivalent.getMap('meta'), legacyText(fileId))
  assert.equal(metaDocEntriesRepresented(local, equivalent), true)

  const remoteOnly = new Y.Doc()
  insertMetaFile(remoteOnly.getMap('meta'), legacyText(fileId))
  const extraId = makeFileId('adoption-remote-only')
  insertMetaFile(remoteOnly.getMap('meta'), legacyText(extraId))
  assert.equal(metaDocEntriesRepresented(local, remoteOnly), true)

  const localOnly = new Y.Doc()
  assert.equal(metaDocEntriesRepresented(local, localOnly), false)
  assert.equal(shouldAdoptRemoteMetadata(local, localOnly), false)
  assert.equal(shouldAdoptRemoteMetadata(local, equivalent), true)

  const divergent = new Y.Doc()
  const changed = legacyText(fileId)
  changed.path = 'Notes/Changed.md'
  changed.canonicalPath = 'notes/changed.md'
  insertMetaFile(divergent.getMap('meta'), changed)
  assert.equal(metaDocEntriesRepresented(local, divergent), false)

  local.destroy()
  equivalent.destroy()
  remoteOnly.destroy()
  localOnly.destroy()
  divergent.destroy()
})

test('metadata writes fail closed for pending persisted Yjs structs', () => {
  const parent = new Y.Doc()
  parent.getMap('root').set('child', new Y.Map<unknown>())
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(parent))
  const child = client.getMap<Y.Map<unknown>>('root').get('child')
  assert.ok(child instanceof Y.Map)
  child.set('value', 'pending')
  const poisoned = new Y.Doc()
  Y.applyUpdate(poisoned, Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent)))
  assert.equal(metaDocWritable(poisoned), false)

  const tombstone = new Y.Doc()
  const map = tombstone.getMap('meta')
  const tombstoneId = makeFileId('tombstone')
  map.set(tombstoneId, { value: 'deleted' })
  map.delete(tombstoneId)
  assert.equal(metaDocWritable(tombstone), true)
  poisoned.destroy()
  tombstone.destroy()
  client.destroy()
  parent.destroy()
})

function legacyText(fileId: string): MetaFile {
  const deviceId = makeDeviceId('deferred-device')
  return {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Deferred.md',
    canonicalPath: 'notes/deferred.md',
    type: 'text',
    ydocId: makeYDocId('deferred-doc'),
    deleted: false,
    createdAt: 1,
    createdBy: deviceId,
    contentUpdatedAt: 1,
    contentUpdatedBy: deviceId,
    updatedAt: 1,
    updatedBy: deviceId,
    mtime: 1,
  }
}
