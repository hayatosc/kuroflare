import { Sha256HexSchema } from '@kuroflare/core'
import * as v from 'valibot'

import { deleteBlobMultipartUpload, readExpiredBlobMultipartUploads } from './storage'
import { blobObjectKey } from './utils'
import type { VaultRoom } from './vault-room'

const EXPIRED_BLOB_MULTIPART_UPLOAD_SWEEP_LIMIT = 16

/**
 * Aborts pending multipart upload sessions past their `expiresAt` and clears
 * their pending rows. Runs from the same alarm as checkpoint/eviction
 * maintenance; see `VaultRoom.alarm()` for why this doesn't schedule its own
 * wakeup.
 */
export async function abortExpiredBlobMultipartUploads(
  room: VaultRoom,
  now = Date.now(),
): Promise<void> {
  const bucket = room.env.SNAPSHOT_BUCKET
  const vaultId = room.vaultId
  if (bucket === undefined || vaultId === undefined) return

  const expired = await readExpiredBlobMultipartUploads(
    room,
    now,
    EXPIRED_BLOB_MULTIPART_UPLOAD_SWEEP_LIMIT,
  )
  for (const upload of expired) {
    if (!v.is(Sha256HexSchema, upload.sha256)) {
      await deleteBlobMultipartUpload(room, upload.uploadId)
      continue
    }
    try {
      await bucket.resumeMultipartUpload(blobObjectKey(vaultId, upload.sha256), upload.uploadId).abort()
    } catch {
      // deliberate: R2 may have already garbage-collected or completed this session.
    }
    await deleteBlobMultipartUpload(room, upload.uploadId)
  }
}
