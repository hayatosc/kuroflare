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
  type ClientHello,
  type DeviceTokenClaims,
  type DeviceTokenScope,
  type BlobManifest,
  type SyncRequest,
  type SyncUpdate,
} from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

import type {
  DurableObjectIdBinding,
  DurableObjectStubBinding,
  WorkerEnv,
  R2BucketBinding,
} from '..'
import { FakeWebSocketPair, FakeUpgradeResponse } from './fakes'
import type { RecordedQuarantineRow } from './sql-storage'

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
    yClientId: 1,
    capabilities: [],
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

export function makeYjsUpdateBase64(messageId: SyncUpdate['messageId']): string {
  const doc = new Y.Doc()
  const fileId = makeFileId(`file-${messageId}`)
  doc.getMap('meta').set(fileId, {
    schemaVersion: 1,
    fileId,
    path: `${messageId}.md`,
    canonicalPath: `${messageId}.md`,
    deleted: false,
    type: 'text',
    ydocId: makeYDocId(`ydoc-${messageId}`),
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
