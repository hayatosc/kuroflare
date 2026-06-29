import assert from 'node:assert/strict'

import {
  makeSha256Hex,
  type BlobHeadRequest,
  type BlobMultipartUploadResponse,
  type BlobSinglePutUploadResponse,
  type BlobUploadUrlRequest,
} from '@kuroflare/core'
import { test } from 'vitest'

import { planBlobHeadHttpResponse, planBlobUploadUrlHttpResponse } from './blob'

const firstHash = makeSha256Hex('a'.repeat(64))
const secondHash = makeSha256Hex('b'.repeat(64))
const thirdHash = makeSha256Hex('c'.repeat(64))

test('blob head HTTP response reports requested object existence', () => {
  const request = {
    hashes: [firstHash, secondHash],
  } satisfies BlobHeadRequest

  assert.deepEqual(
    planBlobHeadHttpResponse({
      request,
      objects: [
        { sha256: firstHash, found: true, size: 123 },
        { sha256: secondHash, found: false },
      ],
    }),
    {
      action: 'respond',
      response: {
        exists: {
          [firstHash]: { found: true, size: 123 },
          [secondHash]: { found: false },
        },
      },
    },
  )
})

test('blob head HTTP response rejects incomplete or unrelated evidence', () => {
  const request = {
    hashes: [firstHash, secondHash],
  } satisfies BlobHeadRequest

  assert.deepEqual(
    planBlobHeadHttpResponse({
      request,
      objects: [{ sha256: firstHash, found: true }],
    }),
    { action: 'reject', reason: 'missing-evidence' },
  )

  assert.deepEqual(
    planBlobHeadHttpResponse({
      request,
      objects: [
        { sha256: firstHash, found: true },
        { sha256: thirdHash, found: false },
      ],
    }),
    { action: 'reject', reason: 'unexpected-evidence' },
  )
})

test('blob head HTTP response rejects duplicate evidence', () => {
  assert.deepEqual(
    planBlobHeadHttpResponse({
      request: { hashes: [firstHash, firstHash] },
      objects: [{ sha256: firstHash, found: true }],
    }),
    { action: 'reject', reason: 'duplicate-request-hash' },
  )

  assert.deepEqual(
    planBlobHeadHttpResponse({
      request: { hashes: [firstHash] },
      objects: [
        { sha256: firstHash, found: true },
        { sha256: firstHash, found: true },
      ],
    }),
    { action: 'reject', reason: 'duplicate-evidence' },
  )
})

test('blob head HTTP response rejects invalid size evidence', () => {
  assert.deepEqual(
    planBlobHeadHttpResponse({
      request: { hashes: [firstHash] },
      objects: [{ sha256: firstHash, found: true, size: -1 }],
    }),
    { action: 'reject', reason: 'invalid-blob-size' },
  )

  assert.deepEqual(
    planBlobHeadHttpResponse({
      request: { hashes: [firstHash] },
      objects: [{ sha256: firstHash, found: false, size: 0 }],
    }),
    { action: 'reject', reason: 'invalid-blob-size' },
  )
})

const uploadRequest = {
  sha256: firstHash,
  size: 1024,
} satisfies BlobUploadUrlRequest

const singlePutResponse = {
  kind: 'single-put',
  url: 'https://upload.example.test/blob',
  headers: { 'content-type': 'application/octet-stream' },
  expiresAt: 2_000,
} satisfies BlobSinglePutUploadResponse

const multipartResponse = {
  kind: 'multipart',
  uploadId: 'upload-1',
  parts: [
    { partNumber: 1, url: 'https://upload.example.test/blob?part=1', headers: {} },
    { partNumber: 2, url: 'https://upload.example.test/blob?part=2', headers: {} },
  ],
  expiresAt: 2_000,
} satisfies BlobMultipartUploadResponse

test('blob upload URL response skips objects that already exist with matching evidence', () => {
  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: true, size: 1024 },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      singlePut: singlePutResponse,
    }),
    {
      action: 'respond',
      response: { kind: 'already-exists' },
    },
  )
})

test('blob upload URL response plans single PUT for small missing objects', () => {
  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      singlePut: singlePutResponse,
      multipart: multipartResponse,
    }),
    {
      action: 'respond',
      response: singlePutResponse,
    },
  )
})

test('blob upload URL response plans multipart only when requested or required', () => {
  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: { ...uploadRequest, multipart: true },
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      singlePut: singlePutResponse,
      multipart: multipartResponse,
    }),
    {
      action: 'respond',
      response: multipartResponse,
    },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: { ...uploadRequest, size: 16 * 1024 * 1024, multipart: true },
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      multipart: multipartResponse,
    }),
    {
      action: 'respond',
      response: multipartResponse,
    },
  )
})

test('blob upload URL response rejects unsafe existence and policy evidence', () => {
  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: secondHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      singlePut: singlePutResponse,
    }),
    { action: 'reject', reason: 'hash-mismatch' },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: true, size: 2048 },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
    }),
    { action: 'reject', reason: 'existing-size-mismatch' },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: false, size: 0 },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
    }),
    { action: 'reject', reason: 'invalid-object-size' },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: false },
      now: -1,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      singlePut: singlePutResponse,
    }),
    { action: 'reject', reason: 'invalid-now' },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 0 },
      singlePut: singlePutResponse,
    }),
    { action: 'reject', reason: 'invalid-policy' },
  )
})

test('blob upload URL response rejects missing or stale upload targets', () => {
  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: { ...uploadRequest, size: 16 * 1024 * 1024 },
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      multipart: multipartResponse,
    }),
    { action: 'reject', reason: 'multipart-required' },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
    }),
    { action: 'reject', reason: 'missing-upload-target' },
  )

  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: uploadRequest,
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      singlePut: { ...singlePutResponse, expiresAt: 1_000 },
    }),
    { action: 'reject', reason: 'invalid-upload-expiry' },
  )
})

test('blob upload URL response rejects malformed multipart targets', () => {
  assert.deepEqual(
    planBlobUploadUrlHttpResponse({
      request: { ...uploadRequest, multipart: true },
      object: { sha256: firstHash, found: false },
      now: 1_000,
      policy: { multipartThresholdBytes: 8 * 1024 * 1024 },
      multipart: {
        ...multipartResponse,
        parts: [
          {
            partNumber: 2,
            url: 'https://upload.example.test/blob?part=2',
            headers: {},
          },
        ],
      },
    }),
    { action: 'reject', reason: 'invalid-multipart-parts' },
  )
})
