import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { createYDocFromSnapshot } from './snapshot-replace'

test('full snapshot replacement does not retain stale Y.Doc structs', () => {
  const staleDoc = new Y.Doc()
  staleDoc.getMap('meta').set('stale-file', { path: 'stale.md' })

  const snapshotDoc = new Y.Doc()
  snapshotDoc.getMap('meta').set('remote-file', { path: 'remote.md' })
  const snapshot = Y.encodeStateAsUpdate(snapshotDoc)
  const replaced = createYDocFromSnapshot(snapshot, 'worker')

  assert.equal(replaced.getMap('meta').has('stale-file'), false)
  assert.deepEqual(replaced.getMap('meta').get('remote-file'), { path: 'remote.md' })
  assert.equal(staleDoc.getMap('meta').has('stale-file'), true)
})
