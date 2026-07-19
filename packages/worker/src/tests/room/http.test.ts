import {
  ApiErrorSchema,
  decodeFullSnapshotBytesFromResponse,
  DocLatestSnapshotResponseSchema,
  MetaLatestSnapshotResponseSchema,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeYDocId,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../../runtime'
import { MAX_HYDRATED_FILE_DOCS } from '../../runtime/constants'
import {
  TEST_DEVICE_TOKEN_SECRET,
  FakeSocket,
  FakeState,
  installFakeWebSocketPair,
  installFakeUpgradeResponse,
  restoreWebSocketPair,
  restoreResponse,
  makeEnv,
  makeDeviceToken,
  makeEnvWithDeviceTokenSecret,
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  makeAuthenticatedWebSocketRequest,
  makeYjsUpdateBytes,
  FakeR2Bucket,
} from '../support'

test('VaultRoom serves the latest meta snapshot from the production HTTP route', async () => {
  const storage = new SqlOnlyStorage()
  const messageId = makeMessageId('message-meta-snapshot')
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`meta:${messageId}`, {
    docId: 'meta',
    seq: 1,
    messageId,
    deviceId: 'device-1',
    updateBytes: makeYjsUpdateBytes(messageId),
    updateSha256: 'a'.repeat(64),
    createdAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  assert(v.is(MetaLatestSnapshotResponseSchema, body))
  assert.equal(body.snapshotSeq, 1)
  assert.equal(body.manifestSeq, 1)

  const decoded = await decodeFullSnapshotBytesFromResponse({ response: body })
  assert(decoded.ok)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, decoded.updateBytes)
  assert.equal(doc.getMap('meta').has(makeFileId('file-message-meta-snapshot')), true)
})

test('VaultRoom serves the latest file snapshot from the production HTTP route', async () => {
  const storage = new SqlOnlyStorage()
  const ydocId = makeYDocId('ydoc-file-snapshot')
  const messageId = makeMessageId('message-file-snapshot')
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:${messageId}`, {
    docId: `file:${ydocId}`,
    seq: 1,
    messageId,
    deviceId: 'device-1',
    updateBytes: makeYjsUpdateBytes(messageId),
    updateSha256: 'a'.repeat(64),
    createdAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request(`https://worker.example/vaults/vault-1/files/${ydocId}/latest`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  assert(v.is(DocLatestSnapshotResponseSchema, body))
  assert.deepEqual(body.docId, { kind: 'file', ydocId })
  assert.equal(body.snapshotSeq, 1)
})

test('VaultRoom refuses to load a new file doc as degraded once the room is at capacity', async () => {
  const storage = new SqlOnlyStorage()
  const ydocId = makeYDocId('ydoc-file-degraded')
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  for (let index = 0; index < MAX_HYDRATED_FILE_DOCS; index += 1) {
    room.hydratedDocs.add(`file:${makeYDocId(`ydoc-padding-${index}`)}`)
  }

  const response = await room.fetch(
    new Request(`https://worker.example/vaults/vault-1/files/${ydocId}/latest`, {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    code: 'server/degraded',
    retryable: true,
    detail: 'doc-load-degraded',
  })
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom rejects latest snapshot requests without a valid access token', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest'),
  )

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    code: 'auth/rejected',
    retryable: false,
    detail: 'auth-reject:invalid-token',
  })
})

test('VaultRoom rejects latest snapshot requests missing the sync:read scope', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/latest', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
          scope: ['sync:write'],
        })}`,
      },
    }),
  )

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    code: 'auth/rejected',
    retryable: false,
    detail: 'auth-reject:missing-scope',
  })
})

test('VaultRoom returns doc-not-found for a latest snapshot request on an unknown doc', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const response = await room.fetch(
    new Request(
      `https://worker.example/vaults/vault-1/files/${makeYDocId('ydoc-missing')}/latest`,
      {
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
        },
      },
    ),
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    code: 'snapshot/not-found',
    retryable: false,
    detail: 'doc-not-found',
  })
})

test('VaultRoom logs a structured event when a checkpoint fails', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-checkpoint-fail'))),
    )

    storage.sql.failOnQueryIncludes = 'insert into checkpoint_runs'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let thrown: unknown
    try {
      await room.checkpointDoc({ kind: 'meta' }, 99)
    } catch (error) {
      thrown = error
    }
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert(thrown instanceof Error)
    assert(events.some((event) => event.event === 'checkpoint-start'))
    assert(
      events.some(
        (event) => event.event === 'checkpoint-failed' && typeof event.error === 'string',
      ),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs a structured event when an HTTP request is auth-rejected', async () => {
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const response = await room.fetch(
    new Request('https://worker.example/admin/quarantine', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    }),
  )
  const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
  logSpy.mockRestore()

  assert.equal(response.status, 401)
  assert(events.some((event) => event.event === 'auth-reject' && event.reason === 'invalid-token'))
})

test('VaultRoom rejects non-upgrade requests', async () => {
  const room = new VaultRoom(new FakeState(), makeEnv())

  const response = await room.fetch(new Request('https://worker.example/ws/vault-1'))

  assert.equal(response.status, 426)
})

test('every public HTTP failure across auth, blob, and snapshot routes uses the guarded ApiError envelope', async () => {
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(new SqlOnlyStorage()),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })

  const unauthenticated = await room.fetch(new Request('https://worker.example/admin/retention'))
  assert.equal(unauthenticated.status, 401)
  assert.equal(v.is(ApiErrorSchema, await unauthenticated.json()), true)

  const malformedSetup = await room.fetch(
    new Request('https://worker.example/setup/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
  assert.equal(malformedSetup.status, 400)
  assert.equal(v.is(ApiErrorSchema, await malformedSetup.json()), true)

  const missingDoc = await room.fetch(
    new Request(
      `https://worker.example/vaults/vault-1/files/${makeYDocId('ydoc-contract-missing')}/latest`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  )
  assert.equal(missingDoc.status, 404)
  assert.equal(v.is(ApiErrorSchema, await missingDoc.json()), true)

  const blobToken = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
    tokenVersion: 1,
    scope: ['sync:read', 'sync:write', 'blob:read', 'blob:write'],
  })
  const missingBlob = await room.fetch(
    new Request(`https://worker.example/blobs/${makeSha256Hex('d'.repeat(64))}`, {
      headers: { Authorization: `Bearer ${blobToken}` },
    }),
  )
  assert.equal(missingBlob.status, 404)
  assert.equal(v.is(ApiErrorSchema, await missingBlob.json()), true)

  const unknownQuarantine = await room.fetch(
    new Request('https://worker.example/admin/quarantine/does-not-exist', {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(unknownQuarantine.status, 404)
  assert.equal(v.is(ApiErrorSchema, await unknownQuarantine.json()), true)
})
