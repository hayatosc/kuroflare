import {
  BLOB_MULTIPART_PART_SIZE_BYTES,
  BlobHeadResponseSchema,
  BlobUploadUrlResponseSchema,
  assembleBlobBytes,
  blobMultipartPartByteSize,
  decideMaterializeWrite,
  makeSha256Hex,
  type BlobMultipartUploadResponse,
} from '@kuroflare/core'
import { TFile, TFolder } from 'obsidian'
import * as v from 'valibot'

import {
  type OutboxWorkerManifestPutSideEffectPlan,
  type OutboxWorkerBlobPutSideEffectPlan,
  type OutboxWorkerBlobGetSideEffectPlan,
  type OutboxWorkerMaterializeSideEffectPlan,
  type OutboxWorkerSideEffectResultEvidence,
} from '../../sync/engine/worker'
import { type LocalStoreOutboxRecord } from '../../sync/store/store'
import { sha256Hex } from '../auth'
import {
  safeLogError,
  retryAfterMsFromHeader,
  responseErrorCode,
  arrayBufferFromBytes,
} from '../helpers'
import type KuroflareSpikePlugin from '../plugin'
import {
  readBlobCacheBytes,
  writeBlobCacheBytes,
  blobBytesMatch,
  cleanupCreatedAdapterFolders,
  ensureVaultParentFolders,
} from './blob'

export async function runManifestPutSideEffect(
  sideEffect: OutboxWorkerManifestPutSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  try {
    const response = await fetch(sideEffect.putManifestRequest.url, {
      method: sideEffect.putManifestRequest.method,
      headers: sideEffect.putManifestRequest.headers,
      body: JSON.stringify(sideEffect.putManifestRequest.bodyJson),
    })
    if (response.ok) {
      return { kind: 'success' }
    }
    return {
      kind: 'http-response',
      status: response.status,
      retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
      code: await responseErrorCode(response),
    }
  } catch (error: unknown) {
    console.warn('[kuroflare] manifest put failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

// Not part of the shared wire contract in `@kuroflare/core` (an internal, ad hoc
// response shape), so it's validated with a small local schema instead.
const BlobPartPutResponseSchema = v.object({
  status: v.literal('stored'),
  partNumber: v.number(),
  etag: v.string(),
  size: v.number(),
})

export async function runBlobPutSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerBlobPutSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const bytes = await readBlobCacheBytes(
    plugin,
    sideEffect.readLocalCache.key,
    sideEffect.readLocalCache.expectedSha256,
    sideEffect.readLocalCache.expectedSize,
  )
  if (bytes === undefined) {
    return { kind: 'invalid-payload', code: 'local-cache-read-failed' }
  }

  const head = await fetchJsonSideEffect(plugin, sideEffect.headRequest)
  if (head.kind !== 'success') {
    return head
  }
  if (!v.is(BlobHeadResponseSchema, head.body)) {
    return { kind: 'invalid-payload', code: 'blob-head-response-invalid' }
  }
  const entry = head.body.exists[sideEffect.blob.sha256]
  if (entry?.found === true) {
    if (entry.size !== sideEffect.blob.size) {
      return { kind: 'invalid-payload', code: 'blob-head-size-mismatch' }
    }
    return { kind: 'success' }
  }

  const uploadUrl = await fetchJsonSideEffect(plugin, sideEffect.uploadUrlRequest)
  if (uploadUrl.kind !== 'success') {
    return uploadUrl
  }
  if (!v.is(BlobUploadUrlResponseSchema, uploadUrl.body)) {
    return { kind: 'invalid-payload', code: 'blob-upload-url-response-invalid' }
  }
  if (uploadUrl.body.kind === 'already-exists') {
    return { kind: 'success' }
  }
  if (uploadUrl.body.kind === 'multipart') {
    return runBlobMultipartPutSideEffect(sideEffect, bytes, uploadUrl.body)
  }

  try {
    const response = await fetch(uploadUrl.body.url, {
      method: sideEffect.uploadPut.method,
      headers: {
        ...uploadUrl.body.headers,
        authorization: sideEffect.uploadUrlRequest.headers.authorization ?? '',
      },
      body: arrayBufferFromBytes(bytes),
    })
    if (response.ok) {
      return { kind: 'success' }
    }
    return await httpFailureResult(response)
  } catch (error: unknown) {
    console.warn('[kuroflare] blob put failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

/**
 * Uploads one part per `target.parts` (byte ranges reconstructed from `bytes.byteLength`
 * and the shared `BLOB_MULTIPART_PART_SIZE_BYTES` constant, matching the worker's own
 * planning), then completes the session. A failure partway through is not retried
 * in place: the outbox retries the whole `blob-put` side effect, which starts a fresh
 * upload-url/session; the orphaned R2 session is swept by the worker's gc/lifecycle rule.
 */
async function runBlobMultipartPutSideEffect(
  sideEffect: OutboxWorkerBlobPutSideEffectPlan,
  bytes: Uint8Array,
  target: BlobMultipartUploadResponse,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const authorization = sideEffect.uploadUrlRequest.headers.authorization ?? ''
  const partCount = target.parts.length
  const completedParts: { partNumber: number; etag: string }[] = []
  let offset = 0

  for (const part of target.parts) {
    const partSize = blobMultipartPartByteSize(
      bytes.byteLength,
      BLOB_MULTIPART_PART_SIZE_BYTES,
      part.partNumber,
      partCount,
    )
    const partBytes = bytes.subarray(offset, offset + partSize)
    offset += partSize

    let response: Response
    try {
      response = await fetch(part.url, {
        method: 'PUT',
        headers: { ...part.headers, authorization },
        body: arrayBufferFromBytes(partBytes),
      })
    } catch (error: unknown) {
      console.warn('[kuroflare] blob multipart part put failed before HTTP response', {
        itemId: sideEffect.itemId,
        partNumber: part.partNumber,
        error: safeLogError(error),
      })
      return { kind: 'network-error' }
    }
    if (!response.ok) {
      return await httpFailureResult(response)
    }
    const partBody: unknown = await response.json().catch(() => undefined)
    if (!v.is(BlobPartPutResponseSchema, partBody)) {
      return { kind: 'invalid-payload', code: 'blob-part-put-response-invalid' }
    }
    completedParts.push({ partNumber: part.partNumber, etag: partBody.etag })
  }

  const completeUrl = new URL(sideEffect.uploadUrlRequest.url)
  completeUrl.pathname = `/blobs/${sideEffect.blob.sha256}/complete`
  completeUrl.search = ''
  try {
    const completeResponse = await fetch(completeUrl.toString(), {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: target.uploadId, parts: completedParts }),
    })
    if (completeResponse.ok) {
      return { kind: 'success' }
    }
    return await httpFailureResult(completeResponse)
  } catch (error: unknown) {
    console.warn('[kuroflare] blob multipart complete failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

export async function runBlobGetSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerBlobGetSideEffectPlan,
  isCurrent: () => boolean = () => true,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  if (!isCurrent()) return { kind: 'network-error' }
  let response: Response
  try {
    response = await fetch(sideEffect.downloadRequest.url, {
      method: sideEffect.downloadRequest.method,
      headers: sideEffect.downloadRequest.headers,
    })
  } catch (error: unknown) {
    console.warn('[kuroflare] blob get failed before HTTP response', {
      itemId: sideEffect.itemId,
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
  if (!response.ok) {
    return await httpFailureResult(response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!isCurrent()) return { kind: 'network-error' }
  if (
    !(await blobBytesMatch(
      plugin,
      bytes,
      sideEffect.writeLocalCache.expectedSha256,
      sideEffect.writeLocalCache.expectedSize,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'blob-download-mismatch' }
  }
  if (!isCurrent()) return { kind: 'network-error' }
  await writeBlobCacheBytes(plugin, sideEffect.writeLocalCache.key, bytes)
  if (!isCurrent()) return { kind: 'network-error' }
  return { kind: 'success' }
}

export async function runMaterializeSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerMaterializeSideEffectPlan,
  isCurrent: () => boolean = () => true,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  if (!isCurrent()) return { kind: 'network-error' }
  const chunks = new Map<NonNullable<LocalStoreOutboxRecord['blobSha256']>, Uint8Array>()
  for (const chunk of sideEffect.readChunks) {
    const bytes = await readBlobCacheBytes(plugin, chunk.key, chunk.sha256, chunk.expectedSize)
    if (!isCurrent()) return { kind: 'network-error' }
    if (bytes === undefined) {
      return { kind: 'invalid-payload', code: 'materialize-cache-read-failed' }
    }
    chunks.set(chunk.sha256, bytes)
  }

  let assembled: Uint8Array
  try {
    assembled = await assembleBlobBytes(sideEffect.manifest, chunks)
    if (!isCurrent()) return { kind: 'network-error' }
  } catch {
    return { kind: 'invalid-payload', code: 'materialize-assembly-failed' }
  }
  if (
    !(await blobBytesMatch(
      plugin,
      assembled,
      sideEffect.assemble.expectedContentSha256,
      sideEffect.assemble.expectedSize,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'materialize-assembled-mismatch' }
  }
  if (!isCurrent()) return { kind: 'network-error' }

  const existing = plugin.app.vault.getAbstractFileByPath(sideEffect.diskCas.path)
  let previousDiskBytes: Uint8Array | undefined
  if (existing instanceof TFolder) {
    return { kind: 'local-conflict' }
  }
  if (existing instanceof TFile) {
    const currentDiskBytes = new Uint8Array(
      await plugin.app.vault.adapter.readBinary(sideEffect.diskCas.path),
    )
    previousDiskBytes = currentDiskBytes
    if (!isCurrent()) return { kind: 'network-error' }
    const decision = decideMaterializeWrite({
      path: sideEffect.diskCas.path,
      activeFilePath: plugin.activeFile?.path,
      currentDiskHash: makeSha256Hex(await sha256Hex(plugin, currentDiskBytes)),
      lastMaterialized: sideEffect.diskCas.lastMaterialized,
    })
    if (decision.action !== 'write') {
      return { kind: 'local-conflict' }
    }
  } else if (existing !== null) {
    return { kind: 'local-conflict' }
  }

  const parentFolders =
    existing === null
      ? await ensureVaultParentFolders(plugin, sideEffect.writeVaultFile.path, isCurrent)
      : { ok: true, createdPaths: [] }
  if (!parentFolders.ok) {
    await cleanupCreatedAdapterFolders(plugin, parentFolders.createdPaths)
    return isCurrent() ? { kind: 'local-conflict' } : { kind: 'network-error' }
  }

  if (!isCurrent()) {
    await cleanupCreatedAdapterFolders(plugin, parentFolders.createdPaths)
    return { kind: 'network-error' }
  }
  const materializationOwner = {}
  plugin.binaryMaterializationOwners.set(sideEffect.writeVaultFile.path, materializationOwner)
  try {
    await plugin.app.vault.adapter.writeBinary(
      sideEffect.writeVaultFile.path,
      arrayBufferFromBytes(assembled),
    )
    const writtenFile = plugin.app.vault.getAbstractFileByPath(sideEffect.writeVaultFile.path)
    if (!isCurrent()) {
      await compensateStaleMaterializeWrite(
        plugin,
        sideEffect.writeVaultFile.path,
        sideEffect.expectedContentSha256,
        assembled.byteLength,
        existing instanceof TFile ? existing : null,
        writtenFile instanceof TFile ? writtenFile : null,
        previousDiskBytes,
        parentFolders.createdPaths,
        materializationOwner,
      )
      return { kind: 'network-error' }
    }
    plugin.lastMaterialized.set(sideEffect.writeVaultFile.path, {
      diskHash: sideEffect.expectedContentSha256,
      ydocHash: sideEffect.expectedContentSha256,
      path: sideEffect.writeVaultFile.path,
      writtenAt: Date.now(),
    })
    return { kind: 'success' }
  } finally {
    if (
      plugin.binaryMaterializationOwners.get(sideEffect.writeVaultFile.path) ===
      materializationOwner
    ) {
      plugin.binaryMaterializationOwners.delete(sideEffect.writeVaultFile.path)
    }
  }
}

async function compensateStaleMaterializeWrite(
  plugin: KuroflareSpikePlugin,
  path: string,
  writtenSha256: NonNullable<LocalStoreOutboxRecord['blobSha256']>,
  writtenSize: number,
  previousFile: TFile | null,
  writtenFile: TFile | null,
  previousBytes: Uint8Array | undefined,
  createdFolders: readonly string[],
  materializationOwner: object,
): Promise<void> {
  try {
    if (plugin.binaryMaterializationOwners.get(path) !== materializationOwner) return
    const currentFile = plugin.app.vault.getAbstractFileByPath(path)
    if (!(currentFile instanceof TFile)) return
    if (writtenFile === null || currentFile !== writtenFile) return
    if (previousFile !== null && currentFile !== previousFile) return
    const currentBytes = new Uint8Array(await plugin.app.vault.adapter.readBinary(path))
    if (!(await blobBytesMatch(plugin, currentBytes, writtenSha256, writtenSize))) return
    if (plugin.binaryMaterializationOwners.get(path) !== materializationOwner) return
    if (previousBytes === undefined) {
      await plugin.app.vault.adapter.remove(path)
    } else {
      await plugin.app.vault.adapter.writeBinary(path, arrayBufferFromBytes(previousBytes))
    }
  } catch (error: unknown) {
    console.warn('[kuroflare] failed to compensate a stale binary materialization', {
      path,
      error: safeLogError(error),
    })
  } finally {
    await cleanupCreatedAdapterFolders(plugin, createdFolders)
  }
}

export async function fetchJsonSideEffect(
  plugin: KuroflareSpikePlugin,
  request: OutboxWorkerManifestPutSideEffectPlan['putManifestRequest'],
): Promise<
  | { readonly kind: 'success'; readonly body: unknown }
  | Exclude<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'success' }>
> {
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
    }
    if (request.bodyJson !== undefined) {
      init.body = JSON.stringify(request.bodyJson)
    }
    const response = await fetch(request.url, init)
    if (!response.ok) {
      return await httpFailureResult(response)
    }
    return { kind: 'success', body: await response.json().catch(() => undefined) }
  } catch (error: unknown) {
    console.warn('[kuroflare] JSON side effect failed before HTTP response', {
      error: safeLogError(error),
    })
    return { kind: 'network-error' }
  }
}

export async function httpFailureResult(
  response: Response,
): Promise<Extract<OutboxWorkerSideEffectResultEvidence, { readonly kind: 'http-response' }>> {
  return {
    kind: 'http-response',
    status: response.status,
    retryAfterMs: retryAfterMsFromHeader(response.headers.get('Retry-After')),
    code: await responseErrorCode(response),
  }
}
