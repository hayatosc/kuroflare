import {
  BlobHeadResponseSchema,
  BlobUploadUrlResponseSchema,
  assembleBlobBytes,
  decideMaterializeWrite,
  makeSha256Hex,
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
  ensureVaultParentFolders,
} from './blob-cache'
import { fetchJsonSideEffect, httpFailureResult } from './http'

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
    return { kind: 'invalid-payload', code: 'blob-upload-multipart-unimplemented' }
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

export async function runBlobGetSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerBlobGetSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
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
  await writeBlobCacheBytes(plugin, sideEffect.writeLocalCache.key, bytes)
  return { kind: 'success' }
}

export async function runMaterializeSideEffect(
  plugin: KuroflareSpikePlugin,
  sideEffect: OutboxWorkerMaterializeSideEffectPlan,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const chunks = new Map<NonNullable<LocalStoreOutboxRecord['blobSha256']>, Uint8Array>()
  for (const chunk of sideEffect.readChunks) {
    const bytes = await readBlobCacheBytes(plugin, chunk.key, chunk.sha256, chunk.expectedSize)
    if (bytes === undefined) {
      return { kind: 'invalid-payload', code: 'materialize-cache-read-failed' }
    }
    chunks.set(chunk.sha256, bytes)
  }

  let assembled: Uint8Array
  try {
    assembled = await assembleBlobBytes(sideEffect.manifest, chunks)
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

  const existing = plugin.app.vault.getAbstractFileByPath(sideEffect.diskCas.path)
  if (existing instanceof TFolder) {
    return { kind: 'local-conflict' }
  }
  if (existing instanceof TFile) {
    const currentDiskBytes = new Uint8Array(
      await plugin.app.vault.adapter.readBinary(sideEffect.diskCas.path),
    )
    const decision = decideMaterializeWrite({
      path: sideEffect.diskCas.path,
      activeFilePath: plugin.activeFile?.path,
      currentDiskHash: makeSha256Hex(await sha256Hex(plugin, currentDiskBytes)),
      lastMaterialized: sideEffect.diskCas.lastMaterialized,
    })
    if (decision.action !== 'write') {
      return { kind: 'local-conflict' }
    }
  } else if (!(await ensureVaultParentFolders(plugin, sideEffect.writeVaultFile.path))) {
    return { kind: 'local-conflict' }
  }

  await plugin.app.vault.adapter.writeBinary(
    sideEffect.writeVaultFile.path,
    arrayBufferFromBytes(assembled),
  )
  plugin.lastMaterialized.set(sideEffect.writeVaultFile.path, {
    diskHash: sideEffect.expectedContentSha256,
    ydocHash: sideEffect.expectedContentSha256,
    path: sideEffect.writeVaultFile.path,
    writtenAt: Date.now(),
  })
  return { kind: 'success' }
}
