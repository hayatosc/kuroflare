import { ApiErrorSchema, makeMessageId, makeYDocId, type SyncUpdate } from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../../../runtime'
import { ensureSchema } from '../../../runtime/storage'
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
  makeEnvWithSnapshotBucket,
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  syncMessages,
  makeAuthenticatedWebSocketRequest,
  makeSyncRequest,
  makeYjsUpdateBytes,
  makeStateVectorBase64,
  decodeTestBase64,
  FakeR2Bucket,
} from '../../support'
import { seedVerifiedSnapshotEvidence } from '../../support'

interface RetentionAdminResponse {
  readonly items: readonly RetentionAdminEvent[]
  readonly nextCursor?: string
}

interface RetentionAdminEvent {
  readonly docId: string
  readonly snapshotKey: string
  readonly action: string
  readonly error: string | null
  readonly attemptedAt: number
}

function isRetentionAdminResponse(value: unknown): value is RetentionAdminResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(Reflect.get(value, 'items')) &&
    Reflect.get(value, 'items').every(
      (event: unknown) =>
        typeof event === 'object' &&
        event !== null &&
        !Array.isArray(event) &&
        typeof Reflect.get(event, 'docId') === 'string' &&
        typeof Reflect.get(event, 'snapshotKey') === 'string' &&
        typeof Reflect.get(event, 'action') === 'string' &&
        (Reflect.get(event, 'error') === null || typeof Reflect.get(event, 'error') === 'string') &&
        typeof Reflect.get(event, 'attemptedAt') === 'number',
    )
  )
}

test('VaultRoom runs snapshot retention cleanup after checkpoint and exposes admin events', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    bucket.listPageSize = 1
    const cumulativeDoc = new Y.Doc()
    const updates = Array.from({ length: 5 }, (_, index) =>
      makeSyncUpdate(makeMessageId(`message-retention-${index + 1}`)),
    )
    const snapshotStateVectors = new Map<number, Uint8Array>()
    for (const [index, update] of updates.entries()) {
      Y.applyUpdate(cumulativeDoc, decodeTestBase64(update.update))
      const seq = index + 1
      const snapshotBytes = Y.encodeStateAsUpdate(cumulativeDoc)
      bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, snapshotBytes)
      await seedVerifiedSnapshotEvidence(
        storage,
        `snapshots/vault-1/meta/${seq}.yupdate`,
        'meta',
        snapshotBytes,
      )
      snapshotStateVectors.set(seq, Y.encodeStateVector(cumulativeDoc))
      storage.sql.checkpointRuns.set(`seed-retention-${seq}`, {
        runId: `seed-retention-${seq}`,
        docId: 'meta',
        upperSeq: seq,
        snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
        stateVector: snapshotStateVectors.get(seq) ?? new Uint8Array(),
        status: 'compacted',
        createdAt: seq,
        r2WrittenAt: seq,
        pointerUpdatedAt: seq,
        compactedAt: seq,
      })
    }
    const expectedFinalUpdate = Y.encodeStateAsUpdate(cumulativeDoc)
    cumulativeDoc.destroy()
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 0,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
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
    for (const update of updates) {
      await room.webSocketMessage(server, JSON.stringify(update))
    }

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/5.yupdate',
      upperSeq: 5,
      compactedSeq: 3,
    })

    assert.deepEqual(
      [...storage.sql.opLog.values()].map((row) => row.seq).sort((left, right) => left - right),
      [4, 5],
    )

    assert.deepEqual(bucket.deletes, [
      'snapshots/vault-1/meta/1.yupdate',
      'snapshots/vault-1/meta/2.yupdate',
    ])
    assert.equal(bucket.lists.length, 10)
    assert.deepEqual(storage.sql.docs.get('meta')?.horizonStateVector, snapshotStateVectors.get(3))
    assert.equal(await bucket.get('snapshots/vault-1/meta/1.yupdate'), null)
    assert.notEqual(await bucket.get('snapshots/vault-1/meta/3.yupdate'), null)
    assert.deepEqual(
      storage.sql.snapshotRetentionEvents.map((event) => ({
        snapshotKey: event.snapshotKey,
        error: event.error,
      })),
      [
        { snapshotKey: 'snapshots/vault-1/meta/1.yupdate', error: undefined },
        { snapshotKey: 'snapshots/vault-1/meta/2.yupdate', error: undefined },
      ],
    )
    for (const snapshotKey of [
      'snapshots/vault-1/meta/1.yupdate',
      'snapshots/vault-1/meta/2.yupdate',
    ]) {
      const deleted = storage.sql.snapshotHealthEvents
        .filter((event) => event.snapshotKey === snapshotKey)
        .at(-1)
      assert.equal(deleted?.physicalStatus, 'mismatch')
      assert.equal(JSON.parse(deleted?.reasons ?? '[]').includes('missing-object'), true)
    }

    restoreResponse(previousResponse)
    const healthResponse = await room.fetch(
      new Request('https://worker.example/admin/snapshots?docId=meta&limit=64', {
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
        },
      }),
    )
    assert.equal(healthResponse.status, 200)
    const healthBody = (await healthResponse.json()) as {
      readonly entries: readonly {
        snapshotKey: string
        physicalStatus: string
        allowedActions: readonly string[]
        actionBlockReason?: string
      }[]
    }
    const deletedEntry = healthBody.entries.find(
      (entry) => entry.snapshotKey === 'snapshots/vault-1/meta/1.yupdate',
    )
    assert(deletedEntry)
    assert.equal(deletedEntry.physicalStatus, 'mismatch')
    assert.deepEqual(deletedEntry.allowedActions, [])
    assert.equal(deletedEntry.actionBlockReason, 'snapshot-health-deleted')
    const deleteCount = bucket.deletes.length
    await room.alarm()
    assert.equal(bucket.deletes.length, deleteCount)

    const restoredBucket = new FakeR2Bucket()
    const snapshot3Bytes = await bucket.get('snapshots/vault-1/meta/3.yupdate')
    assert(snapshot3Bytes)
    restoredBucket.set(
      'snapshots/vault-1/meta/3.yupdate',
      new Uint8Array(await snapshot3Bytes.arrayBuffer()),
    )
    const restoredSnapshotDoc = new Y.Doc()
    Y.applyUpdate(restoredSnapshotDoc, new Uint8Array(await snapshot3Bytes.arrayBuffer()))
    const restoredSnapshotStateVector = Y.encodeStateVector(restoredSnapshotDoc)
    const existingDoc = storage.sql.docs.get('meta')
    assert(existingDoc)
    storage.sql.docs.set('meta', {
      ...existingDoc,
      latestSnapshotSeq: 3,
      latestSnapshotKey: 'snapshots/vault-1/meta/3.yupdate',
      minRetainedSeq: 3,
      horizonStateVector: restoredSnapshotStateVector,
    })
    const restoredRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(restoredBucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void restoredRoom.fetch(await makeAuthenticatedWebSocketRequest())
    const restoredServer = (restoredRoom.state.getWebSockets?.() ?? [])[0]
    assert(restoredServer instanceof FakeSocket)
    await restoredRoom.webSocketMessage(restoredServer, JSON.stringify(makeHello()))
    await restoredRoom.webSocketMessage(
      restoredServer,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-retention-residual'),
          makeStateVectorBase64(restoredSnapshotDoc),
        ),
      ),
    )
    const residualMessage = syncMessages(restoredServer.sent).at(-1)
    assert(typeof residualMessage === 'string')
    const residualUpdate = JSON.parse(residualMessage) as SyncUpdate
    restoredSnapshotDoc.destroy()
    const residualDoc = new Y.Doc()
    Y.applyUpdate(residualDoc, new Uint8Array(await snapshot3Bytes.arrayBuffer()))
    Y.applyUpdate(residualDoc, decodeTestBase64(residualUpdate.update))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, expectedFinalUpdate)
    assert.deepEqual(Y.encodeStateAsUpdate(residualDoc), Y.encodeStateAsUpdate(expectedDoc))
    residualDoc.destroy()
    expectedDoc.destroy()

    restoreResponse(previousResponse)
    const response = await room.fetch(
      new Request('https://worker.example/admin/retention', {
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
            tokenVersion: 1,
          })}`,
        },
      }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert(
      isRetentionAdminResponse(body) &&
        body.items.some((event) => event.snapshotKey === 'snapshots/vault-1/meta/1.yupdate'),
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('GET /admin/retention paginates newest-first with a cursor and rejects out-of-range limits', async () => {
  const storage = new SqlOnlyStorage()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(new FakeR2Bucket(), TEST_DEVICE_TOKEN_SECRET),
  )
  await ensureSchema(room)
  for (let seq = 1; seq <= 3; seq += 1) {
    storage.sql.snapshotRetentionEvents.push({
      id: seq,
      docId: 'meta',
      snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
      action: 'delete',
      error: undefined,
      attemptedAt: seq,
    })
  }
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const firstPage = await room.fetch(
    new Request('https://worker.example/admin/retention?limit=2', { headers: authHeader }),
  )
  assert.equal(firstPage.status, 200)
  const firstBody = await firstPage.json()
  assert(isRetentionAdminResponse(firstBody))
  assert.deepEqual(
    firstBody.items.map((event) => event.snapshotKey),
    ['snapshots/vault-1/meta/3.yupdate', 'snapshots/vault-1/meta/2.yupdate'],
  )
  assert.equal(firstBody.nextCursor, '2')

  const secondPage = await room.fetch(
    new Request(`https://worker.example/admin/retention?limit=2&cursor=${firstBody.nextCursor}`, {
      headers: authHeader,
    }),
  )
  assert.equal(secondPage.status, 200)
  const secondBody = await secondPage.json()
  assert(isRetentionAdminResponse(secondBody))
  assert.deepEqual(
    secondBody.items.map((event) => event.snapshotKey),
    ['snapshots/vault-1/meta/1.yupdate'],
  )
  assert.equal(secondBody.nextCursor, undefined)

  const invalidLimit = await room.fetch(
    new Request('https://worker.example/admin/retention?limit=0', { headers: authHeader }),
  )
  assert.equal(invalidLimit.status, 400)
  assert.equal(v.is(ApiErrorSchema, await invalidLimit.json()), true)

  const invalidCursor = await room.fetch(
    new Request('https://worker.example/admin/retention?cursor=not-a-number', {
      headers: authHeader,
    }),
  )
  assert.equal(invalidCursor.status, 400)
  assert.equal(v.is(ApiErrorSchema, await invalidCursor.json()), true)
})

test('VaultRoom blocks compaction when snapshot retention candidates are invalid', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    bucket.set('snapshots/vault-1/meta/not-a-snapshot.yupdate', new Uint8Array([1]))
    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-retention-invalid'))
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: undefined,
    })
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 0)
    assert.deepEqual(bucket.deletes, [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks compaction and fails closed when SNAPSHOT_RETENTION_MIN_GENERATIONS is invalid', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const env = {
      ...makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
      SNAPSHOT_RETENTION_MIN_GENERATIONS: 'not-a-positive-integer',
    }
    const room = new VaultRoom(state, env)
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const update = makeSyncUpdate(makeMessageId('message-retention-config-invalid'))
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: undefined,
    })
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 0)
    assert.deepEqual(bucket.deletes, [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks compaction when R2 pagination is malformed', async () => {
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
    const update = makeSyncUpdate(makeMessageId('message-retention-pagination-invalid'))
    await room.webSocketMessage(server, JSON.stringify(update))
    bucket.listOverride = async () => ({ objects: [], truncated: true })

    assert.deepEqual(await room.checkpointDoc({ kind: 'meta' }, 99), {
      action: 'checkpointed',
      snapshotKey: 'snapshots/vault-1/meta/1.yupdate',
      upperSeq: 1,
      compactedSeq: undefined,
    })
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
    assert.deepEqual(bucket.deletes, [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom schedules and runs checkpoint alarms after durable appends', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const state = new FakeState(storage)
    const env = makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET)
    const room = new VaultRoom(state, env)
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-alarm'))),
    )

    assert.equal(storage.alarms.length, 1)
    assert.equal(typeof storage.alarms[0], 'number')
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 0)

    const resumedRoom = new VaultRoom(new FakeState(storage), env)
    await resumedRoom.alarm()

    assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/1.yupdate'])
    assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 1)
    assert.equal(
      storage.sql.docs.get('meta')?.latestSnapshotKey,
      'snapshots/vault-1/meta/1.yupdate',
    )
    assert.equal(storage.sql.opLog.has('meta:message-alarm'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom schedules an immediate checkpoint alarm after the op threshold', async () => {
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
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 127,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    for (let seq = 1; seq <= 127; seq += 1) {
      storage.sql.opLog.set(`meta:threshold-seq-${seq}`, {
        docId: 'meta',
        seq,
        messageId: `threshold-seq-${seq}`,
        deviceId: 'device-1',
        updateBytes: makeYjsUpdateBytes(makeMessageId(`threshold-seq-${seq}`)),
        updateSha256: 'a'.repeat(64),
        createdAt: seq,
      })
    }
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-threshold'))),
    )

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 128)
    assert.equal(storage.alarms.length, 1)
    const scheduled = storage.alarms[0]
    assert(typeof scheduled === 'number')
    assert(scheduled <= Date.now())
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom alarm recovers orphaned checkpoint runs before new checkpoints', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-recovered-snapshot'))
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, snapshotBytes)
  const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshotBytes)
  await seedVerifiedSnapshotEvidence(
    storage,
    'snapshots/vault-1/meta/2.yupdate',
    'meta',
    snapshotBytes,
  )
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 3,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.checkpointRuns.set('run-writing', {
    runId: 'run-writing',
    docId: 'meta',
    upperSeq: 2,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: snapshotStateVector,
    status: 'writing',
    createdAt: 1,
    r2WrittenAt: undefined,
    pointerUpdatedAt: undefined,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-writing')?.status, 'r2-written')
  assert.equal(storage.sql.checkpointRuns.get('run-writing')?.r2WrittenAt !== undefined, true)
})

test('VaultRoom alarm advances and compacts recovered checkpoint pointers', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('message-pointer-snapshot'))
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, snapshotBytes)
  const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshotBytes)
  await seedVerifiedSnapshotEvidence(
    storage,
    'snapshots/vault-1/meta/2.yupdate',
    'meta',
    snapshotBytes,
  )
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 2,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:message-before-snapshot', {
    docId: 'meta',
    seq: 1,
    messageId: 'message-before-snapshot',
    deviceId: 'device-1',
    updateBytes: makeYjsUpdateBytes(makeMessageId('message-before-snapshot')),
    updateSha256: 'sha',
    createdAt: 1,
  })
  storage.sql.checkpointRuns.set('run-r2', {
    runId: 'run-r2',
    docId: 'meta',
    upperSeq: 2,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: snapshotStateVector,
    status: 'r2-written',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: undefined,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'pointer-updated')
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotSeq, 2)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, 'snapshots/vault-1/meta/2.yupdate')
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.authorityStatus, 'authoritative')

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-r2')?.status, 'compacted')
  assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 2)
  assert(storage.sql.docs.get('meta')?.horizonStateVector instanceof Uint8Array)
  assert.equal(storage.sql.opLog.has('meta:message-before-snapshot'), false)
})

test('VaultRoom alarm evicts a checkpointed, idle file doc at the tail of the checkpoint pass', async () => {
  const storage = new SqlOnlyStorage()
  const ydocId = makeYDocId('ydoc-evict-idle')
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: 'snapshots/vault-1/files/ydoc-evict-idle/1.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnv())
  room.docs.set(`file:${ydocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${ydocId}`)
  room.docLastAccessedAt.set(`file:${ydocId}`, 0)

  await room.alarm()

  assert.equal(room.docs.has(`file:${ydocId}`), false)
  assert.equal(room.hydratedDocs.has(`file:${ydocId}`), false)
})

test('VaultRoom alarm keeps dirty and recently-accessed file docs resident', async () => {
  const storage = new SqlOnlyStorage()
  const dirtyYDocId = makeYDocId('ydoc-evict-dirty')
  const recentYDocId = makeYDocId('ydoc-evict-recent')
  storage.sql.docs.set(`file:${dirtyYDocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 1,
    latestSnapshotKey: 'snapshots/vault-1/files/ydoc-evict-dirty/1.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.docs.set(`file:${recentYDocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: 'snapshots/vault-1/files/ydoc-evict-recent/1.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(new FakeState(storage), makeEnv())
  room.docs.set(`file:${dirtyYDocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${dirtyYDocId}`)
  room.docLastAccessedAt.set(`file:${dirtyYDocId}`, 0)
  room.docs.set(`file:${recentYDocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${recentYDocId}`)
  room.docLastAccessedAt.set(`file:${recentYDocId}`, Date.now())

  await room.alarm()

  assert.equal(room.hydratedDocs.has(`file:${dirtyYDocId}`), true)
  assert.equal(room.hydratedDocs.has(`file:${recentYDocId}`), true)
})

test('VaultRoom waits for stale hydration before rehydrating an orphaned pointer', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const oldSnapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const recoveredSnapshotKey = 'snapshots/vault-1/meta/2.yupdate'
    const latestSnapshotKey = 'snapshots/vault-1/meta/3.yupdate'
    const oldSnapshotUpdate = makeYjsUpdateBytes(makeMessageId('message-hydration-old'))
    const oldSnapshotDoc = new Y.Doc()
    Y.applyUpdate(oldSnapshotDoc, oldSnapshotUpdate)
    const oldSnapshotBytes = Y.encodeStateAsUpdate(oldSnapshotDoc)
    oldSnapshotDoc.destroy()

    const recoveredDoc = new Y.Doc()
    Y.applyUpdate(recoveredDoc, oldSnapshotUpdate)
    Y.applyUpdate(recoveredDoc, makeYjsUpdateBytes(makeMessageId('message-hydration-recovered')))
    const recoveredSnapshotBytes = Y.encodeStateAsUpdate(recoveredDoc)
    const recoveredStateVector = Y.encodeStateVector(recoveredDoc)
    bucket.set(oldSnapshotKey, oldSnapshotBytes)
    bucket.set(recoveredSnapshotKey, recoveredSnapshotBytes)
    await seedVerifiedSnapshotEvidence(storage, oldSnapshotKey, 'meta', oldSnapshotBytes)
    await seedVerifiedSnapshotEvidence(
      storage,
      recoveredSnapshotKey,
      'meta',
      recoveredSnapshotBytes,
    )

    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 2,
      latestSnapshotSeq: 1,
      latestSnapshotKey: oldSnapshotKey,
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.checkpointRuns.set('run-hydration-recovery', {
      runId: 'run-hydration-recovery',
      docId: 'meta',
      upperSeq: 2,
      snapshotKey: recoveredSnapshotKey,
      stateVector: recoveredStateVector,
      status: 'r2-written',
      createdAt: 1,
      r2WrittenAt: 2,
      pointerUpdatedAt: undefined,
      compactedAt: undefined,
    })
    await storage.put('vault:id', 'vault-1')

    let notifyListStarted: () => void = () => {}
    const listStarted = new Promise<void>((resolve) => {
      notifyListStarted = resolve
    })
    let releaseList: () => void = () => {}
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    let listCalls = 0
    bucket.listOverride = async () => {
      listCalls += 1
      if (listCalls === 1) {
        notifyListStarted()
        await listGate
        return { objects: [{ key: oldSnapshotKey }], truncated: false }
      }
      return {
        objects:
          listCalls === 2
            ? [{ key: oldSnapshotKey }, { key: recoveredSnapshotKey }]
            : [{ key: oldSnapshotKey }, { key: recoveredSnapshotKey }, { key: latestSnapshotKey }],
        truncated: false,
      }
    }

    const state = new FakeState(storage)
    const room = new VaultRoom(
      state,
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const emptyDoc = new Y.Doc()
    const hydrationRequest = room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-hydration-request'),
          makeStateVectorBase64(emptyDoc),
        ),
      ),
    )
    emptyDoc.destroy()
    await listStarted

    const alarm = room.alarm()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(room.docWriteQueues.has('meta'), false)
    releaseList()
    await Promise.all([hydrationRequest, alarm])

    const activeDoc = room.docs.get('meta')
    assert(activeDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(activeDoc), recoveredSnapshotBytes)

    const append = makeSyncUpdate(makeMessageId('message-hydration-append'))
    Y.applyUpdate(recoveredDoc, decodeTestBase64(append.update))
    await room.webSocketMessage(server, JSON.stringify(append))
    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
    const appendedDoc = room.docs.get('meta')
    assert(appendedDoc)
    assert.deepEqual(Y.encodeStateAsUpdate(appendedDoc), Y.encodeStateAsUpdate(recoveredDoc))

    const checkpointResult = await room.checkpointDoc({ kind: 'meta' }, 100)
    if (checkpointResult.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpointResult.snapshotKey, latestSnapshotKey)
    assert.equal(checkpointResult.upperSeq, 3)
    recoveredDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom blocks orphan recovery when snapshot key sequence mismatches the run', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshot2 = makeYjsUpdateBytes(makeMessageId('message-orphan-key-2'))
  const snapshot5 = makeYjsUpdateBytes(makeMessageId('message-orphan-key-5'))
  bucket.set('snapshots/vault-1/meta/2.yupdate', snapshot2)
  bucket.set('snapshots/vault-1/meta/5.yupdate', snapshot5)
  const snapshot2Doc = new Y.Doc()
  Y.applyUpdate(snapshot2Doc, snapshot2)
  const snapshot2StateVector = Y.encodeStateVector(snapshot2Doc)
  snapshot2Doc.destroy()
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 5,
    latestSnapshotSeq: 5,
    latestSnapshotKey: 'snapshots/vault-1/meta/5.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set('meta:message-orphan-key-row', {
    docId: 'meta',
    seq: 1,
    messageId: 'message-orphan-key-row',
    deviceId: 'device-1',
    updateBytes: snapshot2,
    updateSha256: 'sha',
    createdAt: 1,
  })
  storage.sql.checkpointRuns.set('run-orphan-key-mismatch', {
    runId: 'run-orphan-key-mismatch',
    docId: 'meta',
    upperSeq: 5,
    snapshotKey: 'snapshots/vault-1/meta/2.yupdate',
    stateVector: snapshot2StateVector,
    status: 'pointer-updated',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: 3,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

  await room.alarm()

  assert.equal(storage.sql.checkpointRuns.get('run-orphan-key-mismatch')?.status, 'pointer-updated')
  assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 0)
  assert.equal(storage.sql.opLog.has('meta:message-orphan-key-row'), true)
  assert.deepEqual(bucket.deletes, [])
})

test('VaultRoom applies the retained snapshot floor while recovering orphaned checkpoints', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const cumulativeDoc = new Y.Doc()
    const snapshotStateVectors = new Map<number, Uint8Array>()
    const snapshotBytesBySeq = new Map<number, Uint8Array>()
    for (const seq of [1, 2, 3, 4, 5]) {
      const updateBytes = makeYjsUpdateBytes(makeMessageId(`message-orphan-retention-${seq}`))
      Y.applyUpdate(cumulativeDoc, updateBytes)
      const snapshotBytes = Y.encodeStateAsUpdate(cumulativeDoc)
      const stateVector = Y.encodeStateVector(cumulativeDoc)
      bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, snapshotBytes)
      await seedVerifiedSnapshotEvidence(
        storage,
        `snapshots/vault-1/meta/${seq}.yupdate`,
        'meta',
        snapshotBytes,
      )
      snapshotBytesBySeq.set(seq, snapshotBytes)
      snapshotStateVectors.set(seq, stateVector)
      storage.sql.opLog.set(`meta:message-orphan-retention-${seq}`, {
        docId: 'meta',
        seq,
        messageId: `message-orphan-retention-${seq}`,
        deviceId: 'device-1',
        updateBytes,
        updateSha256: 'sha',
        createdAt: seq,
      })
      storage.sql.checkpointRuns.set(`seed-orphan-retention-${seq}`, {
        runId: `seed-orphan-retention-${seq}`,
        docId: 'meta',
        upperSeq: seq,
        snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
        stateVector,
        status: 'compacted',
        createdAt: seq,
        r2WrittenAt: seq,
        pointerUpdatedAt: seq,
        compactedAt: seq,
      })
    }
    const snapshotStateVector = snapshotStateVectors.get(5)
    assert(snapshotStateVector)
    const expectedFinalUpdate = Y.encodeStateAsUpdate(cumulativeDoc)
    cumulativeDoc.destroy()
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 5,
      latestSnapshotSeq: 5,
      latestSnapshotKey: 'snapshots/vault-1/meta/5.yupdate',
      minRetainedSeq: 0,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    storage.sql.checkpointRuns.set('run-orphan-retention', {
      runId: 'run-orphan-retention',
      docId: 'meta',
      upperSeq: 5,
      snapshotKey: 'snapshots/vault-1/meta/5.yupdate',
      stateVector: snapshotStateVector,
      status: 'pointer-updated',
      createdAt: 1,
      r2WrittenAt: 2,
      pointerUpdatedAt: 3,
      compactedAt: undefined,
    })
    await storage.put('vault:id', 'vault-1')
    const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))

    await room.alarm()

    assert.equal(storage.sql.checkpointRuns.get('run-orphan-retention')?.status, 'compacted')
    assert.deepEqual(
      [...storage.sql.opLog.values()].map((row) => row.seq).sort((left, right) => left - right),
      [4, 5],
    )
    assert.deepEqual(bucket.deletes, [
      'snapshots/vault-1/meta/1.yupdate',
      'snapshots/vault-1/meta/2.yupdate',
    ])
    assert.deepEqual(storage.sql.docs.get('meta')?.horizonStateVector, snapshotStateVectors.get(3))

    const oldestRetainedSnapshot = snapshotBytesBySeq.get(3)
    const oldestRetainedStateVector = snapshotStateVectors.get(3)
    assert(oldestRetainedSnapshot)
    assert(oldestRetainedStateVector)
    const restoredBucket = new FakeR2Bucket()
    restoredBucket.set('snapshots/vault-1/meta/3.yupdate', oldestRetainedSnapshot)
    const existingDoc = storage.sql.docs.get('meta')
    assert(existingDoc)
    storage.sql.docs.set('meta', {
      ...existingDoc,
      latestSnapshotSeq: 3,
      latestSnapshotKey: 'snapshots/vault-1/meta/3.yupdate',
      minRetainedSeq: 3,
      horizonStateVector: oldestRetainedStateVector,
    })
    const restoredRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(restoredBucket, TEST_DEVICE_TOKEN_SECRET),
    )
    await restoredRoom.fetch(await makeAuthenticatedWebSocketRequest())
    const restoredServer = (restoredRoom.state.getWebSockets?.() ?? [])[0]
    assert(restoredServer instanceof FakeSocket)
    const oldestSnapshotDoc = new Y.Doc()
    Y.applyUpdate(oldestSnapshotDoc, oldestRetainedSnapshot)
    await restoredRoom.webSocketMessage(restoredServer, JSON.stringify(makeHello()))
    await restoredRoom.webSocketMessage(
      restoredServer,
      JSON.stringify(
        makeSyncRequest(
          makeMessageId('message-orphan-retention-residual'),
          makeStateVectorBase64(oldestSnapshotDoc),
        ),
      ),
    )
    const residualMessage = syncMessages(restoredServer.sent).at(-1)
    assert(typeof residualMessage === 'string')
    const residualUpdate = JSON.parse(residualMessage) as SyncUpdate
    const restoredDoc = new Y.Doc()
    Y.applyUpdate(restoredDoc, oldestRetainedSnapshot)
    Y.applyUpdate(restoredDoc, decodeTestBase64(residualUpdate.update))
    const expectedDoc = new Y.Doc()
    Y.applyUpdate(expectedDoc, expectedFinalUpdate)
    assert.deepEqual(Y.encodeStateAsUpdate(restoredDoc), Y.encodeStateAsUpdate(expectedDoc))
    oldestSnapshotDoc.destroy()
    restoredDoc.destroy()
    expectedDoc.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom honors an operator-configured minimum generation count during retention cleanup', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const cumulativeDoc = new Y.Doc()
  const snapshotStateVectors = new Map<number, Uint8Array>()
  for (const seq of [1, 2, 3, 4, 5]) {
    const updateBytes = makeYjsUpdateBytes(makeMessageId(`message-min-generations-${seq}`))
    Y.applyUpdate(cumulativeDoc, updateBytes)
    const snapshotBytes = Y.encodeStateAsUpdate(cumulativeDoc)
    const stateVector = Y.encodeStateVector(cumulativeDoc)
    bucket.set(`snapshots/vault-1/meta/${seq}.yupdate`, snapshotBytes)
    await seedVerifiedSnapshotEvidence(
      storage,
      `snapshots/vault-1/meta/${seq}.yupdate`,
      'meta',
      snapshotBytes,
    )
    snapshotStateVectors.set(seq, stateVector)
    storage.sql.opLog.set(`meta:message-min-generations-${seq}`, {
      docId: 'meta',
      seq,
      messageId: `message-min-generations-${seq}`,
      deviceId: 'device-1',
      updateBytes,
      updateSha256: 'sha',
      createdAt: seq,
    })
    storage.sql.checkpointRuns.set(`seed-min-generations-${seq}`, {
      runId: `seed-min-generations-${seq}`,
      docId: 'meta',
      upperSeq: seq,
      snapshotKey: `snapshots/vault-1/meta/${seq}.yupdate`,
      stateVector,
      status: 'compacted',
      createdAt: seq,
      r2WrittenAt: seq,
      pointerUpdatedAt: seq,
      compactedAt: seq,
    })
  }
  cumulativeDoc.destroy()
  const snapshotStateVector = snapshotStateVectors.get(5)
  assert(snapshotStateVector)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 5,
    latestSnapshotSeq: 5,
    latestSnapshotKey: 'snapshots/vault-1/meta/5.yupdate',
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.checkpointRuns.set('run-min-generations', {
    runId: 'run-min-generations',
    docId: 'meta',
    upperSeq: 5,
    snapshotKey: 'snapshots/vault-1/meta/5.yupdate',
    stateVector: snapshotStateVector,
    status: 'pointer-updated',
    createdAt: 1,
    r2WrittenAt: 2,
    pointerUpdatedAt: 3,
    compactedAt: undefined,
  })
  await storage.put('vault:id', 'vault-1')
  const room = new VaultRoom(new FakeState(storage), {
    ...makeEnvWithSnapshotBucket(bucket),
    SNAPSHOT_RETENTION_MIN_GENERATIONS: '1',
  })

  await room.alarm()

  // The hardcoded default (3, see the sibling "applies the retained snapshot
  // floor" test) would only delete generations 1 and 2. Overriding to 1 keeps
  // just the newest generation.
  assert.deepEqual(bucket.deletes, [
    'snapshots/vault-1/meta/1.yupdate',
    'snapshots/vault-1/meta/2.yupdate',
    'snapshots/vault-1/meta/3.yupdate',
    'snapshots/vault-1/meta/4.yupdate',
  ])
})
