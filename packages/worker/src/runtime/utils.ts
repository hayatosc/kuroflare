import {
  DeviceIdSchema,
  decodeMetaValue,
  FileIdSchema,
  groupedEntryFromMetaFile,
  MetadataAccessSchema,
  MessageIdSchema,
  Sha256HexSchema,
  YDocIdSchema,
  makeDeviceId,
  type AdminOperation,
  type AdminOperationEffect,
  type ApiError,
  type ApiErrorCode,
  type DeviceId,
  type DocId,
  type Sha256Hex,
  type SyncUpdate,
  type MetaValueDisposition,
  type VaultId,
} from '@kuroflare/core'
import { VaultIdSchema } from '@kuroflare/core'
import * as v from 'valibot'
import * as Y from 'yjs'

import { type CheckpointRunStatus } from '../checkpoint/checkpoint'
import { type QuarantinedUpdateRow } from '../db/checkpointRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import type { QuarantinedUpdateRecord } from '../quarantine'
import { type SnapshotCandidate } from '../sync/snapshots'
import { type SessionState, type WebSocketAttachment, PosIntSchema, NonNegIntSchema } from './types'

const RETRYABLE_API_ERROR_CODES = new Set<ApiErrorCode>([
  'rate-limited',
  'server/degraded',
  'server/error',
])

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

export function adminOperationConfirmationSubject(operation: AdminOperation): string {
  return `admin-operation:${operation}`
}

export function adminOperationConfirmationStorageKey(subject: string): string {
  return `admin-operation-confirmation:${subject}`
}

export function adminOperationPlaceholderEffect(operation: AdminOperation): AdminOperationEffect {
  switch (operation) {
    case 'force-local':
    case 'force-remote':
      return { kind: 'rewrite-meta', count: 1, detail: `${operation}:not-implemented` }
    case 'rebuild':
      return { kind: 'rebuild-index', count: 1, detail: 'not-implemented' }
    case 'gc':
      return { kind: 'delete-snapshot', count: 0, detail: 'snapshot-retention' }
  }
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

export function quarantinedUpdateRecordFromSqlRow(
  row: QuarantinedUpdateRow | undefined,
): QuarantinedUpdateRecord | undefined {
  if (row === undefined) {
    return undefined
  }

  const docId = docIdFromKey(row.docId)
  const updateBytes = readSqlUpdateBytes(row.updateBytes)
  if (
    docId === undefined ||
    !v.is(MessageIdSchema, row.messageId) ||
    !v.is(DeviceIdSchema, row.deviceId) ||
    !isQuarantineReason(row.reason) ||
    !v.is(Sha256HexSchema, row.updateSha256) ||
    updateBytes === undefined ||
    !v.is(NonNegIntSchema, row.createdAt)
  ) {
    return undefined
  }

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
  return (
    value === 'hash-mismatch' || value === 'yjs-apply-failed' || value === 'meta-schema-invalid'
  )
}

export function isStoredQuarantineConfirmation(value: unknown): value is {
  readonly subject: string
  readonly tokenHash: string
  readonly expiresAt: number
} {
  return (
    isRecord(value) &&
    typeof value.subject === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.expiresAt === 'number'
  )
}

export function isStoredAdminOperationConfirmation(value: unknown): value is {
  readonly subject: string
  readonly tokenHash: string
  readonly expiresAt: number
} {
  return (
    isRecord(value) &&
    typeof value.subject === 'string' &&
    typeof value.tokenHash === 'string' &&
    typeof value.expiresAt === 'number'
  )
}

export function stateVectorCoversHorizon(
  clientStateVector: Uint8Array,
  horizonStateVector: Uint8Array | undefined,
): boolean {
  if (horizonStateVector === undefined || horizonStateVector.byteLength === 0) {
    return true
  }

  try {
    const client = Y.decodeStateVector(clientStateVector)
    const horizon = Y.decodeStateVector(horizonStateVector)
    for (const [clientId, horizonClock] of horizon) {
      if ((client.get(clientId) ?? 0) < horizonClock) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function canApplyYjsUpdate(updateBytes: Uint8Array): boolean {
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, updateBytes)
    return true
  } catch {
    return false
  } finally {
    candidate.destroy()
  }
}

/** Validates that an update is causally applicable to the supplied document. */
export function canApplyYjsUpdateToDoc(doc: Y.Doc, updateBytes: Uint8Array): boolean {
  try {
    const { from, to } = Y.parseUpdateMeta(updateBytes)
    const currentStateVector = Y.decodeStateVector(Y.encodeStateVector(doc))
    for (const [clientId, predecessorClock] of from) {
      if ((currentStateVector.get(clientId) ?? 0) < predecessorClock) return false
    }

    const candidate = new Y.Doc()
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc))
      Y.applyUpdate(candidate, updateBytes)
      const candidateStateVector = Y.decodeStateVector(Y.encodeStateVector(candidate))
      for (const [clientId, requiredClock] of to) {
        if ((candidateStateVector.get(clientId) ?? 0) < requiredClock) return false
      }
      const { ds } = Y.decodeUpdate(updateBytes)
      for (const [clientId, ranges] of ds.clients) {
        const coveredClock = candidateStateVector.get(clientId) ?? 0
        for (const range of ranges) {
          if (coveredClock < range.clock + range.len) return false
        }
      }
      return true
    } finally {
      candidate.destroy()
    }
  } catch {
    return false
  }
}

/** Returns true when Yjs retained pending structs or delete ranges beyond its state vector. */
export function hasUnresolvedYjsState(doc: Y.Doc): boolean {
  try {
    const stateVector = Y.encodeStateVector(doc)
    const state = Y.decodeStateVector(stateVector)
    const remainder = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, stateVector))
    if (remainder.structs.length > 0) return true
    for (const [clientId, ranges] of remainder.ds.clients) {
      const coveredClock = state.get(clientId) ?? 0
      for (const range of ranges) {
        if (coveredClock < range.clock + range.len) return true
      }
    }
    return false
  } catch {
    return true
  }
}

export type MetaDocumentDisposition =
  | 'supported-v2'
  | 'legacy-v1'
  | 'mixed'
  | 'unsupported'
  | 'invalid'

/** Classifies every root entry without treating legacy values as corrupt data. */
export function metaYDocSchemaDisposition(doc: Y.Doc): MetaDocumentDisposition {
  if (hasUnresolvedYjsState(doc)) return 'invalid'
  const meta = doc.getMap<unknown>('meta')
  if (meta.size === 0) return 'supported-v2'
  const dispositions = new Set<MetaValueDisposition>()
  for (const [fileId, value] of meta.entries()) {
    if (!v.is(FileIdSchema, fileId)) return 'invalid'
    dispositions.add(decodeMetaValue(value, fileId).disposition)
  }
  if (dispositions.has('invalid')) return 'invalid'
  if (dispositions.has('unsupported')) return 'unsupported'
  if (dispositions.size !== 1) return 'mixed'
  return dispositions.values().next().value === 'supported-v2' ? 'supported-v2' : 'legacy-v1'
}

/** Legacy schema is readable; only a fully grouped document is writable. */
export function metaYDocSchemaValid(doc: Y.Doc): boolean {
  const disposition = metaYDocSchemaDisposition(doc)
  return disposition === 'supported-v2' || disposition === 'legacy-v1'
}

export function metaYDocWritable(doc: Y.Doc): boolean {
  return metaYDocSchemaDisposition(doc) === 'supported-v2'
}

/** Existing grouped identities may not be changed or removed; new file IDs are allowed. */
export function metaIdentityImmutable(current: Y.Doc, candidate: Y.Doc): boolean {
  if (!metaYDocWritable(candidate)) return false
  const currentMeta = current.getMap<unknown>('meta')
  const candidateMeta = candidate.getMap<unknown>('meta')
  for (const [fileId, value] of currentMeta.entries()) {
    const currentEntry = decodeMetaValue(value, fileId)
    if (currentEntry.disposition === 'unsupported' || currentEntry.disposition === 'invalid') {
      return false
    }
    const currentIdentity =
      currentEntry.disposition === 'supported-v2'
        ? currentEntry.grouped?.identity
        : currentEntry.metaFile === undefined || currentEntry.metaFile.deleted
          ? undefined
          : groupedEntryFromMetaFile(currentEntry.metaFile).identity
    if (currentIdentity === undefined) return false
    const candidateEntry = decodeMetaValue(candidateMeta.get(fileId), fileId)
    if (
      candidateEntry.disposition !== 'supported-v2' ||
      candidateEntry.grouped === undefined ||
      JSON.stringify(candidateEntry.grouped.identity) !== JSON.stringify(currentIdentity)
    ) {
      return false
    }
  }
  return true
}

/** Rejects root replacement of grouped entries; nested group edits remain mergeable. */
export function metaRootMutationAllowed(
  current: Y.Doc,
  updateBytes: Uint8Array,
  allowLegacyMigration = false,
): boolean {
  const currentMeta = current.getMap<unknown>('meta')
  const candidate = new Y.Doc()
  let allowed = true
  const candidateMeta = candidate.getMap<unknown>('meta')
  const observer = (event: Y.YMapEvent<unknown>): void => {
    for (const [fileId, change] of event.changes.keys) {
      if (!currentMeta.has(fileId)) {
        if (change.action !== 'add') allowed = false
        continue
      }
      const currentDisposition = decodeMetaValue(currentMeta.get(fileId), fileId).disposition
      if (currentDisposition === 'unsupported' || currentDisposition === 'invalid') {
        allowed = false
        continue
      }
      if (currentDisposition === 'supported-v2' && change.action !== 'add') allowed = false
      if (currentDisposition === 'legacy-v1') {
        if (!allowLegacyMigration || change.action === 'delete') allowed = false
      }
    }
  }
  candidateMeta.observe(observer)
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current))
    Y.applyUpdate(candidate, updateBytes)
  } catch {
    allowed = false
  } finally {
    candidateMeta.unobserve(observer)
    candidate.destroy()
  }
  return allowed
}

/** Migrates an all-v1 document in one transaction using a fresh child map per root entry. */
export function migrateLegacyMetaDoc(doc: Y.Doc): boolean {
  const meta = doc.getMap<unknown>('meta')
  if (meta.size === 0) return true
  const entries: Array<[string, ReturnType<typeof groupedEntryFromMetaFile>]> = []
  for (const [fileId, value] of meta.entries()) {
    if (!v.is(FileIdSchema, fileId)) return false
    const decoded = decodeMetaValue(value, fileId)
    if (decoded.disposition !== 'legacy-v1' || decoded.metaFile === undefined) return false
    entries.push([fileId, groupedEntryFromMetaFile(decoded.metaFile)])
  }
  doc.transact(() => {
    for (const [fileId, grouped] of entries) {
      const child = new Y.Map<unknown>()
      child.set('identity', grouped.identity)
      child.set('location', grouped.location)
      child.set('content', grouped.content)
      child.set('deletion', grouped.deletion)
      meta.set(fileId, child)
    }
  }, 'metadata-schema-v2-migration')
  return true
}

export function isEmptyYjsUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2
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
  return value !== null && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}

export function isWebSocketAttachment(value: unknown): value is WebSocketAttachment {
  if (!isRecord(value)) {
    return false
  }
  const authToken = value.authToken
  const session = value.session
  return (
    (authToken === undefined || typeof authToken === 'string') &&
    (session === undefined || isSessionState(session))
  )
}

export function isSessionState(value: unknown): value is SessionState {
  if (!isRecord(value)) {
    return false
  }
  if ('yClientId' in value || 'y_client_id' in value) {
    return false
  }
  return (
    v.is(VaultIdSchema, value.vaultId) &&
    v.is(DeviceIdSchema, value.deviceId) &&
    (value.metadataAccess === undefined || v.is(MetadataAccessSchema, value.metadataAccess)) &&
    (value.metadataCapabilityAdvertised === undefined ||
      typeof value.metadataCapabilityAdvertised === 'boolean')
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isCheckpointRunStatus(value: unknown): value is CheckpointRunStatus {
  return (
    value === 'writing' ||
    value === 'r2-written' ||
    value === 'pointer-updated' ||
    value === 'compacted' ||
    value === 'completed' ||
    value === 'failed'
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
