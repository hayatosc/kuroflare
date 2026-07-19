import { makeMessageId, makeVaultId, makeYDocId } from '@kuroflare/core'
import { assert, test } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../../runtime'
import { ensureDocHydrated } from '../../runtime/documents'
import { encodeBase64 } from '../../runtime/utils'
import {
  TEST_DEVICE_TOKEN_SECRET,
  FakeSocket,
  FakeState,
  installFakeWebSocketPair,
  installFakeUpgradeResponse,
  restoreWebSocketPair,
  restoreResponse,
  makeDeviceToken,
  makeEnvWithSnapshotBucket,
  makeEnvWithSnapshotBucketAndDeviceTokenSecret,
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  hashTestBytes,
  makeAuthenticatedWebSocketRequest,
  makeYjsUpdateBytes,
  FakeR2Bucket,
} from '../support'
import { seedVerifiedSnapshotEvidence } from '../support'

test('VaultRoom seeds an admin snapshot and records verified evidence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(new FakeState(storage), makeEnvWithSnapshotBucket(bucket))
  const update = makeYjsUpdateBytes(makeMessageId('message-admin-snapshot-seed'))
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vaultId: makeVaultId('vault-1'),
        docId: { kind: 'meta' },
        latestSeq: 3,
        update: encodeBase64(update),
      }),
    }),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    vaultId: makeVaultId('vault-1'),
    docId: { kind: 'meta' },
    snapshotKey: 'snapshots/vault-1/meta/3.yupdate',
  })
  assert.deepEqual(bucket.puts, ['snapshots/vault-1/meta/3.yupdate'])
  assert.equal(storage.sql.docs.get('meta')?.latestSeq, 3)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, 'snapshots/vault-1/meta/3.yupdate')
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.physicalStatus, 'verified')
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
})

test('legacy snapshot verification is explicit and the last healthy generation cannot be quarantined', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-legacy-health')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-health-snapshot'))
  bucket.set(snapshotKey, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  let hydrateFailed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    hydrateFailed =
      error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(hydrateFailed, true)

  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const mismatchedRoute = await room.fetch(
    new Request('https://worker.example/admin/snapshots/wrong-doc/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'route mismatch must be rejected',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(mismatchedRoute.status, 400)
  const verifyResponse = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Approve current legacy bytes after operator inspection',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(verifyResponse.status, 200)
  const verifyBody = (await verifyResponse.json()) as {
    readonly entry: { readonly actor: string }
  }
  assert.equal(verifyBody.entry.actor, 'device-1')
  await ensureDocHydrated(room, docId)
  assert(room.docs.get(`file:${ydocId}`))

  const quarantineResponse = await room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        actor: 'spoofed-request-actor',
        reason: 'Operator quarantined generation for inspection',
        confirmation: 'quarantine',
      }),
    }),
  )
  assert.equal(quarantineResponse.status, 409)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
  room.docs.get(`file:${ydocId}`)?.destroy()
  room.docs.delete(`file:${ydocId}`)
  room.hydratedDocs.delete(`file:${ydocId}`)
  hydrateFailed = false
  try {
    await ensureDocHydrated(room, docId)
  } catch (error) {
    hydrateFailed =
      error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(hydrateFailed, false)
})

test('snapshot health inspection paginates newest generations in descending order', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-pagination')
  for (const seq of [1, 2, 3]) {
    const key = `snapshots/vault-1/files/${ydocId}/${seq}.yupdate`
    const bytes = makeYjsUpdateBytes(makeMessageId(`health-pagination-${seq}`))
    bucket.set(key, bytes)
    await seedVerifiedSnapshotEvidence(storage, key, `file:${ydocId}`, bytes)
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const unauthenticated = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=1`),
  )
  assert.equal(unauthenticated.status, 401)
  const first = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(first.status, 200)
  const firstBody = (await first.json()) as {
    entries: readonly [{ actor: string; upperSeq: number }]
    nextCursor: string
  }
  assert.equal(firstBody.entries[0]?.upperSeq, 3)
  assert.equal(firstBody.entries[0]?.actor, 'system:verifier')
  const second = await room.fetch(
    new Request(
      `https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=1&cursor=${firstBody.nextCursor}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
  )
  assert.equal(second.status, 200)
  const secondBody = (await second.json()) as { entries: readonly [{ upperSeq: number }] }
  assert.equal(secondBody.entries[0]?.upperSeq, 2)
})

test('snapshot health verify rejects out-of-range and incomplete-run generations', async () => {
  const cases = [
    { name: 'future', latestSeq: 1, minRetainedSeq: 0, upperSeq: 2, status: undefined },
    { name: 'below-floor', latestSeq: 3, minRetainedSeq: 2, upperSeq: 1, status: undefined },
    { name: 'r2-written', latestSeq: 2, minRetainedSeq: 0, upperSeq: 2, status: 'r2-written' },
    { name: 'failed-run', latestSeq: 2, minRetainedSeq: 0, upperSeq: 2, status: 'failed' },
  ] as const
  for (const testCase of cases) {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId(`ydoc-verify-${testCase.name}`)
    const docId = { kind: 'file' as const, ydocId }
    const snapshotKey = `snapshots/vault-1/files/${ydocId}/${testCase.upperSeq}.yupdate`
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId(`verify-${testCase.name}`))
    bucket.set(snapshotKey, snapshotBytes)
    storage.sql.docs.set(`file:${ydocId}`, {
      kind: 'file',
      latestSeq: testCase.latestSeq,
      latestSnapshotSeq: 0,
      latestSnapshotKey: undefined,
      minRetainedSeq: testCase.minRetainedSeq,
      horizonStateVector: undefined,
      updatedAt: 1,
    })
    if (testCase.status !== undefined) {
      storage.sql.checkpointRuns.set(`verify-${testCase.name}`, {
        runId: `verify-${testCase.name}`,
        docId: `file:${ydocId}`,
        upperSeq: testCase.upperSeq,
        snapshotKey,
        stateVector: new Uint8Array(),
        status: testCase.status,
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
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          docId,
          snapshotKey,
          upperSeq: testCase.upperSeq,
          reason: 'Reject unverifiable authority transitions',
          confirmation: 'verify',
        }),
      }),
    )
    assert.equal(response.status, 409, testCase.name)
    assert.equal(storage.sql.snapshotHealthEvents.length, 0, testCase.name)
  }
})

test('snapshot health list keeps latest rows after high-volume audit history', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-high-volume')
  const key1 = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const key2 = `snapshots/vault-1/files/${ydocId}/2.yupdate`
  const bytes1 = makeYjsUpdateBytes(makeMessageId('health-high-volume-1'))
  const bytes2 = makeYjsUpdateBytes(makeMessageId('health-high-volume-2'))
  bucket.set(key1, bytes1)
  bucket.set(key2, bytes2)
  await seedVerifiedSnapshotEvidence(storage, key1, `file:${ydocId}`, bytes1)
  await seedVerifiedSnapshotEvidence(storage, key2, `file:${ydocId}`, bytes2)
  const latest = storage.sql.snapshotHealthEvents.at(-1)
  assert(latest)
  for (let index = 0; index < 8_300; index += 1) {
    storage.sql.snapshotHealthEvents.push({
      ...latest,
      id: storage.sql.snapshotHealthEvents.length + 1,
      snapshotKey: key2,
      upperSeq: 2,
      event: 'verification',
      observedAt: index + 2,
    })
  }
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 2,
    latestSnapshotKey: key2,
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
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}&limit=2`, {
      headers: { Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}` },
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly entries: readonly { snapshotKey: string; upperSeq: number }[]
  }
  assert.deepEqual(
    body.entries.map((entry) => entry.snapshotKey),
    [key2, key1],
  )
  assert.equal(body.entries[0]?.upperSeq, 2)
})

test('snapshot health list normalizes legacy zero-seq orphan rows from key and run evidence', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-legacy-orphan')
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/4.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('health-legacy-orphan'))
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  const legacy = storage.sql.snapshotHealthEvents.at(-1)
  assert(legacy)
  storage.sql.snapshotHealthEvents[storage.sql.snapshotHealthEvents.length - 1] = {
    ...legacy,
    upperSeq: 0,
  }
  storage.sql.checkpointRuns.set('legacy-orphan-run', {
    runId: 'legacy-orphan-run',
    docId: `file:${ydocId}`,
    upperSeq: 4,
    snapshotKey,
    stateVector: new Uint8Array(),
    status: 'completed',
    createdAt: 1,
    r2WrittenAt: 1,
    pointerUpdatedAt: 1,
    compactedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}`, {
      headers: { Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}` },
    }),
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    readonly entries: readonly { upperSeq: number }[]
  }
  assert.equal(body.entries[0]?.upperSeq, 4)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.upperSeq, 4)
})

test('snapshot health verify rejects an untracked legacy generation without a checkpoint run', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-legacy-no-run')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-legacy-no-run'))
  bucket.set(snapshotKey, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Approve a legacy generation within the replay horizon',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 409)
  assert.equal(storage.sql.snapshotHealthEvents.length, 0)
})

test('snapshot health verify preserves live op-log state for an untracked legacy object', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-legacy-oplog')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-legacy-oplog-object'))
  const liveUpdate = makeYjsUpdateBytes(makeMessageId('verify-legacy-oplog-live'))
  bucket.set(snapshotKey, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  storage.sql.opLog.set(`file:${ydocId}:verify-legacy-oplog-live`, {
    docId: `file:${ydocId}`,
    seq: 1,
    messageId: 'verify-legacy-oplog-live',
    deviceId: 'device-1',
    updateBytes: liveUpdate,
    updateSha256: await hashTestBytes(liveUpdate),
    createdAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Untracked bytes cannot replace the live op-log boundary',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 409)
  assert.equal(storage.sql.snapshotHealthEvents.length, 0)

  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const hydrated = coldRoom.docs.get(`file:${ydocId}`)
  assert(hydrated)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, liveUpdate)
  assert.deepEqual(Y.encodeStateAsUpdate(hydrated), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('snapshot health verify recovers an R2-only generation into a cold room', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-r2-only')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/7.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-r2-only'))
  bucket.set(snapshotKey, snapshotBytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const coldBeforeVerify = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldBeforeVerify.vaultId = makeVaultId('vault-1')
  let coldHydrationFailed = false
  try {
    await ensureDocHydrated(coldBeforeVerify, docId)
  } catch (error) {
    coldHydrationFailed =
      error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(coldHydrationFailed, true)
  assert.equal(coldBeforeVerify.hydratedDocs.has(`file:${ydocId}`), false)
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const list = await room.fetch(
    new Request(`https://worker.example/admin/snapshots?docId=file:${ydocId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  assert.equal(list.status, 200)
  room.docs.set(`file:${ydocId}`, new Y.Doc())
  room.hydratedDocs.add(`file:${ydocId}`)
  const verify = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 7,
        reason: 'Recover a verified R2-only generation',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(verify.status, 200)
  assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, snapshotKey)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.actor, 'device-1')
  const recoveredInRoom = room.docs.get(`file:${ydocId}`)
  assert(recoveredInRoom)
  const recoveredExpected = new Y.Doc()
  Y.applyUpdate(recoveredExpected, snapshotBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(recoveredInRoom), Y.encodeStateAsUpdate(recoveredExpected))
  recoveredExpected.destroy()
  const eventCountAfterVerify = storage.sql.snapshotHealthEvents.length
  const repeatedVerify = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 7,
        reason: 'Repeated approval is idempotent',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(repeatedVerify.status, 200)
  assert.equal(storage.sql.snapshotHealthEvents.length, eventCountAfterVerify)

  const coldRoom = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  coldRoom.vaultId = makeVaultId('vault-1')
  await ensureDocHydrated(coldRoom, docId)
  const hydrated = coldRoom.docs.get(`file:${ydocId}`)
  assert(hydrated)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, snapshotBytes)
  assert.deepEqual(Y.encodeStateAsUpdate(hydrated), Y.encodeStateAsUpdate(expected))
  expected.destroy()
})

test('snapshot health verify fails closed for a concurrent first append during pending recovery', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const ydocId = makeYDocId('ydoc-verify-concurrent-append')
    const docId = { kind: 'file' as const, ydocId }
    const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-concurrent-snapshot'))
    bucket.set(snapshotKey, snapshotBytes)
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

    let releaseVerification: () => void = () => {}
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve
    })
    let verificationStarted: () => void = () => {}
    const verificationStartedPromise = new Promise<void>((resolve) => {
      verificationStarted = resolve
    })
    bucket.beforeGet = async (key) => {
      if (key !== snapshotKey) return
      verificationStarted()
      await verificationGate
      bucket.beforeGet = undefined
    }
    const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
    const verifyRequest = room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'Concurrent append must remain durable',
          confirmation: 'verify',
        }),
      }),
    )
    await verificationStartedPromise
    const appendUpdate = { ...makeSyncUpdate(makeMessageId('verify-concurrent-append')), docId }
    await room.webSocketMessage(server, JSON.stringify(appendUpdate))
    assert.equal(server.closed, true)
    assert.equal(storage.sql.docs.has(`file:${ydocId}`), false)
    releaseVerification()
    const verifyResponse = await verifyRequest
    assert.equal(verifyResponse.status, 200)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSeq, 1)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotSeq, 1)
    assert.equal(storage.sql.docs.get(`file:${ydocId}`)?.latestSnapshotKey, snapshotKey)
    assert.equal(storage.sql.opLog.get(`file:${ydocId}:${appendUpdate.messageId}`), undefined)
    assert.equal(
      storage.sql.snapshotHealthEvents.some((event) => event.event === 'approval'),
      true,
    )
    const coldRoom = new VaultRoom(
      new FakeState(storage),
      makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
    )
    coldRoom.vaultId = makeVaultId('vault-1')
    await ensureDocHydrated(coldRoom, docId)
    const cold = coldRoom.docs.get(`file:${ydocId}`)
    assert(cold)
    const expected = new Y.Doc()
    Y.applyUpdate(expected, snapshotBytes)
    assert.deepEqual(Y.encodeStateAsUpdate(cold), Y.encodeStateAsUpdate(expected))
    expected.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('snapshot health verify rejects when quarantine commits during the pending read', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-quarantine-pending')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  bucket.set(snapshotKey, makeYjsUpdateBytes(makeMessageId('verify-quarantine-pending')))
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  let releaseVerification: () => void = () => {}
  const verificationGate = new Promise<void>((resolve) => {
    releaseVerification = resolve
  })
  let verificationStarted: () => void = () => {}
  const verificationStartedPromise = new Promise<void>((resolve) => {
    verificationStarted = resolve
  })
  bucket.beforeGet = async (key) => {
    if (key !== snapshotKey) return
    verificationStarted()
    await verificationGate
    bucket.beforeGet = undefined
  }
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const verifyRequest = room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Quarantine must win while verification is reading R2',
        confirmation: 'verify',
      }),
    }),
  )
  await verificationStartedPromise
  const quarantineRequest = room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Operator quarantine during pending verification',
        confirmation: 'quarantine',
      }),
    }),
  )
  releaseVerification()
  const [verifyResponse, quarantineResponse] = await Promise.all([
    Promise.resolve(verifyRequest),
    Promise.resolve(quarantineRequest),
  ])
  assert.equal(quarantineResponse.status, 200)
  assert.equal(verifyResponse.status, 409)
  assert.deepEqual(await verifyResponse.json(), {
    code: 'request/conflict',
    retryable: false,
    detail: 'snapshot-health-quarantined',
  })
  assert.equal(storage.sql.docs.has(`file:${ydocId}`), false)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'quarantined')
  assert.equal(
    storage.sql.snapshotHealthEvents.some((event) => event.event === 'approval'),
    false,
  )
})

test('health quarantine is idempotently blocked for the last healthy generation', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-history-latest')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const bytes = makeYjsUpdateBytes(makeMessageId('health-history-latest'))
  bucket.set(snapshotKey, bytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, bytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const seed = storage.sql.snapshotHealthEvents.at(-1)
  assert(seed)
  for (let index = 0; index < 260; index += 1) {
    storage.sql.snapshotHealthEvents.push({
      ...seed,
      id: storage.sql.snapshotHealthEvents.length + 1,
      event: 'verification',
      observedAt: index + 2,
    })
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const quarantineResponse = await room.fetch(
    new Request('https://worker.example/admin/snapshots/quarantine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'latest audit verdict must win',
        confirmation: 'quarantine',
      }),
    }),
  )
  assert.equal(quarantineResponse.status, 409)
  await ensureDocHydrated(room, docId)
  assert(room.docs.get(`file:${ydocId}`))
})

test('snapshot health verify is idempotent for an already authoritative generation', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-verify-quarantine-race')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('verify-quarantine-race'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  const eventCount = storage.sql.snapshotHealthEvents.length

  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        docId,
        snapshotKey,
        upperSeq: 1,
        reason: 'Do not approve after quarantine wins',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(storage.sql.snapshotHealthEvents.length, eventCount)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
})

test('legacy snapshot approval records state-vector run evidence for compaction', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const bucket = new FakeR2Bucket()
    const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
    const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-run-evidence'))
    const snapshotDoc = new Y.Doc()
    Y.applyUpdate(snapshotDoc, snapshotBytes)
    const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
    snapshotDoc.destroy()
    bucket.set(snapshotKey, snapshotBytes)
    storage.sql.docs.set('meta', {
      kind: 'meta',
      latestSeq: 1,
      latestSnapshotSeq: 1,
      latestSnapshotKey: snapshotKey,
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
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: { kind: 'meta' },
          snapshotKey,
          upperSeq: 1,
          reason: 'Record durable state-vector evidence',
          confirmation: 'verify',
        }),
      }),
    )
    assert.equal(response.status, 200)
    const run = [...storage.sql.checkpointRuns.values()].find(
      (candidate) => candidate.snapshotKey === snapshotKey,
    )
    assert(run)
    assert.equal(run.status, 'completed')
    assert.deepEqual(run.stateVector, snapshotStateVector)

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = (room.state.getWebSockets?.() ?? [])[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('legacy-run-evidence-tail'))),
    )
    const checkpoint = await room.checkpointDoc({ kind: 'meta' }, 100)
    assert.equal(checkpoint.action, 'checkpointed')
    if (checkpoint.action !== 'checkpointed') throw new Error('checkpoint did not complete')
    assert.equal(checkpoint.compactedSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.minRetainedSeq, 1)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('authoritative snapshot verification backfills one missing run idempotently', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-backfill-run'))
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, snapshotBytes)
  const snapshotStateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
  storage.sql.docs.set('meta', {
    kind: 'meta',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    latestStateVector: snapshotStateVector,
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
  const request = async (): Promise<Response> =>
    await room.fetch(
      new Request('https://worker.example/admin/snapshots/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: { kind: 'meta' },
          snapshotKey,
          upperSeq: 1,
          reason: 'Backfill the missing checkpoint evidence',
          confirmation: 'verify',
        }),
      }),
    )

  assert.equal((await request()).status, 200)
  const eventCount = storage.sql.checkpointRuns.size
  assert.equal(eventCount, 1)
  assert.equal((await request()).status, 200)
  assert.equal(storage.sql.checkpointRuns.size, eventCount)
  assert.deepEqual([...storage.sql.checkpointRuns.values()][0]?.stateVector, snapshotStateVector)
})

test('authoritative health evidence without a document uses the full recovery path', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const snapshotKey = 'snapshots/vault-1/meta/1.yupdate'
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('legacy-orphan-recovery'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, 'meta', snapshotBytes)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const response = await room.fetch(
    new Request('https://worker.example/admin/snapshots/verify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        docId: { kind: 'meta' },
        snapshotKey,
        upperSeq: 1,
        reason: 'Recover the durable document pointer',
        confirmation: 'verify',
      }),
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(storage.sql.docs.get('meta')?.latestSnapshotKey, snapshotKey)
  assert.equal(room.hydratedDocs.has('meta'), true)
  assert.equal(
    [...storage.sql.checkpointRuns.values()].some(
      (run) => run.snapshotKey === snapshotKey && run.status === 'completed',
    ),
    true,
  )
})
test('hydration rejects an authoritative candidate below the retained floor', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-below-retained-floor')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const snapshotBytes = makeYjsUpdateBytes(makeMessageId('below-retained-floor'))
  bucket.set(snapshotKey, snapshotBytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, snapshotBytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 2,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 2,
    horizonStateVector: undefined,
    updatedAt: 1,
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
    failed = error instanceof Error && error.message === 'snapshot-health:no-verified-generation'
  }
  assert.equal(failed, true)
})

test('hydration preserves the last healthy generation when quarantine races R2 verification', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const ydocId = makeYDocId('ydoc-health-quarantine-race')
  const docId = { kind: 'file' as const, ydocId }
  const snapshotKey = `snapshots/vault-1/files/${ydocId}/1.yupdate`
  const bytes = makeYjsUpdateBytes(makeMessageId('health-quarantine-race'))
  bucket.set(snapshotKey, bytes)
  await seedVerifiedSnapshotEvidence(storage, snapshotKey, `file:${ydocId}`, bytes)
  storage.sql.docs.set(`file:${ydocId}`, {
    kind: 'file',
    latestSeq: 1,
    latestSnapshotSeq: 1,
    latestSnapshotKey: snapshotKey,
    minRetainedSeq: 1,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const token = await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET)
  let quarantined = false
  bucket.beforeGet = async (key) => {
    if (key !== snapshotKey || quarantined) return
    quarantined = true
    const response = await room.fetch(
      new Request('https://worker.example/admin/snapshots/quarantine', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          docId,
          snapshotKey,
          upperSeq: 1,
          reason: 'quarantine raced physical verification',
          confirmation: 'quarantine',
        }),
      }),
    )
    assert.equal(response.status, 409)
  }
  await ensureDocHydrated(room, docId)
  assert.equal(storage.sql.snapshotHealthEvents.at(-1)?.logicalStatus, 'healthy')
})
