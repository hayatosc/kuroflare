import {
  type OutboxWorkerLeaseAttempt,
  type OutboxWorkerSideEffectPlan,
  type OutboxWorkerSideEffectPlanInput,
} from '../../engine/worker.types'
import {
  planOutboxWorkerManifestPutSideEffect,
  planOutboxWorkerMaterializeSideEffect,
  planOutboxWorkerMetaRefUpdateSideEffect,
} from './side-effect-builders'
import { isSafeLocalBlobCacheKey, normalizeHttpEndpoint } from './validation'

export function isSuccessfulOutboxWorkerLeaseAttempt(
  attempt: OutboxWorkerLeaseAttempt,
): attempt is Extract<OutboxWorkerLeaseAttempt, { readonly ok: true }> {
  return attempt.ok
}

/**
 * Builds the concrete side-effect plan for a persisted outbox lease.
 *
 * @param input Start effect, matching outbox record, sync endpoint, and current access token.
 * @returns A concrete local or network side-effect sequence, or the reason it must not start.
 */
export function planOutboxWorkerSideEffect(
  input: OutboxWorkerSideEffectPlanInput,
): OutboxWorkerSideEffectPlan {
  const record = input.record
  if (record === undefined || record.id !== input.effect.start.id) {
    return { ok: false, reason: 'missing-record' }
  }
  if (record.kind !== input.effect.start.kind) {
    return { ok: false, reason: 'kind-mismatch' }
  }

  if (record.kind === 'materialize') {
    return planOutboxWorkerMaterializeSideEffect(input.effect, record)
  }
  if (record.kind === 'meta-ref-update') {
    return planOutboxWorkerMetaRefUpdateSideEffect(input.effect, record)
  }

  if (record.kind !== 'blob-put' && record.kind !== 'blob-get' && record.kind !== 'manifest-put') {
    return { ok: false, reason: 'unsupported-kind' }
  }

  if (input.accessToken === undefined || input.accessToken.length === 0) {
    return { ok: false, reason: 'missing-access-token' }
  }

  const endpoint = normalizeHttpEndpoint(input.endpoint)
  if (endpoint === undefined) {
    return { ok: false, reason: 'invalid-endpoint' }
  }

  const headers = {
    authorization: `Bearer ${input.accessToken}`,
    'content-type': 'application/json',
  }
  if (record.kind === 'manifest-put') {
    return planOutboxWorkerManifestPutSideEffect(input.effect, record, endpoint, headers)
  }

  if (record.blobSha256 === undefined) {
    return { ok: false, reason: 'missing-blob-sha256' }
  }
  if (record.localCacheKey === undefined || record.localCacheKey.length === 0) {
    return { ok: false, reason: 'missing-local-cache-key' }
  }
  if (!isSafeLocalBlobCacheKey(record.localCacheKey)) {
    return { ok: false, reason: 'invalid-local-cache-key' }
  }
  if (
    record.blobSize === undefined ||
    !Number.isSafeInteger(record.blobSize) ||
    record.blobSize < 0
  ) {
    return { ok: false, reason: 'invalid-blob-size' }
  }

  if (record.kind === 'blob-get') {
    if (record.fileId === undefined) {
      return { ok: false, reason: 'missing-file-id' }
    }
    return {
      ok: true,
      action: 'blob-get',
      itemId: record.id,
      lease: input.effect.lease,
      fileId: record.fileId,
      blob: {
        sha256: record.blobSha256,
        size: record.blobSize,
        localCacheKey: record.localCacheKey,
      },
      downloadRequest: {
        method: 'GET',
        url: new URL(`/blobs/${record.blobSha256}`, endpoint).toString(),
        headers: { authorization: `Bearer ${input.accessToken}` },
      },
      writeLocalCache: {
        key: record.localCacheKey,
        expectedSha256: record.blobSha256,
        expectedSize: record.blobSize,
      },
    }
  }

  const headUrl = new URL('/blobs/head', endpoint).toString()
  const uploadUrl = new URL('/blobs/upload-url', endpoint).toString()
  return {
    ok: true,
    action: 'blob-put',
    itemId: record.id,
    lease: input.effect.lease,
    blob: {
      sha256: record.blobSha256,
      size: record.blobSize,
      localCacheKey: record.localCacheKey,
    },
    readLocalCache: {
      key: record.localCacheKey,
      expectedSha256: record.blobSha256,
      expectedSize: record.blobSize,
    },
    headRequest: {
      method: 'POST',
      url: headUrl,
      headers,
      bodyJson: { hashes: [record.blobSha256] },
    },
    uploadUrlRequest: {
      method: 'POST',
      url: uploadUrl,
      headers,
      bodyJson: { sha256: record.blobSha256, size: record.blobSize },
    },
    uploadPut: {
      method: 'PUT',
      urlSource: 'upload-url-response',
      authorization: 'device-access-token',
      bodySource: 'local-cache',
    },
  }
}
