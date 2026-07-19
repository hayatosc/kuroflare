import {
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeVaultId,
  makeYDocId,
  groupedEntryFromMetaFile,
  type NeedFullSnapshot,
  type SyncUpdate,
} from '@kuroflare/core'
import { assert, expect, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../../../runtime'
import { ensureDocHydrated } from '../../../runtime/documents'
import { metaYDocSchemaDisposition } from '../../../sync/yjs'
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
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  syncMessages,
  hashTestBytes,
  makeInvalidMetaSchemaYjsUpdateBase64,
  makeYjsUpdateBase64,
  makeAuthenticatedWebSocketRequest,
  makeSyncRequest,
  makeYjsUpdateBytes,
  makeStateVectorBase64,
  decodeTestBase64,
  FakeR2Bucket,
  findAckForMessage,
} from '../../support'
import { makePoisonedMetaDoc } from '../../support'

test('VaultRoom checkpoints an active document to R2 and advances the SQL snapshot pointer', async () => {
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
    await room.webSocketMessage(server, JSON.stringify(makeSyncUpdate(makeMessageId('message-cp'))))

    const result = await room.checkpointDoc({ kind: 'meta' }, 99)

    assert.deepEqual(result, {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })
    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 1)
    assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
    assert.equal(storage.sql.opLog.has('meta:message-cp'), false)
    assert.equal(
      storage.sql.docs.get('meta')?.latestSnapshotKey,
      'snapshots/vault-1/meta/1.yupdate',
    )
    const run = storage.sql.checkpointRuns.get('checkpoint:snapshots/vault-1/meta/1.yupdate:99')
    assert(run)
    assert.equal(run.status, 'compacted')
    assert.equal(run.r2WrittenAt, 99)
    assert.equal(run.pointerUpdatedAt, 99)
    assert.equal(run.compactedAt, 99)
    assert.equal(
      storage.sql.snapshotHealthEvents.find((event) => event.event === 'expected')?.actor,
      'system:checkpoint',
    )
    assert.equal(
      storage.sql.snapshotHealthEvents.find((event) => event.event === 'verification')?.actor,
      'system:verifier',
    )

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 100), {
      action: 'skipped',
      reason: 'no-new-ops',
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs a structured event with the checkpoint duration', async () => {
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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-cp-duration'))),
    )

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await room.checkpointDoc({ kind: 'meta' }, 99)
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    const durationEvent = events.find((event) => event.event === 'checkpoint-duration')
    assert(durationEvent)
    assert.deepEqual(durationEvent.docId, { kind: 'meta' })
    assert.equal(durationEvent.upperSeq, 1)
    assert.equal(typeof durationEvent.durationMs, 'number')
    assert(durationEvent.durationMs >= 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed after complete SQLite loss even when R2 retains a checkpoint', async () => {
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
    const checkpointedUpdate = makeSyncUpdate(makeMessageId('message-disaster-checkpoint'))
    await room.webSocketMessage(server, JSON.stringify(checkpointedUpdate))
    assert.equal(findAckForMessage(server.sent, checkpointedUpdate.messageId)?.durableSeq, 1)
    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })
    const authoritativeEvent = storage.sql.snapshotHealthEvents
      .filter((event) => event.event === 'verification')
      .at(-1)
    assert(authoritativeEvent)
    assert.equal(authoritativeEvent.snapshotKey, 'snapshots/vault-1/meta/1.yupdate')
    assert.equal(authoritativeEvent.upperSeq, 1)
    assert.equal(authoritativeEvent.physicalStatus, 'verified')
    assert.equal(authoritativeEvent.logicalStatus, 'healthy')
    assert.equal(authoritativeEvent.authorityStatus, 'authoritative')
    assert.equal(authoritativeEvent.expectedByteLength !== undefined, true)
    assert.equal(authoritativeEvent.expectedUpdateSha256 !== undefined, true)
    assert.equal(authoritativeEvent.expectedStateVectorSha256 !== undefined, true)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, authoritativeEvent.snapshotKey)
    assert.equal(storage.sql.opLog.has(`meta:${checkpointedUpdate.messageId}`), false)

    const residualUpdate = makeSyncUpdate(makeMessageId('message-disaster-residual'))
    await room.webSocketMessage(server, JSON.stringify(residualUpdate))
    assert.equal(findAckForMessage(server.sent, residualUpdate.messageId)?.durableSeq, 2)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${residualUpdate.messageId}`)?.seq, 2)
    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])

    const lostStorage = new SqlOnlyStorage()
    const recoveredRoom = new VaultRoom(
      new FakeState(lostStorage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    recoveredRoom.vaultId = makeVaultId('vault-1')
    const putsBeforeHydration = [...bucket.puts]
    const deletesBeforeHydration = [...bucket.deletes]

    await expect(ensureDocHydrated(recoveredRoom, { kind: 'meta' })).rejects.toThrow(
      'snapshot-health:no-verified-generation',
    )

    assert.equal(recoveredRoom.docs.has('meta'), false)
    assert.equal(recoveredRoom.hydratedDocs.has('meta'), false)
    assert.equal(lostStorage.sql.docs.size, 0)
    assert.equal(lostStorage.sql.opLog.size, 0)
    assert.equal(lostStorage.sql.messageDedup.size, 0)
    assert.equal(lostStorage.sql.snapshotHealthEvents.length, 0)
    assert.deepEqual(bucket.puts, putsBeforeHydration)
    assert.deepEqual(bucket.deletes, deletesBeforeHydration)

    const recoveredSocket = new FakeSocket()
    const recoveredPeer = new FakeSocket()
    recoveredRoom.sessions.add(recoveredSocket)
    recoveredRoom.sessions.add(recoveredPeer)
    recoveredRoom.sessionStates.set(recoveredSocket, {
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      metadataAccess: 'read-write',
      metadataCapabilityAdvertised: true,
    })
    recoveredRoom.sessionStates.set(recoveredPeer, {
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      metadataAccess: 'read-write',
      metadataCapabilityAdvertised: true,
    })
    recoveredRoom.schemaReady = true
    await recoveredRoom.webSocketMessage(recoveredSocket, JSON.stringify(residualUpdate))
    assert.equal(recoveredSocket.closeReason, 'hydrate-failed')
    assert.deepEqual(recoveredSocket.sent, [])
    assert.deepEqual(recoveredPeer.sent, [])
    assert.equal(lostStorage.sql.docs.size, 0)
    assert.equal(lostStorage.sql.opLog.size, 0)
    assert.equal(lostStorage.sql.messageDedup.size, 0)
    assert.deepEqual(bucket.puts, putsBeforeHydration)
    assert.deepEqual(bucket.deletes, deletesBeforeHydration)
    assert.isFalse(
      lostStorage.sql.queries.some((query) => /\b(insert|update|delete)\b/.test(query)),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom acks a compacted duplicate using its durable update hash', async () => {
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

    const update = makeSyncUpdate(makeMessageId('message-compacted-duplicate'))
    await room.webSocketMessage(server, JSON.stringify(update))
    await room.checkpointDoc({ kind: 'meta' }, 99)

    assert.equal(storage.sql.opLog.has(`meta:${update.messageId}`), false)
    assert.equal(
      typeof storage.sql.messageDedup.get(`meta:${update.messageId}`)?.updateSha256,
      'string',
    )

    server.sent.length = 0
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(findAckForMessage(server.sent, update.messageId)?.durableSeq, 1)
    assert.equal(server.closed, false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects a legacy dedup row without hash evidence', async () => {
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

    const update = makeSyncUpdate(makeMessageId('message-legacy-dedup'))
    await room.webSocketMessage(server, JSON.stringify(update))
    const dedup = storage.sql.messageDedup.get(`meta:${update.messageId}`)
    assert(dedup)
    storage.sql.messageDedup.set(`meta:${update.messageId}`, { ...dedup, updateSha256: undefined })
    server.sent.length = 0

    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'duplicate-unsafe')
    assert.equal(findAckForMessage(server.sent, update.messageId), undefined)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom captures checkpoint bytes and state vector before later appends', async () => {
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
    const firstUpdate = makeSyncUpdate(makeMessageId('message-checkpoint-boundary-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))

    let notifyPutStarted: () => void = () => {}
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    bucket.beforePut = async (key) => {
      if (key === 'snapshots/vault-1/meta/1.yupdate') {
        notifyPutStarted()
        await putGate
      }
    }

    const checkpoint = room.checkpointDoc({ kind: 'meta' }, 99)
    await putStarted

    const secondUpdate = makeSyncUpdate(makeMessageId('message-checkpoint-boundary-2'))
    await room.webSocketMessage(server, JSON.stringify(secondUpdate))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 2)

    releasePut()
    assert.deepEqual(await checkpoint, {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: 1,
    })

    const snapshotObject = await bucket.get('snapshots/vault-1/meta/1.yupdate')
    assert(snapshotObject)
    const snapshotDoc = new Y.Doc()
    Y.applyUpdate(snapshotDoc, new Uint8Array(await snapshotObject.arrayBuffer()))
    const firstDoc = new Y.Doc()
    Y.applyUpdate(firstDoc, decodeTestBase64(firstUpdate.update))
    assert.deepEqual(Y.encodeStateAsUpdate(snapshotDoc), Y.encodeStateAsUpdate(firstDoc))
    assert.deepEqual(
      storage.sql.checkpointRuns.get('checkpoint:snapshots/vault-1/meta/1.yupdate:99')?.stateVector,
      Y.encodeStateVector(firstDoc),
    )
    assert.equal(storage.sql.opLog.has(`meta:${firstUpdate.messageId}`), false)
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 2)
    snapshotDoc.destroy()
    firstDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when a checkpoint target key already exists', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const updateBytes = makeYjsUpdateBytes(makeMessageId('message-checkpoint-target-conflict'))
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:checkpoint-target-conflict', {
    docId: 'meta',
    seq: 1,
    messageId: 'checkpoint-target-conflict',
    deviceId: 'device-1',
    updateBytes,
    updateSha256: await hashTestBytes(updateBytes),
    createdAt: 1,
  })
  const targetKey = 'snapshots/vault-1/meta/1.yupdate'
  const existingBytes = makeYjsUpdateBytes(makeMessageId('checkpoint-target-existing'))
  bucket.set(targetKey, existingBytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')

  let failure: unknown
  try {
    await room.checkpointDoc({ kind: 'meta' }, 99)
  } catch (error) {
    failure = error
  }
  assert(failure instanceof Error)
  assert.match(failure.message, /snapshot-checkpoint-target-exists/)
  const persisted = await bucket.get(targetKey)
  assert(persisted)
  assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), existingBytes)
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('VaultRoom serializes snapshot import with a concurrent live append', async () => {
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
    const firstUpdate = makeSyncUpdate(makeMessageId('message-import-boundary-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))
    const importUpdate = makeYjsUpdateBytes(makeMessageId('message-import-boundary-import'))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, decodeTestBase64(firstUpdate.update))
    Y.applyUpdate(expectedDoc, importUpdate)

    let notifyPutStarted: () => void = () => {}
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    bucket.beforePut = async (key) => {
      if (key === 'snapshots/vault-1/meta/2.yupdate') {
        notifyPutStarted()
        await putGate
      }
    }

    const importRequest = room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )
    await putStarted

    let appendSettled = false
    const secondUpdate = makeSyncUpdate(makeMessageId('message-import-boundary-2'))
    const append = room.webSocketMessage(server, JSON.stringify(secondUpdate)).finally(() => {
      appendSettled = true
    })
    await Promise.resolve()
    assert.equal(appendSettled, false)

    releasePut()
    const importResponse = await importRequest
    await append
    assert.equal(importResponse.status, 200)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 3)
    const importRun = [...storage.sql.checkpointRuns.values()].find(
      (run) => run.snapshotKey === 'snapshots/vault-1/meta/2.yupdate',
    )
    assert.equal(importRun?.status, 'pointer-updated')
    assert.deepEqual(importRun?.stateVector, Y.encodeStateVector(expectedDoc))

    const importedSnapshot = await bucket.get('snapshots/vault-1/meta/2.yupdate')
    assert(importedSnapshot)
    const importedBytes = new Uint8Array(await importedSnapshot.arrayBuffer())
    const importedDoc = new Y.Doc()
    Y.applyUpdate(importedDoc, importedBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(importedDoc), Y.encodeStateAsUpdate(expectedDoc))
    importedDoc.destroy()
    expectedDoc.destroy()

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 100), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/3.yupdate',
      upperSeq: 3,
      compactedSeq: 2,
    })
    assert.equal(storage.sql.opLog.get(`meta:${secondUpdate.messageId}`)?.seq, 3)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom fails closed when an import target key already exists', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const targetKey = 'snapshots/vault-1/meta/1.yupdate'
  const existingBytes = makeYjsUpdateBytes(makeMessageId('import-target-existing'))
  bucket.set(targetKey, existingBytes)
  const importBytes = makeYjsUpdateBytes(makeMessageId('import-target-conflict'))
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(importBytes).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 409)
  assert.deepEqual(bucket.puts, [])
  const persisted = await bucket.get(targetKey)
  assert(persisted)
  assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), existingBytes)
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('VaultRoom requires explicit v2 evidence for metadata snapshot imports', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(
          makeYjsUpdateBytes(makeMessageId('meta-evidence-missing')),
        ).toString('base64'),
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'metadata-schema-v2-evidence-required',
  })
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.checkpointRuns.size, 0)
})

test('VaultRoom rejects snapshot imports that would convert a legacy deleted tombstone', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const fileId = makeFileId('legacy-deleted-import')
  const legacy = new Y.Doc()
  legacy.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: 'Notes/Deleted.md',
    canonicalPath: 'notes/deleted.md',
    type: 'text',
    ydocId: makeYDocId('legacy-deleted-import-doc'),
    deleted: true,
    deletedAt: 2,
    deletedBy: makeDeviceId('legacy-deleter'),
    deletedContentVersion: {
      kind: 'binary',
      blobManifestHash: '0'.repeat(64),
    },
    createdAt: 1,
    createdBy: makeDeviceId('legacy-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('legacy-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('legacy-creator'),
    mtime: 1,
  })
  room.docs.set('meta', legacy)
  room.hydratedDocs.add('meta')
  const before = Y.encodeStateAsUpdate(legacy)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 0,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    latestStateVector: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })

  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(legacy))
  const active = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Notes/Deleted.md',
    canonicalPath: 'notes/deleted.md',
    type: 'text' as const,
    ydocId: makeYDocId('legacy-deleted-import-doc'),
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('legacy-creator'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('legacy-creator'),
    updatedAt: 1,
    updatedBy: makeDeviceId('legacy-creator'),
    mtime: 1,
  }
  candidate.getMap('meta').set(fileId, groupedEntryFromMetaFile(active))
  const update = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(legacy))
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(update).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'invalid-snapshot-import-meta-schema',
  })
  assert.deepEqual(bucket.puts, [])
  assert.deepEqual(Y.encodeStateAsUpdate(legacy), before)
  assert.equal(room.docs.get('meta'), legacy)
  assert.equal(storage.sql.checkpointRuns.size, 0)
  candidate.destroy()
  legacy.destroy()
})

test('VaultRoom rejects unresolved snapshot-import deltas without advancing the sequence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const source = new Y.Doc()
  const firstFileId = makeFileId('causal-import-base')
  source.getMap('meta').set(
    firstFileId,
    groupedEntryFromMetaFile({
      schemaVersion: 1,
      fileId: firstFileId,
      path: 'Notes/Base.md',
      canonicalPath: 'notes/base.md',
      type: 'text',
      ydocId: makeYDocId('causal-import-base-doc'),
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('causal-import-device'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('causal-import-device'),
      updatedAt: 1,
      updatedBy: makeDeviceId('causal-import-device'),
      mtime: 1,
    }),
  )
  const baseStateVector = Y.encodeStateVector(source)
  const secondFileId = makeFileId('causal-import-delta')
  source.getMap('meta').set(
    secondFileId,
    groupedEntryFromMetaFile({
      schemaVersion: 1,
      fileId: secondFileId,
      path: 'Notes/Delta.md',
      canonicalPath: 'notes/delta.md',
      type: 'text',
      ydocId: makeYDocId('causal-import-delta-doc'),
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('causal-import-device'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('causal-import-device'),
      updatedAt: 1,
      updatedBy: makeDeviceId('causal-import-device'),
      mtime: 1,
    }),
  )
  const unresolvedDelta = Y.encodeStateAsUpdate(source, baseStateVector)
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: Buffer.from(unresolvedDelta).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'invalid-snapshot-import-update',
  })
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.docs.size, 0)
  source.destroy()
})

test('VaultRoom rejects metadata snapshot imports when the current document is poisoned', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const poisoned = makePoisonedMetaDoc(makeFileId('poisoned-import-meta'))
  room.docs.set('meta', poisoned)
  room.hydratedDocs.add('meta')
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    latestStateVector: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })

  const beforeStateVector = Y.encodeStateVector(poisoned)
  const response = await room.fetch(
    new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        updateBytesBase64: makeYjsUpdateBase64(makeMessageId('poisoned-import-v2-root')),
        latestSeq: 1,
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    code: 'request/invalid',
    retryable: false,
    detail: 'invalid-snapshot-import-meta-schema',
  })
  assert.deepEqual(bucket.puts, [])
  assert.equal(storage.sql.checkpointRuns.size, 0)
  assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)
  assert.deepEqual(Y.encodeStateVector(poisoned), beforeStateVector)
  assert.equal(metaYDocSchemaDisposition(poisoned), 'invalid')
  assert.equal(room.docs.get('meta'), poisoned)
})

test('VaultRoom rejects stale snapshot import sequences without durable mutation', async () => {
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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-seq-1'))),
    )
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-seq-2'))),
    )

    const staleDoc = room.docs.get('meta')
    assert(staleDoc)
    const omittedSeqResponse = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(
            makeYjsUpdateBytes(makeMessageId('message-import-seq-omitted')),
          ).toString('base64'),
          metadataSchemaVersion: 2,
        }),
      }),
    )
    assert.equal(omittedSeqResponse.status, 409)
    for (const latestSeq of [1, 3]) {
      const response = await room.fetch(
        new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
              tokenVersion: 1,
            })}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            updateBytesBase64: Buffer.from(
              makeYjsUpdateBytes(makeMessageId(`message-import-seq-stale-${latestSeq}`)),
            ).toString('base64'),
            latestSeq,
            metadataSchemaVersion: 2,
          }),
        }),
      )
      assert.equal(response.status, 409)
    }

    assert.deepEqual(bucket.puts, [])
    assert.equal(storage.sql.checkpointRuns.size, 0)
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)
    assert.equal(room.docs.get('meta'), staleDoc)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom lets only one snapshot importer win an identical latest sequence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })
  const request = (updateBytesBase64: string): Promise<Response> =>
    Promise.resolve(
      room.fetch(
        new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ updateBytesBase64, metadataSchemaVersion: 2 }),
        }),
      ),
    )

  const first = await request(makeYjsUpdateBase64(makeMessageId('cas-first')))
  assert.equal(first.status, 200)
  const second = await request(makeYjsUpdateBase64(makeMessageId('cas-second')))
  assert.equal(second.status, 409)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
  assert.equal(bucket.puts.length, 1)
  const active = room.docs.get('meta')
  assert(active)
  assert.equal(active.getMap('meta').size, 1)
  assert.equal(active.getMap('meta').has(makeFileId('file-cas-first')), true)
  assert.equal(active.getMap('meta').has(makeFileId('file-cas-second')), false)
})

test('VaultRoom rejects invalid meta snapshot imports without replacing the active document', async () => {
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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-meta-valid'))),
    )
    const activeDoc = room.docs.get('meta')
    assert(activeDoc)

    const response = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: makeInvalidMetaSchemaYjsUpdateBase64(),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(bucket.puts, [])
    assert.equal(storage.sql.checkpointRuns.size, 0)
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)
    assert.equal(room.docs.get('meta'), activeDoc)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects metadata snapshot imports that mutate immutable identity', async () => {
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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-import-identity-base'))),
    )
    const activeDoc = room.docs.get('meta')
    assert(activeDoc)
    const fileId = [...activeDoc.getMap('meta').keys()][0]
    assert(fileId)

    const candidate = new Y.Doc()
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(activeDoc))
    const child = candidate.getMap<Y.Map<unknown>>('meta').get(fileId)
    assert(child instanceof Y.Map)
    const identity = child.get('identity')
    assert(typeof identity === 'object' && identity !== null)
    child.set('identity', { ...(identity as Record<string, unknown>), createdAt: 2 })
    const importUpdate = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(activeDoc))
    candidate.destroy()

    const response = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )

    assert.equal(response.status, 400)
    assert.deepEqual(bucket.puts, [])
    assert.equal(storage.sql.checkpointRuns.size, 0)
    assert.equal(room.docs.get('meta'), activeDoc)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rehydrates an active document after recovering a failed snapshot import', async () => {
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
    const firstUpdate = makeSyncUpdate(makeMessageId('message-import-recovery-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))
    const importUpdate = makeYjsUpdateBytes(makeMessageId('message-import-recovery-import'))
    const expectedImportedDoc = new Y.Doc()
    Y.applyUpdate(expectedImportedDoc, decodeTestBase64(firstUpdate.update))
    Y.applyUpdate(expectedImportedDoc, importUpdate)

    storage.sql.failOnQueryIncludes = 'insert into docs'
    const importResponse = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )
    assert.equal(importResponse.status, 500)
    storage.sql.failOnQueryIncludes = undefined

    const importRun = [...storage.sql.checkpointRuns.values()].find(
      (run) => run.snapshotKey === 'snapshots/vault-1/meta/2.yupdate',
    )
    assert.equal(importRun?.status, 'r2-written')

    await room.alarm()

    assert(importRun)
    assert.equal(storage.sql.checkpointRuns.get(importRun.runId)?.status, 'pointer-updated')
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 2)
    const recoveredDoc = room.docs.get('meta')
    assert(recoveredDoc)
    assert.deepEqual(
      Y.encodeStateAsUpdate(recoveredDoc),
      Y.encodeStateAsUpdate(expectedImportedDoc),
    )

    const emptyStateVector = makeStateVectorBase64(new Y.Doc())
    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-import-recovery-sync'), emptyStateVector),
      ),
    )
    const syncResponse = syncMessages(server.sent).at(-1)
    assert(typeof syncResponse === 'string')
    const syncUpdate = JSON.parse(syncResponse) as SyncUpdate
    const syncDoc = new Y.Doc()
    Y.applyUpdate(syncDoc, decodeTestBase64(syncUpdate.update))
    assert.deepEqual(Y.encodeStateAsUpdate(syncDoc), Y.encodeStateAsUpdate(expectedImportedDoc))
    syncDoc.destroy()

    const append = makeSyncUpdate(makeMessageId('message-import-recovery-append'))
    Y.applyUpdate(expectedImportedDoc, decodeTestBase64(append.update))
    await room.webSocketMessage(server, JSON.stringify(append))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    const appendedDoc = room.docs.get('meta')
    assert(appendedDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(appendedDoc), Y.encodeStateAsUpdate(expectedImportedDoc))

    const checkpointResult = await room.checkpointDoc({ kind: 'meta' }, 100)
    if (checkpointResult.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpointResult.snapshotKey, 'snapshots/vault-1/meta/3.yupdate')
    assert.equal(checkpointResult.upperSeq, 3)
    const checkpointObject = await bucket.get('snapshots/vault-1/meta/3.yupdate')
    assert(checkpointObject)
    const checkpointDoc = new Y.Doc()
    Y.applyUpdate(checkpointDoc, new Uint8Array(await checkpointObject.arrayBuffer()))
    assert.deepEqual(
      Y.encodeStateAsUpdate(checkpointDoc),
      Y.encodeStateAsUpdate(expectedImportedDoc),
    )
    checkpointDoc.destroy()
    expectedImportedDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom preserves an imported document when pointer run status fails after SQL commit', async () => {
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

    const firstUpdate = makeSyncUpdate(makeMessageId('message-import-status-failure-1'))
    await room.webSocketMessage(server, JSON.stringify(firstUpdate))
    const staleDoc = room.docs.get('meta')
    assert(staleDoc)
    const importUpdate = makeYjsUpdateBytes(makeMessageId('message-import-status-failure-import'))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, decodeTestBase64(firstUpdate.update))
    Y.applyUpdate(expectedDoc, importUpdate)
    const importedSnapshotDoc = new Y.Doc()
    Y.applyUpdate(importedSnapshotDoc, Y.encodeStateAsUpdate(expectedDoc))

    storage.sql.failOnQueryIncludes = 'pointer_updated_at'
    const importResponse = await room.fetch(
      new Request('https://worker.example/vaults/vault-1/meta/snapshot', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          updateBytesBase64: Buffer.from(importUpdate).toString('base64'),
          latestSeq: 1,
          metadataSchemaVersion: 2,
        }),
      }),
    )
    assert.equal(importResponse.status, 500)
    storage.sql.failOnQueryIncludes = undefined
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
    const importRun = [...storage.sql.checkpointRuns.values()].find(
      (run) => run.snapshotKey === 'snapshots/vault-1/meta/2.yupdate',
    )
    assert.equal(importRun?.status, 'r2-written')

    const activeAfterFailure = room.docs.get('meta')
    assert(activeAfterFailure)
    assert.notEqual(activeAfterFailure, staleDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(activeAfterFailure), Y.encodeStateAsUpdate(expectedDoc))

    const append = makeSyncUpdate(makeMessageId('message-import-status-failure-append'))
    Y.applyUpdate(expectedDoc, decodeTestBase64(append.update))
    await room.webSocketMessage(server, JSON.stringify(append))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    const checkpointResult = await room.checkpointDoc({ kind: 'meta' }, 100)
    if (checkpointResult.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpointResult.upperSeq, 3)

    const coldRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void coldRoom.fetch(await makeAuthenticatedWebSocketRequest())
    const coldServer = (coldRoom.state.getWebSockets?.() ?? [])[0]
    assert(coldServer instanceof FakeSocket)
    await coldRoom.webSocketMessage(coldServer, JSON.stringify(makeHello()))
    await coldRoom.webSocketMessage(
      coldServer,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-import-status-failure-cold'),
          makeStateVectorBase64(importedSnapshotDoc),
        ),
      ),
    )
    const coldResponse = syncMessages(coldServer.sent).at(-1)
    assert(typeof coldResponse === 'string')
    assert.deepEqual(JSON.parse(coldResponse) as NeedFullSnapshot, {
      type: 'need-full-snapshot',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      docId: { kind: 'meta' },
      reason: 'state-vector-too-old',
    })
    importedSnapshotDoc.destroy()
    expectedDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})
