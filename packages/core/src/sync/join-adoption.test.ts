import { assert, test } from 'vitest'

import { decideJoinFileAdoption } from '../sync/join-adoption'
import { makeFileId } from '../utils/ids'

const remoteFileId = makeFileId('remote-file-a')

test('join adoption allocates a new fileId when remote has no matching path', () => {
  assert.deepEqual(
    decideJoinFileAdoption({
      remoteEntry: undefined,
      localContentHash: 'local-hash',
    }),
    { action: 'allocate-new' },
  )
})

test('join adoption adopts the remote fileId without changes when content hashes match', () => {
  assert.deepEqual(
    decideJoinFileAdoption({
      remoteEntry: { fileId: remoteFileId, contentHash: 'same-hash' },
      localContentHash: 'same-hash',
    }),
    { action: 'adopt-matching-content', fileId: remoteFileId },
  )
})

test('join adoption adopts the remote fileId and imports the local diff when hashes differ', () => {
  assert.deepEqual(
    decideJoinFileAdoption({
      remoteEntry: { fileId: remoteFileId, contentHash: 'remote-hash' },
      localContentHash: 'local-hash',
    }),
    { action: 'adopt-with-local-edit', fileId: remoteFileId },
  )
})
