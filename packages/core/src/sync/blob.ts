import * as v from 'valibot'

import { Sha256HexSchema, type BinaryMetaFile } from '../sync/meta'
import { DeviceIdSchema, FileIdSchema } from '../utils/ids'
import type { FileId } from '../utils/ids'
import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const BlobManifestChunkSchema = v.object({
  sha256: Sha256HexSchema,
  offset: NonNegativeSafeIntegerSchema,
  size: PositiveSafeIntegerSchema,
})
export type BlobManifestChunk = v.InferInput<typeof BlobManifestChunkSchema>

function chunksCoverSize(chunks: readonly BlobManifestChunk[], totalSize: number): boolean {
  if (totalSize === 0) {
    return chunks.length === 0
  }
  if (chunks.length === 0) {
    return false
  }

  let expectedOffset = 0
  for (const chunk of chunks) {
    if (chunk.offset !== expectedOffset) {
      return false
    }
    expectedOffset += chunk.size
  }

  return expectedOffset === totalSize
}

export const BlobManifestSchema = v.pipe(
  v.object({
    version: v.literal(1),
    fileId: FileIdSchema,
    contentSha256: Sha256HexSchema,
    size: NonNegativeSafeIntegerSchema,
    chunks: v.array(BlobManifestChunkSchema),
    createdBy: DeviceIdSchema,
    createdAt: NonNegativeSafeIntegerSchema,
  }),
  v.check((val) => chunksCoverSize(val.chunks, val.size), 'Chunks do not cover file size'),
)
export type BlobManifest = v.InferInput<typeof BlobManifestSchema>

export function parseBlobManifestJson(
  input: string | Uint8Array,
  expectedFileId?: FileId,
): BlobManifest | null {
  try {
    const text = typeof input === 'string' ? input : textDecoder.decode(input)
    const value = JSON.parse(text)
    const result = v.safeParse(BlobManifestSchema, value)
    if (!result.success) return null
    if (expectedFileId !== undefined && result.output.fileId !== expectedFileId) return null
    return result.output
  } catch {
    return null
  }
}

export function stringifyBlobManifest(manifest: BlobManifest): string {
  if (!v.is(BlobManifestSchema, manifest)) {
    throw new Error('Invalid blob manifest')
  }

  const chunkJsons = manifest.chunks.map(
    (chunk) =>
      `{"sha256":${JSON.stringify(chunk.sha256)},"offset":${chunk.offset},"size":${chunk.size}}`,
  )

  // Deterministic property order is required for SHA-256 hash integrity.
  // `JSON.stringify` does not guarantee property order, so we build the JSON manually
  // from an ordered list of key-value pairs.
  const pairs: readonly [string, string][] = [
    ['version', '1'],
    ['fileId', JSON.stringify(manifest.fileId)],
    ['contentSha256', JSON.stringify(manifest.contentSha256)],
    ['size', String(manifest.size)],
    ['chunks', `[${chunkJsons.join(',')}]`],
    ['createdBy', JSON.stringify(manifest.createdBy)],
    ['createdAt', String(manifest.createdAt)],
  ]

  return `{${pairs.map(([key, value]) => `"${key}":${value}`).join(',')}}`
}

export function encodeBlobManifestJson(manifest: BlobManifest): Uint8Array {
  return textEncoder.encode(stringifyBlobManifest(manifest))
}

export function blobManifestMatchesMetaFile(
  manifest: BlobManifest,
  metaFile: BinaryMetaFile,
): boolean {
  if (manifest.fileId !== metaFile.fileId) {
    return false
  }
  if (manifest.chunks.length !== metaFile.blobChunks.length) {
    return false
  }

  return manifest.chunks.every((chunk, index) => chunk.sha256 === metaFile.blobChunks[index])
}
