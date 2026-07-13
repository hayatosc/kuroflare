import * as Y from 'yjs'

/** Creates a fresh Y.Doc from a verified full snapshot update. */
export function createYDocFromSnapshot(updateBytes: Uint8Array, origin: unknown): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, updateBytes, origin)
  return doc
}
