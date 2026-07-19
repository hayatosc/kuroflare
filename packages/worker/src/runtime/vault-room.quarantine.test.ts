import {
  ApiErrorSchema,
  QuarantinedUpdateDetailResponseSchema,
  QuarantinedUpdateListResponseSchema,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeYDocId,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../runtime'
import { ensureDocHydrated } from '../runtime/document-hydration'
import { metaYDocSchemaDisposition } from '../runtime/yjs-validation'
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
  SqlOnlyStorage,
  makeSyncUpdate,
  makeHello,
  syncMessages,
  hashTestBytes,
  makeInvalidMetaSchemaYjsUpdateBase64,
  makeYjsUpdateBase64,
  makeAuthenticatedWebSocketRequest,
  decodeTestBase64,
  stringMessageAt,
} from './test-helpers'
import { makePoisonedMetaDoc } from './test-helpers/yjs-fixtures'

test('VaultRoom quarantines a live delta with a missing predecessor without appending it', async () => {
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

    const docId = { kind: 'file', ydocId: makeYDocId('causal-live-file') } as const
    await ensureDocHydrated(room, docId)
    const source = new Y.Doc()
    source.getText('body').insert(0, 'base')
    const baseStateVector = Y.encodeStateVector(source)
    source.getText('body').insert(4, ' delta')
    const delta = Y.encodeStateAsUpdate(source, baseStateVector)
    const update = {
      ...makeSyncUpdate(makeMessageId('message-causal-live-delta')),
      docId,
      update: Buffer.from(delta).toString('base64'),
    } satisfies SyncUpdate

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await room.webSocketMessage(server, JSON.stringify(update))
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert(
      events.some(
        (event) =>
          event.event === 'quarantine' &&
          event.reason === 'yjs-apply-failed' &&
          typeof event.quarantineId === 'string',
      ),
    )
    assert.equal(storage.sql.opLog.has('file:causal-live-file:message-causal-live-delta'), false)
    assert.equal(
      storage.sql.messageDedup.has('file:causal-live-file:message-causal-live-delta'),
      false,
    )
    assert.equal(server.closeCode, undefined)
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'yjs-apply-failed',
      retryable: false,
    })
    assert.equal(syncMessages(server.sent).length, 1)
    source.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines live v1-to-v2 migration updates instead of appending them', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const fileId = makeFileId('live-v1-root')
    const legacy = new Y.Doc()
    legacy.getMap('meta').set(fileId, {
      schemaVersion: 1,
      fileId,
      path: 'Notes/Legacy.md',
      canonicalPath: 'notes/legacy.md',
      type: 'text',
      ydocId: makeYDocId('live-v1-doc'),
      deleted: false,
      createdAt: 1,
      createdBy: makeDeviceId('device-1'),
      contentUpdatedAt: 1,
      contentUpdatedBy: makeDeviceId('device-1'),
      updatedAt: 1,
      updatedBy: makeDeviceId('device-1'),
      mtime: 1,
    })
    room.docs.set('meta', legacy)
    room.hydratedDocs.add('meta')
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
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))
    const migrated = new Y.Doc()
    Y.applyUpdate(migrated, Y.encodeStateAsUpdate(legacy))
    const child = new Y.Map<unknown>()
    child.set('identity', {
      schemaVersion: 2,
      fileId,
      type: 'text',
      ydocId: makeYDocId('live-v1-doc'),
      createdAt: 1,
      createdBy: makeDeviceId('device-1'),
    })
    child.set('location', {
      path: 'Notes/Legacy.md',
      canonicalPath: 'notes/legacy.md',
      updatedAt: 1,
      updatedBy: makeDeviceId('device-1'),
      mtime: 1,
    })
    child.set('content', { contentUpdatedAt: 1, contentUpdatedBy: makeDeviceId('device-1') })
    child.set('deletion', { deleted: false })
    migrated.getMap('meta').set(fileId, child)
    const update = Y.encodeStateAsUpdate(migrated, Y.encodeStateVector(legacy))
    const message = {
      ...makeSyncUpdate(makeMessageId('live-v1-to-v2')),
      docId: { kind: 'meta' as const },
      update: Buffer.from(update).toString('base64'),
    }
    await room.webSocketMessage(server, JSON.stringify(message))
    assert.equal(storage.sql.opLog.size, 0)
    assert.equal(
      storage.sql.quarantines.get(`q-${message.messageId}`)?.reason,
      'meta-schema-invalid',
    )
    migrated.destroy()
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines live metadata updates when the current document is poisoned', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const poisoned = makePoisonedMetaDoc(makeFileId('poisoned-live-meta'))
    room.docs.set('meta', poisoned)
    room.hydratedDocs.add('meta')
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

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const beforeStateVector = Y.encodeStateVector(poisoned)
    const message = {
      ...makeSyncUpdate(makeMessageId('message-poisoned-live-meta')),
      update: makeYjsUpdateBase64(makeMessageId('poisoned-live-v2-root')),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(message))

    assert.equal(storage.sql.opLog.size, 0)
    assert.equal(storage.sql.messageDedup.size, 0)
    assert.equal(
      storage.sql.quarantines.get(`q-${message.messageId}`)?.reason,
      'meta-schema-invalid',
    )
    assert.deepEqual(Y.encodeStateVector(poisoned), beforeStateVector)
    assert.equal(metaYDocSchemaDisposition(poisoned), 'invalid')
    assert.equal(room.docs.get('meta'), poisoned)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines invalid Yjs updates without acking or broadcasting', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-bad')),
      update: 'AQID',
    } satisfies SyncUpdate
    await room.webSocketMessage(firstServer, JSON.stringify(update))

    assert.deepEqual(JSON.parse(stringMessageAt(firstServer.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'yjs-apply-failed',
      retryable: false,
    })
    assert.equal(syncMessages(firstServer.sent).length, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [])
    const quarantined = storage.sql.quarantines.get('q-message-bad')
    assert(quarantined)
    assert.equal(Number.isSafeInteger(quarantined.createdAt), true)
    assert.deepEqual(quarantined, {
      id: 'q-message-bad',
      docId: 'meta',
      messageId: makeMessageId('message-bad'),
      deviceId: makeDeviceId('device-1'),
      reason: 'yjs-apply-failed',
      updateSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      updateBytes: Uint8Array.from([1, 2, 3]),
      createdAt: quarantined.createdAt,
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines updates with mismatched wire hashes', async () => {
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

    const update = {
      ...makeSyncUpdate(makeMessageId('message-hash-mismatch')),
      updateSha256: makeSha256Hex('0'.repeat(64)),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'hash-mismatch',
      retryable: false,
    })
    assert.equal(syncMessages(server.sent).length, 1)
    assert.equal(storage.sql.opLog.has('meta:message-hash-mismatch'), false)
    assert.equal(storage.sql.quarantines.get('q-message-hash-mismatch')?.reason, 'hash-mismatch')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom treats repeated quarantine inserts as idempotent', async () => {
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

    const update = {
      ...makeSyncUpdate(makeMessageId('message-repeat-bad')),
      update: 'AQID',
    } satisfies SyncUpdate
    const invalidUpdate = JSON.stringify(update)

    await room.webSocketMessage(server, invalidUpdate)
    await room.webSocketMessage(server, invalidUpdate)

    const expectedRejection = {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'yjs-apply-failed',
      retryable: false,
    }
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 0)), expectedRejection)
    assert.deepEqual(JSON.parse(stringMessageAt(server.sent, 1)), expectedRejection)
    assert.equal(syncMessages(server.sent).length, 2)
    assert.equal(server.closed, false)
    assert.equal(storage.sql.quarantines.get('q-message-repeat-bad')?.reason, 'yjs-apply-failed')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom quarantines meta updates that fail MetaFile schema validation', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-bad-meta')),
      update: makeInvalidMetaSchemaYjsUpdateBase64(),
    } satisfies SyncUpdate
    await room.webSocketMessage(firstServer, JSON.stringify(update))

    assert.deepEqual(JSON.parse(stringMessageAt(firstServer.sent, 0)), {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'meta-schema-invalid',
      retryable: false,
    })
    assert.equal(syncMessages(firstServer.sent).length, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [])
    const quarantined = storage.sql.quarantines.get('q-message-bad-meta')
    assert(quarantined)
    assert.equal(quarantined.reason, 'meta-schema-invalid')
    assert.equal(quarantined.docId, 'meta')
    assert.equal(quarantined.messageId, makeMessageId('message-bad-meta'))
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom exposes authenticated quarantine list and detail inspection', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.quarantines.set('q-message-bad', {
    id: 'q-message-bad',
    docId: 'meta',
    messageId: 'message-bad',
    deviceId: 'device-1',
    reason: 'yjs-apply-failed',
    updateSha256: 'a'.repeat(64),
    updateBytes: Uint8Array.from([1, 2, 3]),
    createdAt: 123,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  const listResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(listResponse.status, 200)
  const listBody = await listResponse.json()
  assert.equal(v.is(QuarantinedUpdateListResponseSchema, listBody), true)
  assert.deepEqual(listBody, {
    items: [
      {
        id: 'q-message-bad',
        docId: { kind: 'meta' },
        messageId: 'message-bad',
        deviceId: 'device-1',
        reason: 'yjs-apply-failed',
        updateSha256: 'a'.repeat(64),
        updateBytesLength: 3,
        createdAt: 123,
      },
    ],
  })

  const detailResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-message-bad', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )

  assert.equal(detailResponse.status, 200)
  const detailBody = await detailResponse.json()
  assert.equal(v.is(QuarantinedUpdateDetailResponseSchema, detailBody), true)
  assert.deepEqual(detailBody, {
    entry: listBody.items[0],
    updateBytesBase64: 'AQID',
  })

  const missingResponse = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-missing', {
      headers: {
        Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, {
          tokenVersion: 1,
        })}`,
      },
    }),
  )
  assert.equal(missingResponse.status, 404)
  assert.deepEqual(await missingResponse.json(), {
    code: 'request/not-found',
    retryable: false,
    detail: 'unknown-quarantine',
  })
})

test('GET /admin/quarantine paginates newest-first with a cursor', async () => {
  const storage = new SqlOnlyStorage()
  for (let index = 1; index <= 3; index += 1) {
    storage.sql.quarantines.set(`q-message-${index}`, {
      id: `q-message-${index}`,
      docId: 'meta',
      messageId: `message-${index}`,
      deviceId: 'device-1',
      reason: 'yjs-apply-failed',
      updateSha256: 'a'.repeat(64),
      updateBytes: Uint8Array.from([index]),
      createdAt: index,
    })
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const firstPage = await room.fetch(
    new Request('https://worker.example/admin/quarantine?limit=2', { headers: authHeader }),
  )
  assert.equal(firstPage.status, 200)
  const firstBody = await firstPage.json()
  assert.equal(v.is(QuarantinedUpdateListResponseSchema, firstBody), true)
  assert.deepEqual(
    firstBody.items.map((entry: { id: string }) => entry.id),
    ['q-message-3', 'q-message-2'],
  )
  assert.equal(firstBody.nextCursor, '2:q-message-2')

  const secondPage = await room.fetch(
    new Request(`https://worker.example/admin/quarantine?limit=2&cursor=${firstBody.nextCursor}`, {
      headers: authHeader,
    }),
  )
  assert.equal(secondPage.status, 200)
  const secondBody = await secondPage.json()
  assert.deepEqual(
    secondBody.items.map((entry: { id: string }) => entry.id),
    ['q-message-1'],
  )
  assert.equal(secondBody.nextCursor, undefined)

  const invalidLimit = await room.fetch(
    new Request('https://worker.example/admin/quarantine?limit=0', { headers: authHeader }),
  )
  assert.equal(invalidLimit.status, 400)
  assert.equal(v.is(ApiErrorSchema, await invalidLimit.json()), true)
})

test('POST /admin/quarantine/:id/force-apply merges the update, advances the op log, and records an audit entry', async () => {
  const storage = new SqlOnlyStorage()
  const state = new FakeState(storage)
  const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
  storage.sql.docs.set('file:force-apply-file', {
    kind: 'file',
    latestSeq: 0,
    latestSnapshotSeq: 0,
    latestSnapshotKey: undefined,
    minRetainedSeq: 0,
    horizonStateVector: undefined,
    updatedAt: 1,
  })
  const source = new Y.Doc()
  source.getText('body').insert(0, 'hello')
  const updateBytes = Y.encodeStateAsUpdate(source)
  storage.sql.quarantines.set('q-force-apply', {
    id: 'q-force-apply',
    docId: 'file:force-apply-file',
    messageId: 'message-force-apply',
    deviceId: 'device-2',
    reason: 'yjs-apply-failed',
    updateSha256: 'a'.repeat(64),
    updateBytes,
    createdAt: 100,
  })
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const dryRun = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-force-apply/force-apply', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dry-run' }),
    }),
  )
  assert.equal(dryRun.status, 200)
  const dryRunBody = await dryRun.json()
  assert.equal(dryRunBody.confirmationRequired, true)
  assert.deepEqual(dryRunBody.effects, [
    { kind: 'quarantine-force-apply', count: 1, detail: 'seq=1' },
  ])

  const execute = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-force-apply/force-apply', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', confirmationToken: dryRunBody.confirmationToken }),
    }),
  )
  assert.equal(execute.status, 200)
  const executeBody = await execute.json()
  assert.equal(executeBody.applied, true)
  assert.deepEqual(executeBody.effects, [
    { kind: 'quarantine-force-apply', count: 1, detail: 'seq=1' },
  ])

  assert.equal(storage.sql.quarantines.has('q-force-apply'), false)
  assert.equal(storage.sql.docs.get('file:force-apply-file')?.latestSeq, 1)
  assert.equal(storage.sql.opLog.has('file:force-apply-file:message-force-apply'), true)
  assert.equal(storage.sql.messageDedup.has('file:force-apply-file:message-force-apply'), true)
  assert.equal(room.docs.get('file:force-apply-file')?.getText('body').toJSON(), 'hello')
  assert.equal(storage.sql.quarantineAuditEvents.length, 1)
  const auditEvent = storage.sql.quarantineAuditEvents[0]
  assert(auditEvent !== undefined)
  assert.deepEqual(auditEvent, {
    id: 1,
    quarantineId: 'q-force-apply',
    docId: 'file:force-apply-file',
    messageId: 'message-force-apply',
    deviceId: 'device-2',
    reason: 'yjs-apply-failed',
    action: 'force-applied-by-admin',
    actor: 'device-1',
    appliedSeq: 1,
    quarantinedAt: 100,
    resolvedAt: auditEvent.resolvedAt,
  })

  // The confirmation token is single-use; replaying it must fail closed.
  const replay = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-force-apply/force-apply', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', confirmationToken: dryRunBody.confirmationToken }),
    }),
  )
  assert.equal(replay.status, 404)
  source.destroy()
})

test('POST /admin/quarantine/:id/discard removes the row and records an audit entry without touching the op log', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.quarantines.set('q-discard', {
    id: 'q-discard',
    docId: 'meta',
    messageId: 'message-discard',
    deviceId: 'device-2',
    reason: 'hash-mismatch',
    updateSha256: 'a'.repeat(64),
    updateBytes: Uint8Array.from([9]),
    createdAt: 200,
  })
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const dryRun = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-discard/discard', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dry-run' }),
    }),
  )
  assert.equal(dryRun.status, 200)
  const dryRunBody = await dryRun.json()

  const execute = await room.fetch(
    new Request('https://worker.example/admin/quarantine/q-discard/discard', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', confirmationToken: dryRunBody.confirmationToken }),
    }),
  )
  assert.equal(execute.status, 200)

  assert.equal(storage.sql.quarantines.has('q-discard'), false)
  assert.equal(storage.sql.opLog.size, 0)
  assert.equal(storage.sql.quarantineAuditEvents.length, 1)
  assert.equal(storage.sql.quarantineAuditEvents[0]?.action, 'discarded-by-admin')
  assert.equal(storage.sql.quarantineAuditEvents[0]?.actor, 'device-1')
  assert.equal(storage.sql.quarantineAuditEvents[0]?.appliedSeq, undefined)
})

test('GET /admin/quarantine/audit paginates the resolved-quarantine trail newest-first', async () => {
  const storage = new SqlOnlyStorage()
  for (let index = 1; index <= 3; index += 1) {
    storage.sql.quarantineAuditEvents.push({
      id: index,
      quarantineId: `q-${index}`,
      docId: 'meta',
      messageId: `message-${index}`,
      deviceId: 'device-2',
      reason: 'hash-mismatch',
      action: 'discarded-by-admin',
      actor: 'device-1',
      appliedSeq: undefined,
      quarantinedAt: index,
      resolvedAt: index + 100,
    })
  }
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )
  const authHeader = {
    Authorization: `Bearer ${await makeDeviceToken(TEST_DEVICE_TOKEN_SECRET, { tokenVersion: 1 })}`,
  }

  const firstPage = await room.fetch(
    new Request('https://worker.example/admin/quarantine/audit?limit=2', { headers: authHeader }),
  )
  assert.equal(firstPage.status, 200)
  const firstBody = await firstPage.json()
  assert.deepEqual(
    firstBody.items.map((entry: { quarantineId: string }) => entry.quarantineId),
    ['q-3', 'q-2'],
  )
  assert.equal(firstBody.nextCursor, '2')

  const secondPage = await room.fetch(
    new Request(
      `https://worker.example/admin/quarantine/audit?limit=2&cursor=${firstBody.nextCursor}`,
      { headers: authHeader },
    ),
  )
  assert.equal(secondPage.status, 200)
  const secondBody = await secondPage.json()
  assert.deepEqual(
    secondBody.items.map((entry: { quarantineId: string }) => entry.quarantineId),
    ['q-1'],
  )
  assert.equal(secondBody.nextCursor, undefined)
})
