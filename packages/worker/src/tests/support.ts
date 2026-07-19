import type {
  DurableObjectStateBinding,
  DurableObjectStorageBinding,
  R2BucketBinding,
  R2ListOptionsBinding,
  R2MultipartUploadBinding,
  R2ObjectBodyBinding,
  R2ObjectsBinding,
  R2UploadedPartBinding,
  RuntimeWebSocket,
} from '../runtime'
import { RecordingSqlStorage, type RecordingSqlSnapshot } from './sql'

export class FakeSocket implements RuntimeWebSocket {
  readonly sent: Array<string | ArrayBuffer> = []
  accepted = false
  closed = false
  closeCode: number | undefined
  closeReason: string | undefined
  private attachment: unknown

  accept(): void {
    this.accepted = true
  }

  send(message: string | ArrayBuffer): void {
    this.sent.push(message)
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment
  }

  deserializeAttachment(): unknown {
    return this.attachment
  }
}

export class FakeWebSocketPair {
  readonly 0 = new FakeSocket()
  readonly 1 = new FakeSocket()
}

export class FakeUpgradeResponse {
  readonly status: number
  readonly webSocket: RuntimeWebSocket | undefined

  constructor(_body: BodyInit | null, init?: ResponseInit & { webSocket?: RuntimeWebSocket }) {
    this.status = init?.status ?? 200
    this.webSocket = init?.webSocket
  }
}

export class MemoryStorage implements DurableObjectStorageBinding {
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }

  async transaction<T>(closure: () => T | Promise<T>): Promise<T> {
    return closure()
  }
}

export class FakeR2Object implements R2ObjectBodyBinding {
  constructor(private readonly bytes: Uint8Array) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.bytes.byteLength)
    new Uint8Array(buffer).set(this.bytes)
    return buffer
  }
}

/** In-memory R2 multipart upload session backing `FakeR2Bucket`. */
export class FakeR2MultipartUpload implements R2MultipartUploadBinding {
  constructor(
    private readonly bucket: FakeR2Bucket,
    private readonly key: string,
    readonly uploadId: string,
  ) {}

  async uploadPart(partNumber: number, value: Uint8Array): Promise<R2UploadedPartBinding> {
    return this.bucket.recordUploadedPart(this.uploadId, partNumber, value)
  }

  async complete(uploadedParts: readonly R2UploadedPartBinding[]): Promise<void> {
    this.bucket.completeMultipartUpload(this.key, this.uploadId, uploadedParts)
  }

  async abort(): Promise<void> {
    this.bucket.abortMultipartUpload(this.uploadId)
  }
}

export class FakeR2Bucket implements R2BucketBinding {
  readonly gets: string[] = []
  readonly heads: string[] = []
  readonly lists: string[] = []
  readonly puts: string[] = []
  readonly deletes: string[] = []
  beforeGet: ((key: string) => void | Promise<void>) | undefined
  beforePut: ((key: string, value: Uint8Array) => void | Promise<void>) | undefined
  listOverride:
    | ((options: R2ListOptionsBinding) => R2ObjectsBinding | Promise<R2ObjectsBinding>)
    | undefined
  listPageSize: number | undefined
  private readonly values = new Map<string, Uint8Array>()
  private readonly multipartUploads = new Map<string, Map<number, Uint8Array>>()
  private nextMultipartUploadId = 1

  set(key: string, bytes: Uint8Array): void {
    this.values.set(key, bytes)
  }

  async get(key: string): Promise<R2ObjectBodyBinding | null> {
    this.gets.push(key)
    await this.beforeGet?.(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : new FakeR2Object(bytes)
  }

  async head(key: string): Promise<{ readonly size: number } | null> {
    this.heads.push(key)
    const bytes = this.values.get(key)
    return bytes === undefined ? null : { size: bytes.byteLength }
  }

  async list(options: R2ListOptionsBinding): Promise<R2ObjectsBinding> {
    this.lists.push(options.prefix)
    if (this.listOverride !== undefined) return this.listOverride(options)
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    const start = options.cursor === undefined ? 0 : Number(options.cursor)
    if (!Number.isSafeInteger(start) || start < 0 || start > keys.length) {
      throw new Error('invalid-list-cursor')
    }
    const pageSize =
      this.listPageSize === undefined ||
      !Number.isSafeInteger(this.listPageSize) ||
      this.listPageSize <= 0
        ? keys.length
        : this.listPageSize
    const end = Math.min(start + pageSize, keys.length)
    return {
      objects: keys.slice(start, end).map((key) => ({ key })),
      truncated: end < keys.length,
      ...(end < keys.length ? { cursor: String(end) } : {}),
    }
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.puts.push(key)
    await this.beforePut?.(key, value)
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key)
    this.values.delete(key)
  }

  async createMultipartUpload(key: string): Promise<R2MultipartUploadBinding> {
    const uploadId = `fake-upload-${this.nextMultipartUploadId}`
    this.nextMultipartUploadId += 1
    this.multipartUploads.set(uploadId, new Map())
    return new FakeR2MultipartUpload(this, key, uploadId)
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadBinding {
    return new FakeR2MultipartUpload(this, key, uploadId)
  }

  recordUploadedPart(
    uploadId: string,
    partNumber: number,
    value: Uint8Array,
  ): R2UploadedPartBinding {
    const parts = this.multipartUploads.get(uploadId)
    if (parts === undefined) throw new Error(`unknown multipart upload: ${uploadId}`)
    parts.set(partNumber, value)
    return { partNumber, etag: `etag-${uploadId}-${partNumber}` }
  }

  completeMultipartUpload(
    key: string,
    uploadId: string,
    uploadedParts: readonly R2UploadedPartBinding[],
  ): void {
    const parts = this.multipartUploads.get(uploadId)
    if (parts === undefined) throw new Error(`unknown multipart upload: ${uploadId}`)
    const orderedParts = [...uploadedParts].sort(
      (left, right) => left.partNumber - right.partNumber,
    )
    const partBytes: Uint8Array[] = []
    let totalLength = 0
    for (const part of orderedParts) {
      const bytes = parts.get(part.partNumber)
      if (bytes === undefined) throw new Error(`missing uploaded part: ${part.partNumber}`)
      partBytes.push(bytes)
      totalLength += bytes.byteLength
    }
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const bytes of partBytes) {
      combined.set(bytes, offset)
      offset += bytes.byteLength
    }
    this.set(key, combined)
    this.multipartUploads.delete(uploadId)
  }

  abortMultipartUpload(uploadId: string): void {
    if (!this.multipartUploads.has(uploadId))
      throw new Error(`unknown multipart upload: ${uploadId}`)
    this.multipartUploads.delete(uploadId)
  }
}

export class SqlOnlyStorage implements DurableObjectStorageBinding {
  readonly sql = new RecordingSqlStorage()
  readonly alarms: Array<number | Date> = []
  private readonly values = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key)
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarms.push(scheduledTime)
  }

  async transaction<T>(closure: () => T | Promise<T>): Promise<T> {
    const snapshot = this.snapshotSql()
    this.sql.queries.push('transaction begin')
    try {
      const result = await closure()
      this.sql.queries.push('transaction commit')
      return result
    } catch (error) {
      this.restoreSql(snapshot)
      this.sql.queries.push('transaction rollback')
      throw error
    }
  }

  private snapshotSql(): RecordingSqlSnapshot {
    return {
      docs: new Map(this.sql.docs),
      opLog: new Map(this.sql.opLog),
      messageDedup: new Map(this.sql.messageDedup),
      quarantines: new Map(this.sql.quarantines),
      checkpointRuns: new Map(this.sql.checkpointRuns),
      snapshotHealthEvents: [...this.sql.snapshotHealthEvents],
      setupTokens: new Map(this.sql.setupTokens),
      refreshTokens: new Map(this.sql.refreshTokens),
      blobMultipartUploads: new Map(this.sql.blobMultipartUploads),
      blobMultipartParts: new Map(this.sql.blobMultipartParts),
      devices: new Map(this.sql.devices),
      migrationVersions: new Set(this.sql.migrationVersions),
      messageDedupColumns: new Set(this.sql.messageDedupColumns),
      tableColumns: new Map(this.sql.tableColumns),
      tableRowCounts: new Map(this.sql.tableRowCounts),
      tableRows: new Map(this.sql.tableRows),
      tableColumnDetails: new Map(this.sql.tableColumnDetails),
      tableIndexes: new Map(this.sql.tableIndexes),
      tableForeignKeys: new Map(this.sql.tableForeignKeys),
    }
  }

  private restoreSql(snapshot: RecordingSqlSnapshot): void {
    replaceMap(this.sql.docs, snapshot.docs)
    replaceMap(this.sql.opLog, snapshot.opLog)
    replaceMap(this.sql.messageDedup, snapshot.messageDedup)
    replaceMap(this.sql.quarantines, snapshot.quarantines)
    replaceMap(this.sql.checkpointRuns, snapshot.checkpointRuns)
    this.sql.snapshotHealthEvents.splice(
      0,
      this.sql.snapshotHealthEvents.length,
      ...snapshot.snapshotHealthEvents,
    )
    replaceMap(this.sql.setupTokens, snapshot.setupTokens)
    replaceMap(this.sql.refreshTokens, snapshot.refreshTokens)
    replaceMap(this.sql.blobMultipartUploads, snapshot.blobMultipartUploads)
    replaceMap(this.sql.blobMultipartParts, snapshot.blobMultipartParts)
    replaceMap(this.sql.devices, snapshot.devices)
    replaceSet(this.sql.migrationVersions, snapshot.migrationVersions)
    replaceSet(this.sql.messageDedupColumns, snapshot.messageDedupColumns)
    replaceMap(this.sql.tableColumns, snapshot.tableColumns)
    replaceMap(this.sql.tableRowCounts, snapshot.tableRowCounts)
    replaceMap(this.sql.tableRows, snapshot.tableRows)
    replaceMap(this.sql.tableColumnDetails, snapshot.tableColumnDetails)
    replaceMap(this.sql.tableIndexes, snapshot.tableIndexes)
    replaceMap(this.sql.tableForeignKeys, snapshot.tableForeignKeys)
  }
}

export function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of source) {
    target.set(key, value)
  }
}

export function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
  target.clear()
  for (const value of source) {
    target.add(value)
  }
}

export class FakeState implements DurableObjectStateBinding {
  readonly accepted: RuntimeWebSocket[] = []

  constructor(readonly storage: DurableObjectStorageBinding = new MemoryStorage()) {}

  acceptWebSocket(webSocket: RuntimeWebSocket): void {
    webSocket.accept?.()
    this.accepted.push(webSocket)
  }

  getWebSockets(): readonly RuntimeWebSocket[] {
    return this.accepted
  }
}
import {
  CURRENT_PROTOCOL_VERSION,
  DEVICE_TOKEN_ISSUER,
  AckSchema,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  makeVaultId,
  makeYDocId,
  type Ack,
  type AwarenessUpdate,
  type ClientHello,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type BlobManifest,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import { assert } from 'vitest'
import * as Y from 'yjs'

import type { DurableObjectIdBinding, DurableObjectStubBinding, WorkerEnv } from '../runtime'
import type { RecordedQuarantineRow } from './sql'

export const TEST_DEVICE_TOKEN_SECRET = 'test-device-token-secret'

export function makeEnv(): WorkerEnv {
  return {
    VAULT_ROOM: {
      idFromName(): DurableObjectIdBinding {
        return {}
      },
      get(): DurableObjectStubBinding {
        return {
          async fetch(): Promise<Response> {
            return new Response('unused')
          },
        }
      },
    },
  }
}

export function quarantineSqlRow(row: RecordedQuarantineRow): Record<string, unknown> {
  return {
    id: row.id,
    docId: row.docId,
    messageId: row.messageId,
    deviceId: row.deviceId,
    reason: row.reason,
    updateSha256: row.updateSha256,
    updateBytes: row.updateBytes,
    createdAt: row.createdAt,
  }
}

export function makeEnvWithSnapshotBucket(bucket: R2BucketBinding): WorkerEnv {
  return { ...makeEnv(), SNAPSHOT_BUCKET: bucket }
}

export function makeEnvWithSnapshotBucketAndDeviceTokenSecret(
  bucket: R2BucketBinding,
  secret: string,
): WorkerEnv {
  return { ...makeEnvWithSnapshotBucket(bucket), DEVICE_TOKEN_SECRET: secret }
}

export function makeEnvWithDeviceTokenSecret(secret: string): WorkerEnv {
  return { ...makeEnv(), DEVICE_TOKEN_SECRET: secret }
}

export async function makeAuthenticatedWebSocketRequest(
  secret = TEST_DEVICE_TOKEN_SECRET,
  overrides: Partial<DeviceTokenClaims> = {},
): Promise<Request> {
  return new Request('https://worker.example/ws/vault-1', {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${await makeDeviceToken(secret, {
        tokenVersion: 1,
        ...overrides,
      })}`,
    },
  })
}

export function makeHello(): ClientHello {
  return {
    type: 'hello',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    capabilities: ['metadata-schema-v2'],
  }
}

export function makeSyncUpdate(messageId: SyncUpdate['messageId']): SyncUpdate {
  return {
    type: 'sync-update',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId,
    docId: { kind: 'meta' },
    update: makeYjsUpdateBase64(messageId),
  }
}

export function makeSyncRequest(
  messageId: SyncRequest['messageId'],
  stateVector: string,
): SyncRequest {
  return {
    type: 'sync-request',
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    messageId,
    docId: { kind: 'meta' },
    stateVector,
  }
}

export function makeAwarenessUpdate(
  clientId: number,
  state: Record<string, unknown> | null,
): AwarenessUpdate {
  return {
    type: 'awareness-update',
    vaultId: makeVaultId('vault-1'),
    deviceId: makeDeviceId('device-1'),
    docId: { kind: 'meta' },
    clientId,
    state,
  }
}

export function makeYjsUpdateBase64(messageId: SyncUpdate['messageId']): string {
  const doc = new Y.Doc()
  const fileId = makeFileId(`file-${messageId}`)
  const entry = new Y.Map<unknown>()
  entry.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId(`ydoc-${messageId}`),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
  })
  entry.set('location', {
    path: `${messageId}.md`,
    canonicalPath: `${messageId}.md`,
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  entry.set('content', { contentUpdatedAt: 1, contentUpdatedBy: makeDeviceId('device-1') })
  entry.set('deletion', { deleted: false })
  doc.getMap('meta').set(fileId, entry)
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

export function makeInvalidMetaSchemaYjsUpdateBase64(): string {
  const doc = new Y.Doc()
  const fileId = makeFileId('file-invalid-meta')
  doc.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: 'Valid.md',
    canonicalPath: 'wrong.md',
    deleted: false,
    type: 'text',
    ydocId: makeYDocId('ydoc-invalid-meta'),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

export function makeLargeFileYjsUpdateBase64(): string {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'x'.repeat(600 * 1024))
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

export function makeYjsUpdateBytes(messageId: SyncUpdate['messageId']): Uint8Array {
  return new Uint8Array(Buffer.from(makeYjsUpdateBase64(messageId), 'base64'))
}

export function stringMessageAt(
  messages: readonly (string | ArrayBuffer)[],
  index: number,
): string {
  const message = syncMessages(messages)[index]
  if (message === undefined) {
    throw new Error(`missing message at index ${index}`)
  }
  return stringMessage(message)
}

export function findAckForMessage(
  messages: readonly (string | ArrayBuffer)[],
  messageId: string,
): Ack | undefined {
  for (const message of syncMessages(messages)) {
    if (typeof message !== 'string') {
      continue
    }
    const parsed = JSON.parse(message) as unknown
    if (v.is(AckSchema, parsed) && parsed.messageId === messageId) {
      return parsed
    }
  }
  return undefined
}

export function hasTypeProperty(obj: unknown): obj is { type: unknown } {
  return typeof obj === 'object' && obj !== null && 'type' in obj
}

export function syncMessages(
  messages: readonly (string | ArrayBuffer)[],
): readonly (string | ArrayBuffer)[] {
  return messages.filter((message) => {
    if (typeof message !== 'string') {
      return true
    }
    const parsed: unknown = JSON.parse(message)
    if (hasTypeProperty(parsed) && typeof parsed.type === 'string') {
      return parsed.type !== 'hello-accepted'
    }
    return true
  })
}

export function stringMessage(message: string | ArrayBuffer): string {
  if (typeof message !== 'string') {
    throw new Error('expected string message')
  }
  return message
}

export function makeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export function makeStateVectorBase64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString('base64')
}

export function decodeTestBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

export async function makeDeviceToken(
  secret: string,
  overrides: Partial<DeviceTokenClaims> = {},
): Promise<string> {
  const now = Date.now()
  const claims: DeviceTokenClaims = {
    iss: DEVICE_TOKEN_ISSUER,
    aud: makeVaultId('vault-1'),
    sub: makeDeviceId('device-1'),
    scope: ['sync:read', 'sync:write'] satisfies readonly DeviceTokenScope[],
    iat: now - 1_000,
    exp: now + 60_000,
    tokenVersion: 2,
    ...overrides,
  }
  const encodedHeader = encodeTestBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const encodedPayload = encodeTestBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await signTestHs256(`${encodedHeader}.${encodedPayload}`, secret)
  return `${encodedHeader}.${encodedPayload}.${encodeTestBase64Url(signature)}`
}

export async function signTestHs256(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))
}

export function encodeTestBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export async function hashTestText(value: string): Promise<string> {
  return hashTestBytes(new TextEncoder().encode(value))
}

export async function hashTestBytes(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength)
  bytes.set(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function testBlobManifest(): BlobManifest {
  return {
    version: 1,
    fileId: makeFileId('file-1'),
    contentSha256: makeSha256Hex('f'.repeat(64)),
    size: 123,
    chunks: [
      { sha256: makeSha256Hex('d'.repeat(64)), offset: 0, size: 64 },
      { sha256: makeSha256Hex('e'.repeat(64)), offset: 64, size: 59 },
    ],
    createdBy: makeDeviceId('device-1'),
    createdAt: 1_000,
  }
}

export function expectString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('expected string SQL binding')
  }
  return value
}

export function expectNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('expected number SQL binding')
  }
  return value
}

export function expectUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  throw new Error('expected Uint8Array SQL binding')
}

export function installFakeWebSocketPair(): unknown {
  const previous = Reflect.get(globalThis, 'WebSocketPair')
  Reflect.set(globalThis, 'WebSocketPair', FakeWebSocketPair)
  return previous
}

export function installFakeUpgradeResponse(): unknown {
  const previous = Reflect.get(globalThis, 'Response')
  Reflect.set(globalThis, 'Response', FakeUpgradeResponse)
  return previous
}

export function restoreWebSocketPair(previous: unknown): void {
  if (previous === undefined) {
    Reflect.deleteProperty(globalThis, 'WebSocketPair')
    return
  }
  Reflect.set(globalThis, 'WebSocketPair', previous)
}

export function restoreResponse(previous: unknown): void {
  Reflect.set(globalThis, 'Response', previous)
}
export async function seedVerifiedSnapshotEvidence(
  storage: SqlOnlyStorage,
  snapshotKey: string,
  docId: 'meta' | `file:${string}`,
  bytes: Uint8Array,
  authorityStatus: 'candidate' | 'authoritative' = 'authoritative',
): Promise<void> {
  const snapshotDoc = new Y.Doc()
  Y.applyUpdate(snapshotDoc, bytes)
  const stateVector = Y.encodeStateVector(snapshotDoc)
  snapshotDoc.destroy()
  const seqText = snapshotKey.slice(snapshotKey.lastIndexOf('/') + 1, -'.yupdate'.length)
  const upperSeq = Number(seqText)
  const expectedUpdateSha256 = await hashTestBytes(bytes)
  const expectedStateVectorSha256 = await hashTestBytes(stateVector)
  const base = {
    id: storage.sql.snapshotHealthEvents.length + 1,
    docId,
    snapshotKey,
    upperSeq,
    actor: 'system:verifier',
    authorityStatus,
    expectedByteLength: bytes.byteLength,
    expectedUpdateSha256,
    expectedStateVectorSha256,
    actualByteLength: bytes.byteLength,
    actualUpdateSha256: expectedUpdateSha256,
    actualStateVectorSha256: expectedStateVectorSha256,
    physicalStatus: 'verified',
    logicalStatus: 'healthy',
    reasons: '[]',
    observedAt: 1,
  } as const
  storage.sql.snapshotHealthEvents.push({ ...base, event: 'verification' })
}
export function makePoisonedMetaDoc(fileId: ReturnType<typeof makeFileId>): Y.Doc {
  const parent = new Y.Doc()
  const parentEntry = new Y.Map<unknown>()
  parentEntry.set('identity', {
    schemaVersion: 2,
    fileId,
    type: 'text',
    ydocId: makeYDocId(`poison-${fileId}`),
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
  })
  parentEntry.set('location', {
    path: 'Notes/Poison.md',
    canonicalPath: 'notes/poison.md',
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  })
  parentEntry.set('content', { contentUpdatedAt: 1, contentUpdatedBy: makeDeviceId('device-1') })
  parentEntry.set('deletion', { deleted: false })
  parent.getMap('meta').set(fileId, parentEntry)

  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(parent))
  const clientEntry = client.getMap<Y.Map<unknown>>('meta').get(fileId)
  assert(clientEntry instanceof Y.Map)
  clientEntry.set('location', {
    path: 'Notes/Poisoned.md',
    canonicalPath: 'notes/poisoned.md',
    updatedAt: 2,
    updatedBy: makeDeviceId('device-1'),
    mtime: 2,
  })
  const pendingUpdate = Y.encodeStateAsUpdate(client, Y.encodeStateVector(parent))

  const poisoned = new Y.Doc()
  Y.applyUpdate(poisoned, pendingUpdate)
  client.destroy()
  parent.destroy()
  return poisoned
}
