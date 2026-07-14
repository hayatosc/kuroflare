import { assert, test } from 'vitest'

import {
  decideOutboxSyncUpdateRejectedRepair,
  makeMessageId,
  makeOutboxPlanItemId,
  makeSha256Hex,
  makeYDocId,
} from '../index'

const itemId = outboxId('rejected-repair-item')
const docId = { kind: 'file', ydocId: makeYDocId('rejected-repair-doc') } as const
const messageId = makeMessageId('rejected-repair-message')
const hash = makeSha256Hex('a'.repeat(64))

const valid = {
  itemId,
  kind: 'y-update' as const,
  status: 'paused' as const,
  reason: 'sync-update-rejected',
  docId,
  messageId,
  updateSha256: hash,
  rejectionUpdateSha256: hash,
  rejectionReason: 'large-update-requires-snapshot-import' as const,
  rejectionRetryable: false as const,
  updateBytesBase64: 'AQID',
  importedSnapshotSeq: 7,
}

function outboxId(value: string) {
  const id = makeOutboxPlanItemId(value)
  if (id === null) throw new Error('invalid test outbox ID')
  return id
}

test('rejected repair completion requires exact paused evidence and imported sequence', () => {
  assert.deepEqual(decideOutboxSyncUpdateRejectedRepair(valid), {
    action: 'complete',
    patch: {
      id: itemId,
      status: 'done',
      nextAttemptAt: undefined,
      completedBy: 'sync-update-rejected-repair',
      snapshotSeq: 7,
    },
  })
  assert.equal(decideOutboxSyncUpdateRejectedRepair({ ...valid, status: 'done' }).action, 'reject')
  assert.equal(
    decideOutboxSyncUpdateRejectedRepair({
      ...valid,
      updateSha256: makeSha256Hex('b'.repeat(64)),
    }).action,
    'reject',
  )
  assert.equal(
    decideOutboxSyncUpdateRejectedRepair({ ...valid, importedSnapshotSeq: 0 }).action,
    'reject',
  )
  assert.equal(
    decideOutboxSyncUpdateRejectedRepair({ ...valid, kind: 'blob-put' }).action,
    'reject',
  )
  assert.equal(
    decideOutboxSyncUpdateRejectedRepair({
      ...valid,
      rejectionReason: undefined,
    }).action,
    'reject',
  )
})
