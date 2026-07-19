import { makeMessageId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../../runtime'
import { ensureDocHydrated } from '../../runtime/documents'
import {
  TEST_DEVICE_TOKEN_SECRET,
  FakeSocket,
  FakeState,
  installFakeWebSocketPair,
  installFakeUpgradeResponse,
  restoreWebSocketPair,
  restoreResponse,
  makeDeviceToken,
  makeEnvWithDeviceTokenSecret,
  makeEnvWithSnapshotBucket,
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  syncMessages,
  hashTestBytes,
  makeAuthenticatedWebSocketRequest,
  makeYjsUpdateBytes,
  decodeTestBase64,
  FakeR2Bucket,
  findAckForMessage,
} from '../support'
import { seedVerifiedSnapshotEvidence } from '../support'

test('VaultRoom rehydrates committed state after an active YDoc apply failure', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    const baseUpdate = makeSyncUpdate(makeMessageId('apply-base'))
    await room.webSocketMessage(sender, JSON.stringify(baseUpdate))
    const staleDoc = room.docs.get('meta')
    assert(staleDoc instanceof Y.Doc)
    staleDoc.on('update', () => {
      throw new Error('injected active YDoc observer failure')
    })

    const update = makeSyncUpdate(makeMessageId('apply-rehydrate'))
    const expected = new Y.Doc()
    Y.applyUpdate(expected, decodeTestBase64(baseUpdate.update))
    Y.applyUpdate(expected, decodeTestBase64(update.update))
    const expectedUpdate = Y.encodeStateAsUpdate(expected)
    const assertRehydrated = (): void => {
      const recovered = room.docs.get('meta')
      assert(recovered instanceof Y.Doc)
      assert.notEqual(recovered, staleDoc)
      assert.equal(room.hydratedDocs.has('meta'), true)
      assert.deepEqual(Y.encodeStateAsUpdate(recovered), expectedUpdate)
    }
    const senderSend = sender.send.bind(sender)
    sender.send = (message) => {
      if (typeof message === 'string' && message.includes(update.messageId)) assertRehydrated()
      senderSend(message)
    }
    const peerSend = peer.send.bind(peer)
    peer.send = (message) => {
      if (typeof message === 'string' && message.includes(update.messageId)) assertRehydrated()
      peerSend(message)
    }

    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 2)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 2)
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 2)
    assert.equal(syncMessages(peer.sent).length, 2)

    sender.sent.length = 0
    peer.sent.length = 0
    await room.webSocketMessage(sender, JSON.stringify(update))
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 2)
    assert.equal(syncMessages(peer.sent).length, 0)
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom withholds ack and broadcast when post-commit rehydration fails', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(new FakeR2Bucket(), TEST_DEVICE_TOKEN_SECRET),
    )

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const sender = state.accepted[0]
    const peer = state.accepted[1]
    assert(sender instanceof FakeSocket)
    assert(peer instanceof FakeSocket)
    await room.webSocketMessage(sender, JSON.stringify(makeHello()))
    await room.webSocketMessage(peer, JSON.stringify(makeHello()))

    await room.webSocketMessage(
      sender,
      JSON.stringify(makeSyncUpdate(makeMessageId('rehydrate-base'))),
    )
    const staleDoc = room.docs.get('meta')
    assert(staleDoc instanceof Y.Doc)
    staleDoc.on('update', () => {
      throw new Error('injected active YDoc observer failure')
    })
    const existingDoc = storage.sql.docs.get('meta')
    assert(existingDoc)
    storage.sql.docs.set('meta', {
      ...existingDoc,
      latestSnapshotSeq: 1,
      latestSnapshotKey: 'snapshots/vault-1/meta/missing.yupdate',
      minRetainedSeq: 1,
    })

    const update = makeSyncUpdate(makeMessageId('rehydrate-failure'))
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 2)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 2)
    assert.equal(findAckForMessage(sender.sent, update.messageId), undefined)
    assert.equal(syncMessages(peer.sent).length, 1)
    assert.equal(sender.closeReason, 'hydrate-failed')
    assert.equal(room.docs.has('meta'), false)
    assert.equal(room.hydratedDocs.has('meta'), false)

    peer.sent.length = 0
    await room.webSocketMessage(peer, JSON.stringify(update))
    assert.equal(peer.closeCode, 1011)
    assert.equal(peer.closeReason, 'hydrate-failed')
    assert.equal(findAckForMessage(peer.sent, update.messageId), undefined)
    assert.deepEqual(syncMessages(peer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom hydrates active Y.Doc from SQL op_log after Durable Object restart', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const request = await makeAuthenticatedWebSocketRequest()

    const firstState = new FakeState(storage)
    const firstRoom = new VaultRoom(
      firstState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    void firstRoom.fetch(request)
    const firstServer = firstState.accepted[0]
    assert(firstServer instanceof FakeSocket)
    await firstRoom.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await firstRoom.webSocketMessage(
      firstServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-before-restart'))),
    )

    const queryCountBeforeRestart = storage.sql.queries.length
    const secondState = new FakeState(storage)
    const secondRoom = new VaultRoom(
      secondState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    void secondRoom.fetch(request)
    const secondServer = secondState.accepted[0]
    assert(secondServer instanceof FakeSocket)
    await secondRoom.webSocketMessage(secondServer, JSON.stringify(makeHello()))
    await secondRoom.webSocketMessage(
      secondServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-restart'))),
    )

    const restartQueries = storage.sql.queries.slice(queryCountBeforeRestart)
    assert(
      restartQueries.some((query) => query.includes('update_bytes')),
      'expected restarted room to replay op_log before appending',
    )
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get('meta:message-before-restart')?.seq, 1)
    assert.equal(storage.sql.opLog.get('meta:message-after-restart')?.seq, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom hydrates active Y.Doc from R2 snapshot plus residual SQL op_log', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-snapshot'))
    bucket.set(snapshotKey, snapshotBytes)
    await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 1,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.opLog.set('meta:message-residual', {
      docId: 'meta',
      seq: 2,
      messageId: 'message-residual',
      deviceId: 'device-1',
      updateBytes: makeYjsUpdateBytes(makeMessageId('message-residual')),
      updateSha256: 'a'.repeat(64),
      createdAt: 2,
    })

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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-snapshot'))),
    )

    assert.deepEqual(bucket.gets, [snapshotKey, snapshotKey])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-snapshot')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs the cold-start restore source for a brand-new document', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-empty-restore'))),
    )
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert.deepEqual(
      events.filter((event) => event.event === 'doc-restore-source'),
      [
        {
          event: 'doc-restore-source',
          vaultId: makeVaultId('vault-1'),
          docId: { kind: 'meta' },
          source: 'empty',
        },
      ],
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs the cold-start restore source as op-log-replay after a Durable Object restart', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const request = await makeAuthenticatedWebSocketRequest()

    const firstState = new FakeState(storage)
    const firstRoom = new VaultRoom(
      firstState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    void firstRoom.fetch(request)
    const firstServer = firstState.accepted[0]
    assert(firstServer instanceof FakeSocket)
    await firstRoom.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await firstRoom.webSocketMessage(
      firstServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-before-restart-restore'))),
    )

    const secondState = new FakeState(storage)
    const secondRoom = new VaultRoom(
      secondState,
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    void secondRoom.fetch(request)
    const secondServer = secondState.accepted[0]
    assert(secondServer instanceof FakeSocket)
    await secondRoom.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await secondRoom.webSocketMessage(
      secondServer,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-restart-restore'))),
    )
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert.deepEqual(
      events.filter((event) => event.event === 'doc-restore-source'),
      [
        {
          event: 'doc-restore-source',
          vaultId: makeVaultId('vault-1'),
          docId: { kind: 'meta' },
          source: 'op-log-replay',
        },
      ],
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs the cold-start restore source as r2-snapshot when a snapshot is replayed', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-snapshot-restore'))
    bucket.set(snapshotKey, snapshotBytes)
    await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 1,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-snapshot-restore'))),
    )
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert.deepEqual(
      events.filter((event) => event.event === 'doc-restore-source'),
      [
        {
          event: 'doc-restore-source',
          vaultId: makeVaultId('vault-1'),
          docId: { kind: 'meta' },
          source: 'r2-snapshot',
        },
      ],
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when residual op_log sequences contain a gap', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-oplog-gap')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('oplog-gap-snapshot'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 3,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const seq3 = makeYjsUpdateBytes(makeMessageId('oplog-gap-seq3'))
  storage.sql.opLog.set(`file:${ydocId}:oplog-gap-seq3`, {
    docId: `file:${ydocId}`,
    seq: 3,
    messageId: 'oplog-gap-seq3',
    deviceId: 'device-1',
    updateBytes: seq3,
    updateSha256: await hashTestBytes(seq3),
    createdAt: 3,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    failed = error instanceof Error && error.message === 'op_log sequence gap'
  }
  assert.equal(failed, true)
  assert.equal(room.docs.has(`file:${ydocId}`), false)
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom fails closed when residual op_log rows stop before the durable tail', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-oplog-tail-gap')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('oplog-tail-snapshot'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 3,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const seq2 = makeYjsUpdateBytes(makeMessageId('oplog-tail-seq2'))
  storage.sql.opLog.set(`file:${ydocId}:oplog-tail-seq2`, {
    docId: `file:${ydocId}`,
    seq: 2,
    messageId: 'oplog-tail-seq2',
    deviceId: 'device-1',
    updateBytes: seq2,
    updateSha256: await hashTestBytes(seq2),
    createdAt: 2,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    failed = error instanceof Error && error.message === 'op_log sequence gap'
  }
  assert.equal(failed, true)
  assert.equal(room.docs.has(`file:${ydocId}`), false)
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom stops sync updates when the recorded R2 snapshot is missing', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
      minRetainedSeq: 1,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-missing-snapshot'))),
    )

    assert.deepEqual(bucket.gets, [snapshotKey])
    assert.equal(server.closed, true)
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'hydrate-failed')
    assert.deepEqual(syncMessages(server.sent), [])
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.opLog.has('meta:message-after-missing-snapshot'), false)
    assert.equal(storage.sql.quarantines.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom falls back from a missing snapshot pointer to the newest listed snapshot', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const stalePointerKey = 'snapshots/vault-1/meta/1.yupdate'
    const fallbackKey = 'snapshots/vault-1/meta/2.yupdate'
    const fallbackBytes = makeYjsUpdateBytes(makeMessageId('message-fallback-snapshot'))
    bucket.set(fallbackKey, fallbackBytes)
    await seedVerifiedSnapshotEvidence(storage, fallbackKey, 'meta', fallbackBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: stalePointerKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })

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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-fallback'))),
    )

    assert.deepEqual(bucket.lists, ['snapshots/vault-1/meta/'])
    assert.deepEqual(bucket.gets, [fallbackKey, fallbackKey])
    assert.equal(server.closed, false)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get('meta:message-after-fallback')?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom skips a corrupt newest generation and replays residual op_log from an older verified snapshot', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-fallback')
  const docId = { kind: 'file' as const, ydocId }
  const olderKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const newestKey = `snapshots/vault-1/files/${ydocId}/3.yupdate`
  const olderDoc = new Y.Doc()
  olderDoc.getText('content').insert(0, 'older')
  const olderBytes = Y.encodeStateAsUpdate(olderDoc)
  const newestDoc = new Y.Doc()
  newestDoc.getText('content').insert(0, 'newest')
  const newestBytes = Y.encodeStateAsUpdate(newestDoc)
  olderDoc.destroy()
  newestDoc.destroy()
  bucket.set(olderKey, olderBytes)
  bucket.set(newestKey, newestBytes)
  await seedVerifiedSnapshotEvidence(storage, olderKey, `file:${ydocId}`, olderBytes)
  await seedVerifiedSnapshotEvidence(storage, newestKey, `file:${ydocId}`, newestBytes)
  const corruptNewest = newestBytes.slice()
  corruptNewest[corruptNewest.length - 1] = (corruptNewest.at(-1) ?? 0) ^ 0xff
  bucket.set(newestKey, corruptNewest)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 3,
    latestSnapshotSeq: 3,
    latestSnapshotKey: newestKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const residual = makeYjsUpdateBytes(makeMessageId('health-fallback-residual'))
  storage.sql.opLog.set(`file:${ydocId}:health-fallback-residual`, {
    docId: `file:${ydocId}`,
    seq: 2,
    messageId: 'health-fallback-residual',
    deviceId: 'device-1',
    updateBytes: residual,
    updateSha256: await hashTestBytes(residual),
    createdAt: 2,
  })
  const tail = makeYjsUpdateBytes(makeMessageId('health-fallback-tail'))
  storage.sql.opLog.set(`file:${ydocId}:health-fallback-tail`, {
    docId: `file:${ydocId}`,
    seq: 3,
    messageId: 'health-fallback-tail',
    deviceId: 'device-1',
    updateBytes: tail,
    updateSha256: await hashTestBytes(tail),
    createdAt: 3,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  await ensureDocHydrated(room, docId)

  assert(room.docs.get(`file:${ydocId}`))
  const newestEvents = storage.sql.snapshotHealthEvents.filter(
    (row) => row.snapshotKey === newestKey,
  )
  assert.equal(newestEvents.at(-1)?.physicalStatus, 'mismatch')
  assert.equal(newestEvents.at(-1)?.event, 'verification')
  assert.equal(storage.sql.opLog.has(`file:${ydocId}:health-fallback-residual`), true)
})

test('rollback writes a new audited generation and preserves the source object', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-health')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const currentKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-source'))
  const currentBytes = makeYjsUpdateBytes(makeMessageId('rollback-current'))
  bucket.set(sourceKey, sourceBytes)
  bucket.set(currentKey, currentBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, currentKey, `file:${ydocId}`, currentBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 2,
    latestSnapshotKey: currentKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:rollback-current`, {
    docId: `file:${ydocId}`,
    seq: 2,
    messageId: 'rollback-current',
    deviceId: 'device-1',
    updateBytes: currentBytes,
    updateSha256: await hashTestBytes(currentBytes),
    createdAt: 2,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Rollback to the last verified operator-approved generation',
        confirmation: 'rollback',
      }),
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly actor: string
    readonly snapshotKey: string
    readonly snapshotSeq: number
  }
  assert.equal(body.actor, 'device-1')
  assert.equal(body.snapshotSeq, 3)
  assert.equal(body.snapshotKey, `snapshots/vault-1/files/${ydocId}/3.yupdate`)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotSeq, 3)
  assert.equal((await bucket.get(sourceKey)) !== null, true)
  assert.equal(
    storage.sql.snapshotHealthEvents.some(
      (event) => event.snapshotKey === body.snapshotKey && event.event === 'rollback',
    ),
    true,
  )
  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const coldHydrated = coldRoom.docs.get(`file:${ydocId}`)
  assert(coldHydrated)
  const expectedColdDoc = new Y.Doc()
  Y.applyUpdate(expectedColdDoc, sourceBytes)
  Y.applyUpdate(expectedColdDoc, currentBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(coldHydrated), Y.encodeStateAsUpdate(expectedColdDoc))
  expectedColdDoc.destroy()
})

test('rollback accepts and preserves grouped metadata generations', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const sourceKey = 'snapshots/vault-1/meta/1.yupdate'
  const currentKey = 'snapshots/vault-1/meta/2.yupdate'
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-meta-source'))
  const currentBytes = makeYjsUpdateBytes(makeMessageId('rollback-meta-current'))
  bucket.set(sourceKey, sourceBytes)
  bucket.set(currentKey, currentBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, 'meta', sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, currentKey, 'meta', currentBytes)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
    latestSnapshotSeq: 2,
    latestSnapshotKey: currentKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:rollback-meta-current', {
    docId: 'meta',
    seq: 2,
    messageId: 'rollback-meta-current',
    deviceId: 'device-1',
    updateBytes: currentBytes,
    updateSha256: await hashTestBytes(currentBytes),
    createdAt: 2,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: { kind: 'meta' },
        snapshotKey: sourceKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Rollback grouped metadata to the last verified generation',
        confirmation: 'rollback',
      }),
    }),
  )

  assert.equal(response.status, 200)
  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, { kind: 'meta' })
  const coldMeta = coldRoom.docs.get('meta')
  assert(coldMeta)
  for (const value of coldMeta.getMap('meta').values()) {
    assert(value instanceof Y.Map)
  }
})

test('rollback refuses to overwrite an existing target key', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-target-conflict')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const targetKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-target-source'))
  const existingBytes = makeYjsUpdateBytes(makeMessageId('rollback-target-existing'))
  bucket.set(sourceKey, sourceBytes)
  bucket.set(targetKey, existingBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Do not overwrite an immutable target generation',
        confirmation: 'rollback',
      }),
    }),
  )

  assert.equal(response.status, 409)
  const persisted = await bucket.get(targetKey)
  assert(persisted)
  assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), existingBytes)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, sourceKey)
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('rollback pointer failure leaves the orphan target out of cold hydration', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-pointer-failure')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-pointer-source'))
  bucket.set(sourceKey, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  storage.sql.failOnQueryIncludes = 'update docs'
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Pointer failure must not authorize an orphan object',
        confirmation: 'rollback',
      }),
    }),
  )
  storage.sql.failOnQueryIncludes = undefined

  assert.equal(response.status, 500)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, sourceKey)
  const run = [...storage.sql.checkpointRuns.values()].at(-1)
  assert.equal(run?.status, 'failed')
  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const cold = coldRoom.docs.get(`file:${ydocId}`)
  assert(cold)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, sourceBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(cold), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('rollback rejects candidate and failed-run source generations at the API boundary', async () => {
  for (const sourceState of ['candidate', 'failed'] as const) {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId(`ydoc-rollback-${sourceState}`)
    const docId = { kind: 'file' as const, ydocId }
    const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const sourceBytes = makeYjsUpdateBytes(makeMessageId(`rollback-${sourceState}-source`))
    bucket.set(sourceKey, sourceBytes)
    await seedVerifiedSnapshotEvidence(
      storage,
      sourceKey,
      `file:${ydocId}`,
      sourceBytes,
      sourceState === 'candidate' ? 'candidate' : 'authoritative',
    )
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: 1,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    if (sourceState === 'failed') {
      storage.sql.checkpointRuns.set('rollback-failed-source', {
        runId: 'rollback-failed-source',
        docId: `file:${ydocId}`,
        upperSeq: 1,
        snapshotKey: sourceKey,
        stateVector: new Uint8Array(),
        status: 'failed',
        createdAt: 1,
        r2WrittenAt: undefined,
        pointerUpdatedAt: undefined,
        compactedAt: undefined,
      })
    }
    const room = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/rollback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey: sourceKey,
          upperSeq: 1,
          reason: 'Reject uncommitted rollback sources',
          confirmation: 'rollback',
        }),
      }),
    )
    assert.equal(response.status, 409, sourceState)
    assert.equal(storage.sql.checkpointRuns.size, sourceState === 'failed' ? 1 : 0)
  }
})

test('rollback serializes a concurrent append at the document write queue', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId('ydoc-rollback-append-queue')
    const docId = { kind: 'file' as const, ydocId }
    const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-append-source'))
    bucket.set(sourceKey, sourceBytes)
    await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: sourceKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    let releaseSourceRead: () => void = () => {}
    const sourceReadGate = new Promise<void>((resolve) => {
      releaseSourceRead = resolve
    })
    let sourceReads = 0
    let notifySourceRead: () => void = () => {}
    const sourceReadStarted = new Promise<void>((resolve) => {
      notifySourceRead = resolve
    })
    bucket.beforeGet = async (key) => {
      if (key !== sourceKey || sourceReads > 0) return
      sourceReads += 1
      notifySourceRead()
      await sourceReadGate
    }
    const rollbackRequest = room.fetch(
      new Request('https://worker.example/admin/snapshots/rollback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey: sourceKey,
          upperSeq: 1,
          reason: 'Serialize rollback with a concurrent append',
          confirmation: 'rollback',
        }),
      }),
    )
    await sourceReadStarted

    let appendSettled = false
    const appendUpdate = {
      ...makeSyncUpdate(makeMessageId('rollback-append-after')),
      docId,
    }
    const append = room.webSocketMessage(server, JSON.stringify(appendUpdate)).finally(() => {
      appendSettled = true
    })
    await Promise.resolve()
    assert.equal(appendSettled, false)

    releaseSourceRead()
    const rollbackResponse = await rollbackRequest
    await append
    assert.equal(rollbackResponse.status, 200)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSeq, 3)
    assert.equal(storage.sql.opLog.get(`file:${ydocId}:${appendUpdate.messageId}`)?.seq, 3)

    const targetKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
    const target = await bucket.get(targetKey)
    assert(target)
    const rollbackDoc = new Y.Doc()
    Y.applyUpdate(rollbackDoc, new Uint8Array(await target.arrayBuffer()))
    const expected = new Y.Doc()
    Y.applyUpdate(expected, sourceBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(rollbackDoc), Y.encodeStateAsUpdate(expected))
    rollbackDoc.destroy()
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('rollback linearizes before a queued source quarantine', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-quarantine-race')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-quarantine-source'))
  bucket.set(sourceKey, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  let sourceReads = 0
  let quarantineRequest: Promise<Response> | undefined
  bucket.beforeGet = async (key) => {
    if (key !== sourceKey) return
    sourceReads += 1
    if (sourceReads !== 2) return
    quarantineRequest = Promise.resolve(
      room.fetch(
        new Request('https://worker.example/admin/snapshots/quarantine', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            docId,
            snapshotKey: sourceKey,
            upperSeq: 1,
            reason: 'Source quarantined during rollback construction',
            confirmation: 'quarantine',
          }),
        }),
      ),
    )
  }

  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Do not commit a rollback from a quarantined source',
        confirmation: 'rollback',
      }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(
    storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey,
    `snapshots/vault-1/files/${ydocId}/2.yupdate`,
  )
  assert(quarantineRequest)
  const quarantine = await quarantineRequest
  assert.equal(quarantine.status, 200)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'quarantined')
  assert.equal(
    storage.sql.snapshotHealthEvents.some(
      (event) => event.snapshotKey !== sourceKey && event.event === 'rollback',
    ),
    true,
  )
})

test('rollback keeps the last healthy source when quarantine is rejected first', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-rollback-quarantine-first')
  const docId = { kind: 'file' as const, ydocId }
  const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-quarantine-first-source'))
  bucket.set(sourceKey, sourceBytes)
  await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: sourceKey,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const quarantine = await room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Quarantine source before rollback admission',
        confirmation: 'quarantine',
      }),
    }),
  )
  assert.equal(quarantine.status, 409)

  const rollback = await room.fetch(
    new Request('https://worker.example/admin/snapshots/rollback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey: sourceKey,
        upperSeq: 1,
        reason: 'Do not roll back from quarantined source',
        confirmation: 'rollback',
      }),
    }),
  )
  assert.equal(rollback.status, 200)
  assert.equal(
    storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey,
    `snapshots/vault-1/files/${ydocId}/2.yupdate`,
  )
})

test('rollback refreshes state after an in-flight stale hydration settles', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId('ydoc-rollback-hydration-race')
    const docId = { kind: 'file' as const, ydocId }
    const sourceKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const sourceBytes = makeYjsUpdateBytes(makeMessageId('rollback-hydration-source'))
    bucket.set(sourceKey, sourceBytes)
    await seedVerifiedSnapshotEvidence(storage, sourceKey, `file:${ydocId}`, sourceBytes)
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: sourceKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    room.vaultId = makeVaultId('vault-1')
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    let releaseHydration: () => void = () => {}
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    let hydrationReadStarted: () => void = () => {}
    const hydrationStarted = new Promise<void>((resolve) => {
      hydrationReadStarted = resolve
    })
    let firstSourceRead = true
    bucket.beforeGet = async (key) => {
      if (key !== sourceKey || !firstSourceRead) return
      firstSourceRead = false
      hydrationReadStarted()
      await hydrationGate
    }
    const staleHydration = ensureDocHydrated(room, docId)
    await hydrationStarted

    const rollbackPromise = room.fetch(
      new Request('https://worker.example/admin/snapshots/rollback', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey: sourceKey,
          upperSeq: 1,
          reason: 'Refresh after stale hydration settles',
          confirmation: 'rollback',
        }),
      }),
    )
    await Promise.resolve()
    releaseHydration()
    await staleHydration
    const rollbackResponse = await rollbackPromise
    assert.equal(rollbackResponse.status, 200)

    const targetKey = `snapshots/vault-1/files/${ydocId}/2.yupdate`
    const active = room.docs.get(`file:${ydocId}`)
    assert(active)
    const expected = new Y.Doc()
    Y.applyUpdate(expected, sourceBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(active), Y.encodeStateAsUpdate(expected))

    const appendUpdate = { ...makeSyncUpdate(makeMessageId('rollback-hydration-append')), docId }
    await room.webSocketMessage(server, JSON.stringify(appendUpdate))
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSeq, 3)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, targetKey)
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('hydration ignores R2-only candidate evidence without durable authority', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-uncommitted-candidate')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('uncommitted-snapshot'))
  const durableUpdate = makeYjsUpdateBytes(makeMessageId('durable-op'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(
    storage,
    snapshotKey,
    `file:${ydocId}`,
    snapshotBytes,
    'candidate',
  )
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:durable-op`, {
    docId: `file:${ydocId}`,
    seq: 1,
    messageId: 'durable-op',
    deviceId: 'device-1',
    updateBytes: durableUpdate,
    updateSha256: await hashTestBytes(durableUpdate),
    createdAt: 1,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))
  room.vaultId = makeVaultId('vault-1')

  await ensureDocHydrated(room, docId)
  const hydrated = room.docs.get(`file:${ydocId}`)
  assert(hydrated)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, durableUpdate)
  assert.deepEqual(Y.encodeStateAsUpdate(hydrated), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('hydration replays only the op-log through its captured document clock', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 3,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  for (const seq of [1, 2, 3]) {
    const updateBytes = makeYjsUpdateBytes(makeMessageId(`captured-clock-${seq}`))
    storage.sql.opLog.set(`meta:captured-clock-${seq}`, {
      docId: 'meta',
      seq,
      messageId: `captured-clock-${seq}`,
      deviceId: 'device-1',
      updateBytes,
      updateSha256: await hashTestBytes(updateBytes),
      createdAt: seq,
    })
  }
  let appended = false
  bucket.listOverride = async () => {
    if (!appended) {
      appended = true
      const updateBytes = makeYjsUpdateBytes(makeMessageId('captured-clock-4'))
      storage.sql.opLog.set('meta:captured-clock-4', {
        docId: 'meta',
        seq: 4,
        messageId: 'captured-clock-4',
        deviceId: 'device-1',
        updateBytes,
        updateSha256: await hashTestBytes(updateBytes),
        createdAt: 4,
      })
    }
    return { objects: [], truncated: false }
  }
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))
  room.vaultId = makeVaultId('vault-1')

  await ensureDocHydrated(room, { kind: 'meta' })

  assert(room.docs.has('meta'))
})
