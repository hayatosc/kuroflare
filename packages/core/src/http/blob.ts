import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'

export const MAX_BLOB_HEAD_HASHES = 512

// R2/S3 multipart uploads cap parts at 10,000; enforced both on the wire (schema
// maxLength below) and by the worker's own upload planning.
export const MAX_BLOB_MULTIPART_PARTS = 10_000

// Fixed part size for planned multipart uploads. R2 (like S3) requires every
// non-final part to be at least 5MiB; 8MiB keeps part count (and R2 API call
// count) low for large files while staying well clear of that floor. Shared
// between worker and client so both derive identical part byte ranges from
// just `size` and `parts.length` (the wire response carries no byte ranges).
export const BLOB_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024

/**
 * Number of fixed-size parts a multipart upload of `size` bytes is split into.
 * At least one part even for a zero-byte blob, since R2 requires a non-empty part list.
 */
export function blobMultipartPartCount(size: number, partSizeBytes: number): number {
  return Math.max(1, Math.ceil(size / partSizeBytes))
}

/** Expected byte length of one part: fixed size, except the trailing remainder on the last part. */
export function blobMultipartPartByteSize(
  size: number,
  partSizeBytes: number,
  partNumber: number,
  partCount: number,
): number {
  return partNumber < partCount ? partSizeBytes : size - partSizeBytes * (partCount - 1)
}

export const BlobHeadRequestSchema = v.object({
  hashes: v.pipe(v.array(Sha256HexSchema), v.minLength(1), v.maxLength(MAX_BLOB_HEAD_HASHES)),
})
export type BlobHeadRequest = v.InferInput<typeof BlobHeadRequestSchema>

export const BlobHeadEntrySchema = v.pipe(
  v.object({
    found: v.boolean(),
    size: v.optional(NonNegativeSafeIntegerSchema),
  }),
  v.check((val) => val.found === (val.size !== undefined), 'Invalid blob head entry'),
)
export type BlobHeadEntry = v.InferInput<typeof BlobHeadEntrySchema>

export const BlobHeadResponseSchema = v.object({
  exists: v.record(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), BlobHeadEntrySchema),
})
export type BlobHeadResponse = v.InferInput<typeof BlobHeadResponseSchema>

export const BlobUploadUrlRequestSchema = v.object({
  sha256: Sha256HexSchema,
  size: NonNegativeSafeIntegerSchema,
  multipart: v.optional(v.boolean()),
})
export type BlobUploadUrlRequest = v.InferInput<typeof BlobUploadUrlRequestSchema>

export const BlobAlreadyExistsUploadResponseSchema = v.object({
  kind: v.literal('already-exists'),
})
export type BlobAlreadyExistsUploadResponse = v.InferInput<
  typeof BlobAlreadyExistsUploadResponseSchema
>

export const HttpUploadUrlSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.check((val) => {
    try {
      const url = new URL(val)
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === '' &&
        url.hash === ''
      )
    } catch {
      return false
    }
  }, 'Invalid HTTP upload URL'),
)

export const HeadersSchema = v.record(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9-]+$/)), v.string())

export const BlobSinglePutUploadResponseSchema = v.object({
  kind: v.literal('single-put'),
  url: HttpUploadUrlSchema,
  headers: HeadersSchema,
  expiresAt: PositiveSafeIntegerSchema,
})
export type BlobSinglePutUploadResponse = v.InferInput<typeof BlobSinglePutUploadResponseSchema>

export const BlobUploadIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1024))

export const BlobMultipartUploadPartSchema = v.object({
  partNumber: PositiveSafeIntegerSchema,
  url: HttpUploadUrlSchema,
  headers: HeadersSchema,
})
export type BlobMultipartUploadPart = v.InferInput<typeof BlobMultipartUploadPartSchema>

export const BlobMultipartUploadResponseSchema = v.object({
  kind: v.literal('multipart'),
  uploadId: BlobUploadIdSchema,
  parts: v.pipe(
    v.array(BlobMultipartUploadPartSchema),
    v.minLength(1),
    v.maxLength(MAX_BLOB_MULTIPART_PARTS),
  ),
  expiresAt: PositiveSafeIntegerSchema,
})
export type BlobMultipartUploadResponse = v.InferInput<typeof BlobMultipartUploadResponseSchema>

export const BlobUploadUrlResponseSchema = v.union([
  BlobAlreadyExistsUploadResponseSchema,
  BlobSinglePutUploadResponseSchema,
  BlobMultipartUploadResponseSchema,
])
export type BlobUploadUrlResponse = v.InferInput<typeof BlobUploadUrlResponseSchema>

export const BlobMultipartCompletePartSchema = v.object({
  partNumber: PositiveSafeIntegerSchema,
  etag: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
})
export type BlobMultipartCompletePart = v.InferInput<typeof BlobMultipartCompletePartSchema>

export const BlobMultipartCompleteRequestSchema = v.object({
  uploadId: BlobUploadIdSchema,
  parts: v.pipe(
    v.array(BlobMultipartCompletePartSchema),
    v.minLength(1),
    v.maxLength(MAX_BLOB_MULTIPART_PARTS),
  ),
})
export type BlobMultipartCompleteRequest = v.InferInput<typeof BlobMultipartCompleteRequestSchema>

export const BlobMultipartAbortRequestSchema = v.object({
  uploadId: BlobUploadIdSchema,
})
export type BlobMultipartAbortRequest = v.InferInput<typeof BlobMultipartAbortRequestSchema>
