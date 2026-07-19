import { hashBytesSha256 } from '@kuroflare/core'
import {
  blobManifestMatchesMetaFile,
  encodeBlobManifestJson,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  type BinaryMetaFile,
} from '@kuroflare/core'
import { assert, expect, test } from 'vitest'

import {
  assembleBlobBytes,
  BlobAssemblyError,
  buildBlobManifest,
  chunkBytes,
  DEFAULT_CHUNKING_OPTIONS,
} from '../index'

test('default chunking parameters stay pinned', () => {
  // Changing these silently defeats dedup against previously written chunks;
  // treat this pin as a storage-format compatibility boundary when tuning them.
  assert.deepEqual(DEFAULT_CHUNKING_OPTIONS, {
    minSize: 64 * 1024,
    avgSize: 256 * 1024,
    maxSize: 1024 * 1024,
  })
})

test('chunkBytes produces deterministic chunks that cover the input', () => {
  const bytes = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')

  const chunks = chunkBytes(bytes, { minSize: 4, avgSize: 8, maxSize: 10 })

  assert(chunks.length > 1)
  assert.equal(sumByteLengths(chunks), bytes.byteLength)
  assert.deepEqual(chunks, chunkBytes(bytes, { minSize: 4, avgSize: 8, maxSize: 10 }))
})

test('manifest inputs reject unsafe integers through shared schemas', async () => {
  const fileId = makeFileId('file-unsafe-integer')
  const createdBy = makeDeviceId('device-unsafe-integer')
  const bytes = new Uint8Array([1])

  await expect(
    buildBlobManifest(fileId, bytes, createdBy, Number.MAX_SAFE_INTEGER + 1),
  ).rejects.toThrow(/Invalid manifest timestamp/)
  expect(() =>
    chunkBytes(bytes, {
      minSize: Number.MAX_SAFE_INTEGER + 1,
      avgSize: 8,
      maxSize: Number.MAX_SAFE_INTEGER + 1,
    }),
  ).toThrow(/Invalid minSize/)
  expect(() =>
    Reflect.apply(chunkBytes, undefined, [bytes, { minSize: 'bad', avgSize: 8, maxSize: 16 }]),
  ).toThrow(/Invalid minSize: bad/)
})

test('buildBlobManifest creates a canonical manifest and upload list', async () => {
  const fileId = makeFileId('file-1')
  const createdBy = makeDeviceId('device-1')
  const bytes = new TextEncoder().encode('hello deterministic blob manifest')

  const built = await buildBlobManifest(fileId, bytes, createdBy, 123, {
    minSize: 4,
    avgSize: 8,
    maxSize: 10,
  })

  assert.equal(built.manifest.fileId, fileId)
  assert.equal(built.manifest.size, bytes.byteLength)
  assert.equal(sumByteLengths(built.chunks.map((chunk) => chunk.bytes)), bytes.byteLength)
  assert.deepEqual(built.manifestBytes, encodeBlobManifestJson(built.manifest))
  assert.equal(built.manifestHash, makeSha256Hex(await hashBytesSha256(built.manifestBytes)))
})

test('built manifests match binary meta fast-path chunk references', async () => {
  const fileId = makeFileId('file-1')
  const createdBy = makeDeviceId('device-1')
  const bytes = new TextEncoder().encode('binary payload')
  const built = await buildBlobManifest(fileId, bytes, createdBy, 1, {
    minSize: 4,
    avgSize: 8,
    maxSize: 10,
  })
  const metaFile: BinaryMetaFile = {
    schemaVersion: 1,
    fileId,
    path: 'Assets/payload.bin',
    canonicalPath: 'assets/payload.bin',
    type: 'binary',
    blobManifestHash: built.manifestHash,
    blobChunks: built.manifest.chunks.map((chunk) => chunk.sha256),
    deleted: false,
    createdAt: 1,
    createdBy,
    contentUpdatedAt: 1,
    contentUpdatedBy: createdBy,
    updatedAt: 1,
    updatedBy: createdBy,
    mtime: 1,
  }

  assert.equal(blobManifestMatchesMetaFile(built.manifest, metaFile), true)
})

test('buildBlobManifest is deterministic for identical inputs', async () => {
  const fileId = makeFileId('file-1')
  const createdBy = makeDeviceId('device-1')
  const bytes = new TextEncoder().encode('hello deterministic blob manifest')
  const options = { minSize: 4, avgSize: 8, maxSize: 10 }

  const first = await buildBlobManifest(fileId, bytes, createdBy, 123, options)
  const second = await buildBlobManifest(fileId, bytes, createdBy, 123, options)

  assert.equal(second.manifestHash, first.manifestHash)
  assert.equal(second.manifest.contentSha256, first.manifest.contentSha256)
  assert.deepEqual(
    second.manifest.chunks.map((chunk) => chunk.sha256),
    first.manifest.chunks.map((chunk) => chunk.sha256),
  )
})

test('re-uploading identical content under a new createdAt changes the manifest hash but not the content address', async () => {
  // `manifestHash` is the SHA-256 of the full canonical manifest, which embeds `createdAt`/
  // `createdBy` (see stringifyBlobManifest field order) -- so it is not itself a stable content
  // address across separate upload attempts. The chunk hashes and `contentSha256` are the actual
  // content-addressed data, and stay identical. Callers deciding whether a re-upload is a no-op
  // must compare at that level (e.g. via `blobManifestMatchesMetaFile`), not by comparing
  // `manifestHash` values -- comparing manifest hashes would never settle and would re-enqueue
  // the "upload" on every attempt.
  const fileId = makeFileId('file-1')
  const bytes = new TextEncoder().encode('same bytes, uploaded twice')
  const options = { minSize: 4, avgSize: 8, maxSize: 10 }

  const firstAttempt = await buildBlobManifest(
    fileId,
    bytes,
    makeDeviceId('device-1'),
    1_000,
    options,
  )
  const secondAttempt = await buildBlobManifest(
    fileId,
    bytes,
    makeDeviceId('device-2'),
    2_000,
    options,
  )

  assert.notEqual(secondAttempt.manifestHash, firstAttempt.manifestHash)
  assert.equal(secondAttempt.manifest.contentSha256, firstAttempt.manifest.contentSha256)
  assert.deepEqual(
    secondAttempt.manifest.chunks.map((chunk) => chunk.sha256),
    firstAttempt.manifest.chunks.map((chunk) => chunk.sha256),
  )

  const metaFileFromFirstAttempt: BinaryMetaFile = {
    schemaVersion: 1,
    fileId,
    path: 'Assets/payload.bin',
    canonicalPath: 'assets/payload.bin',
    type: 'binary',
    blobManifestHash: firstAttempt.manifestHash,
    blobChunks: firstAttempt.manifest.chunks.map((chunk) => chunk.sha256),
    deleted: false,
    createdAt: 1,
    createdBy: makeDeviceId('device-1'),
    contentUpdatedAt: 1,
    contentUpdatedBy: makeDeviceId('device-1'),
    updatedAt: 1,
    updatedBy: makeDeviceId('device-1'),
    mtime: 1,
  }

  // The settlement check an outbox re-enqueue path must use: does the freshly built manifest's
  // content already match what meta already references? True here even though manifestHash
  // differs, so re-uploading the same content must be skipped instead of looping forever.
  assert.equal(blobManifestMatchesMetaFile(secondAttempt.manifest, metaFileFromFirstAttempt), true)
})

test('buildBlobManifest handles empty files', async () => {
  const built = await buildBlobManifest(
    makeFileId('file-1'),
    new Uint8Array(),
    makeDeviceId('device-1'),
    1,
  )

  assert.equal(built.manifest.size, 0)
  assert.deepEqual(built.manifest.chunks, [])
  assert.deepEqual(built.chunks, [])
})

// DR-010: an empty file's meta entry has no chunks, but keeps blobManifestHash as content
// evidence, so it must still match its (chunkless) manifest.
test('empty-file manifests match binary meta entries with no chunks', async () => {
  const fileId = makeFileId('file-1')
  const createdBy = makeDeviceId('device-1')
  const built = await buildBlobManifest(fileId, new Uint8Array(), createdBy, 1)
  const metaFile: BinaryMetaFile = {
    schemaVersion: 1,
    fileId,
    path: 'Assets/empty.bin',
    canonicalPath: 'assets/empty.bin',
    type: 'binary',
    blobManifestHash: built.manifestHash,
    blobChunks: [],
    deleted: false,
    createdAt: 1,
    createdBy,
    contentUpdatedAt: 1,
    contentUpdatedBy: createdBy,
    updatedAt: 1,
    updatedBy: createdBy,
    mtime: 1,
  }

  assert.equal(blobManifestMatchesMetaFile(built.manifest, metaFile), true)
})

test('assembleBlobBytes verifies chunks and content hash', async () => {
  const bytes = new TextEncoder().encode('downloaded binary payload')
  const built = await buildBlobManifest(makeFileId('file-1'), bytes, makeDeviceId('device-1'), 1, {
    minSize: 4,
    avgSize: 8,
    maxSize: 10,
  })

  const assembled = await assembleBlobBytes(
    built.manifest,
    new Map(built.chunks.map((chunk) => [chunk.sha256, chunk.bytes])),
  )

  assert.deepEqual(assembled, bytes)
})

test('assembleBlobBytes rejects missing or corrupt chunks', async () => {
  const bytes = new TextEncoder().encode('corrupt me')
  const built = await buildBlobManifest(makeFileId('file-1'), bytes, makeDeviceId('device-1'), 1, {
    minSize: 4,
    avgSize: 8,
    maxSize: 10,
  })
  const firstChunk = built.chunks[0]
  assert(firstChunk)

  await expect(assembleBlobBytes(built.manifest, new Map())).rejects.toThrow(BlobAssemblyError)
  try {
    await assembleBlobBytes(built.manifest, new Map())
  } catch (error) {
    assert.instanceOf(error, BlobAssemblyError)
    assert.equal(error.code, 'missing-chunk')
  }

  try {
    await assembleBlobBytes(built.manifest, new Map([[firstChunk.sha256, Uint8Array.from([1])]]))
  } catch (error) {
    assert.instanceOf(error, BlobAssemblyError)
    assert.equal(error.code, 'chunk-size-mismatch')
  }

  const sameSizeCorrupt = Uint8Array.from(firstChunk.bytes)
  sameSizeCorrupt[0] = (sameSizeCorrupt[0] ?? 0) ^ 0xff
  try {
    await assembleBlobBytes(built.manifest, new Map([[firstChunk.sha256, sameSizeCorrupt]]))
  } catch (error) {
    assert.instanceOf(error, BlobAssemblyError)
    assert.equal(error.code, 'chunk-hash-mismatch')
  }
})

test('assembleBlobBytes rejects content hash mismatch', async () => {
  const built = await buildBlobManifest(
    makeFileId('file-1'),
    new TextEncoder().encode('payload'),
    makeDeviceId('device-1'),
    1,
    { minSize: 4, avgSize: 8, maxSize: 10 },
  )

  try {
    await assembleBlobBytes(
      { ...built.manifest, contentSha256: makeSha256Hex('0'.repeat(64)) },
      new Map(built.chunks.map((chunk) => [chunk.sha256, chunk.bytes])),
    )
  } catch (error) {
    assert.instanceOf(error, BlobAssemblyError)
    assert.equal(error.code, 'content-hash-mismatch')
  }
})

function sumByteLengths(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
}
