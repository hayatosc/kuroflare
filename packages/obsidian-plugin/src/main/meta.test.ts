// @vitest-environment jsdom

import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { hashCanonicalText } from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import type { LoadedTextDoc } from '../main-types'
import { flushYTextToDisk } from './editor'
import { activateLoadedTextDoc } from './meta'

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
