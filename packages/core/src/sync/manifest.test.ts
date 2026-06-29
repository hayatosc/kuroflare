import assert from 'node:assert/strict'

import { hashBytesSha256 } from '@kuroflare/core'
import {
  blobManifestMatchesMetaFile,
  encodeBlobManifestJson,
  makeDeviceId,
  makeFileId,
  makeSha256Hex,
  type BinaryMetaFile,
} from '@kuroflare/core'
import { test } from 'vitest'

import { assembleBlobBytes, BlobAssemblyError, buildBlobManifest, chunkBytes } from '../index'

test('chunkBytes produces deterministic chunks that cover the input', () => {
  const bytes = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')

  const chunks = chunkBytes(bytes, { minSize: 4, avgSize: 8, maxSize: 10 })

  assert(chunks.length > 1)
  assert.equal(sumByteLengths(chunks), bytes.byteLength)
  assert.deepEqual(chunks, chunkBytes(bytes, { minSize: 4, avgSize: 8, maxSize: 10 }))
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

  await assert.rejects(
    () => assembleBlobBytes(built.manifest, new Map()),
    (error) => error instanceof BlobAssemblyError && error.code === 'missing-chunk',
  )

  await assert.rejects(
    () => assembleBlobBytes(built.manifest, new Map([[firstChunk.sha256, Uint8Array.from([1])]])),
    (error) => error instanceof BlobAssemblyError && error.code === 'chunk-size-mismatch',
  )

  const sameSizeCorrupt = Uint8Array.from(firstChunk.bytes)
  sameSizeCorrupt[0] = (sameSizeCorrupt[0] ?? 0) ^ 0xff
  await assert.rejects(
    () => assembleBlobBytes(built.manifest, new Map([[firstChunk.sha256, sameSizeCorrupt]])),
    (error) => error instanceof BlobAssemblyError && error.code === 'chunk-hash-mismatch',
  )
})

test('assembleBlobBytes rejects content hash mismatch', async () => {
  const built = await buildBlobManifest(
    makeFileId('file-1'),
    new TextEncoder().encode('payload'),
    makeDeviceId('device-1'),
    1,
    { minSize: 4, avgSize: 8, maxSize: 10 },
  )

  await assert.rejects(
    () =>
      assembleBlobBytes(
        { ...built.manifest, contentSha256: makeSha256Hex('0'.repeat(64)) },
        new Map(built.chunks.map((chunk) => [chunk.sha256, chunk.bytes])),
      ),
    (error) => error instanceof BlobAssemblyError && error.code === 'content-hash-mismatch',
  )
})

function sumByteLengths(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
}
