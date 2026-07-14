import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
} from '@kuroflare/core'
import { assert, test } from 'vitest'

import type { LocalSetupMetadata } from '../engine/setup'
import type { LocalStoreOutboxRecord } from '../store/store'
import {
  listPausedRejectedUpdates,
  repairRejectedUpdateRemote,
  type RejectedUpdateRepairRemoteRow,
} from './rejected-update-repair'

const vaultId = makeVaultId('repair-vault')
const docId = { kind: 'file', ydocId: makeYDocId('repair-doc') } as const
const updateSha256 = makeSha256Hex(
  '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
)
const setup: LocalSetupMetadata = {
  endpoint: 'https://sync.example.test/base',
  vaultId,
  deviceId: makeDeviceId('repair-device'),
  yClientId: 1,
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  bootstrapMode: 'join-existing',
  tokenVersion: 1,
}

test('rejected repair remote adapter orders latest GET before exact PUT import', async () => {
  const calls: { readonly method: string; readonly url: string; readonly body?: string }[] = []
  const http = {
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const call = { method: init?.method ?? 'GET', url }
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push(body === undefined ? call : { ...call, body })
      if (init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            ok: true,
            vaultId,
            docId,
            snapshotKey: 'snapshots/repair-vault/files/repair-doc/8.yupdate',
            snapshotSeq: 8,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          docId,
          manifestSeq: 3,
          snapshotKey: 'snapshots/repair-vault/files/repair-doc/7.yupdate',
          snapshotSeq: 7,
          updateSha256,
          stateVectorSha256: updateSha256,
          stateVector: 'AQID',
          updateBytesBase64: 'AQID',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  }
  const row: RejectedUpdateRepairRemoteRow = {
    kind: 'y-update',
    docId,
    updateSha256,
    rejectionUpdateSha256: updateSha256,
    rejectionReason: 'large-update-requires-snapshot-import',
    rejectionRetryable: false,
    updateBytesBase64: 'AQID',
  }

  const result = await repairRejectedUpdateRemote({
    setup,
    accessToken: 'access-token',
    row,
    http,
  })

  assert.deepEqual(result, { ok: true, snapshotSeq: 8 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.method, 'GET')
  assert.equal(calls[1]?.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[1]?.body ?? '{}'), {
    updateBytesBase64: 'AQID',
    latestSeq: 3,
  })
})

test('rejected repair remote adapter leaves failures before PUT and rejects hash mismatches', async () => {
  const calls: string[] = []
  const row: RejectedUpdateRepairRemoteRow = {
    kind: 'y-update',
    docId,
    updateSha256,
    rejectionUpdateSha256: makeSha256Hex('a'.repeat(64)),
    rejectionReason: 'large-update-requires-snapshot-import',
    rejectionRetryable: false,
    updateBytesBase64: 'AQID',
  }
  const result = await repairRejectedUpdateRemote({
    setup,
    accessToken: 'access-token',
    row,
    http: {
      fetch: async (): Promise<Response> => {
        calls.push('unexpected')
        return new Response('{}', { status: 500 })
      },
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'hash-mismatch' })
  assert.deepEqual(calls, [])
})

test('rejected repair remote adapter treats latest 404 as a new document without latestSeq', async () => {
  let importBody = ''
  const result = await repairRejectedUpdateRemote({
    setup,
    accessToken: 'access-token',
    row: {
      kind: 'y-update',
      docId,
      updateSha256,
      rejectionUpdateSha256: updateSha256,
      rejectionReason: 'large-update-requires-snapshot-import',
      rejectionRetryable: false,
      updateBytesBase64: 'AQID',
    },
    http: {
      fetch: async (_url, init): Promise<Response> => {
        if (init?.method === 'PUT') {
          importBody = typeof init.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({
              ok: true,
              vaultId,
              docId,
              snapshotKey: 'snapshots/repair-vault/files/repair-doc/1.yupdate',
              snapshotSeq: 1,
            }),
            { status: 200 },
          )
        }
        return new Response('{}', { status: 404 })
      },
    },
  })
  assert.deepEqual(result, { ok: true, snapshotSeq: 1 })
  assert.deepEqual(JSON.parse(importBody), { updateBytesBase64: 'AQID' })
})

test('rejected repair remote adapter leaves 409 and invalid import identity as incomplete', async () => {
  const rejectedRow: RejectedUpdateRepairRemoteRow = {
    kind: 'y-update',
    docId,
    updateSha256,
    rejectionUpdateSha256: updateSha256,
    rejectionReason: 'large-update-requires-snapshot-import',
    rejectionRetryable: false,
    updateBytesBase64: 'AQID',
  }
  const latestBody = JSON.stringify({
    docId,
    manifestSeq: 3,
    snapshotKey: 'snapshots/repair-vault/files/repair-doc/7.yupdate',
    snapshotSeq: 7,
    updateSha256,
    stateVectorSha256: updateSha256,
    stateVector: 'AQID',
    updateBytesBase64: 'AQID',
  })
  let putCount = 0
  const conflict = await repairRejectedUpdateRemote({
    setup,
    accessToken: 'access-token',
    row: rejectedRow,
    http: {
      fetch: async (_url, init): Promise<Response> => {
        if (init?.method === 'PUT') {
          putCount += 1
          return new Response('{}', { status: 409 })
        }
        return new Response(latestBody, { status: 200 })
      },
    },
  })
  assert.deepEqual(conflict, { ok: false, reason: 'conflict', status: 409 })

  const invalidIdentity = await repairRejectedUpdateRemote({
    setup,
    accessToken: 'access-token',
    row: rejectedRow,
    http: {
      fetch: async (_url, init): Promise<Response> => {
        if (init?.method === 'PUT') {
          putCount += 1
          return new Response(
            JSON.stringify({
              ok: true,
              vaultId: makeVaultId('other-vault'),
              docId,
              snapshotKey: 'snapshots/other-vault/files/repair-doc/8.yupdate',
              snapshotSeq: 8,
            }),
            { status: 200 },
          )
        }
        return new Response(latestBody, { status: 200 })
      },
    },
  })
  assert.deepEqual(invalidIdentity, { ok: false, reason: 'invalid-import-response' })
  assert.equal(putCount, 2)
})

test('rejected repair list keeps one row per paused rejection without doc-wide release', () => {
  const base = {
    id: 'row-1',
    kind: 'y-update' as const,
    status: 'paused' as const,
    dependsOn: [],
    nextAttemptAt: undefined,
    reason: 'sync-update-rejected',
    docId,
    messageId: makeMessageId('message-1'),
    updateSha256,
    rejectionUpdateSha256: updateSha256,
    rejectionReason: 'large-update-requires-snapshot-import' as const,
    rejectionRetryable: false as const,
    updateBytesBase64: 'AQID',
  } satisfies LocalStoreOutboxRecord
  const rows = listPausedRejectedUpdates([base, { ...base, id: 'row-2', status: 'done' }])
  assert.deepEqual(
    rows.entries.map((entry) => entry.id),
    ['row-1'],
  )
  assert.equal(
    listPausedRejectedUpdates([
      { ...base, id: 'unsupported', kind: 'blob-put' },
      { ...base, id: 'wrong-reason', rejectionReason: undefined },
    ]).entries.length,
    0,
  )
})
