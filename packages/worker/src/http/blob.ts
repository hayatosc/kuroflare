import {
  BlobHeadResponseSchema,
  BlobUploadUrlResponseSchema,
  type BlobHeadRequest,
  type BlobHeadResponse,
  type BlobMultipartUploadResponse,
  type BlobSinglePutUploadResponse,
  type BlobUploadUrlRequest,
  type BlobUploadUrlResponse,
  type Sha256Hex,
} from '@kuroflare/core'
import * as v from 'valibot'

/** R2 HEAD evidence for one requested blob object. */
export interface BlobHeadObjectEvidence {
  readonly sha256: Sha256Hex
  readonly found: boolean
  readonly size?: number | undefined
}

/** Input for building a `/blobs/head` response from R2 object evidence. */
export interface BlobHeadHttpResponsePlanInput {
  readonly request: BlobHeadRequest
  readonly objects: readonly BlobHeadObjectEvidence[]
}

/** Decision for returning a `/blobs/head` response. */
export type BlobHeadHttpResponsePlan =
  | {
      readonly action: 'respond'
      readonly response: BlobHeadResponse
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'duplicate-request-hash'
        | 'duplicate-evidence'
        | 'missing-evidence'
        | 'unexpected-evidence'
        | 'invalid-blob-size'
        | 'invalid-response'
    }

/** R2 object evidence for one requested blob upload target. */
export interface BlobUploadObjectEvidence {
  readonly sha256: Sha256Hex
  readonly found: boolean
  readonly size?: number | undefined
}

/** Policy for choosing single PUT vs multipart blob upload responses. */
export interface BlobUploadUrlPolicy {
  readonly multipartThresholdBytes: number
}

/** Input for building a `/blobs/upload-url` response from R2 and upload target evidence. */
export interface BlobUploadUrlHttpResponsePlanInput {
  readonly request: BlobUploadUrlRequest
  readonly object: BlobUploadObjectEvidence
  readonly now: number
  readonly policy: BlobUploadUrlPolicy
  readonly singlePut?: BlobSinglePutUploadResponse | undefined
  readonly multipart?: BlobMultipartUploadResponse | undefined
}

/** Decision for returning a `/blobs/upload-url` response. */
export type BlobUploadUrlHttpResponsePlan =
  | {
      readonly action: 'respond'
      readonly response: BlobUploadUrlResponse
    }
  | {
      readonly action: 'reject'
      readonly reason:
        | 'hash-mismatch'
        | 'invalid-object-size'
        | 'existing-size-mismatch'
        | 'invalid-now'
        | 'invalid-policy'
        | 'multipart-required'
        | 'missing-upload-target'
        | 'invalid-upload-expiry'
        | 'invalid-multipart-parts'
        | 'invalid-response'
    }

/**
 * Builds a guarded `/blobs/head` response from caller-provided R2 HEAD results.
 *
 * @param input Guarded request hashes and one evidence row for each requested hash.
 * @returns A response body, or the reason the HEAD evidence cannot be trusted.
 */
export function planBlobHeadHttpResponse(
  input: BlobHeadHttpResponsePlanInput,
): BlobHeadHttpResponsePlan {
  const requested = new Set<Sha256Hex>()
  for (const hash of input.request.hashes) {
    if (requested.has(hash)) {
      return { action: 'reject', reason: 'duplicate-request-hash' }
    }
    requested.add(hash)
  }

  const exists: Record<string, { found: boolean; size?: number }> = {}
  const seenEvidence = new Set<Sha256Hex>()
  for (const object of input.objects) {
    if (!requested.has(object.sha256)) {
      return { action: 'reject', reason: 'unexpected-evidence' }
    }
    if (seenEvidence.has(object.sha256)) {
      return { action: 'reject', reason: 'duplicate-evidence' }
    }
    seenEvidence.add(object.sha256)

    if (object.found) {
      if (object.size === undefined || !Number.isSafeInteger(object.size) || object.size < 0) {
        return { action: 'reject', reason: 'invalid-blob-size' }
      }
      exists[object.sha256] = { found: true, size: object.size }
      continue
    }

    if (object.size !== undefined) {
      return { action: 'reject', reason: 'invalid-blob-size' }
    }
    exists[object.sha256] = { found: false }
  }

  if (seenEvidence.size !== requested.size) {
    return { action: 'reject', reason: 'missing-evidence' }
  }

  const response = { exists }
  if (!v.is(BlobHeadResponseSchema, response)) {
    return { action: 'reject', reason: 'invalid-response' }
  }

  return { action: 'respond', response }
}

/**
 * Builds a guarded `/blobs/upload-url` response from object existence and upload target evidence.
 *
 * @param input Guarded request, R2 HEAD result, upload policy, and optional upload targets.
 * @returns The upload response to send, or the reason the evidence cannot be trusted.
 */
export function planBlobUploadUrlHttpResponse(
  input: BlobUploadUrlHttpResponsePlanInput,
): BlobUploadUrlHttpResponsePlan {
  if (input.object.sha256 !== input.request.sha256) {
    return { action: 'reject', reason: 'hash-mismatch' }
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return { action: 'reject', reason: 'invalid-now' }
  }
  if (
    !Number.isSafeInteger(input.policy.multipartThresholdBytes) ||
    input.policy.multipartThresholdBytes <= 0
  ) {
    return { action: 'reject', reason: 'invalid-policy' }
  }

  if (input.object.found) {
    if (
      input.object.size !== undefined &&
      (!Number.isSafeInteger(input.object.size) || input.object.size < 0)
    ) {
      return { action: 'reject', reason: 'invalid-object-size' }
    }
    if (input.object.size !== undefined && input.object.size !== input.request.size) {
      return { action: 'reject', reason: 'existing-size-mismatch' }
    }
    return { action: 'respond', response: { kind: 'already-exists' } }
  }

  if (input.object.size !== undefined) {
    return { action: 'reject', reason: 'invalid-object-size' }
  }

  const requiresMultipart = input.request.size >= input.policy.multipartThresholdBytes
  if (requiresMultipart && input.request.multipart !== true) {
    return { action: 'reject', reason: 'multipart-required' }
  }

  const response =
    requiresMultipart || input.request.multipart === true ? input.multipart : input.singlePut
  if (response === undefined) {
    return { action: 'reject', reason: 'missing-upload-target' }
  }

  if (!uploadResponseExpiresInFuture(response, input.now)) {
    return { action: 'reject', reason: 'invalid-upload-expiry' }
  }
  if (response.kind === 'multipart' && !hasContiguousMultipartParts(response)) {
    return { action: 'reject', reason: 'invalid-multipart-parts' }
  }
  if (!v.is(BlobUploadUrlResponseSchema, response)) {
    return { action: 'reject', reason: 'invalid-response' }
  }

  return { action: 'respond', response }
}

function uploadResponseExpiresInFuture(
  response: BlobSinglePutUploadResponse | BlobMultipartUploadResponse,
  now: number,
): boolean {
  return Number.isSafeInteger(response.expiresAt) && response.expiresAt > now
}

function hasContiguousMultipartParts(response: BlobMultipartUploadResponse): boolean {
  return response.parts.every((part, index) => part.partNumber === index + 1)
}
