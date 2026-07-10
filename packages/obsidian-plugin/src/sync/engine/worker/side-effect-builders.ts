import { type BlobManifest } from '@kuroflare/core'

import {
  type OutboxWorkerMaterializeChunkReadPlan,
  type OutboxWorkerSideEffectPlan,
  type OutboxWorkerStartEffect,
} from '../../engine/worker.types'
import { type LocalStoreOutboxRecord } from '../../store/store'
import { isSafeLocalBlobCacheKey, isSafeVaultRelativePath } from './validation'

export function planOutboxWorkerManifestPutSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
  endpoint: string,
  headers: Readonly<Record<string, string>>,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.blobManifestHash === undefined) {
    return { ok: false, reason: 'missing-blob-manifest-hash' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }

  return {
    ok: true,
    action: 'manifest-put',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    manifestHash: record.blobManifestHash,
    manifest: record.blobManifest,
    putManifestRequest: {
      method: 'PUT',
      url: new URL(`/blob-manifests/${record.blobManifestHash}.json`, endpoint).toString(),
      headers,
      bodyJson: record.blobManifest,
      bodySource: 'canonical-blob-manifest-json',
    },
  }
}

export function planOutboxWorkerMetaRefUpdateSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.blobManifestHash === undefined) {
    return { ok: false, reason: 'missing-blob-manifest-hash' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }
  if (record.docId === undefined) {
    return { ok: false, reason: 'missing-doc-id' }
  }
  if (record.messageId === undefined) {
    return { ok: false, reason: 'missing-message-id' }
  }
  if (record.updateSha256 === undefined) {
    return { ok: false, reason: 'missing-update-sha256' }
  }
  if (record.updateBytesBase64 === undefined || record.updateBytesBase64.length === 0) {
    return { ok: false, reason: 'missing-update-bytes' }
  }

  return {
    ok: true,
    action: 'meta-ref-update',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    binaryRef: {
      blobManifestHash: record.blobManifestHash,
      blobChunks: record.blobManifest.chunks.map((chunk) => chunk.sha256),
    },
    sendSyncUpdate: {
      transport: 'active-sync-websocket',
      docId: record.docId,
      messageId: record.messageId,
      updateSha256: record.updateSha256,
      updateBytesBase64: record.updateBytesBase64,
    },
  }
}

export function planOutboxWorkerMaterializeSideEffect(
  effect: OutboxWorkerStartEffect,
  record: LocalStoreOutboxRecord,
): OutboxWorkerSideEffectPlan {
  if (record.fileId === undefined) {
    return { ok: false, reason: 'missing-file-id' }
  }
  if (record.expectedHash === undefined) {
    return { ok: false, reason: 'missing-expected-hash' }
  }
  if (record.targetPath === undefined || record.targetPath.length === 0) {
    return { ok: false, reason: 'missing-target-path' }
  }
  if (!isSafeVaultRelativePath(record.targetPath)) {
    return { ok: false, reason: 'invalid-target-path' }
  }
  if (record.blobManifest === undefined) {
    return { ok: false, reason: 'missing-blob-manifest' }
  }
  if (record.blobManifest.fileId !== record.fileId) {
    return { ok: false, reason: 'manifest-file-mismatch' }
  }
  if (record.blobManifest.contentSha256 !== record.expectedHash) {
    return { ok: false, reason: 'manifest-content-mismatch' }
  }
  if (record.materializeChunks === undefined) {
    return { ok: false, reason: 'manifest-chunk-key-mismatch' }
  }
  if (record.materializeChunks.length !== record.blobManifest.chunks.length) {
    return { ok: false, reason: 'manifest-chunk-key-mismatch' }
  }

  const seenChunkHashes = new Set<BlobManifest['chunks'][number]['sha256']>()
  const readChunks: OutboxWorkerMaterializeChunkReadPlan[] = []
  for (const chunk of record.blobManifest.chunks) {
    if (seenChunkHashes.has(chunk.sha256)) {
      return { ok: false, reason: 'manifest-chunk-key-mismatch' }
    }
    seenChunkHashes.add(chunk.sha256)
    const cached = record.materializeChunks.find((candidate) => candidate.sha256 === chunk.sha256)
    if (cached === undefined || cached.localCacheKey.length === 0 || cached.size !== chunk.size) {
      return { ok: false, reason: 'manifest-chunk-key-mismatch' }
    }
    if (!isSafeLocalBlobCacheKey(cached.localCacheKey)) {
      return { ok: false, reason: 'invalid-local-cache-key' }
    }
    readChunks.push({
      sha256: chunk.sha256,
      key: cached.localCacheKey,
      expectedSize: chunk.size,
    })
  }

  return {
    ok: true,
    action: 'materialize',
    itemId: record.id,
    lease: effect.lease,
    fileId: record.fileId,
    targetPath: record.targetPath,
    expectedContentSha256: record.expectedHash,
    manifest: record.blobManifest,
    readChunks,
    assemble: {
      expectedContentSha256: record.expectedHash,
      expectedSize: record.blobManifest.size,
    },
    diskCas: {
      path: record.targetPath,
      lastMaterialized: record.lastMaterialized,
    },
    writeVaultFile: {
      path: record.targetPath,
      bodySource: 'assembled-blob',
    },
  }
}
