import {
  BlobHeadRequestSchema,
  BlobUploadUrlRequestSchema,
  BlobMultipartCompleteRequestSchema,
  BlobMultipartAbortRequestSchema,
  BlobUploadIdSchema,
  BlobManifestSchema,
  BLOB_MULTIPART_PART_SIZE_BYTES,
  MAX_BLOB_MULTIPART_PARTS,
  Sha256HexSchema,
  blobMultipartPartCount,
  blobMultipartPartByteSize,
  makeSha256Hex,
  encodeBlobManifestJson,
  type BlobMultipartCompletePart,
  type BlobMultipartUploadPart,
  type BlobMultipartUploadResponse,
  type Sha256Hex,
  type VaultId,
} from '@kuroflare/core'
import { type Context } from 'hono'
import * as v from 'valibot'

import {
  planBlobHeadHttpResponse,
  planBlobUploadUrlHttpResponse,
  type BlobHeadObjectEvidence,
  type BlobUploadObjectEvidence,
} from '../http/blob'
import { authorizeHttpRequest } from './auth'
import {
  BLOB_MANIFEST_MAX_BYTES,
  BLOB_MULTIPART_THRESHOLD_BYTES,
  BLOB_SINGLE_PUT_MAX_BYTES,
  BLOB_UPLOAD_URL_TTL_MS,
} from './constants'
import type { VaultRoom } from './room'
import {
  deleteBlobMultipartUpload,
  persistBlobMultipartPart,
  persistBlobMultipartUpload,
  readExpiredBlobMultipartUploads,
  readBlobMultipartParts,
  readBlobMultipartUpload,
} from './storage'
import type { R2MultipartUploadBinding } from './types'
import {
  apiErrorBody,
  blobObjectKey,
  blobManifestObjectKey,
  parseBlobSize,
  parseContentLength,
  parsePartNumber,
  readRequestBytesWithLimit,
  sha256Hex,
} from './utils'

const EXPIRED_BLOB_MULTIPART_UPLOAD_SWEEP_LIMIT = 16

export async function handleBlobHead(room: VaultRoom, c: Context): Promise<Response> {
  if (room.env.SNAPSHOT_BUCKET === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:read'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(BlobHeadRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-head-request'), 400)

  const objects: BlobHeadObjectEvidence[] = []
  for (const hash of body.hashes) objects.push(await readBlobHeadEvidence(room, vaultId, hash))

  const plan = planBlobHeadHttpResponse({ request: body, objects })
  if (plan.action === 'reject')
    return c.json(apiErrorBody('request/invalid', `blob-head:${plan.reason}`), 400)
  return c.json(plan.response, 200)
}

export async function handleBlobUploadUrl(room: VaultRoom, c: Context): Promise<Response> {
  if (room.env.SNAPSHOT_BUCKET === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:write'])
  if (rejection !== undefined) return rejection

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(BlobUploadUrlRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-upload-url-request'), 400)
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const now = Date.now()
  const expiresAt = now + BLOB_UPLOAD_URL_TTL_MS
  const uploadUrl = new URL(c.req.url)
  uploadUrl.pathname = `/blobs/${body.sha256}`
  uploadUrl.search = `?size=${body.size}`
  const object = await readBlobUploadEvidence(room, vaultId, body.sha256)

  const requiresMultipart = body.size >= BLOB_MULTIPART_THRESHOLD_BYTES || body.multipart === true
  let multipart: BlobMultipartUploadResponse | undefined
  if (!object.found && requiresMultipart) {
    multipart = await createBlobMultipartUploadTarget(
      room,
      vaultId,
      body.sha256,
      body.size,
      c.req.url,
      now,
      expiresAt,
    )
    if (multipart === undefined)
      return c.json(apiErrorBody('request/invalid', 'blob-upload-url:blob-too-large'), 413)
  }

  const plan = planBlobUploadUrlHttpResponse({
    request: body,
    object,
    now,
    policy: { multipartThresholdBytes: BLOB_MULTIPART_THRESHOLD_BYTES },
    singlePut: { kind: 'single-put', url: uploadUrl.toString(), headers: {}, expiresAt },
    multipart,
  })
  if (plan.action === 'reject')
    return c.json(
      apiErrorBody('request/invalid', `blob-upload-url:${plan.reason}`),
      plan.reason === 'multipart-required' ? 413 : 400,
    )
  return c.json(plan.response, 200)
}

/**
 * Starts an R2 multipart upload session and plans one proxy PUT URL per part.
 *
 * @returns The multipart response to offer the client, or `undefined` when the
 * blob would need more parts than R2 allows (caller rejects as too large).
 */
async function createBlobMultipartUploadTarget(
  room: VaultRoom,
  vaultId: VaultId,
  sha256: Sha256Hex,
  size: number,
  requestUrl: string,
  now: number,
  expiresAt: number,
): Promise<BlobMultipartUploadResponse | undefined> {
  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined) return undefined
  const partCount = blobMultipartPartCount(size, BLOB_MULTIPART_PART_SIZE_BYTES)
  if (partCount > MAX_BLOB_MULTIPART_PARTS) return undefined

  const upload = await bucket.createMultipartUpload(blobObjectKey(vaultId, sha256))
  const parts: BlobMultipartUploadPart[] = []
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const url = new URL(requestUrl)
    url.pathname = `/blobs/${sha256}/parts/${upload.uploadId}/${partNumber}`
    url.search = ''
    parts.push({ partNumber, url: url.toString(), headers: {} })
  }
  await persistBlobMultipartUpload(room, upload.uploadId, sha256, size, now, expiresAt)
  return { kind: 'multipart', uploadId: upload.uploadId, parts, expiresAt }
}

export async function handleBlobGet(room: VaultRoom, c: Context): Promise<Response> {
  const hash = c.req.param('hash')
  if (!v.is(Sha256HexSchema, hash))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-hash'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['blob:read'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const object = await room.env.SNAPSHOT_BUCKET?.get(blobObjectKey(vaultId, hash))
  if (object === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)
  if (object === null) return c.json(apiErrorBody('request/not-found', 'blob-not-found'), 404)

  const bytes = new Uint8Array(await object.arrayBuffer())
  if (makeSha256Hex(await sha256Hex(bytes)) !== hash)
    return c.json(apiErrorBody('blob/hash-mismatch'), 500)
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'x-content-sha256': hash,
    },
  })
}

export async function handleBlobPut(room: VaultRoom, c: Context): Promise<Response> {
  const hash = c.req.param('hash')
  if (!v.is(Sha256HexSchema, hash))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-hash'), 400)

  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:write'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const expectedSize = parseBlobSize(c.req.raw)
  if (expectedSize === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-size'), 400)
  if (expectedSize > BLOB_SINGLE_PUT_MAX_BYTES)
    return c.json(apiErrorBody('request/invalid', 'blob-put:use-multipart'), 413)
  const contentLength = parseContentLength(c.req.raw)
  if (contentLength === undefined || contentLength > BLOB_SINGLE_PUT_MAX_BYTES)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-size'), 413)
  const bytes = await readRequestBytesWithLimit(c.req.raw, BLOB_SINGLE_PUT_MAX_BYTES)
  if (bytes === undefined) return c.json(apiErrorBody('request/invalid', 'invalid-blob-size'), 413)
  if (bytes.byteLength !== expectedSize)
    return c.json(apiErrorBody('request/invalid', 'blob/size-mismatch'), 400)
  if (makeSha256Hex(await sha256Hex(bytes)) !== hash)
    return c.json(apiErrorBody('blob/hash-mismatch'), 400)

  await bucket.put(blobObjectKey(vaultId, hash), bytes)
  return c.json({ status: 'stored', sha256: hash, size: bytes.byteLength }, 200)
}

export async function handleBlobPartPut(room: VaultRoom, c: Context): Promise<Response> {
  const hash = c.req.param('hash')
  if (!v.is(Sha256HexSchema, hash))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-hash'), 400)
  const uploadId = c.req.param('uploadId')
  if (uploadId === undefined || !v.is(BlobUploadIdSchema, uploadId))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-upload-id'), 400)
  const partNumber = parsePartNumber(c.req.param('partNumber'), MAX_BLOB_MULTIPART_PARTS)
  if (partNumber === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-part-number'), 400)

  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:write'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const upload = await readBlobMultipartUpload(room, uploadId)
  if (upload === undefined || upload.sha256 !== hash)
    return c.json(apiErrorBody('request/not-found', 'blob-part:upload-not-found'), 404)
  if (upload.expiresAt <= Date.now())
    return c.json(apiErrorBody('request/not-found', 'blob-part:upload-expired'), 410)

  const partCount = blobMultipartPartCount(upload.size, BLOB_MULTIPART_PART_SIZE_BYTES)
  if (partNumber > partCount)
    return c.json(apiErrorBody('request/invalid', 'blob-part:part-number-out-of-range'), 400)
  const expectedSize = blobMultipartPartByteSize(
    upload.size,
    BLOB_MULTIPART_PART_SIZE_BYTES,
    partNumber,
    partCount,
  )

  const contentLength = parseContentLength(c.req.raw)
  if (contentLength === undefined || contentLength > BLOB_MULTIPART_PART_SIZE_BYTES)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-size'), 413)
  const bytes = await readRequestBytesWithLimit(c.req.raw, BLOB_MULTIPART_PART_SIZE_BYTES)
  if (bytes === undefined) return c.json(apiErrorBody('request/invalid', 'invalid-blob-size'), 413)
  if (bytes.byteLength !== expectedSize)
    return c.json(apiErrorBody('request/invalid', 'blob/size-mismatch'), 400)

  const partSha256 = makeSha256Hex(await sha256Hex(bytes))
  const uploaded = await bucket
    .resumeMultipartUpload(blobObjectKey(vaultId, hash), uploadId)
    .uploadPart(partNumber, bytes)
  await persistBlobMultipartPart(
    room,
    uploadId,
    partNumber,
    uploaded.etag,
    bytes.byteLength,
    partSha256,
  )
  return c.json({ status: 'stored', partNumber, etag: uploaded.etag, size: bytes.byteLength }, 200)
}

export async function handleBlobMultipartComplete(room: VaultRoom, c: Context): Promise<Response> {
  const hash = c.req.param('hash')
  if (!v.is(Sha256HexSchema, hash))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-hash'), 400)

  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:write'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(BlobMultipartCompleteRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-multipart-complete-request'), 400)

  const upload = await readBlobMultipartUpload(room, body.uploadId)
  if (upload === undefined || upload.sha256 !== hash)
    return c.json(
      apiErrorBody('request/not-found', 'blob-multipart-complete:upload-not-found'),
      404,
    )

  const key = blobObjectKey(vaultId, hash)
  const multipartUpload = bucket.resumeMultipartUpload(key, body.uploadId)
  if (upload.expiresAt <= Date.now()) {
    await abortBlobMultipartUpload(room, multipartUpload, body.uploadId)
    return c.json(apiErrorBody('request/not-found', 'blob-multipart-complete:upload-expired'), 410)
  }

  const persistedParts = await readBlobMultipartParts(room, body.uploadId)
  const partCount = blobMultipartPartCount(upload.size, BLOB_MULTIPART_PART_SIZE_BYTES)
  if (!multipartCompletePartsMatchPersisted(body.parts, persistedParts, partCount)) {
    await abortBlobMultipartUpload(room, multipartUpload, body.uploadId)
    return c.json(apiErrorBody('request/invalid', 'blob-multipart-complete:part-mismatch'), 400)
  }

  try {
    await multipartUpload.complete(
      persistedParts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    )
  } catch {
    await abortBlobMultipartUpload(room, multipartUpload, body.uploadId)
    return c.json(apiErrorBody('server/error', 'blob-multipart-complete:complete-failed'), 500)
  }

  // The object is only made visible to readers via `blobObjectKey` above once this
  // full-content hash check passes; a mismatch here means R2 assembled parts that
  // don't add up to the addressed content, so the object must not stay reachable.
  const object = await bucket.get(key)
  const bytes = object === null ? undefined : new Uint8Array(await object.arrayBuffer())
  if (bytes === undefined || makeSha256Hex(await sha256Hex(bytes)) !== hash) {
    await bucket.delete(key)
    await deleteBlobMultipartUpload(room, body.uploadId)
    return c.json(apiErrorBody('blob/hash-mismatch'), 400)
  }

  await deleteBlobMultipartUpload(room, body.uploadId)
  return c.json({ status: 'stored', sha256: hash, size: bytes.byteLength }, 200)
}

export async function handleBlobMultipartAbort(room: VaultRoom, c: Context): Promise<Response> {
  const hash = c.req.param('hash')
  if (!v.is(Sha256HexSchema, hash))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-hash'), 400)

  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:write'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const body: unknown = await c.req.json().catch(() => undefined)
  if (!v.is(BlobMultipartAbortRequestSchema, body))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-multipart-abort-request'), 400)

  // Idempotent: an already-aborted or expired-and-swept session has no pending
  // row left, and retrying abort against it should still report success.
  const upload = await readBlobMultipartUpload(room, body.uploadId)
  if (upload !== undefined && upload.sha256 === hash) {
    const multipartUpload = bucket.resumeMultipartUpload(
      blobObjectKey(vaultId, hash),
      body.uploadId,
    )
    await abortBlobMultipartUpload(room, multipartUpload, body.uploadId)
  }
  return c.json({ status: 'aborted', sha256: hash }, 200)
}

/** Cross-checks the client's claimed parts against what the DO itself recorded per part. */
function multipartCompletePartsMatchPersisted(
  requestedParts: readonly BlobMultipartCompletePart[],
  persistedParts: readonly { readonly partNumber: number; readonly etag: string }[],
  expectedPartCount: number,
): boolean {
  if (requestedParts.length !== expectedPartCount || persistedParts.length !== expectedPartCount) {
    return false
  }
  const persistedByPartNumber = new Map(persistedParts.map((part) => [part.partNumber, part]))
  const seenPartNumbers = new Set<number>()
  for (const part of requestedParts) {
    if (seenPartNumbers.has(part.partNumber)) return false
    seenPartNumbers.add(part.partNumber)
    const persisted = persistedByPartNumber.get(part.partNumber)
    if (persisted === undefined || persisted.etag !== part.etag) return false
  }
  return true
}

/** Best-effort R2 abort (an already-completed or GC'd session may reject it) plus row cleanup. */
async function abortBlobMultipartUpload(
  room: VaultRoom,
  multipartUpload: R2MultipartUploadBinding,
  uploadId: string,
): Promise<void> {
  try {
    await multipartUpload.abort()
  } catch {
    // deliberate: an upload R2 already garbage-collected or completed cannot be
    // aborted again; the pending-row cleanup below is what actually matters here.
  }
  await deleteBlobMultipartUpload(room, uploadId)
}

export async function handleBlobManifestGet(room: VaultRoom, c: Context): Promise<Response> {
  const match = /^\/blob-manifests\/([^/]+)\.json$/.exec(c.req.path)
  const hash = match !== null && v.is(Sha256HexSchema, match[1]) ? match[1] : undefined
  if (hash === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-manifest-hash'), 400)

  const rejection = await authorizeHttpRequest(room, c, ['blob:read'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const object = await room.env.SNAPSHOT_BUCKET?.get(blobManifestObjectKey(vaultId, hash))
  if (object === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)
  if (object === null)
    return c.json(apiErrorBody('request/not-found', 'blob-manifest-not-found'), 404)

  const bytes = new Uint8Array(await object.arrayBuffer())
  if (makeSha256Hex(await sha256Hex(bytes)) !== hash)
    return c.json(apiErrorBody('blob/hash-mismatch', 'blob-manifest/hash-mismatch'), 500)
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(bytes.byteLength),
      'x-content-sha256': hash,
    },
  })
}

export async function handleBlobManifestPut(room: VaultRoom, c: Context): Promise<Response> {
  const match = /^\/blob-manifests\/([^/]+)\.json$/.exec(c.req.path)
  const hash = match !== null && v.is(Sha256HexSchema, match[1]) ? match[1] : undefined
  if (hash === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-manifest-hash'), 400)

  const bucket = room.env.SNAPSHOT_BUCKET
  if (bucket === undefined)
    return c.json(apiErrorBody('server/degraded', 'blob-storage-unavailable'), 503)

  const rejection = await authorizeHttpRequest(room, c, ['blob:write'])
  if (rejection !== undefined) return rejection
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const contentLength = parseContentLength(c.req.raw)
  if (contentLength === undefined || contentLength > BLOB_MANIFEST_MAX_BYTES)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-manifest-size'), 413)
  const requestBytes = await readRequestBytesWithLimit(c.req.raw, BLOB_MANIFEST_MAX_BYTES)
  if (requestBytes === undefined)
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-manifest-size'), 413)

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(requestBytes))
  } catch {
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-manifest-json'), 400)
  }
  if (!v.is(BlobManifestSchema, parsedBody))
    return c.json(apiErrorBody('request/invalid', 'invalid-blob-manifest-json'), 400)

  const canonicalBytes = encodeBlobManifestJson(parsedBody)
  if (makeSha256Hex(await sha256Hex(canonicalBytes)) !== hash)
    return c.json(apiErrorBody('blob/hash-mismatch', 'blob-manifest/hash-mismatch'), 400)

  await bucket.put(blobManifestObjectKey(vaultId, hash), canonicalBytes)
  return c.json({ status: 'stored', sha256: hash, size: canonicalBytes.byteLength }, 200)
}

async function readBlobHeadEvidence(
  room: VaultRoom,
  vaultId: VaultId,
  sha256: Sha256Hex,
): Promise<BlobHeadObjectEvidence> {
  const object = await room.env.SNAPSHOT_BUCKET?.head(blobObjectKey(vaultId, sha256))
  if (object === undefined || object === null) return { sha256, found: false }
  return { sha256, found: true, size: object.size }
}

async function readBlobUploadEvidence(
  room: VaultRoom,
  vaultId: VaultId,
  sha256: Sha256Hex,
): Promise<BlobUploadObjectEvidence> {
  const object = await room.env.SNAPSHOT_BUCKET?.head(blobObjectKey(vaultId, sha256))
  if (object === undefined || object === null) return { sha256, found: false }
  return { sha256, found: true, size: object.size }
}

/**
 * Aborts pending multipart upload sessions past their `expiresAt` and clears
 * their pending rows. Runs from the same alarm as checkpoint/eviction
 * maintenance; see `VaultRoom.alarm()` for why this doesn't schedule its own
 * wakeup.
 */
export async function abortExpiredBlobMultipartUploads(
  room: VaultRoom,
  now = Date.now(),
): Promise<void> {
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (bucket === undefined || vaultId === undefined) return

  const expired = await readExpiredBlobMultipartUploads(
    room,
    now,
    EXPIRED_BLOB_MULTIPART_UPLOAD_SWEEP_LIMIT,
  )
  for (const upload of expired) {
    if (!v.is(Sha256HexSchema, upload.sha256)) {
      await deleteBlobMultipartUpload(room, upload.uploadId)
      continue
    }
    try {
      await bucket
        .resumeMultipartUpload(blobObjectKey(vaultId, upload.sha256), upload.uploadId)
        .abort()
    } catch {
      // deliberate: R2 may have already garbage-collected or completed this session.
    }
    await deleteBlobMultipartUpload(room, upload.uploadId)
  }
}
