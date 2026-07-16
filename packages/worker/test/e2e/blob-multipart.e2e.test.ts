import {
  BlobMultipartUploadResponseSchema,
  hashBytesSha256,
  makeSha256Hex,
  makeVaultId,
  makeDeviceId,
  signHs256DeviceToken,
} from '@kuroflare/core'
import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import * as v from 'valibot'

import { createDb } from '../../src/db/db'
import { SCHEMA_MIGRATIONS } from '../../src/db/schema'

const VAULT_ID = 'vault-multipart'
const DEVICE_ID = 'device-multipart'
const DEVICE_TOKEN_SECRET = 'e2e-device-token-secret'

const BlobPartPutResponseSchema = v.object({
  status: v.literal('stored'),
  partNumber: v.number(),
  etag: v.string(),
  size: v.number(),
})

const BlobMultipartAbortResponseSchema = v.object({
  status: v.literal('aborted'),
  sha256: v.string(),
})

function roomStub() {
  return env.VAULT_ROOM.get(env.VAULT_ROOM.idFromName(VAULT_ID))
}

async function seedDevice(): Promise<void> {
  await runInDurableObject(roomStub(), async (_instance, state) => {
    const sql = state.storage.sql
    const db = createDb(sql)
    for (const migration of SCHEMA_MIGRATIONS) {
      await migration.migrate(db)
    }
    sql.exec(
      'insert or replace into devices (device_id, token_version, created_at) values (?, ?, ?)',
      DEVICE_ID,
      1,
      Date.now(),
    )
  })
}

async function mintAccessToken(): Promise<string> {
  const now = Date.now()
  return signHs256DeviceToken({
    claims: {
      iss: 'kuroflare-worker',
      aud: makeVaultId(VAULT_ID),
      sub: makeDeviceId(DEVICE_ID),
      scope: ['blob:read', 'blob:write'],
      iat: now - 1_000,
      exp: now + 3_600_000,
      tokenVersion: 1,
    },
    secret: DEVICE_TOKEN_SECRET,
  })
}

// Exercises the real R2 multipart binding (miniflare), not the hand-rolled fake used by the
// node-pool unit tests, since real R2 semantics (etags, session lifetime) are what the
// fake's known blind spots could otherwise hide.
test('the Worker completes a real R2-backed multipart blob upload', async () => {
  await seedDevice()
  const token = await mintAccessToken()
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const bytes = new TextEncoder().encode('real R2 multipart upload payload')
  const hash = makeSha256Hex(await hashBytesSha256(bytes))

  const uploadUrlResponse = await roomStub().fetch(
    new Request('https://kuroflare.test/blobs/upload-url', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sha256: hash, size: bytes.byteLength, multipart: true }),
    }),
  )
  expect(uploadUrlResponse.status).toBe(200)
  const uploadUrlBody = v.parse(BlobMultipartUploadResponseSchema, await uploadUrlResponse.json())
  expect(uploadUrlBody.parts).toHaveLength(1)
  const [part] = uploadUrlBody.parts
  if (part === undefined) throw new Error('expected one planned part')

  const partPutResponse = await roomStub().fetch(
    new Request(part.url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-length': String(bytes.byteLength),
      },
      body: bytes,
    }),
  )
  expect(partPutResponse.status).toBe(200)
  const partPutBody = v.parse(BlobPartPutResponseSchema, await partPutResponse.json())

  const completeResponse = await roomStub().fetch(
    new Request(`https://kuroflare.test/blobs/${hash}/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        uploadId: uploadUrlBody.uploadId,
        parts: [{ partNumber: part.partNumber, etag: partPutBody.etag }],
      }),
    }),
  )
  expect(completeResponse.status).toBe(200)
  expect(await completeResponse.json()).toEqual({
    status: 'stored',
    sha256: hash,
    size: bytes.byteLength,
  })

  const getResponse = await roomStub().fetch(
    new Request(`https://kuroflare.test/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  expect(getResponse.status).toBe(200)
  expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(bytes)
})

test('the Worker aborts a real R2-backed multipart blob upload session', async () => {
  await seedDevice()
  const token = await mintAccessToken()
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const hash = makeSha256Hex(await hashBytesSha256(new TextEncoder().encode('aborted upload')))

  const uploadUrlResponse = await roomStub().fetch(
    new Request('https://kuroflare.test/blobs/upload-url', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sha256: hash, size: 10, multipart: true }),
    }),
  )
  const uploadUrlBody = v.parse(BlobMultipartUploadResponseSchema, await uploadUrlResponse.json())

  const abortResponse = await roomStub().fetch(
    new Request(`https://kuroflare.test/blobs/${hash}/abort`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ uploadId: uploadUrlBody.uploadId }),
    }),
  )
  expect(abortResponse.status).toBe(200)
  expect(v.parse(BlobMultipartAbortResponseSchema, await abortResponse.json())).toEqual({
    status: 'aborted',
    sha256: hash,
  })

  const getResponse = await roomStub().fetch(
    new Request(`https://kuroflare.test/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  )
  expect(getResponse.status).toBe(404)
})
