import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeVaultId,
  makeYDocId,
  type SyncRequest,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import { decideSyncRequest, type SyncRequestDocState } from './request'

const request: SyncRequest = {
  type: 'sync-request',
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  vaultId: makeVaultId('vault-a'),
  deviceId: makeDeviceId('device-a'),
  messageId: makeMessageId('message-a'),
  docId: { kind: 'file', ydocId: makeYDocId('doc-a') },
  stateVector: 'AQID',
}

const syncedDoc: SyncRequestDocState = {
  latestSeq: 12,
  minRetainedSeq: 7,
  stateVectorCoversHorizon: true,
  diffSourceAvailable: true,
  diffUpdateBase64: 'BAUG',
  diffUpdateSha256: 'a'.repeat(64),
}

test('sync request sends a validated diff update when horizon and diff source are available', () => {
  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: syncedDoc,
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    {
      action: 'send-update',
      durableSeq: 12,
      response: {
        type: 'sync-update',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: request.vaultId,
        deviceId: request.deviceId,
        messageId: request.messageId,
        docId: request.docId,
        update: 'BAUG',
        baseStateVector: 'AQID',
        durableSeq: 12,
        updateSha256: 'a'.repeat(64),
      },
    },
  )
})

test('sync request is a no-op for missing docs or empty diffs', () => {
  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: undefined,
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    { action: 'no-update', durableSeq: 0, reason: 'doc-not-found' },
  )

  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: { ...syncedDoc, diffUpdateBase64: undefined },
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    { action: 'no-update', durableSeq: 12, reason: 'empty-diff' },
  )
})

test('sync request requires full snapshots for retention or source gaps', () => {
  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: { ...syncedDoc, stateVectorCoversHorizon: false },
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    {
      action: 'need-full-snapshot',
      response: {
        type: 'need-full-snapshot',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: request.vaultId,
        deviceId: request.deviceId,
        docId: request.docId,
        reason: 'state-vector-too-old',
      },
    },
  )

  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: { ...syncedDoc, diffSourceAvailable: false },
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    {
      action: 'need-full-snapshot',
      response: {
        type: 'need-full-snapshot',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: request.vaultId,
        deviceId: request.deviceId,
        docId: request.docId,
        reason: 'missing-log',
      },
    },
  )
})

test('sync request requires full snapshots on protocol mismatch', () => {
  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: syncedDoc,
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION + 1,
    }),
    {
      action: 'need-full-snapshot',
      response: {
        type: 'need-full-snapshot',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: request.vaultId,
        deviceId: request.deviceId,
        docId: request.docId,
        reason: 'protocol-upgrade',
      },
    },
  )
})

test('sync request rejects invalid persisted evidence', () => {
  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: { ...syncedDoc, latestSeq: 5, minRetainedSeq: 6 },
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    { action: 'reject', reason: 'invalid-doc-sequence' },
  )

  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: { ...syncedDoc, diffUpdateBase64: '' },
      serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
    }),
    { action: 'reject', reason: 'invalid-diff-update' },
  )

  assert.deepEqual(
    decideSyncRequest({
      request,
      doc: syncedDoc,
      serverProtocolVersion: -1,
    }),
    { action: 'reject', reason: 'invalid-server-protocol-version' },
  )
})
