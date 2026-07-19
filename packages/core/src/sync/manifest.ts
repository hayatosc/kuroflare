import * as v from 'valibot'

import { encodeBlobManifestJson, type BlobManifest } from '../sync/blob'
import { makeSha256Hex, type Sha256Hex } from '../sync/meta'
import { hashBytesSha256 } from '../utils/hashing'
import { type DeviceId, type FileId } from '../utils/ids'
import { NonNegativeSafeIntegerSchema, PositiveSafeIntegerSchema } from '../utils/shared'

export interface ChunkingOptions {
  readonly minSize?: number
  readonly avgSize?: number
  readonly maxSize?: number
}

export interface BlobChunk {
  readonly sha256: Sha256Hex
  readonly offset: number
  readonly bytes: Uint8Array
}

export interface BuiltBlobManifest {
  readonly manifest: BlobManifest
  readonly manifestHash: Sha256Hex
  readonly manifestBytes: Uint8Array
  readonly chunks: readonly BlobChunk[]
}

export type BlobAssemblyErrorCode =
  | 'missing-chunk'
  | 'chunk-size-mismatch'
  | 'chunk-hash-mismatch'
  | 'content-hash-mismatch'

export class BlobAssemblyError extends Error {
  readonly code: BlobAssemblyErrorCode
  readonly sha256?: Sha256Hex

  constructor(code: BlobAssemblyErrorCode, message: string, sha256?: Sha256Hex) {
    super(message)
    this.name = 'BlobAssemblyError'
    this.code = code
    if (sha256 !== undefined) {
      this.sha256 = sha256
    }
  }
}

/**
 * Default parameters for splitting files into chunks.
 * Changing these parameters will alter chunk boundaries, affecting
 * deduplication efficiency, but does not affect the correctness of existing files.
 */
export const DEFAULT_CHUNKING_OPTIONS = {
  minSize: 64 * 1024,
  avgSize: 256 * 1024,
  maxSize: 1024 * 1024,
} as const satisfies Required<ChunkingOptions>

const NormalizedChunkingOptionsSchema = v.pipe(
  v.object({
    minSize: v.number(),
    avgSize: v.number(),
    maxSize: v.number(),
  }),
  v.check(({ avgSize }) => isPositivePowerOfTwo(avgSize), 'invalid-average-size'),
  v.check(({ minSize }) => v.is(PositiveSafeIntegerSchema, minSize), 'invalid-minimum-size'),
  v.check(
    ({ minSize, maxSize }) => v.is(PositiveSafeIntegerSchema, maxSize) && maxSize >= minSize,
    'invalid-maximum-size',
  ),
  v.check(
    ({ minSize, avgSize, maxSize }) => avgSize >= minSize && avgSize <= maxSize,
    'average-size-out-of-range',
  ),
)

/**
 * Splits bytes into deterministic content-defined chunks.
 *
 * @param bytes - Complete file bytes.
 * @param options - Optional chunk size tuning.
 * @returns Chunk byte ranges with offsets.
 */
export function chunkBytes(
  bytes: Uint8Array,
  options: ChunkingOptions = {},
): readonly Uint8Array[] {
  const { minSize, avgSize, maxSize } = normalizeChunkingOptions(options)
  if (bytes.byteLength === 0) {
    return []
  }

  const boundaryMask = avgSize - 1
  const chunks: Uint8Array[] = []
  let start = 0
  let rolling = 0

  // Split the file bytes at deterministic content-defined boundaries.
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) {
      throw new Error('Unexpected sparse byte array')
    }
    rolling = ((rolling << 5) - rolling + byte) >>> 0

    const size = index + 1 - start
    if (size < minSize) {
      continue
    }

    const reachedBoundary = (rolling & boundaryMask) === boundaryMask
    if (reachedBoundary || size >= maxSize) {
      chunks.push(bytes.slice(start, index + 1))
      start = index + 1
      rolling = 0
    }
  }

  if (start < bytes.byteLength) {
    chunks.push(bytes.slice(start))
  }

  return chunks
}

/**
 * Builds a content-addressed blob manifest and upload chunk list.
 *
 * @param fileId - Stable file identifier.
 * @param bytes - Complete binary file bytes.
 * @param createdBy - Device that created this manifest.
 * @param createdAt - Millisecond timestamp controlled by the caller.
 * @param options - Optional chunk size tuning.
 * @returns Manifest, canonical manifest bytes, manifest hash, and chunk bytes.
 */
export async function buildBlobManifest(
  fileId: FileId,
  bytes: Uint8Array,
  createdBy: DeviceId,
  createdAt: number,
  options: ChunkingOptions = {},
): Promise<BuiltBlobManifest> {
  if (!v.is(NonNegativeSafeIntegerSchema, createdAt)) {
    throw new Error(`Invalid manifest timestamp: ${String(createdAt)}`)
  }

  const chunkByteSlices = chunkBytes(bytes, options)
  const chunks: BlobChunk[] = []
  let offset = 0
  for (const chunkBytesValue of chunkByteSlices) {
    const sha256 = makeSha256Hex(await hashBytesSha256(chunkBytesValue))
    chunks.push({ sha256, offset, bytes: chunkBytesValue })
    offset += chunkBytesValue.byteLength
  }

  const manifest: BlobManifest = {
    version: 1,
    fileId,
    contentSha256: makeSha256Hex(await hashBytesSha256(bytes)),
    size: bytes.byteLength,
    chunks: chunks.map((chunk) => ({
      sha256: chunk.sha256,
      offset: chunk.offset,
      size: chunk.bytes.byteLength,
    })),
    createdBy,
    createdAt,
  }
  const manifestBytes = encodeBlobManifestJson(manifest)
  const manifestHash = makeSha256Hex(await hashBytesSha256(manifestBytes))

  return { manifest, manifestHash, manifestBytes, chunks }
}

/**
 * Reassembles binary file bytes after verifying every chunk against a manifest.
 *
 * @param manifest - Manifest describing the expected chunks and full payload.
 * @param chunksBySha256 - Local cache or downloaded chunk bytes keyed by hash.
 * @returns Verified file bytes.
 * @throws BlobAssemblyError when a chunk is missing, malformed, or corrupt.
 */
export async function assembleBlobBytes(
  manifest: BlobManifest,
  chunksBySha256: ReadonlyMap<Sha256Hex, Uint8Array>,
): Promise<Uint8Array> {
  const output = new Uint8Array(manifest.size)

  for (const chunk of manifest.chunks) {
    const bytes = chunksBySha256.get(chunk.sha256)
    if (bytes === undefined) {
      throw new BlobAssemblyError(
        'missing-chunk',
        `Missing blob chunk: ${chunk.sha256}`,
        chunk.sha256,
      )
    }
    if (bytes.byteLength !== chunk.size) {
      throw new BlobAssemblyError(
        'chunk-size-mismatch',
        `Blob chunk size mismatch: ${chunk.sha256}`,
        chunk.sha256,
      )
    }

    const actualChunkHash = makeSha256Hex(await hashBytesSha256(bytes))
    if (actualChunkHash !== chunk.sha256) {
      throw new BlobAssemblyError(
        'chunk-hash-mismatch',
        `Blob chunk hash mismatch: ${chunk.sha256}`,
        chunk.sha256,
      )
    }

    output.set(bytes, chunk.offset)
  }

  const actualContentHash = makeSha256Hex(await hashBytesSha256(output))
  if (actualContentHash !== manifest.contentSha256) {
    throw new BlobAssemblyError('content-hash-mismatch', 'Blob content hash mismatch')
  }

  return output
}

function normalizeChunkingOptions(options: ChunkingOptions): Required<ChunkingOptions> {
  const minSize = options.minSize ?? DEFAULT_CHUNKING_OPTIONS.minSize
  const avgSize = options.avgSize ?? DEFAULT_CHUNKING_OPTIONS.avgSize
  const maxSize = options.maxSize ?? DEFAULT_CHUNKING_OPTIONS.maxSize

  const result = v.safeParse(NormalizedChunkingOptionsSchema, { minSize, avgSize, maxSize })
  if (!result.success) {
    const invalidField = String(result.issues[0]?.path?.[0]?.key)
    if (invalidField === 'avgSize') {
      throw new Error(`avgSize must be a positive power of two: ${String(avgSize)}`)
    }
    if (invalidField === 'minSize') {
      throw new Error(`Invalid minSize: ${String(minSize)}`)
    }
    if (invalidField === 'maxSize') {
      throw new Error(`Invalid maxSize: ${String(maxSize)}`)
    }
    switch (result.issues[0]?.message) {
      case 'invalid-average-size':
        throw new Error(`avgSize must be a positive power of two: ${String(avgSize)}`)
      case 'invalid-minimum-size':
        throw new Error(`Invalid minSize: ${String(minSize)}`)
      case 'invalid-maximum-size':
        throw new Error(`Invalid maxSize: ${String(maxSize)}`)
      default:
        throw new Error(`avgSize must be between minSize and maxSize: ${String(avgSize)}`)
    }
  }

  return result.output
}

function isPositivePowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0
}
