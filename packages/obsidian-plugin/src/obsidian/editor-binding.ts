import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { computeMinimalTextReplacement } from '@kuroflare/core'
import type { MarkdownView } from 'obsidian'
import { yCollab } from 'y-codemirror.next'
import type * as Y from 'yjs'

interface MaybeCodeMirrorEditor {
  readonly editor?: {
    readonly cm?: unknown
  }
}

function isMaybeCodeMirrorEditor(value: unknown): value is MaybeCodeMirrorEditor {
  return typeof value === 'object' && value !== null && 'editor' in value
}

/**
 * Extracts Obsidian's CodeMirror 6 editor view from an active markdown view.
 *
 * @param markdownView Obsidian markdown view to inspect.
 * @returns The embedded EditorView, or null when Obsidian does not expose one.
 */
export function getEditorView(markdownView: MarkdownView): EditorView | null {
  const maybeEditor: unknown = markdownView
  if (!isMaybeCodeMirrorEditor(maybeEditor)) {
    return null
  }
  const cm = maybeEditor.editor?.cm
  return cm instanceof EditorView ? cm : null
}

/**
 * Builds the editor extension that binds one Y.Text to CodeMirror.
 *
 * @param ytext Shared text document for the active markdown file.
 * @param awareness Optional provider awareness instance for remote selections.
 * @returns CodeMirror extension installed through a compartment.
 */
export function createYTextEditorExtension(ytext: Y.Text, awareness: unknown = null): Extension {
  return yCollab(ytext, awareness, { undoManager: false })
}

/**
 * Replaces the entire CodeMirror document in one dispatch.
 *
 * @param editorView Editor view to update.
 * @param nextText Text that should become the visible editor buffer.
 */
export function dispatchFullDocumentReplace(editorView: EditorView, nextText: string): void {
  editorView.dispatch({
    changes: {
      from: 0,
      to: editorView.state.doc.length,
      insert: nextText,
    },
  })
}

/**
 * Applies a minimal text replacement to a Y.Text inside a transaction.
 *
 * @param ydoc Parent Y.Doc used to create the transaction boundary.
 * @param ytext Target shared text.
 * @param nextText Desired text content.
 * @param origin Transaction origin used for echo-loop filtering.
 */
export function replaceYText(ydoc: Y.Doc, ytext: Y.Text, nextText: string, origin: string): void {
  const previous = ytext.toJSON()
  const replacement = computeMinimalTextReplacement(previous, nextText)
  if (!replacement) {
    return
  }

  ydoc.transact(() => {
    if (replacement.deleteLength > 0) {
      ytext.delete(replacement.from, replacement.deleteLength)
    }
    if (replacement.insert.length > 0) {
      ytext.insert(replacement.from, replacement.insert)
    }
  }, origin)
}
