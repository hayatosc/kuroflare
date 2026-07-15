import { makeDeviceId, makeMessageId, makeSha256Hex, makeYDocId, type DocId } from '@kuroflare/core'
import { assert, test } from 'vitest'

import { decideQuarantinedUpdateAdmin, type QuarantinedUpdateRecord } from './quarantine'

const docId: DocId = { kind: 'file', ydocId: makeYDocId('doc-a') }
const record: QuarantinedUpdateRecord = {
  id: 'quarantine-a',
  docId,
  messageId: makeMessageId('message-a'),
  deviceId: makeDeviceId('device-a'),
  reason: 'meta-schema-invalid',
  updateSha256: makeSha256Hex('a'.repeat(64)),
  updateBytesLength: 32,
  createdAt: 100,
}

test('quarantined update admin inspect is read-only and does not require confirmation', () => {
  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'inspect',
      record,
      now: 200,
      confirmationTokenValid: false,
      latestSeq: undefined,
      yjsApplySucceeded: undefined,
      metaSchemaValid: undefined,
    }),
    { action: 'inspect', record },
  )
})

test('quarantined update admin discard requires confirmation and only deletes quarantine row', () => {
  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'discard',
      record,
      now: 200,
      confirmationTokenValid: false,
      latestSeq: undefined,
      yjsApplySucceeded: undefined,
      metaSchemaValid: undefined,
    }),
    { action: 'reject', reason: 'confirmation-required' },
  )

  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'discard',
      record,
      now: 200,
      confirmationTokenValid: true,
      latestSeq: undefined,
      yjsApplySucceeded: undefined,
      metaSchemaValid: undefined,
    }),
    {
      action: 'discard',
      deletePatch: {
        id: 'quarantine-a',
        deletedAt: 200,
        reason: 'discarded-by-admin',
      },
    },
  )
})

test('quarantined update admin force apply requires confirmation and fresh revalidation', () => {
  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'force-apply',
      record,
      now: 200,
      confirmationTokenValid: true,
      latestSeq: 10,
      yjsApplySucceeded: undefined,
      metaSchemaValid: true,
    }),
    { action: 'reject', reason: 'revalidation-required' },
  )

  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'force-apply',
      record,
      now: 200,
      confirmationTokenValid: true,
      latestSeq: 10,
      yjsApplySucceeded: true,
      metaSchemaValid: false,
    }),
    { action: 'reject', reason: 'revalidation-failed' },
  )

  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'force-apply',
      record,
      now: 200,
      confirmationTokenValid: true,
      latestSeq: 10,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
    }),
    {
      action: 'force-apply',
      opLogAppend: {
        seq: 11,
        docId: record.docId,
        messageId: record.messageId,
        deviceId: record.deviceId,
        updateSha256: record.updateSha256,
        createdAt: 200,
      },
      docPatch: {
        latestSeq: 11,
        updatedAt: 200,
      },
      deletePatch: {
        id: 'quarantine-a',
        deletedAt: 200,
        reason: 'force-applied-by-admin',
      },
    },
  )
})

test('quarantined update admin rejects unknown records and invalid clocks', () => {
  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'inspect',
      record: undefined,
      now: 200,
      confirmationTokenValid: false,
      latestSeq: undefined,
      yjsApplySucceeded: undefined,
      metaSchemaValid: undefined,
    }),
    { action: 'reject', reason: 'unknown-quarantine' },
  )

  assert.deepEqual(
    decideQuarantinedUpdateAdmin({
      action: 'force-apply',
      record,
      now: 200,
      confirmationTokenValid: true,
      latestSeq: -1,
      yjsApplySucceeded: true,
      metaSchemaValid: true,
    }),
    { action: 'reject', reason: 'invalid-clock' },
  )
})
