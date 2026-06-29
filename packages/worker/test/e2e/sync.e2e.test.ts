import {
  canonicalizeVaultPath,
  CURRENT_PROTOCOL_VERSION,
  makeDeviceId,
  makeFileId,
  makeVaultId,
  makeYDocId,
  signHs256DeviceToken,
  type DeviceTokenScope,
  type FileId,
  type MetaFile,
  type YDocId,
} from '@kuroflare/core'
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import * as Y from 'yjs'

import { SCHEMA_MIGRATIONS } from '../../src/schema'
import { makeSnapshotListPrefix } from '../../src/snapshots'

const VAULT_ID = 'vault-1'
const DEVICE_TOKEN_SECRET = 'e2e-device-token-secret'
// Each test uses a distinct file YDoc id: the Durable Object keeps authoritative YDocs in memory
// across tests (only durable storage is isolated per test), so sharing one id leaks state.
const SINGLE_DOC_ID = { kind: 'file', ydocId: 'ydoc-single' } as const
const CONCURRENT_DOC_ID = { kind: 'file', ydocId: 'ydoc-concurrent' } as const
const META_DOC_ID = { kind: 'meta' } as const
const CHECKPOINT_DOC_ID = { kind: 'file', ydocId: 'ydoc-checkpoint' } as const
const COLD_START_DOC_ID = { kind: 'file', ydocId: 'ydoc-coldstart' } as const
const ACCESS_SCOPES: readonly DeviceTokenScope[] = [
  'sync:read',
  'sync:write',
  'blob:read',
  'blob:write',
]

interface SeededDevice {
  readonly deviceId: string
  readonly yClientId: number
}

const DEVICE_A: SeededDevice = { deviceId: 'device-a', yClientId: 1 }
const DEVICE_B: SeededDevice = { deviceId: 'device-b', yClientId: 2 }
const DEVICE_C: SeededDevice = { deviceId: 'device-c', yClientId: 3 }

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function metaFile(
  fileId: FileId,
  path: string,
  ydocId: YDocId,
  deviceId: string,
  now: number,
): MetaFile {
  const guardedDeviceId = makeDeviceId(deviceId)
  return {
    schemaVersion: 1,
    fileId,
    path,
    canonicalPath: canonicalizeVaultPath(path),
    type: 'text',
    ydocId,
    deleted: false,
    createdAt: now,
    createdBy: guardedDeviceId,
    contentUpdatedAt: now,
    contentUpdatedBy: guardedDeviceId,
    updatedAt: now,
    updatedBy: guardedDeviceId,
    mtime: now,
  }
}

function metaPaths(doc: Y.Doc): readonly (readonly [string, string])[] {
  return [...doc.getMap<MetaFile>('meta').entries()]
    .map(([fileId, value]) => [fileId, value.path] as const)
    .sort(([left], [right]) => left.localeCompare(right))
}

function roomStub() {
  return env.VAULT_ROOM.get(env.VAULT_ROOM.idFromName(VAULT_ID))
}

async function seedDevices(devices: readonly SeededDevice[]): Promise<void> {
  await runInDurableObject(roomStub(), (_instance, state) => {
    const sql = state.storage.sql
    for (const migration of SCHEMA_MIGRATIONS) {
      for (const statement of migration.statements) {
        sql.exec(statement)
      }
    }
    const now = Date.now()
    for (const device of devices) {
      sql.exec(
        'insert or replace into devices (device_id, y_client_id, token_version, created_at) values (?, ?, ?, ?)',
        device.deviceId,
        device.yClientId,
        1,
        now,
      )
    }
    const [seeded] = [
      ...sql.exec<{ readonly count: number }>('select count(*) as count from devices'),
    ]
    if ((seeded?.count ?? 0) < devices.length) {
      throw new Error(`device seed failed: ${seeded?.count ?? 0} rows`)
    }
  })
}

async function mintAccessToken(deviceId: string): Promise<string> {
  // Claims clocks are milliseconds: the Worker admits tokens by comparing `exp` against Date.now().
  const now = Date.now()
  return signHs256DeviceToken({
    claims: {
      iss: 'kuroflare-worker',
      aud: makeVaultId(VAULT_ID),
      sub: makeDeviceId(deviceId),
      scope: [...ACCESS_SCOPES],
      iat: now - 1_000,
      exp: now + 3_600_000,
      tokenVersion: 1,
    },
    secret: DEVICE_TOKEN_SECRET,
  })
}

interface ControlMessage {
  readonly type: string
  readonly [key: string]: unknown
}

/** Buffers Worker -> client control messages and lets a test await the next one matching a predicate. */
class TestClient {
  private readonly inbox: ControlMessage[] = []
  private readonly waiters: Array<{
    readonly predicate: (message: ControlMessage) => boolean
    readonly resolve: (message: ControlMessage) => void
  }> = []

  private closeInfo: { readonly code: number; readonly reason: string } | undefined

  private constructor(
    readonly deviceId: string,
    readonly yClientId: number,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        return
      }
      const parsed = JSON.parse(event.data)
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
        return
      }
      const message: ControlMessage = parsed
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message))
      if (waiterIndex === -1) {
        this.inbox.push(message)
        return
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1)
      waiter?.resolve(message)
    })
    socket.addEventListener('close', (event: CloseEvent) => {
      this.closeInfo = { code: event.code, reason: event.reason }
    })
  }

  static async connect(device: SeededDevice): Promise<TestClient> {
    const token = await mintAccessToken(device.deviceId)
    // Drive the WebSocket through the DO stub directly so seeding (runInDurableObject) and serving
    // hit the same instance + storage. Worker entrypoint routing is covered by the node unit tests.
    const response = await roomStub().fetch(
      new Request(`https://kuroflare.test/ws/${VAULT_ID}`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
    )
    const socket = response.webSocket
    if (socket === null) {
      throw new Error(`expected websocket upgrade, got status ${response.status}`)
    }
    socket.accept()
    const client = new TestClient(device.deviceId, device.yClientId, socket)
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: VAULT_ID,
        deviceId: device.deviceId,
        yClientId: device.yClientId,
        capabilities: [],
      }),
    )
    await client.waitFor((message) => message.type === 'hello-accepted')
    return client
  }

  waitFor(predicate: (message: ControlMessage) => boolean): Promise<ControlMessage> {
    const buffered = this.inbox.findIndex(predicate)
    if (buffered !== -1) {
      const [message] = this.inbox.splice(buffered, 1)
      if (message !== undefined) {
        return Promise.resolve(message)
      }
    }
    if (this.closeInfo !== undefined) {
      return Promise.reject(
        new Error(
          `socket ${this.deviceId} closed: ${this.closeInfo.code} ${this.closeInfo.reason}`,
        ),
      )
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const closed = this.closeInfo
        reject(
          new Error(
            closed === undefined
              ? `timed out waiting for message on ${this.deviceId}`
              : `socket ${this.deviceId} closed: ${closed.code} ${closed.reason}`,
          ),
        )
      }, 3000)
      this.waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timeout)
          resolve(message)
        },
      })
    })
  }

  sendUpdate(messageId: string, docId: unknown, update: Uint8Array): void {
    this.socket.send(
      JSON.stringify({
        type: 'sync-update',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: VAULT_ID,
        deviceId: this.deviceId,
        messageId,
        docId,
        update: toBase64(update),
      }),
    )
  }

  sendSyncRequest(messageId: string, docId: unknown, stateVector: Uint8Array): void {
    this.socket.send(
      JSON.stringify({
        type: 'sync-request',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        vaultId: VAULT_ID,
        deviceId: this.deviceId,
        messageId,
        docId,
        stateVector: toBase64(stateVector),
      }),
    )
  }

  close(): void {
    this.socket.close()
  }
}

test('authenticated client syncs one update and the Worker acks it with a durable seq', async () => {
  await seedDevices([DEVICE_A])
  const client = await TestClient.connect(DEVICE_A)

  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'hello world')
  client.sendUpdate('msg-1', SINGLE_DOC_ID, Y.encodeStateAsUpdate(doc))

  const ack = await client.waitFor(
    (message) => message.type === 'ack' && message.messageId === 'msg-1',
  )
  expect(ack.durableSeq).toBe(1)

  client.close()
})

test('two clients editing the same paragraph concurrently both survive', async () => {
  await seedDevices([DEVICE_A, DEVICE_B, DEVICE_C])
  const alice = await TestClient.connect(DEVICE_A)
  const bob = await TestClient.connect(DEVICE_B)

  // Both edits are made before either client observes the other -> a genuine concurrent merge.
  const aliceDoc = new Y.Doc()
  aliceDoc.getText('content').insert(0, 'Alpha')
  const aliceUpdate = Y.encodeStateAsUpdate(aliceDoc)

  const bobDoc = new Y.Doc()
  bobDoc.getText('content').insert(0, 'Bravo')
  const bobUpdate = Y.encodeStateAsUpdate(bobDoc)

  alice.sendUpdate('alice-1', CONCURRENT_DOC_ID, aliceUpdate)
  bob.sendUpdate('bob-1', CONCURRENT_DOC_ID, bobUpdate)

  const broadcastToAlice = await alice.waitFor(
    (message) => message.type === 'sync-update' && message.messageId === 'bob-1',
  )
  const broadcastToBob = await bob.waitFor(
    (message) => message.type === 'sync-update' && message.messageId === 'alice-1',
  )

  const receivedAliceUpdate = broadcastToAlice.update
  const receivedBobUpdate = broadcastToBob.update
  if (typeof receivedAliceUpdate !== 'string' || typeof receivedBobUpdate !== 'string') {
    throw new Error('Expected update strings')
  }
  Y.applyUpdate(aliceDoc, fromBase64(receivedAliceUpdate))
  Y.applyUpdate(bobDoc, fromBase64(receivedBobUpdate))

  const aliceText = aliceDoc.getText('content').toJSON()
  const bobText = bobDoc.getText('content').toJSON()
  expect(aliceText).toBe(bobText)
  expect(aliceText).toContain('Alpha')
  expect(aliceText).toContain('Bravo')

  // A late joiner reconstructs the merged document straight from the Worker's authoritative state.
  const carol = await TestClient.connect(DEVICE_C)
  carol.sendSyncRequest('carol-sr', CONCURRENT_DOC_ID, Y.encodeStateVector(new Y.Doc()))
  const delta = await carol.waitFor((message) => message.type === 'sync-update')
  const carolDoc = new Y.Doc()
  const deltaUpdate = delta.update
  if (typeof deltaUpdate !== 'string') {
    throw new Error('Expected delta update string')
  }
  Y.applyUpdate(carolDoc, fromBase64(deltaUpdate))
  expect(carolDoc.getText('content').toJSON()).toBe(aliceText)

  alice.close()
  bob.close()
  carol.close()
})

test('meta YDoc updates broadcast across clients and late joiners reconstruct the tree', async () => {
  await seedDevices([DEVICE_A, DEVICE_B, DEVICE_C])
  const alice = await TestClient.connect(DEVICE_A)
  const bob = await TestClient.connect(DEVICE_B)

  const aliceDoc = new Y.Doc()
  const aliceMap = aliceDoc.getMap<unknown>('meta')
  const fileA = makeFileId('meta-file-a')
  const fileB = makeFileId('meta-file-b')
  aliceMap.set(fileA, metaFile(fileA, 'a.md', makeYDocId('meta-doc-a'), DEVICE_A.deviceId, 1))
  aliceMap.set(fileB, metaFile(fileB, 'b.md', makeYDocId('meta-doc-b'), DEVICE_A.deviceId, 2))
  alice.sendUpdate('meta-base', META_DOC_ID, Y.encodeStateAsUpdate(aliceDoc))
  await alice.waitFor((message) => message.type === 'ack' && message.messageId === 'meta-base')
  const baseBroadcast = await bob.waitFor(
    (message) => message.type === 'sync-update' && message.messageId === 'meta-base',
  )

  const bobDoc = new Y.Doc()
  const baseUpdate = baseBroadcast.update
  if (typeof baseUpdate !== 'string') {
    throw new Error('Expected baseUpdate string')
  }
  Y.applyUpdate(bobDoc, fromBase64(baseUpdate))
  const aliceBaseVector = Y.encodeStateVector(aliceDoc)
  const bobBaseVector = Y.encodeStateVector(bobDoc)

  aliceMap.set(fileA, metaFile(fileA, 'Shared.md', makeYDocId('meta-doc-a'), DEVICE_A.deviceId, 10))
  bobDoc
    .getMap<unknown>('meta')
    .set(fileB, metaFile(fileB, 'Shared.md', makeYDocId('meta-doc-b'), DEVICE_B.deviceId, 10))

  alice.sendUpdate(
    'meta-alice-rename',
    META_DOC_ID,
    Y.encodeStateAsUpdate(aliceDoc, aliceBaseVector),
  )
  bob.sendUpdate('meta-bob-rename', META_DOC_ID, Y.encodeStateAsUpdate(bobDoc, bobBaseVector))

  const bobRenameForAlice = await alice.waitFor(
    (message) => message.type === 'sync-update' && message.messageId === 'meta-bob-rename',
  )
  const aliceRenameForBob = await bob.waitFor(
    (message) => message.type === 'sync-update' && message.messageId === 'meta-alice-rename',
  )
  const bobUpdateForAlice = bobRenameForAlice.update
  const aliceUpdateForBob = aliceRenameForBob.update
  if (typeof bobUpdateForAlice !== 'string' || typeof aliceUpdateForBob !== 'string') {
    throw new Error('Expected update strings')
  }
  Y.applyUpdate(aliceDoc, fromBase64(bobUpdateForAlice))
  Y.applyUpdate(bobDoc, fromBase64(aliceUpdateForBob))

  expect(metaPaths(aliceDoc)).toEqual(metaPaths(bobDoc))
  expect(metaPaths(aliceDoc)).toEqual([
    ['meta-file-a', 'Shared.md'],
    ['meta-file-b', 'Shared.md'],
  ])

  const carol = await TestClient.connect(DEVICE_C)
  carol.sendSyncRequest('meta-carol-sr', META_DOC_ID, Y.encodeStateVector(new Y.Doc()))
  const delta = await carol.waitFor((message) => message.type === 'sync-update')
  const carolDoc = new Y.Doc()
  const deltaUpdate = delta.update
  if (typeof deltaUpdate !== 'string') {
    throw new Error('Expected delta update string')
  }
  Y.applyUpdate(carolDoc, fromBase64(deltaUpdate))
  expect(metaPaths(carolDoc)).toEqual(metaPaths(aliceDoc))

  alice.close()
  bob.close()
  carol.close()
})

test('the Worker checkpoints an active document to R2', async () => {
  await seedDevices([DEVICE_A])
  const client = await TestClient.connect(DEVICE_A)
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'snapshot me')
  client.sendUpdate('checkpoint-1', CHECKPOINT_DOC_ID, Y.encodeStateAsUpdate(doc))
  await client.waitFor((message) => message.type === 'ack' && message.messageId === 'checkpoint-1')

  const result = await runInDurableObject(roomStub(), (instance) =>
    instance.checkpointDoc(CHECKPOINT_DOC_ID),
  )
  expect(result.action).toBe('checkpointed')

  const listed = await env.SNAPSHOT_BUCKET.list({
    prefix: makeSnapshotListPrefix(makeVaultId(VAULT_ID), CHECKPOINT_DOC_ID),
  })
  expect(listed.objects.length).toBeGreaterThanOrEqual(1)

  client.close()
})

test('a cold-started Durable Object rebuilds document state from its durable op log', async () => {
  await seedDevices([DEVICE_A])
  const author = await TestClient.connect(DEVICE_A)
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'durable text')
  author.sendUpdate('cold-1', COLD_START_DOC_ID, Y.encodeStateAsUpdate(doc))
  await author.waitFor((message) => message.type === 'ack' && message.messageId === 'cold-1')
  author.close()

  // Tear down the instance: in-memory YDocs are lost; the durable SQLite op log survives.
  // (No checkpoint here: compaction would advance the horizon past an empty-state-vector client,
  // which by design returns need-full-snapshot. The R2 snapshot write itself is covered above.)
  await evictDurableObject(roomStub())

  const rejoin = await TestClient.connect(DEVICE_A)
  rejoin.sendSyncRequest('cold-sr', COLD_START_DOC_ID, Y.encodeStateVector(new Y.Doc()))
  const delta = await rejoin.waitFor((message) => message.type === 'sync-update')
  const restored = new Y.Doc()
  const deltaUpdate = delta.update
  if (typeof deltaUpdate !== 'string') {
    throw new Error('Expected delta update string')
  }
  Y.applyUpdate(restored, fromBase64(deltaUpdate))
  expect(restored.getText('content').toJSON()).toBe('durable text')

  rejoin.close()
})
