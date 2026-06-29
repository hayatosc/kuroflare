import { hashBytesSha256 } from '@kuroflare/core'
import {
  encodeBlobManifestJson,
  makeSha256Hex,
  type BlobManifest,
  type DeviceId,
  type FileId,
  type Sha256Hex,
} from '@kuroflare/protocol'

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

const DEFAULT_MIN_SIZE = 64 * 1024
const DEFAULT_AVG_SIZE = 256 * 1024
const DEFAULT_MAX_SIZE = 1024 * 1024

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

  // MVP chunker: deterministic content-defined boundaries, but not a fixed-window
  // FastCDC/Gear hash. A future format version may replace this for stronger
  // insertion-stable deduplication without changing manifest verification.
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
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error(`Invalid manifest timestamp: ${createdAt}`)
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
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE
  const avgSize = options.avgSize ?? DEFAULT_AVG_SIZE
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE

  if (!isPositivePowerOfTwo(avgSize)) {
    throw new Error(`avgSize must be a positive power of two: ${avgSize}`)
  }
  if (!Number.isSafeInteger(minSize) || minSize <= 0) {
    throw new Error(`Invalid minSize: ${minSize}`)
  }
  if (!Number.isSafeInteger(maxSize) || maxSize < minSize) {
    throw new Error(`Invalid maxSize: ${maxSize}`)
  }
  if (avgSize < minSize || avgSize > maxSize) {
    throw new Error(`avgSize must be between minSize and maxSize: ${avgSize}`)
  }

  return { minSize, avgSize, maxSize }
}

function isPositivePowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0
}
