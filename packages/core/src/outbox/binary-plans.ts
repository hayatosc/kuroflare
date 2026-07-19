import * as v from 'valibot'

import {
  type OutboxPlanItemId,
  type BinaryUploadOutboxPlanInput,
  type BinaryDownloadOutboxPlanInput,
  type BinaryOutboxPlanItem,
  type BinaryUploadOutboxPlanBuildResult,
  type BinaryDownloadOutboxPlanBuildResult,
} from './types'
import { OutboxPlanItemIdSchema, validateBinaryChunks, hasDuplicateIds } from './validation'

/**
 * Brands a caller-assigned outbox item ID after checking it is non-empty.
 */
export function makeOutboxPlanItemId(value: string): OutboxPlanItemId | null {
  const result = v.safeParse(OutboxPlanItemIdSchema, value)
  return result.success ? result.output : null
}

/**
 * Builds blob PUT, manifest PUT, and meta reference update items for binary upload.
 */
export function buildBinaryUploadOutboxPlan(
  input: BinaryUploadOutboxPlanInput,
): BinaryUploadOutboxPlanBuildResult {
  const validationError = validateBinaryChunks(input.chunks)
  if (validationError !== undefined) {
    return { ok: false, reason: validationError }
  }

  const ids = [...input.chunks.map((chunk) => chunk.id), input.manifestPutId, input.metaRefUpdateId]
  if (hasDuplicateIds(ids)) {
    return { ok: false, reason: 'duplicate-item-id' }
  }

  const chunkPuts = input.chunks.map(
    (chunk): BinaryOutboxPlanItem => ({
      kind: 'blob-put',
      id: chunk.id,
      dependsOn: [],
      fileId: input.fileId,
      sha256: chunk.sha256,
      localCacheKey: chunk.localCacheKey,
      size: chunk.size,
    }),
  )
  const chunkPutIds = chunkPuts.map((item) => item.id)
  const manifestPut: BinaryOutboxPlanItem = {
    kind: 'manifest-put',
    id: input.manifestPutId,
    dependsOn: chunkPutIds,
    fileId: input.fileId,
    blobManifestHash: input.blobManifestHash,
  }
  const metaRefUpdate: BinaryOutboxPlanItem = {
    kind: 'meta-ref-update',
    id: input.metaRefUpdateId,
    dependsOn: [...chunkPutIds, input.manifestPutId],
    fileId: input.fileId,
    blobManifestHash: input.blobManifestHash,
  }

  return {
    ok: true,
    plan: {
      fileId: input.fileId,
      items: [...chunkPuts, manifestPut, metaRefUpdate],
      chunkPuts: chunkPutIds,
      manifestPut: input.manifestPutId,
      metaRefUpdate: input.metaRefUpdateId,
    },
  }
}

/**
 * Builds blob GET and dependent materialize items for binary download.
 */
export function buildBinaryDownloadOutboxPlan(
  input: BinaryDownloadOutboxPlanInput,
): BinaryDownloadOutboxPlanBuildResult {
  const validationError = validateBinaryChunks(input.chunks)
  if (validationError !== undefined) {
    return { ok: false, reason: validationError }
  }

  const ids = [...input.chunks.map((chunk) => chunk.id), input.materializeId]
  if (hasDuplicateIds(ids)) {
    return { ok: false, reason: 'duplicate-item-id' }
  }

  const chunkGets = input.chunks.map(
    (chunk): BinaryOutboxPlanItem => ({
      kind: 'blob-get',
      id: chunk.id,
      dependsOn: [],
      fileId: input.fileId,
      sha256: chunk.sha256,
      localCacheKey: chunk.localCacheKey,
      size: chunk.size,
    }),
  )
  const chunkGetIds = chunkGets.map((item) => item.id)
  const materialize: BinaryOutboxPlanItem = {
    kind: 'materialize',
    id: input.materializeId,
    dependsOn: chunkGetIds,
    fileId: input.fileId,
    expectedHash: input.expectedHash,
  }

  return {
    ok: true,
    plan: {
      fileId: input.fileId,
      items: [...chunkGets, materialize],
      chunkGets: chunkGetIds,
      materialize: input.materializeId,
    },
  }
}
