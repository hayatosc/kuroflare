import {
  CURRENT_PROTOCOL_VERSION,
  decodeBinaryFrame,
  encodeBinaryFrame,
  makeDeviceId,
  makeFileId,
  makeMessageId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  groupedEntryFromMetaFile,
  type Ack,
  type NeedFullSnapshot,
  type SyncUpdate,
} from '@kuroflare/core'
import { assert, expect, test, vi } from 'vitest'
import * as Y from 'yjs'

import { VaultRoom } from '../../runtime'
import { MAX_HYDRATED_FILE_DOCS } from '../../runtime/constants'
import { ensureDocHydrated } from '../../runtime/documents'
import { ensureSchema } from '../../runtime/storage'
import { metaIdentityImmutable, metaRootMutationAllowed, metaYDocWritable } from '../../sync/yjs'
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
  syncMessages,
  hashTestBytes,
  makeYjsUpdateBase64,
  makeAuthenticatedWebSocketRequest,
  makeAwarenessUpdate,
  makeSyncRequest,
  makeLargeFileYjsUpdateBase64,
  makeYjsUpdateBytes,
  makeStateVectorBase64,
  decodeTestBase64,
  FakeR2Bucket,
  stringMessageAt,
  findAckForMessage,
  makeArrayBuffer,
} from '../support'

test('VaultRoom appends JSON sync updates, acks the sender, and broadcasts to peers', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    const unauthenticatedServer = state.accepted[2]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)
    assert(unauthenticatedServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-1'))
    const updateJson = JSON.stringify(update)

    await room.webSocketMessage(firstServer, updateJson)

    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected ack string')
    }
    assert.deepEqual(JSON.parse(ack) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])

    await room.webSocketMessage(firstServer, updateJson)

    const duplicateAck = stringMessageAt(firstServer.sent, 1)
    if (typeof duplicateAck !== 'string') {
      throw new Error('expected duplicate ack string')
    }
    assert.deepEqual(JSON.parse(duplicateAck) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-1'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom broadcasts awareness updates to other vault peers without persisting them', async () => {
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

    const update = makeAwarenessUpdate(1, { cursor: { anchor: 0, head: 0 } })
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.deepEqual(syncMessages(sender.sent), [])
    assert.deepEqual(syncMessages(peer.sent), [JSON.stringify(update)])
    assert.equal(storage.sql.docs.size, 0)
    assert.equal(storage.sql.opLog.size, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom broadcasts a removal when a socket advertising awareness disconnects', async () => {
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

    const update = makeAwarenessUpdate(1, { cursor: { anchor: 0, head: 0 } })
    await room.webSocketMessage(sender, JSON.stringify(update))
    peer.sent.length = 0

    room.webSocketClose(sender)

    assert.deepEqual(syncMessages(peer.sent), [JSON.stringify({ ...update, state: null })])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom silently drops an oversized awareness update without closing the session', async () => {
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

    const oversized = makeAwarenessUpdate(1, { blob: 'x'.repeat(5_000) })
    await room.webSocketMessage(sender, JSON.stringify(oversized))

    assert.equal(sender.closed, false)
    assert.deepEqual(syncMessages(peer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom persists JSON sync updates through Durable Object SQL storage', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const request = await makeAuthenticatedWebSocketRequest()

    void room.fetch(request)
    void room.fetch(request)

    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const peerSend = secondServer.send.bind(secondServer)
    secondServer.send = (message) => {
      assert(storage.sql.queries.includes('transaction commit'))
      peerSend(message)
    }

    const update = makeSyncUpdate(makeMessageId('message-sql'))
    const updateJson = JSON.stringify({ ...update, actor: 'spoofed-audit-device' })

    await room.webSocketMessage(firstServer, updateJson)

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.docs.get('meta')?.kind, 'meta')
    assert.equal(storage.sql.opLog.get('meta:message-sql')?.seq, 1)
    assert.equal(storage.sql.opLog.get('meta:message-sql')?.deviceId, 'device-1')
    assert.equal(storage.sql.messageDedup.has('meta:message-sql'), true)
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])

    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected SQL ack string')
    }
    assert.equal((JSON.parse(ack) as Ack).durableSeq, 1)

    await room.webSocketMessage(firstServer, updateJson)

    const duplicateAck = stringMessageAt(firstServer.sent, 1)
    if (typeof duplicateAck !== 'string') {
      throw new Error('expected SQL duplicate ack string')
    }
    assert.equal((JSON.parse(duplicateAck) as Ack).durableSeq, 1)
    assert.deepEqual(syncMessages(secondServer.sent), [
      JSON.stringify({ ...update, durableSeq: 1 }),
    ])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rolls back every append SQL statement failure and retries at the same durable sequence', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    for (const [failureIndex, failureNeedle] of [
      'insert into op_log',
      'insert into docs',
      'insert into message_dedup',
    ].entries()) {
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

      const update = makeSyncUpdate(makeMessageId(`append-failure-${failureIndex}`))
      storage.sql.failAfterQueryIncludes = failureNeedle
      let failure: unknown
      try {
        await room.webSocketMessage(sender, JSON.stringify(update))
      } catch (error) {
        failure = error
      }

      assert(failure instanceof Error)
      assert.equal(storage.sql.opLog.size, 0)
      assert.equal(storage.sql.docs.size, 0)
      assert.equal(storage.sql.messageDedup.size, 0)
      assert.deepEqual(syncMessages(sender.sent), [])
      assert.deepEqual(syncMessages(peer.sent), [])

      storage.sql.failAfterQueryIncludes = undefined
      await room.webSocketMessage(sender, JSON.stringify(update))

      assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
      assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
      assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 1)
      assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 1)
      assert.equal(syncMessages(peer.sent).length, 1)
    }
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom still acks and broadcasts when checkpoint scheduling fails after append', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.setAlarm = async () => {
      throw new Error('injected checkpoint alarm failure')
    }
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

    const update = makeSyncUpdate(makeMessageId('checkpoint-alarm-failure'))
    await room.webSocketMessage(sender, JSON.stringify(update))

    assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
    assert.equal(storage.sql.opLog.get(`meta:${update.messageId}`)?.seq, 1)
    assert.equal(storage.sql.messageDedup.get(`meta:${update.messageId}`)?.durableSeq, 1)
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 1)
    assert.equal(syncMessages(peer.sent).length, 1)

    sender.sent.length = 0
    peer.sent.length = 0
    await room.webSocketMessage(sender, JSON.stringify(update))
    assert.equal(findAckForMessage(sender.sent, update.messageId)?.durableSeq, 1)
    assert.equal(syncMessages(peer.sent).length, 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom applies pending schema migrations once before serving SQL traffic', async () => {
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

    const created = storage.sql.queries.filter((query) =>
      query.includes('create table if not exists devices'),
    )
    assert.equal(created.length, 1)
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])

    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('after-migrate'))),
    )

    const insertedVersions = storage.sql.queries.filter((query) =>
      query.includes('insert into schema_migrations'),
    )
    assert.equal(insertedVersions.length, 6)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('ensureSchema coalesces concurrent cold-start migrations', async () => {
  const storage = new SqlOnlyStorage()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  await Promise.all([ensureSchema(room), ensureSchema(room)])

  assert.equal(room.schemaReady, true)
  assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
  assert.equal(
    storage.sql.queries.filter((query) => query.includes('create table if not exists devices'))
      .length,
    1,
  )
})

test('schema fault injection fires after the fake DDL mutation', () => {
  const storage = new SqlOnlyStorage()
  storage.sql.failAfterQueryIncludes = 'drop table devices'

  expect(() => storage.sql.exec('drop table devices')).toThrow(/injected SQL failure after query/)
  assert.equal(storage.sql.tableColumns.has('devices'), false)
  assert.equal(storage.sql.tableRowCounts.has('devices'), false)
})

test('ensureSchema rolls back every device identity DDL boundary before retrying', async () => {
  const ddlBoundaries = [
    'create table devices__dr007',
    'insert into devices__dr007',
    'drop table devices',
    'alter table devices__dr007 rename to devices',
    'create table op_log__dr007',
    'insert into op_log__dr007',
    'drop table op_log',
    'alter table op_log__dr007 rename to op_log',
    'create index if not exists idx_op_log_doc_seq',
    'create table connected_devices__dr007',
    'insert into connected_devices__dr007',
    'drop table connected_devices',
    'alter table connected_devices__dr007 rename to connected_devices',
    'insert into schema_migrations',
  ] as const
  const legacyColumns = {
    devices: [
      'device_id',
      'y_client_id',
      'token_version',
      'revoked_at',
      'created_at',
      'last_seen_at',
    ],
    op_log: [
      'doc_id',
      'seq',
      'message_id',
      'device_id',
      'y_client_id',
      'update_bytes',
      'update_sha256',
      'created_at',
    ],
    connected_devices: [
      'device_id',
      'y_client_id',
      'last_seen_at',
      'user_agent',
      'protocol_version',
    ],
  } as const
  const legacyColumnDetails = {
    devices: [
      { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'y_client_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'token_version', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
      { cid: 3, name: 'revoked_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 4, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: 'last_seen_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    ],
    op_log: [
      { cid: 0, name: 'doc_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: 'seq', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: 'message_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'device_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: 'y_client_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: 'update_bytes', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 6, name: 'update_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 7, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ],
    connected_devices: [
      { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'y_client_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 2, name: 'last_seen_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'user_agent', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 4, name: 'protocol_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ],
  } as const

  for (const boundary of ddlBoundaries) {
    const storage = new SqlOnlyStorage()
    storage.sql.migrationVersions.add(1)
    storage.sql.migrationVersions.add(2)
    storage.sql.migrationVersions.add(3)
    for (const [table, columns] of Object.entries(legacyColumns)) {
      storage.sql.tableColumns.set(table, columns)
      storage.sql.tableColumnDetails.set(
        table,
        legacyColumnDetails[table as keyof typeof legacyColumnDetails],
      )
      storage.sql.tableRowCounts.set(table, table === 'op_log' ? 2 : 1)
    }
    storage.sql.tableIndexes.set('devices', [
      { name: 'sqlite_autoindex_devices_1', unique: true, columns: ['device_id'] },
      { name: 'sqlite_autoindex_devices_2', unique: true, columns: ['y_client_id'] },
    ])
    storage.sql.tableRows.set('devices', [['device-1', 7, 1, null, 10, 11]])
    storage.sql.tableRows.set('op_log', [
      ['meta', 2, 'message-2', 'device-1', 7, new Uint8Array([2]), 'sha-2', 2],
      ['meta', 1, 'message-1', 'device-1', 7, new Uint8Array([1]), 'sha-1', 1],
    ])
    storage.sql.tableRowCounts.set('op_log', 2)
    storage.sql.tableRows.set('connected_devices', [['device-1', 7, 11, 'ua', 1]])
    const beforeRows = new Map(storage.sql.tableRows)
    const beforeColumns = new Map(storage.sql.tableColumns)
    const beforeColumnDetails = new Map(storage.sql.tableColumnDetails)
    const beforeRowCounts = new Map(storage.sql.tableRowCounts)
    const beforeIndexes = new Map(storage.sql.tableIndexes)
    const beforeForeignKeys = new Map(storage.sql.tableForeignKeys)
    const room = new VaultRoom(
      new FakeState(storage),
      makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
    )
    storage.sql.failAfterQueryIncludes = boundary

    await expect(ensureSchema(room)).rejects.toThrow(/injected SQL failure/)
    assert.equal(room.schemaReady, false)
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3])
    assert.deepEqual(storage.sql.tableColumns, beforeColumns)
    assert.deepEqual(storage.sql.tableColumnDetails, beforeColumnDetails)
    assert.deepEqual(storage.sql.tableRowCounts, beforeRowCounts)
    assert.deepEqual(storage.sql.tableRows, beforeRows)
    assert.deepEqual(storage.sql.tableIndexes, beforeIndexes)
    assert.deepEqual(storage.sql.tableForeignKeys, beforeForeignKeys)

    storage.sql.failAfterQueryIncludes = undefined
    await ensureSchema(room)
    assert.equal(room.schemaReady, true)
    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
    assert.deepEqual(storage.sql.tableColumns.get('devices'), [
      'device_id',
      'token_version',
      'revoked_at',
      'created_at',
      'last_seen_at',
    ])
    assert.deepEqual(
      [...storage.sql.exec('pragma table_info(devices)')],
      [
        { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'token_version', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
        { cid: 2, name: 'revoked_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 3, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 4, name: 'last_seen_at', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      ],
    )
    assert.deepEqual(
      [...storage.sql.exec('pragma table_info(op_log)')],
      [
        { cid: 0, name: 'doc_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: 'seq', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 2 },
        { cid: 2, name: 'message_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 3, name: 'device_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 4, name: 'update_bytes', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 5, name: 'update_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 6, name: 'created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      ],
    )
    assert.deepEqual(
      [...storage.sql.exec('pragma table_info(connected_devices)')],
      [
        { cid: 0, name: 'device_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'last_seen_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
        { cid: 2, name: 'user_agent', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 3, name: 'protocol_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      ],
    )
    assert.deepEqual(
      storage.sql.tableRowCounts,
      new Map([
        ['devices', 1],
        ['op_log', 2],
        ['connected_devices', 1],
        ['schema_migrations', 0],
        ['blob_multipart_uploads', 0],
        ['blob_multipart_parts', 0],
        ['quarantine_audit_events', 0],
      ]),
    )
    assert.deepEqual(storage.sql.tableRows.get('devices'), [['device-1', 1, null, 10, 11]])
    assert.deepEqual(storage.sql.tableRows.get('op_log'), [
      ['meta', 1, 'message-1', 'device-1', new Uint8Array([1]), 'sha-1', 1],
      ['meta', 2, 'message-2', 'device-1', new Uint8Array([2]), 'sha-2', 2],
    ])
    assert.deepEqual(storage.sql.tableRows.get('connected_devices'), [['device-1', 11, 'ua', 1]])
    assert.deepEqual(storage.sql.tableForeignKeys.get('device_refresh_tokens'), [
      { table: 'devices', from: 'device_id', to: 'device_id' },
    ])
    assert.equal(
      storage.sql.tableIndexes.get('op_log')?.some((index) => index.name === 'idx_op_log_doc_seq'),
      true,
    )
    assert.deepEqual(storage.sql.tableIndexes.get('devices'), [
      { name: 'sqlite_autoindex_devices_1', unique: true, columns: ['device_id'] },
    ])
    assert.deepEqual(storage.sql.tableIndexes.get('op_log'), [
      { name: 'sqlite_autoindex_op_log_1', unique: true, columns: ['doc_id', 'seq'] },
      { name: 'sqlite_autoindex_op_log_2', unique: true, columns: ['doc_id', 'message_id'] },
      { name: 'idx_op_log_doc_seq', unique: false, columns: ['doc_id', 'seq'] },
    ])
    assert.deepEqual(storage.sql.tableIndexes.get('connected_devices'), [
      { name: 'sqlite_autoindex_connected_devices_1', unique: true, columns: ['device_id'] },
    ])
  }
})

test('ensureSchema rejects a malformed temp table even when its row count matches', async () => {
  const storage = new SqlOnlyStorage()
  storage.sql.migrationVersions.add(1)
  storage.sql.migrationVersions.add(2)
  storage.sql.migrationVersions.add(3)
  storage.sql.tableColumns.set('devices', [
    'device_id',
    'y_client_id',
    'token_version',
    'revoked_at',
    'created_at',
    'last_seen_at',
  ])
  storage.sql.tableRowCounts.set('devices', 1)
  storage.sql.tableColumns.set('devices__dr007', ['device_id', 'unexpected_column'])
  storage.sql.tableRowCounts.set('devices__dr007', 1)
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET),
  )

  await expect(ensureSchema(room)).rejects.toThrow(
    'schema-migration:devices__dr007-unexpected-columns',
  )
  assert.equal(room.schemaReady, false)
  assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3])
  assert.deepEqual(storage.sql.tableColumns.get('devices__dr007'), [
    'device_id',
    'unexpected_column',
  ])
})

test('VaultRoom upgrades an existing v1 schema before serving SQL traffic', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.sql.migrationVersions.add(1)
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
    assert.equal(
      storage.sql.queries.filter((query) => query.includes('alter table message_dedup')).length,
      1,
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom retries v2 schema migration after ALTER succeeds before recording the version', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    storage.sql.migrationVersions.add(1)
    storage.sql.failOnQueryIncludes = 'insert into schema_migrations'
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    let firstFailure: unknown
    try {
      await room.webSocketMessage(server, JSON.stringify(makeHello()))
    } catch (error) {
      firstFailure = error
    }
    assert(firstFailure instanceof Error)
    assert.deepEqual([...storage.sql.migrationVersions], [1])
    assert.deepEqual([...storage.sql.messageDedupColumns], [])

    storage.sql.failOnQueryIncludes = undefined
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    assert.deepEqual([...storage.sql.migrationVersions], [1, 2, 3, 4, 5, 6])
    assert.equal(
      storage.sql.queries.filter((query) => query.includes('alter table message_dedup')).length,
      2,
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom serializes concurrent sync update appends per document', async () => {
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
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    await Promise.all([
      room.webSocketMessage(
        firstServer,
        JSON.stringify(makeSyncUpdate(makeMessageId('message-concurrent-a'))),
      ),
      room.webSocketMessage(
        secondServer,
        JSON.stringify(makeSyncUpdate(makeMessageId('message-concurrent-b'))),
      ),
    ])

    const rows = [...storage.sql.opLog.values()]
      .filter(
        (row) =>
          row.messageId === 'message-concurrent-a' || row.messageId === 'message-concurrent-b',
      )
      .sort((left, right) => left.seq - right.seq)
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2],
    )
    const firstAck = findAckForMessage(firstServer.sent, 'message-concurrent-a')
    const secondAck = findAckForMessage(secondServer.sent, 'message-concurrent-b')
    assert.equal(firstAck?.durableSeq, storage.sql.opLog.get('meta:message-concurrent-a')?.seq)
    assert.equal(secondAck?.durableSeq, storage.sql.opLog.get('meta:message-concurrent-b')?.seq)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom rejects large live updates without acknowledging or advancing durable state', async () => {
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

    const docId = { kind: 'file', ydocId: makeYDocId('large-file-doc') } as const
    const update = {
      ...makeSyncUpdate(makeMessageId('message-large-update')),
      docId,
      update: makeLargeFileYjsUpdateBase64(),
    } satisfies SyncUpdate
    const updateJson = JSON.stringify(update)
    await room.webSocketMessage(server, updateJson)

    const rejection = JSON.parse(stringMessageAt(server.sent, 0)) as Record<string, unknown>
    assert.deepEqual(rejection, {
      type: 'sync-update-rejected',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId,
      updateSha256: makeSha256Hex(await hashTestBytes(decodeTestBase64(update.update))),
      reason: 'large-update-requires-snapshot-import',
      retryable: false,
    })
    assert.equal(syncMessages(server.sent).length, 1)
    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.has('file:large-file-doc'), false)
    assert.equal(storage.sql.messageDedup.has('file:large-file-doc:message-large-update'), false)
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'append-reject:large-update-requires-snapshot-import')
    assert.equal(room.docs.has('file:large-file-doc'), false)

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const retryServer = state.accepted[1]
    assert(retryServer instanceof FakeSocket)
    await room.webSocketMessage(retryServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(retryServer, updateJson)

    assert.equal(syncMessages(retryServer.sent).length, 1)
    assert.equal(JSON.parse(stringMessageAt(retryServer.sent, 0)).type, 'sync-update-rejected')
    assert.equal(storage.sql.opLog.has('file:large-file-doc:message-large-update'), false)
    assert.equal(storage.sql.docs.has('file:large-file-doc'), false)
    assert.equal(storage.sql.messageDedup.has('file:large-file-doc:message-large-update'), false)
    assert.equal(retryServer.closeCode, 1011)
    assert.equal(retryServer.closeReason, 'append-reject:large-update-requires-snapshot-import')
    assert.equal(room.docs.has('file:large-file-doc'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom refuses a live update that would load a new file doc while at capacity', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    for (let index = 0; index < MAX_HYDRATED_FILE_DOCS; index += 1) {
      room.hydratedDocs.add(`file:${makeYDocId(`padding-${index}`)}`)
    }

    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify(makeHello()))

    const docId = { kind: 'file', ydocId: makeYDocId('degraded-new-file') } as const
    const messageId = makeMessageId('message-degraded-new-file')
    const update = {
      ...makeSyncUpdate(messageId),
      docId,
      update: makeYjsUpdateBase64(messageId),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'doc-load-degraded')
    assert.equal(storage.sql.opLog.has(`file:degraded-new-file:${messageId}`), false)
    assert.equal(storage.sql.docs.has('file:degraded-new-file'), false)
    assert.equal(room.hydratedDocs.has('file:degraded-new-file'), false)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom leaves an already-hydrated document byte-for-byte unchanged after oversized rejection', async () => {
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

    const docId = { kind: 'file', ydocId: makeYDocId('already-hydrated-large-file') } as const
    await ensureDocHydrated(room, docId)
    const hydrated = room.docs.get('file:already-hydrated-large-file')
    assert(hydrated !== undefined)
    hydrated.getText('body').insert(0, 'preserved local state')
    const before = Y.encodeStateAsUpdate(hydrated)

    const update = {
      ...makeSyncUpdate(makeMessageId('message-large-update-hydrated')),
      docId,
      update: makeLargeFileYjsUpdateBase64(),
    } satisfies SyncUpdate
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.deepEqual(Y.encodeStateAsUpdate(hydrated), before)
    assert.equal(syncMessages(server.sent).length, 1)
    assert.equal(JSON.parse(stringMessageAt(server.sent, 0)).type, 'sync-update-rejected')
    assert.equal(
      storage.sql.opLog.has('file:already-hydrated-large-file:message-large-update-hydrated'),
      false,
    )
    assert.equal(
      storage.sql.messageDedup.has(
        'file:already-hydrated-large-file:message-large-update-hydrated',
      ),
      false,
    )
    assert.equal(server.closeCode, 1011)
    assert.equal(server.closeReason, 'append-reject:large-update-requires-snapshot-import')
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires hello before accepting binary sync frames', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState(new SqlOnlyStorage())
    const room = new VaultRoom(state, makeEnv())
    const request = new Request('https://worker.example/ws/vault-1', {
      headers: { Upgrade: 'websocket' },
    })

    void room.fetch(request)
    void room.fetch(request)
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)

    const update = makeSyncUpdate(makeMessageId('message-binary-before-hello'))
    const frame = makeArrayBuffer(
      encodeBinaryFrame(
        {
          type: 'sync-update',
          protocolVersion: update.protocolVersion,
          vaultId: update.vaultId,
          deviceId: update.deviceId,
          messageId: update.messageId,
          docId: update.docId,
        },
        makeYjsUpdateBytes(update.messageId),
      ),
    )

    await room.webSocketMessage(firstServer, frame)

    assert.equal(firstServer.closed, true)
    assert.equal(firstServer.closeReason, 'hello-required')
    assert.deepEqual(syncMessages(secondServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom persists binary sync frames before acking and broadcasting', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    const request = await makeAuthenticatedWebSocketRequest()

    void room.fetch(request)
    void room.fetch(request)
    void room.fetch(request)
    const firstServer = state.accepted[0]
    const secondServer = state.accepted[1]
    const unauthenticatedServer = state.accepted[2]
    assert(firstServer instanceof FakeSocket)
    assert(secondServer instanceof FakeSocket)
    assert(unauthenticatedServer instanceof FakeSocket)
    await room.webSocketMessage(firstServer, JSON.stringify(makeHello()))
    await room.webSocketMessage(secondServer, JSON.stringify(makeHello()))

    const update = makeSyncUpdate(makeMessageId('message-binary'))
    const payload = makeYjsUpdateBytes(update.messageId)
    const frame = makeArrayBuffer(
      encodeBinaryFrame(
        {
          type: 'sync-update',
          protocolVersion: update.protocolVersion,
          vaultId: update.vaultId,
          deviceId: update.deviceId,
          messageId: update.messageId,
          docId: update.docId,
        },
        payload,
      ),
    )

    await room.webSocketMessage(firstServer, frame)

    assert.equal(storage.sql.opLog.get('meta:message-binary')?.seq, 1)
    const ack = stringMessageAt(firstServer.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected binary ack string')
    }
    assert.equal((JSON.parse(ack) as Ack).durableSeq, 1)
    assert.equal(syncMessages(secondServer.sent).length, 1)
    const broadcast = syncMessages(secondServer.sent)[0]
    assert(broadcast !== undefined)
    if (typeof broadcast === 'string') {
      throw new Error('expected binary broadcast frame')
    }
    const decoded = decodeBinaryFrame(new Uint8Array(broadcast))
    assert(decoded)
    assert.deepEqual(decoded.header, {
      type: 'sync-update',
      protocolVersion: update.protocolVersion,
      vaultId: update.vaultId,
      deviceId: update.deviceId,
      messageId: update.messageId,
      docId: update.docId,
      durableSeq: 1,
    })
    assert.deepEqual(decoded.payload, payload)
    assert.deepEqual(syncMessages(unauthenticatedServer.sent), [])
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom restores WebSocket sessions from hibernation attachments', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const request = await makeAuthenticatedWebSocketRequest()

    const initialRoom = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void initialRoom.fetch(request)
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await initialRoom.webSocketMessage(server, JSON.stringify(makeHello()))

    const resumedRoom = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    await resumedRoom.webSocketMessage(
      server,
      JSON.stringify(makeSyncUpdate(makeMessageId('message-after-hibernation'))),
    )

    assert.equal(server.closed, false)
    const ack = stringMessageAt(server.sent, 0)
    if (typeof ack !== 'string') {
      throw new Error('expected resumed session ack string')
    }
    assert.deepEqual(JSON.parse(ack) as Ack, {
      type: 'ack',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      messageId: makeMessageId('message-after-hibernation'),
      docId: { kind: 'meta' },
      durableSeq: 1,
    })
    assert.equal(storage.sql.opLog.get('meta:message-after-hibernation')?.seq, 1)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom answers sync requests with Yjs diffs and no-ops empty diffs', async () => {
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
    const update = makeSyncUpdate(makeMessageId('message-sync-source'))
    await room.webSocketMessage(server, JSON.stringify(update))

    const emptyStateVector = makeStateVectorBase64(new Y.Doc())
    await room.webSocketMessage(
      server,
      JSON.stringify(makeSyncRequest(makeMessageId('message-sync-request'), emptyStateVector)),
    )

    const response = stringMessageAt(server.sent, 1)
    if (typeof response !== 'string') {
      throw new Error('expected sync-request response string')
    }
    const parsed = JSON.parse(response) as SyncUpdate
    assert.equal(parsed.type, 'sync-update')
    assert.equal(parsed.messageId, makeMessageId('message-sync-request'))
    assert.equal(parsed.baseStateVector, emptyStateVector)

    const localDoc = new Y.Doc()
    Y.applyUpdate(localDoc, decodeTestBase64(update.update))
    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-sync-current'), makeStateVectorBase64(localDoc)),
      ),
    )

    assert.equal(syncMessages(server.sent).length, 2)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires a full snapshot when sync request state vector is older than horizon', async () => {
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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-horizon'))),
    )
    await room.checkpointDoc({ kind: 'meta' }, 10)

    await room.webSocketMessage(
      server,
      JSON.stringify(
        makeSyncRequest(makeMessageId('message-old-horizon'), makeStateVectorBase64(new Y.Doc())),
      ),
    )

    const response = stringMessageAt(server.sent, 1)
    if (typeof response !== 'string') {
      throw new Error('expected need-full-snapshot response string')
    }
    assert.deepEqual(JSON.parse(response) as NeedFullSnapshot, {
      type: 'need-full-snapshot',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      vaultId: makeVaultId('vault-1'),
      deviceId: makeDeviceId('device-1'),
      docId: { kind: 'meta' },
      reason: 'state-vector-too-old',
    })
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom accepts a v1 migration delta against an empty sequence-0 snapshot', async () => {
  const storage = new SqlOnlyStorage()
  const bucket = new FakeR2Bucket()
  const room = new VaultRoom(
    new FakeState(storage),
    makeEnvWithSnapshotBucketAndDeviceTokenSecret(bucket, TEST_DEVICE_TOKEN_SECRET),
  )
  room.vaultId = makeVaultId('vault-1')
  const fileId = makeFileId('seq-zero-migration')
  const legacyFile = {
    schemaVersion: 1 as const,
    fileId,
    path: 'Notes/Legacy.md',
    canonicalPath: 'notes/legacy.md',
    type: 'text' as const,
    ydocId: makeYDocId('seq-zero-migration-doc'),
    deleted: false as const,
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  }
  const legacy = new Y.Doc()
  legacy.getMap('meta').set(fileId, legacyFile)
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

  const migrated = new Y.Doc()
  Y.applyUpdate(migrated, Y.encodeStateAsUpdate(legacy))
  const grouped = groupedEntryFromMetaFile(legacyFile)
  const groupedMap = new Y.Map<unknown>()
  groupedMap.set('identity', grouped.identity)
  groupedMap.set('location', grouped.location)
  groupedMap.set('content', grouped.content)
  groupedMap.set('deletion', grouped.deletion)
  migrated.getMap('meta').set(fileId, groupedMap)
  const migrationDelta = Y.encodeStateAsUpdate(migrated, Y.encodeStateVector(legacy))
  const candidate = new Y.Doc()
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(legacy))
  Y.applyUpdate(candidate, migrationDelta)
  assert.equal(metaYDocWritable(candidate), true)
  assert.equal(metaIdentityImmutable(legacy, candidate), true)
  assert.equal(metaRootMutationAllowed(legacy, migrationDelta, true), true)
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
        updateBytesBase64: Buffer.from(migrationDelta).toString('base64'),
        metadataSchemaVersion: 2,
      }),
    }),
  )

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(storage.sql.docs.get('meta')?.latestSeq, 1)
  assert.equal(bucket.puts.length, 1)
  migrated.destroy()
  legacy.destroy()
})

test('metadata read-only sessions still append file YDoc updates', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const server = state.accepted[0]
    assert(server instanceof FakeSocket)
    await room.webSocketMessage(server, JSON.stringify({ ...makeHello(), capabilities: [] }))

    const update = {
      ...makeSyncUpdate(makeMessageId('message-read-only-file')),
      docId: { kind: 'file', ydocId: makeYDocId('read-only-file') },
    }
    await room.webSocketMessage(server, JSON.stringify(update))

    assert.equal(server.closed, false)
    assert.ok(findAckForMessage(server.sent, update.messageId))
    assert.equal(storage.sql.opLog.has(`file:${update.docId.ydocId}:${update.messageId}`), true)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom requires hello before sync updates', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const state = new FakeState()
    const room = new VaultRoom(state, makeEnv())
    void room.fetch(
      new Request('https://worker.example/ws/vault-1', {
        headers: { Upgrade: 'websocket' },
      }),
    )

    const server = state.accepted[0]
    assert(server instanceof FakeSocket)

    await room.webSocketMessage(server, JSON.stringify(makeSyncUpdate(makeMessageId('message-1'))))

    assert.equal(server.closed, true)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs structured connection-open and connection-close events with a live count', async () => {
  const previousPair = installFakeWebSocketPair()
  const previousResponse = installFakeUpgradeResponse()
  try {
    const storage = new SqlOnlyStorage()
    const state = new FakeState(storage)
    const room = new VaultRoom(state, makeEnvWithDeviceTokenSecret(TEST_DEVICE_TOKEN_SECRET))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    void room.fetch(await makeAuthenticatedWebSocketRequest())
    const first = state.accepted[0]
    const second = state.accepted[1]
    assert(first instanceof FakeSocket)
    assert(second instanceof FakeSocket)

    room.webSocketClose(first)

    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert.deepEqual(
      events.filter((event) => event.event === 'connection-open'),
      [
        { event: 'connection-open', vaultId: makeVaultId('vault-1'), connectionCount: 1 },
        { event: 'connection-open', vaultId: makeVaultId('vault-1'), connectionCount: 2 },
      ],
    )
    assert.deepEqual(
      events.filter((event) => event.event === 'connection-close'),
      [{ event: 'connection-close', vaultId: makeVaultId('vault-1'), connectionCount: 1 }],
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs a structured event with the durable op-append latency', async () => {
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
      JSON.stringify(makeSyncUpdate(makeMessageId('message-append-latency'))),
    )
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    const latencyEvent = events.find((event) => event.event === 'op-append-latency')
    assert(latencyEvent)
    assert.equal(latencyEvent.vaultId, makeVaultId('vault-1'))
    assert.deepEqual(latencyEvent.docId, { kind: 'meta' })
    assert.equal(typeof latencyEvent.durationMs, 'number')
    assert(latencyEvent.durationMs >= 0)
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})

test('VaultRoom logs a structured event when an identical duplicate update is ignored', async () => {
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

    const update = makeSyncUpdate(makeMessageId('message-duplicate-ignored'))
    await room.webSocketMessage(server, JSON.stringify(update))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await room.webSocketMessage(server, JSON.stringify(update))
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    logSpy.mockRestore()

    assert.deepEqual(
      events.filter((event) => event.event === 'sync-duplicate-ignored'),
      [
        {
          event: 'sync-duplicate-ignored',
          vaultId: makeVaultId('vault-1'),
          docId: { kind: 'meta' },
          messageId: update.messageId,
          durableSeq: 1,
        },
      ],
    )
  } finally {
    restoreResponse(previousResponse)
    restoreWebSocketPair(previousPair)
  }
})
