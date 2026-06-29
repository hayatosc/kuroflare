// @vitest-environment jsdom
import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, test } from 'vitest'
import * as Y from 'yjs'

import {
  createYTextEditorExtension,
  dispatchFullDocumentReplace,
  replaceYText,
} from './editor-binding.js'

// These tests exercise the real CodeMirror 6 <-> Yjs binding (y-codemirror.next) under jsdom — the
// spec's §9.1 "highest implementation risk" — without a running Obsidian. They prove the binding
// surface (createYTextEditorExtension / replaceYText / dispatchFullDocumentReplace) actually keeps a
// Y.Text and a CodeMirror document in sync in both directions. End-to-end coverage inside the real
// Obsidian shell is left to obsidian-e2e on a machine with the Obsidian app installed.

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy()
  }
  document.body.replaceChildren()
})

function mountEditor(ytext: Y.Text): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: ytext.toJSON(),
      extensions: [createYTextEditorExtension(ytext)],
    }),
    parent,
  })
  views.push(view)
  return view
}

test('a local CodeMirror edit propagates into the bound Y.Text', () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const view = mountEditor(ytext)

  view.dispatch({ changes: { from: 0, insert: 'hello world' } })

  assert.equal(ytext.toJSON(), 'hello world')
})

test('a remote Y.Text change propagates into the bound CodeMirror document', () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const view = mountEditor(ytext)

  // Simulate a remote/peer update arriving outside the editor.
  ydoc.transact(() => {
    ytext.insert(0, 'from peer')
  }, 'kuroflare:remote-simulated')

  assert.equal(view.state.doc.toString(), 'from peer')
})

test('replaceYText applies a minimal diff that both stores observe', () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const view = mountEditor(ytext)
  view.dispatch({ changes: { from: 0, insert: 'the quick brown fox' } })

  replaceYText(ydoc, ytext, 'the quick red fox', 'kuroflare:disk')

  assert.equal(ytext.toJSON(), 'the quick red fox')
  assert.equal(view.state.doc.toString(), 'the quick red fox')
})

test('two editors bound to merged Y.Docs converge on the same text', () => {
  const aliceDoc = new Y.Doc()
  const aliceText = aliceDoc.getText('content')
  const aliceView = mountEditor(aliceText)

  const bobDoc = new Y.Doc()
  const bobText = bobDoc.getText('content')
  const bobView = mountEditor(bobText)

  // Concurrent edits in two independently-bound editors.
  aliceView.dispatch({ changes: { from: 0, insert: 'Alpha' } })
  bobView.dispatch({ changes: { from: 0, insert: 'Bravo' } })

  // Exchange updates the way the sync engine would, then let the bindings reflect the merge.
  Y.applyUpdate(bobDoc, Y.encodeStateAsUpdate(aliceDoc))
  Y.applyUpdate(aliceDoc, Y.encodeStateAsUpdate(bobDoc))

  assert.equal(aliceText.toJSON(), bobText.toJSON())
  assert.equal(aliceView.state.doc.toString(), aliceText.toJSON())
  assert.equal(bobView.state.doc.toString(), bobText.toJSON())
})

test('dispatchFullDocumentReplace swaps the whole editor buffer', () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const view = mountEditor(ytext)
  view.dispatch({ changes: { from: 0, insert: 'original contents' } })

  dispatchFullDocumentReplace(view, 'replacement contents')

  assert.equal(view.state.doc.toString(), 'replacement contents')
  assert.equal(ytext.toJSON(), 'replacement contents')
})
