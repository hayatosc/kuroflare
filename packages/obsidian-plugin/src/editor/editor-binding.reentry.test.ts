// @vitest-environment jsdom
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, assert, test } from 'vitest'
import * as Y from 'yjs'

import { createYTextEditorExtension, dispatchFullDocumentReplace } from './editor-binding'

// Regression test for the "first full-sync round-trip loses remote-seeded content" bug found in
// the real-Obsidian miniflare e2e. Startup can call `bindActiveMarkdownView` (main.ts) twice in
// quick succession for the same file ('layout-ready' then 'foreground-resume:layout-ready'). The
// second call's `seedYTextFromDiskIfNeeded` snapshots `ytext.toJSON()` into a local variable and,
// after further `await`s (disk read, hashing), compares that stale snapshot against the *current*
// editor buffer, calling `dispatchFullDocumentReplace(editorView, snapshot)` on mismatch. If
// yCollab is *already* bound to that editorView (installed by the first call), this dispatch is
// not a benign editor-only repaint: y-codemirror.next's YSyncPluginValue.update() mirrors any
// doc-changed CM6 transaction straight back into the bound Y.Text as a real local edit -- deleting
// whatever the Y.Text currently holds and inserting the stale snapshot. If a remote update merged
// into the Y.Text after the snapshot was captured but before the dispatch fires, that remote
// insert is deleted and replaced by the stale, local-only snapshot.
//
// The fix (main.ts): `seedYTextFromDiskIfNeeded` now refuses to call `dispatchFullDocumentReplace`
// on a view that is already yCollab-bound (tracked in `KuroflareSpikePlugin#yCollabBoundViews`,
// populated right after `cmCompartment.reconfigure` installs the binding). This test exercises
// that guard pattern directly against the real y-codemirror.next binding, since
// `bindActiveMarkdownView` itself is not unit-testable in isolation (it is entangled with
// Obsidian's `Plugin`/`Workspace`/`MarkdownView`/`Vault` globals, none of which are mocked
// anywhere else in this test suite).

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy()
  }
  document.body.replaceChildren()
})

function mountEditor(ytext: Y.Text, initialDoc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: initialDoc,
      extensions: [createYTextEditorExtension(ytext)],
    }),
    parent,
  })
  views.push(view)
  return view
}

/** Walks the Yjs internal linked list, matching how the original corruption was diagnosed. */
function historyOf(ytext: Y.Text): Array<{ str: unknown; deleted: boolean }> {
  const out: Array<{ str: unknown; deleted: boolean }> = []
  let item = Reflect.get(ytext, '_start')
  while (item !== null) {
    out.push({ str: Reflect.get(item.content, 'str'), deleted: item.deleted })
    item = item.right
  }
  return out
}

test('a bound-view guard prevents a stale realignment from discarding a concurrent remote merge', () => {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  // Mirrors `KuroflareSpikePlugin#yCollabBoundViews`.
  const yCollabBoundViews = new WeakSet<EditorView>()

  // Step 1: ytext already holds locally-seeded content (as if disk-seeded in an earlier bind),
  // and the editor is bound and in sync with it -- the steady state right after a successful
  // bind installs yCollab.
  ydoc.transact(() => {
    ytext.insert(0, 'Local')
  }, 'kuroflare:disk-seed')
  const view = mountEditor(ytext, ytext.toJSON())
  yCollabBoundViews.add(view)
  assert.equal(view.state.doc.toString(), 'Local')

  // Step 2: a second, racing bind pass for the same file/view snapshots the Y.Text before a
  // remote update lands.
  const staleCurrentYText = ytext.toJSON()
  assert.equal(staleCurrentYText, 'Local')

  // Step 3: a remote peer's update merges into the Y.Text while the snapshot above is
  // stale-in-flight (e.g. during the disk read / hash awaits inside seedYTextFromDiskIfNeeded).
  // Because yCollab is already bound, the editor buffer picks this up immediately.
  ydoc.transact(() => {
    ytext.insert(5, 'Remote')
  }, 'kuroflare:remote-simulated')
  assert.equal(ytext.toJSON(), 'LocalRemote')
  assert.equal(
    view.state.doc.toString(),
    'LocalRemote',
    'yCollab should have pushed the remote insert into the editor',
  )

  // Step 4: the racing bind pass re-checks the (now stale) snapshot against the live editor
  // buffer and would normally realign it -- but the fixed seedYTextFromDiskIfNeeded skips
  // dispatchFullDocumentReplace once the view is already yCollab-bound, exactly this case.
  assert.notEqual(staleCurrentYText, view.state.doc.toString())
  if (!yCollabBoundViews.has(view) && staleCurrentYText !== view.state.doc.toString()) {
    dispatchFullDocumentReplace(view, staleCurrentYText)
  }

  // The remote insert must survive: both in the visible text...
  assert.equal(ytext.toJSON(), 'LocalRemote')
  assert.equal(view.state.doc.toString(), 'LocalRemote')

  // ...and structurally: no item was deleted, and no stale local-only item was re-inserted.
  const history = historyOf(ytext)
  assert.isTrue(
    history.every((entry) => !entry.deleted),
    'no CRDT item should have been deleted by the (skipped) stale realignment',
  )
})

// Regression test for the file-switch ordering hazard: Obsidian can reuse the same EditorView
// across a file switch within one leaf. If `bindActiveMarkdownView` (main.ts) realigned the
// buffer for the *new* file while the view still had the *previous* file's yCollab binding live,
// y-sync would mirror that realignment dispatch straight back into the *previous* file's Y.Text --
// deleting whatever it held and inserting the new file's stale snapshot. The fix detaches the
// compartment (reconfigures it to `[]`, which destroys the live YSyncPluginValue and unobserves
// its Y.Text) and removes the view from `yCollabBoundViews` *before* seeding/realigning, so the
// realignment dispatch below is a benign, unbound editor-only repaint.
test('detaching before realigning a reused view repaints the buffer without touching the previous file Y.Text', () => {
  const compartment = new Compartment()
  // Mirrors `KuroflareSpikePlugin#yCollabBoundViews`.
  const yCollabBoundViews = new WeakSet<EditorView>()

  const docA = new Y.Doc()
  const textA = docA.getText('content')
  docA.transact(() => {
    textA.insert(0, 'FileA')
  }, 'kuroflare:disk-seed')

  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    state: EditorState.create({
      doc: textA.toJSON(),
      extensions: [compartment.of(createYTextEditorExtension(textA))],
    }),
    parent,
  })
  views.push(view)
  yCollabBoundViews.add(view)
  assert.equal(view.state.doc.toString(), 'FileA')

  // Obsidian reuses `view` for a different file, whose Y.Text already holds different content.
  const docB = new Y.Doc()
  const textB = docB.getText('content')
  docB.transact(() => {
    textB.insert(0, 'FileB')
  }, 'kuroflare:disk-seed')

  // Detach step: reconfigure the shared compartment to no binding, and drop the view from the
  // bound-views set, mirroring the new guard in bindActiveMarkdownView.
  view.dispatch({ effects: compartment.reconfigure([]) })
  yCollabBoundViews.delete(view)

  // Realign step: with the binding detached, this dispatch cannot be mirrored anywhere.
  const currentYText = textB.toJSON()
  if (!yCollabBoundViews.has(view) && currentYText !== view.state.doc.toString()) {
    dispatchFullDocumentReplace(view, currentYText)
  }

  // The previous file's Y.Text must be untouched by the realignment.
  assert.equal(textA.toJSON(), 'FileA')
  assert.isTrue(
    historyOf(textA).every((entry) => !entry.deleted),
    'detaching before realigning must not mirror into the previous file Y.Text',
  )

  // The buffer now shows the new file's content, still unbound.
  assert.equal(view.state.doc.toString(), 'FileB')

  // Bind step: install the new file's yCollab extension and re-add the view to the set.
  view.dispatch({ effects: compartment.reconfigure(createYTextEditorExtension(textB)) })
  yCollabBoundViews.add(view)

  // From here on, edits flow to the new file's Y.Text only.
  view.dispatch({ changes: { from: 0, insert: 'X' } })
  assert.equal(textB.toJSON(), 'XFileB')
  assert.equal(textA.toJSON(), 'FileA')
})
