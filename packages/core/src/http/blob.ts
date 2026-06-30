import * as v from 'valibot'

import { Sha256HexSchema } from '../sync/meta'
import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'

export const MAX_BLOB_HEAD_HASHES = 512

export const BlobHeadRequestSchema = v.object({
  hashes: v.pipe(v.array(Sha256HexSchema), v.minLength(1), v.maxLength(MAX_BLOB_HEAD_HASHES)),
})
export type BlobHeadRequest = v.InferInput<typeof BlobHeadRequestSchema>

export const BlobHeadEntrySchema = v.pipe(
  v.object({
    found: v.boolean(),
    size: v.optional(NonNegativeSafeIntegerSchema),
  }),
  v.check((val) => {
    if (!val.found) return val.size === undefined
    return true
  }, 'Invalid blob head entry'),
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

export const BlobMultipartUploadPartSchema = v.object({
  partNumber: PositiveSafeIntegerSchema,
  url: HttpUploadUrlSchema,
  headers: HeadersSchema,
})
export type BlobMultipartUploadPart = v.InferInput<typeof BlobMultipartUploadPartSchema>

export const BlobMultipartUploadResponseSchema = v.object({
  kind: v.literal('multipart'),
  uploadId: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  parts: v.pipe(v.array(BlobMultipartUploadPartSchema), v.minLength(1)),
  expiresAt: PositiveSafeIntegerSchema,
})
export type BlobMultipartUploadResponse = v.InferInput<typeof BlobMultipartUploadResponseSchema>

export const BlobUploadUrlResponseSchema = v.union([
  BlobAlreadyExistsUploadResponseSchema,
  BlobSinglePutUploadResponseSchema,
  BlobMultipartUploadResponseSchema,
])
export type BlobUploadUrlResponse = v.InferInput<typeof BlobUploadUrlResponseSchema>
