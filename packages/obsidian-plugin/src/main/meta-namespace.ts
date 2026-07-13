import * as Y from 'yjs'

/** Creates an empty in-memory meta document when switching persisted vault namespaces. */
export function createFreshMetaDocForVaultSwitch(previous: Y.Doc): Y.Doc {
  previous.destroy()
  return new Y.Doc()
}
