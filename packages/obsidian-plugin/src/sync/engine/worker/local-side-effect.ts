import {
  type BlobManifest,
  BlobHeadResponseSchema,
  BlobUploadUrlResponseSchema,
  assembleBlobBytes,
  decideMaterializeWrite,
  makeSha256Hex,
} from '@kuroflare/core'
import * as v from 'valibot'

import {
  type OutboxWorkerLocalSideEffectRunnerPorts,
  type OutboxWorkerSideEffectPlan,
  type OutboxWorkerSideEffectResultEvidence,
} from '../../engine/worker.types'

/**
 * Runs local binary download/materialize side effects through explicit ports.
 *
 * @param plan Concrete side-effect plan produced after a persisted outbox lease.
 * @param ports Fake vault or production adapters used for local I/O and hashing.
 * @returns Completion evidence consumed by outbox success/failure planning.
 */
export async function runOutboxWorkerLocalSideEffect(
  plan:
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-put' }>
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-get' }>
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'manifest-put' }>
    | Extract<OutboxWorkerSideEffectPlan, { readonly action: 'materialize' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  switch (plan.action) {
    case 'blob-put':
      return await runBlobPutLocalSideEffect(plan, ports)
    case 'blob-get':
      return await runBlobGetLocalSideEffect(plan, ports)
    case 'manifest-put':
      return await runManifestPutLocalSideEffect(plan, ports)
    case 'materialize':
      return await runMaterializeLocalSideEffect(plan, ports)
  }
}

async function runBlobPutLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-put' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const bytes = await ports.readBlobCache(plan.readLocalCache)
  if (bytes === undefined) {
    return { kind: 'invalid-payload', code: 'local-cache-read-failed' }
  }
  if (
    !(await bytesMatch(
      bytes,
      plan.readLocalCache.expectedSha256,
      plan.readLocalCache.expectedSize,
      ports,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'local-cache-mismatch' }
  }

  const head = await ports.sendJsonRequest(plan.headRequest)
  if (head.kind !== 'success') {
    return head
  }
  if (!v.is(BlobHeadResponseSchema, head.body)) {
    return { kind: 'invalid-payload', code: 'blob-head-response-invalid' }
  }
  const entry = head.body.exists[plan.blob.sha256]
  if (entry?.found === true) {
    if (entry.size !== undefined && entry.size !== plan.blob.size) {
      return { kind: 'invalid-payload', code: 'blob-head-size-mismatch' }
    }
    return { kind: 'success' }
  }

  const uploadUrl = await ports.sendJsonRequest(plan.uploadUrlRequest)
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

  return await ports.uploadBytes(
    {
      method: plan.uploadPut.method,
      url: uploadUrl.body.url,
      headers: {
        ...uploadUrl.body.headers,
        authorization: plan.uploadUrlRequest.headers.authorization ?? '',
      },
    },
    bytes,
  )
}

async function runBlobGetLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'blob-get' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const response = await ports.downloadBytes(plan.downloadRequest)
  if (response.kind !== 'success') {
    return response
  }
  if (
    !(await bytesMatch(
      response.bytes,
      plan.writeLocalCache.expectedSha256,
      plan.writeLocalCache.expectedSize,
      ports,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'blob-download-mismatch' }
  }
  await ports.writeBlobCache(plan.writeLocalCache, response.bytes)
  return { kind: 'success' }
}

async function runManifestPutLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'manifest-put' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const response = await ports.sendJsonRequest(plan.putManifestRequest)
  return response.kind === 'success' ? { kind: 'success' } : response
}

async function runMaterializeLocalSideEffect(
  plan: Extract<OutboxWorkerSideEffectPlan, { readonly action: 'materialize' }>,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<OutboxWorkerSideEffectResultEvidence> {
  const chunks = new Map<BlobManifest['chunks'][number]['sha256'], Uint8Array>()
  for (const chunk of plan.readChunks) {
    const bytes = await ports.readBlobCache({
      key: chunk.key,
      expectedSha256: chunk.sha256,
      expectedSize: chunk.expectedSize,
    })
    if (bytes === undefined) {
      return { kind: 'invalid-payload', code: 'materialize-cache-read-failed' }
    }
    chunks.set(chunk.sha256, bytes)
  }

  let assembled: Uint8Array
  try {
    assembled = await assembleBlobBytes(plan.manifest, chunks)
  } catch {
    return { kind: 'invalid-payload', code: 'materialize-assembly-failed' }
  }
  if (
    !(await bytesMatch(
      assembled,
      plan.assemble.expectedContentSha256,
      plan.assemble.expectedSize,
      ports,
    ))
  ) {
    return { kind: 'invalid-payload', code: 'materialize-assembled-mismatch' }
  }

  const existing = await ports.readVaultFile(plan.diskCas.path)
  if (existing.kind === 'folder') {
    return { kind: 'local-conflict' }
  }
  if (existing.kind === 'file') {
    const decision = decideMaterializeWrite({
      path: plan.diskCas.path,
      activeFilePath: ports.getActiveFilePath(),
      currentDiskHash: makeSha256Hex(await ports.sha256Hex(existing.bytes)),
      lastMaterialized: plan.diskCas.lastMaterialized,
    })
    if (decision.action !== 'write') {
      return { kind: 'local-conflict' }
    }
  } else if (!(await ports.ensureVaultParentFolders(plan.writeVaultFile.path))) {
    return { kind: 'local-conflict' }
  }

  await ports.writeVaultFile(plan.writeVaultFile.path, assembled)
  ports.writeLastMaterialized({
    diskHash: plan.expectedContentSha256,
    ydocHash: plan.expectedContentSha256,
    path: plan.writeVaultFile.path,
    writtenAt: ports.now(),
  })
  return { kind: 'success' }
}

async function bytesMatch(
  bytes: Uint8Array,
  expectedSha256: string,
  expectedSize: number,
  ports: OutboxWorkerLocalSideEffectRunnerPorts,
): Promise<boolean> {
  return (
    bytes.byteLength === expectedSize &&
    makeSha256Hex(await ports.sha256Hex(bytes)) === expectedSha256
  )
}
