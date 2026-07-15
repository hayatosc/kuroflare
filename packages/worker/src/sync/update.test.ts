import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type SyncUpdate,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import { decideSyncUpdateAppend, decideSyncUpdateQuarantine } from './update'

const update: SyncUpdate = {
  type: 'sync-update',
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  vaultId: makeVaultId('vault-a'),
  deviceId: makeDeviceId('device-a'),
  messageId: makeMessageId('message-a'),
  docId: { kind: 'file', ydocId: makeYDocId('doc-a') },
  update: 'AQID',
  baseStateVector: 'BAUG',
}

const updateSha256 = makeSha256Hex('a'.repeat(64))
const otherSha256 = makeSha256Hex('b'.repeat(64))

test('sync update quarantine accepts semantically valid update evidence', () => {
  assert.deepEqual(
    decideSyncUpdateQuarantine({
      update,
      quarantineId: 'quarantine-a',
      updateBytesLength: 20,
      actualUpdateSha256: updateSha256,
      expectedUpdateSha256: updateSha256,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
      now: 1000,
    }),
    {
      action: 'accept',
      updateBytesLength: 20,
      updateSha256,
    },
  )
})

test('sync update quarantine isolates hash, Yjs apply, and meta schema failures without ack evidence', () => {
  assert.deepEqual(
    decideSyncUpdateQuarantine({
      update,
      quarantineId: 'quarantine-hash',
      updateBytesLength: 20,
      actualUpdateSha256: updateSha256,
      expectedUpdateSha256: otherSha256,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
      now: 1000,
    }),
    {
      action: 'quarantine',
      row: {
        id: 'quarantine-hash',
        docId: update.docId,
        messageId: update.messageId,
        deviceId: update.deviceId,
        reason: 'hash-mismatch',
        updateSha256,
        updateBytesLength: 20,
        createdAt: 1000,
      },
    },
  )

  assert.equal(
    decideSyncUpdateQuarantine({
      update,
      quarantineId: 'quarantine-yjs',
      updateBytesLength: 20,
      actualUpdateSha256: updateSha256,
      yjsApplySucceeded: false,
      metaSchemaValid: true,
      now: 1000,
    }).action,
    'quarantine',
  )

  const metaDecision = decideSyncUpdateQuarantine({
    update: { ...update, docId: { kind: 'meta' } },
    quarantineId: 'quarantine-meta',
    updateBytesLength: 20,
    actualUpdateSha256: updateSha256,
    yjsApplySucceeded: true,
    metaSchemaValid: false,
    now: 1000,
  })
  assert.equal(metaDecision.action, 'quarantine')
  if (metaDecision.action === 'quarantine') {
    assert.equal(metaDecision.row.reason, 'meta-schema-invalid')
  }
})

test('sync update quarantine rejects invalid local evidence', () => {
  assert.deepEqual(
    decideSyncUpdateQuarantine({
      update,
      quarantineId: '',
      updateBytesLength: 20,
      actualUpdateSha256: updateSha256,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
      now: 1000,
    }),
    { action: 'reject', reason: 'invalid-quarantine-id' },
  )

  assert.deepEqual(
    decideSyncUpdateQuarantine({
      update,
      quarantineId: 'quarantine-a',
      updateBytesLength: 0,
      actualUpdateSha256: updateSha256,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
      now: 1000,
    }),
    { action: 'reject', reason: 'invalid-update-size' },
  )

  assert.deepEqual(
    decideSyncUpdateQuarantine({
      update,
      quarantineId: 'quarantine-a',
      updateBytesLength: 20,
      actualUpdateSha256: updateSha256,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
      now: -1,
    }),
    { action: 'reject', reason: 'invalid-now' },
  )
})

test('sync update append plans a new op_log row and durable ack', () => {
  assert.deepEqual(
    decideSyncUpdateAppend({
      update,
      doc: { latestSeq: 10 },
      duplicate: undefined,
      updateBytesLength: 20,
      updateSha256,
      now: 1000,
      largeUpdateThresholdBytes: 1024,
    }),
    {
      action: 'append-op',
      opLogAppend: {
        seq: 11,
        messageId: update.messageId,
        deviceId: update.deviceId,
        docId: update.docId,
        updateSha256,
        createdAt: 1000,
      },
      docPatch: { latestSeq: 11, updatedAt: 1000 },
      ack: {
        type: 'ack',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: update.vaultId,
        deviceId: update.deviceId,
        messageId: update.messageId,
        docId: update.docId,
        durableSeq: 11,
      },
    },
  )
})

test('sync update append creates the first document clock', () => {
  const decision = decideSyncUpdateAppend({
    update,
    doc: undefined,
    duplicate: undefined,
    updateBytesLength: 20,
    updateSha256,
    now: 1000,
    largeUpdateThresholdBytes: 1024,
  })

  assert.equal(decision.action, 'append-op')
  if (decision.action === 'append-op') {
    assert.equal(decision.opLogAppend.seq, 1)
    assert.equal(decision.ack.durableSeq, 1)
  }
})

test('sync update append acks duplicates without allocating a new sequence', () => {
  assert.deepEqual(
    decideSyncUpdateAppend({
      update,
      doc: { latestSeq: 10 },
      duplicate: { durableSeq: 7 },
      updateBytesLength: 20,
      updateSha256,
      now: 1000,
      largeUpdateThresholdBytes: 1024,
    }),
    {
      action: 'ack-duplicate',
      ack: {
        type: 'ack',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: update.vaultId,
        deviceId: update.deviceId,
        messageId: update.messageId,
        docId: update.docId,
        durableSeq: 7,
      },
    },
  )
})

test('sync update append rejects large updates without durable evidence', () => {
  assert.deepEqual(
    decideSyncUpdateAppend({
      update,
      doc: { latestSeq: 10 },
      duplicate: undefined,
      updateBytesLength: 2048,
      updateSha256,
      now: 1000,
      largeUpdateThresholdBytes: 1024,
    }),
    {
      action: 'reject',
      reason: 'large-update-requires-snapshot-import',
    },
  )
})

test('sync update append rejects invalid clocks and evidence', () => {
  assert.deepEqual(
    decideSyncUpdateAppend({
      update,
      doc: { latestSeq: -1 },
      duplicate: undefined,
      updateBytesLength: 20,
      updateSha256,
      now: 1000,
      largeUpdateThresholdBytes: 1024,
    }),
    { action: 'reject', reason: 'invalid-clock' },
  )

  assert.deepEqual(
    decideSyncUpdateAppend({
      update,
      doc: { latestSeq: 10 },
      duplicate: { durableSeq: 11 },
      updateBytesLength: 20,
      updateSha256,
      now: 1000,
      largeUpdateThresholdBytes: 1024,
    }),
    { action: 'reject', reason: 'duplicate-ahead-of-doc' },
  )

  assert.deepEqual(
    decideSyncUpdateAppend({
      update,
      doc: { latestSeq: 10 },
      duplicate: undefined,
      updateBytesLength: 0,
      updateSha256,
      now: 1000,
      largeUpdateThresholdBytes: 1024,
    }),
    { action: 'reject', reason: 'invalid-update-size' },
  )
})
