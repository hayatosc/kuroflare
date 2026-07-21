import {
  DeviceIdSchema,
  DocIdSchema,
  MetadataAccessSchema,
  MessageIdSchema,
  Sha256HexSchema,
  YDocIdSchema,
  makeDeviceId,
  timingSafeEqual,
  type ApiError,
  type ApiErrorCode,
  type DeviceId,
  type DocId,
  type QuarantineAuditAction,
  type QuarantineAuditEntry,
  type Sha256Hex,
  type SyncUpdate,
  type VaultId,
} from '@kuroflare/core'
import { VaultIdSchema } from '@kuroflare/core'
import * as v from 'valibot'

import { type CheckpointRunStatus } from '../checkpoint/checkpoint'
import { type QuarantineAuditEventRow, type QuarantinedUpdateRow } from '../db/checkpointRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import type { QuarantinedUpdateRecord } from '../quarantine'
import { type SnapshotCandidate } from '../sync/snapshots'
import {
  type SessionState,
  type WebSocketAttachment,
  type WebSocketAwarenessAttachment,
  PosIntSchema,
  NonNegIntSchema,
} from './types'

const RETRYABLE_API_ERROR_CODES = new Set<ApiErrorCode>([
  'rate-limited',
  'server/degraded',
  'server/error',
])

const StoredQuarantineConfirmationSchema = v.object({
  subject: v.string(),
  tokenHash: v.string(),
  expiresAt: v.number(),
})

/** Builds the guarded `ApiError` envelope every public HTTP failure response uses. */
export function apiErrorBody(code: ApiErrorCode, detail?: string): ApiError {
  return {
    code,
    retryable: RETRYABLE_API_ERROR_CODES.has(code),
    ...(detail === undefined ? {} : { detail }),
  }
}

export function docKey(docId: DocId): string {
  return docId.kind === 'meta' ? 'meta' : `file:${docId.ydocId}`
}

export function docIdFromKey(key: unknown): DocId | undefined {
  if (key === 'meta') {
    return { kind: 'meta' }
  }
  if (typeof key !== 'string' || !key.startsWith('file:')) {
    return undefined
  }

  const ydocId = key.slice('file:'.length)
  return v.is(YDocIdSchema, ydocId) ? { kind: 'file', ydocId } : undefined
}

export function makeQuarantineId(update: SyncUpdate): string {
  return `q-${update.messageId}`
}

export function blobObjectKey(vaultId: VaultId, sha256: Sha256Hex): string {
  return `vaults/${vaultId}/blobs/${sha256}`
}

export function blobManifestObjectKey(vaultId: VaultId, sha256: Sha256Hex): string {
  return `vaults/${vaultId}/blob-manifests/${sha256}.json`
}

export function quarantineConfirmationStorageKey(subject: string): string {
  return `quarantine-confirmation:${subject}`
}

export function compareCodeUnitString(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function parseBlobSize(request: Request): number | undefined {
  const rawSize = new URL(request.url).searchParams.get('size')
  if (rawSize === null || !/^(0|[1-9][0-9]*)$/.test(rawSize)) {
    return undefined
  }
  const size = Number(rawSize)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

export function parsePartNumber(raw: string | undefined, maxParts: number): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    return undefined
  }
  const partNumber = Number(raw)
  return Number.isSafeInteger(partNumber) && partNumber >= 1 && partNumber <= maxParts
    ? partNumber
    : undefined
}

export function parseContentLength(request: Request): number | undefined {
  const rawLength = request.headers.get('content-length')
  if (rawLength === null || !/^(0|[1-9][0-9]*)$/.test(rawLength)) {
    return undefined
  }
  const length = Number(rawLength)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

export async function readRequestBytesWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (request.body === null) {
    return new Uint8Array()
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) {
      break
    }
    total += result.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function snapshotCandidateFromKey(
  prefix: string,
  key: string,
): SnapshotCandidate | undefined {
  if (!key.startsWith(prefix) || !key.endsWith('.yupdate')) {
    return undefined
  }

  const seqText = key.slice(prefix.length, -'.yupdate'.length)
  if (!/^[1-9][0-9]*$/.test(seqText)) {
    return undefined
  }

  const upperSeq = Number(seqText)
  if (!v.is(PosIntSchema, upperSeq)) {
    return undefined
  }

  return { key, upperSeq, healthy: true }
}

const QuarantinedUpdateRowSchema = v.object({
  messageId: MessageIdSchema,
  deviceId: DeviceIdSchema,
  reason: v.picklist(['hash-mismatch', 'yjs-apply-failed', 'meta-schema-invalid']),
  updateSha256: Sha256HexSchema,
  createdAt: NonNegIntSchema,
})

export function quarantinedUpdateRecordFromSqlRow(
  row: QuarantinedUpdateRow | undefined,
): QuarantinedUpdateRecord | undefined {
  if (row === undefined) return undefined
  const docId = docIdFromKey(row.docId)
  const updateBytes = readSqlUpdateBytes(row.updateBytes)
  if (docId === undefined || updateBytes === undefined) return undefined
  if (!v.is(QuarantinedUpdateRowSchema, row)) return undefined

  return {
    id: row.id,
    docId,
    messageId: row.messageId,
    deviceId: row.deviceId,
    reason: row.reason,
    updateSha256: row.updateSha256,
    updateBytesLength: updateBytes.byteLength,
    createdAt: row.createdAt,
  }
}

export function isQuarantineReason(value: unknown): value is QuarantinedUpdateRecord['reason'] {
  return v.is(v.picklist(['hash-mismatch', 'yjs-apply-failed', 'meta-schema-invalid']), value)
}

export function isQuarantineAuditAction(value: unknown): value is QuarantineAuditAction {
  return v.is(v.picklist(['discarded-by-admin', 'force-applied-by-admin']), value)
}

const QuarantineAuditEventRowSchema = v.object({
  messageId: MessageIdSchema,
  deviceId: DeviceIdSchema,
  reason: v.picklist(['hash-mismatch', 'yjs-apply-failed', 'meta-schema-invalid']),
  action: v.picklist(['discarded-by-admin', 'force-applied-by-admin']),
  actor: DeviceIdSchema,
  quarantinedAt: NonNegIntSchema,
  resolvedAt: NonNegIntSchema,
  appliedSeq: v.nullable(PosIntSchema),
})

export function quarantineAuditEntryFromSqlRow(
  row: QuarantineAuditEventRow,
): QuarantineAuditEntry | undefined {
  const docId = docIdFromKey(row.docId)
  if (docId === undefined) return undefined
  if (!v.is(QuarantineAuditEventRowSchema, row)) return undefined

  return {
    quarantineId: row.quarantineId,
    docId,
    messageId: row.messageId,
    deviceId: row.deviceId,
    reason: row.reason,
    action: row.action,
    actor: row.actor,
    ...(row.appliedSeq === null ? {} : { appliedSeq: row.appliedSeq }),
    quarantinedAt: row.quarantinedAt,
    resolvedAt: row.resolvedAt,
  }
}

export function isStoredQuarantineConfirmation(value: unknown): value is {
  readonly subject: string
  readonly tokenHash: string
  readonly expiresAt: number
} {
  return v.is(StoredQuarantineConfirmationSchema, value)
}

export function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value)
    const bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

export function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function encodeOptionalBase64(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : encodeBase64(value)
}

/** Constant-time comparison for shared-secret headers (e.g. the admin token). */
export function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(left), encoder.encode(right))
}

export function extractBearerToken(authorization: string | null): string | undefined {
  if (authorization === null) {
    return undefined
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)
  return match?.[1]
}

export function extractWebSocketBearerToken(request: Request): string | undefined {
  const headerToken = extractBearerToken(request.headers.get('Authorization'))
  if (headerToken !== undefined) {
    return headerToken
  }

  const queryToken = new URL(request.url).searchParams.get('access_token')
  if (queryToken !== null && isCompactJwt(queryToken)) {
    return queryToken
  }

  return extractWebSocketProtocolToken(request.headers.get('Sec-WebSocket-Protocol'))
}

export function extractWebSocketProtocolToken(protocolHeader: string | null): string | undefined {
  if (protocolHeader === null) {
    return undefined
  }
  for (const token of protocolHeader.split(',')) {
    const trimmed = token.trim()
    if (isCompactJwt(trimmed)) {
      return trimmed
    }
    if (trimmed.startsWith('kuroflare-token.')) {
      const encoded = trimmed.slice('kuroflare-token.'.length)
      if (isCompactJwt(encoded)) {
        return encoded
      }
    }
  }
  return undefined
}

export function isCompactJwt(value: string | null): boolean {
  return (
    value !== null &&
    v.is(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)), value)
  )
}

const WebSocketAwarenessAttachmentSchema = v.object({
  docId: DocIdSchema,
  clientId: NonNegIntSchema,
})

const WebSocketAttachmentSchema = v.object({
  authToken: v.optional(v.string()),
  session: v.optional(v.custom(isSessionState)),
  awareness: v.optional(v.custom<WebSocketAwarenessAttachment>(isWebSocketAwarenessAttachment)),
})

export function isWebSocketAttachment(value: unknown): value is WebSocketAttachment {
  return v.is(WebSocketAttachmentSchema, value)
}

export function isWebSocketAwarenessAttachment(
  value: unknown,
): value is WebSocketAwarenessAttachment {
  return v.is(WebSocketAwarenessAttachmentSchema, value)
}

const SessionStateSchema = v.pipe(
  v.object({
    vaultId: VaultIdSchema,
    deviceId: DeviceIdSchema,
    metadataAccess: v.optional(MetadataAccessSchema),
    metadataCapabilityAdvertised: v.optional(v.boolean()),
  }),
  v.check((s) => !('yClientId' in s) && !('y_client_id' in s)),
)

export function isSessionState(value: unknown): value is SessionState {
  return v.is(SessionStateSchema, value)
}

export function isCheckpointRunStatus(value: unknown): value is CheckpointRunStatus {
  return v.is(
    v.picklist(['writing', 'r2-written', 'pointer-updated', 'compacted', 'completed', 'failed']),
    value,
  )
}

export function checkpointRunStatus(value: unknown): CheckpointRunStatus {
  return isCheckpointRunStatus(value) ? value : 'failed'
}

export function retentionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 256 ? message : `${message.slice(0, 253)}...`
}

/**
 * Emits a single-line structured JSON log entry for one of the runtime's
 * minimal operational events (checkpoint lifecycle, quarantine, auth reject).
 * Callers must not pass token material, update bytes, or user content in
 * `fields`.
 */
export function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function makeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

export function makeOpaqueToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

export function encodeBase64Url(value: Uint8Array): string {
  return encodeBase64(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function makeGeneratedDeviceId(): DeviceId {
  return makeDeviceId(`device-${crypto.randomUUID()}`)
}
