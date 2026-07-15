import {
  BlobHeadRequestSchema,
  BlobUploadUrlRequestSchema,
  BlobManifestSchema,
  Sha256HexSchema,
  makeSha256Hex,
  encodeBlobManifestJson,
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
import {
  apiErrorBody,
  blobObjectKey,
  blobManifestObjectKey,
  parseBlobSize,
  parseContentLength,
  readRequestBytesWithLimit,
  sha256Hex,
} from './utils'
import type { VaultRoom } from './vault-room'

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
  if (body.size > BLOB_SINGLE_PUT_MAX_BYTES || body.multipart === true)
    return c.json(apiErrorBody('request/invalid', 'blob-upload-url:multipart-unimplemented'), 413)
  const vaultId = room.vaultId
  if (vaultId === undefined) return c.json(apiErrorBody('server/error', 'vault-unavailable'), 500)

  const now = Date.now()
  const expiresAt = now + BLOB_UPLOAD_URL_TTL_MS
  const uploadUrl = new URL(c.req.url)
  uploadUrl.pathname = `/blobs/${body.sha256}`
  uploadUrl.search = `?size=${body.size}`
  const object = await readBlobUploadEvidence(room, vaultId, body.sha256)
  const plan = planBlobUploadUrlHttpResponse({
    request: body,
    object,
    now,
    policy: { multipartThresholdBytes: BLOB_MULTIPART_THRESHOLD_BYTES },
    singlePut: { kind: 'single-put', url: uploadUrl.toString(), headers: {}, expiresAt },
  })
  if (plan.action === 'reject')
    return c.json(
      apiErrorBody('request/invalid', `blob-upload-url:${plan.reason}`),
      plan.reason === 'multipart-required' ? 413 : 400,
    )
  return c.json(plan.response, 200)
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
    return c.json(apiErrorBody('request/invalid', 'blob-upload-url:multipart-unimplemented'), 413)
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
