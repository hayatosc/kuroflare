import { type Kysely, sql } from 'kysely'

import type { Database } from './types'

export interface BlobMultipartUploadRow {
  readonly sha256: string
  readonly size: number
  readonly createdAt: number
  readonly expiresAt: number
}

export interface BlobMultipartPartRow {
  readonly partNumber: number
  readonly etag: string
  readonly size: number
  readonly sha256: string
}

export interface ExpiredBlobMultipartUpload {
  readonly uploadId: string
  readonly sha256: string
}

export async function insertBlobMultipartUpload(
  db: Kysely<Database>,
  uploadId: string,
  sha256: string,
  size: number,
  createdAt: number,
  expiresAt: number,
): Promise<void> {
  await db
    .insertInto('blob_multipart_uploads')
    .values({
      upload_id: uploadId,
      sha256,
      size,
      created_at: createdAt,
      expires_at: expiresAt,
    })
    .execute()
}

export async function getBlobMultipartUpload(
  db: Kysely<Database>,
  uploadId: string,
): Promise<BlobMultipartUploadRow | undefined> {
  return db
    .selectFrom('blob_multipart_uploads')
    .select((eb) => [
      eb.ref('sha256').as('sha256'),
      eb.ref('size').as('size'),
      eb.ref('created_at').as('createdAt'),
      eb.ref('expires_at').as('expiresAt'),
    ])
    .where('upload_id', '=', uploadId)
    .executeTakeFirst()
}

export async function getExpiredBlobMultipartUploads(
  db: Kysely<Database>,
  now: number,
  limit: number,
): Promise<readonly ExpiredBlobMultipartUpload[]> {
  return db
    .selectFrom('blob_multipart_uploads')
    .select((eb) => [eb.ref('upload_id').as('uploadId'), eb.ref('sha256').as('sha256')])
    .where('expires_at', '<=', now)
    .limit(limit)
    .execute()
}

export async function deleteBlobMultipartUpload(
  db: Kysely<Database>,
  uploadId: string,
): Promise<void> {
  await db.deleteFrom('blob_multipart_uploads').where('upload_id', '=', uploadId).execute()
  await db.deleteFrom('blob_multipart_parts').where('upload_id', '=', uploadId).execute()
}

export async function upsertBlobMultipartPart(
  db: Kysely<Database>,
  uploadId: string,
  partNumber: number,
  etag: string,
  size: number,
  sha256: string,
): Promise<void> {
  await db
    .insertInto('blob_multipart_parts')
    .values({ upload_id: uploadId, part_number: partNumber, etag, size, sha256 })
    .onConflict((oc) =>
      oc.columns(['upload_id', 'part_number']).doUpdateSet({
        etag: sql`excluded.etag`,
        size: sql`excluded.size`,
        sha256: sql`excluded.sha256`,
      }),
    )
    .execute()
}

export async function getBlobMultipartParts(
  db: Kysely<Database>,
  uploadId: string,
): Promise<readonly BlobMultipartPartRow[]> {
  return db
    .selectFrom('blob_multipart_parts')
    .select((eb) => [
      eb.ref('part_number').as('partNumber'),
      eb.ref('etag').as('etag'),
      eb.ref('size').as('size'),
      eb.ref('sha256').as('sha256'),
    ])
    .where('upload_id', '=', uploadId)
    .orderBy('part_number', 'asc')
    .execute()
}
