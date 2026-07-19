import { makeDeviceId, makeFileId, makeYDocId } from '@kuroflare/core'
import { assert } from 'vitest'
import * as Y from 'yjs'

export function makePoisonedMetaDoc(fileId: ReturnType<typeof makeFileId>): Y.Doc {
  const parent = new Y.Doc()
  const parentEntry = new Y.Map<unknown>()
  parentEntry.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId(`poison-${fileId}`),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
  })
  parentEntry.set('location', {
    path: 'Notes/Poison.md',
    canonicalPath: 'notes/poison.md',
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  parentEntry.set('content', { contentUpdatedAt: 1, contentUpdatedBy: makeDeviceId('device-1') })
  parentEntry.set('deletion', { deleted: false })
  parent.getMap('meta').set(fileId, parentEntry)

  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(parent))
  const clientEntry = client.getMap<Y.Map<unknown>>('meta').get(fileId)
  assert(clientEntry instanceof Y.Map)
  clientEntry.set('location', {
    path: 'Notes/Poisoned.md',
    canonicalPath: 'notes/poisoned.md',
    updatedAt: 2,
    updatedBy: makeDeviceId('device-1'),
    mtime: 2,
  })
  const pendingUpdate = Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent))

  const poisoned = new Y.Doc()
  Y.applyUpdate(poisoned, pendingUpdate)
  client.destroy()
  parent.destroy()
  return poisoned
}
