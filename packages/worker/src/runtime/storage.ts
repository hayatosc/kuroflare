import {
  VaultIdSchema,
  Sha256HexSchema,
  type DocId,
  type MessageId,
  type Sha256Hex,
  type VaultId,
  type ClientHello,
} from '@kuroflare/core'
import type { Kysely } from 'kysely'
import * as v from 'valibot'

import {
  insertBlobMultipartUpload,
  getBlobMultipartUpload,
  getExpiredBlobMultipartUploads,
  deleteBlobMultipartUpload as deleteBlobMultipartUploadRow,
  upsertBlobMultipartPart,
  getBlobMultipartParts,
  type ExpiredBlobMultipartUpload,
} from '../db/blobRepo'
import {
  getQuarantinedUpdates,
  getQuarantinedUpdateById,
  getQuarantinedUpdateBytes,
} from '../db/checkpointRepo'
import { createDb } from '../db/db'
import {
  getDevice,
  upsertDevice,
  updateDeviceRevoked,
  getRefreshToken,
  insertRefreshToken,
  updateRefreshTokenRevoked,
} from '../db/deviceRepo'
import {
  getDocClock,
  getDocSnapshotPointer,
  getDocSnapshotSeq,
  getDocRetention,
  getFirstDocId,
  getMessageDedupSeq,
} from '../db/docRepo'
import { readSqlUpdateBytes } from '../db/helpers'
import { decideSchemaMigration } from '../db/migrations'
import { SCHEMA_MIGRATIONS } from '../db/schema'
import {
  createSchemaMigrationsTable,
  getAppliedMigrations,
  insertMigration,
} from '../db/schemaRepo'
import { getSetupToken, consumeSetupToken as consumeSetupTokenDb } from '../db/setupRepo'
import type { Database } from '../db/types'
import { type DeviceRegistryEntry, type DeviceRefreshTokenEvidence } from '../devices'
import type { SetupTokenEntry } from '../devices/tokens'
import type { QuarantinedUpdateRecord } from '../quarantine'
import type { SyncRequestDocState } from '../sync/request'
import type { SyncUpdateDocClock, SyncUpdateDuplicateEvidence } from '../sync/update'
import { VAULT_ID_STORAGE_KEY } from './constants'
import {
  PosIntSchema,
  NonNegIntSchema,
  type RuntimeBlobMultipartUploadRecord,
  type RuntimeBlobMultipartPartRecord,
  type RuntimeSnapshotPointerRecord,
} from './types'
import { docKey, quarantinedUpdateRecordFromSqlRow } from './utils'
import type { VaultRoom } from './vault-room'

export function getDb(room: VaultRoom): Kysely<Database> | undefined {
  const sql = room.state.storage.sql
  return sql === undefined ? undefined : createDb(sql)
}

export async function ensureSchema(room: VaultRoom): Promise<void> {
  if (room.schemaReady) return
  const inFlight = room.schemaEnsurePromise
  if (inFlight !== undefined) return inFlight

  const promise = ensureSchemaOnce(room)
  room.schemaEnsurePromise = promise
  try {
    await promise
  } finally {
    if (room.schemaEnsurePromise === promise) room.schemaEnsurePromise = undefined
  }
}

async function ensureSchemaOnce(room: VaultRoom): Promise<void> {
  const sql = room.state.storage.sql
  const db = getDb(room)
  if (sql === undefined || db === undefined) return

  // SQLite does not allow changing foreign_keys inside a transaction. The
  // device table rebuild temporarily removes a referenced table, so disable
  // enforcement before entering the Durable Object transaction and restore it
  // on every exit path.
  try {
    sql.exec('pragma foreign_keys = off')
    await room.state.storage.transaction(async () => {
      await createSchemaMigrationsTable(db)
      const appliedVersions = new Set<number>()
      for (const row of await getAppliedMigrations(db)) {
        if (v.is(PosIntSchema, row.version)) appliedVersions.add(row.version)
      }

      const decision = decideSchemaMigration({
        appliedVersions,
        availableMigrations: SCHEMA_MIGRATIONS,
        failedMigration: undefined,
      })
      if (decision.action === 'degraded') {
        throw new Error(`schema-degraded:${decision.reason}`)
      }
      if (decision.action === 'apply-migrations') {
        const now = Date.now()
        for (const migration of decision.migrations) {
          await migration.migrate(db)
          await insertMigration(db, migration.version, now)
        }
      }
    })
  } finally {
    sql.exec('pragma foreign_keys = on')
  }
  room.schemaReady = true
}

export async function readDocClock(
  room: VaultRoom,
  docId: DocId,
): Promise<SyncUpdateDocClock | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getDocClock(db, docKey(docId))
  const latestSeq = row?.latestSeq
  return v.is(NonNegIntSchema, latestSeq) ? { latestSeq } : undefined
}

export async function readDuplicate(
  room: VaultRoom,
  docId: DocId,
  messageId: MessageId,
): Promise<SyncUpdateDuplicateEvidence | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getMessageDedupSeq(db, docKey(docId), messageId)
  if (row === undefined) return undefined
  const durableSeq = v.is(PosIntSchema, row.durableSeq) ? row.durableSeq : 0
  const updateSha256 = v.is(Sha256HexSchema, row.updateSha256) ? row.updateSha256 : undefined
  return { durableSeq, updateSha256 }
}

export async function readSyncRequestDocState(
  room: VaultRoom,
  docId: DocId,
): Promise<
  | (Omit<
      SyncRequestDocState,
      'stateVectorCoversHorizon' | 'diffSourceAvailable' | 'diffUpdateBase64' | 'diffUpdateSha256'
    > & { readonly horizonStateVector: Uint8Array | undefined })
  | undefined
> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getDocRetention(db, docKey(docId))
  const latestSeq = row?.latestSeq
  const minRetainedSeq = row?.minRetainedSeq
  const horizonStateVector = readSqlUpdateBytes(row?.horizonStateVector)
  if (!v.is(NonNegIntSchema, latestSeq) || !v.is(NonNegIntSchema, minRetainedSeq)) return undefined
  return { latestSeq, minRetainedSeq, horizonStateVector }
}

export async function readSnapshotPointer(
  room: VaultRoom,
  docId: DocId,
): Promise<RuntimeSnapshotPointerRecord | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getDocSnapshotPointer(db, docKey(docId))
  const latestSnapshotSeq = row?.latestSnapshotSeq
  const latestSnapshotKey = row?.latestSnapshotKey
  if (
    !v.is(PosIntSchema, latestSnapshotSeq) ||
    typeof latestSnapshotKey !== 'string' ||
    latestSnapshotKey.length === 0
  )
    return undefined
  return {
    latestSnapshotSeq,
    latestSnapshotKey,
    stateVector: readSqlUpdateBytes(row?.latestStateVector),
  }
}

export async function readSnapshotSeq(room: VaultRoom, docId: DocId): Promise<number> {
  const db = getDb(room)
  if (db === undefined) return 0
  const row = await getDocSnapshotSeq(db, docKey(docId))
  const latestSnapshotSeq = row?.latestSnapshotSeq
  return v.is(NonNegIntSchema, latestSnapshotSeq) ? latestSnapshotSeq : 0
}

export async function readDeviceRegistryEntry(
  room: VaultRoom,
  deviceId: ClientHello['deviceId'],
): Promise<DeviceRegistryEntry | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getDevice(db, deviceId)
  const tokenVersion = row?.tokenVersion
  const revokedAt = row?.revokedAt ?? undefined
  if (!v.is(PosIntSchema, tokenVersion)) return undefined
  return { deviceId, tokenVersion, revokedAt }
}

export async function readSetupToken(
  room: VaultRoom,
  tokenHash: string,
): Promise<SetupTokenEntry | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getSetupToken(db, tokenHash)
  if (
    row === undefined ||
    !v.is(VaultIdSchema, row.vaultId) ||
    !v.is(NonNegIntSchema, row.issuedAt) ||
    !v.is(NonNegIntSchema, row.expiresAt)
  )
    return undefined
  const consumedAt = row.consumedAt ?? undefined
  if (consumedAt !== undefined && !v.is(NonNegIntSchema, consumedAt)) return undefined
  return { vaultId: row.vaultId, issuedAt: row.issuedAt, expiresAt: row.expiresAt, consumedAt }
}

export async function readRefreshToken(
  room: VaultRoom,
  tokenHash: string,
): Promise<DeviceRefreshTokenEvidence | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getRefreshToken(db, tokenHash)
  if (
    row === undefined ||
    !v.is(NonNegIntSchema, row.issuedAt) ||
    !v.is(NonNegIntSchema, row.expiresAt)
  )
    return undefined
  const revokedAt = row.revokedAt ?? undefined
  return { tokenHashMatches: true, issuedAt: row.issuedAt, expiresAt: row.expiresAt, revokedAt }
}

export async function readQuarantinedUpdates(
  room: VaultRoom,
): Promise<readonly QuarantinedUpdateRecord[]> {
  const db = getDb(room)
  if (db === undefined) return []
  return [...(await getQuarantinedUpdates(db))]
    .map(quarantinedUpdateRecordFromSqlRow)
    .filter((r): r is QuarantinedUpdateRecord => r !== undefined)
}

export async function readQuarantinedUpdate(
  room: VaultRoom,
  id: string,
): Promise<QuarantinedUpdateRecord | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  return quarantinedUpdateRecordFromSqlRow(await getQuarantinedUpdateById(db, id))
}

export async function readQuarantinedUpdateBytes(
  room: VaultRoom,
  id: string,
): Promise<Uint8Array | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getQuarantinedUpdateBytes(db, id)
  return readSqlUpdateBytes(row?.updateBytes)
}

export async function hasAnyPersistedDocs(room: VaultRoom): Promise<boolean> {
  const db = getDb(room)
  if (db === undefined) return false
  return (await getFirstDocId(db)) !== undefined
}

export async function consumeSetupToken(
  room: VaultRoom,
  tokenHash: string,
  consumedAt: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await consumeSetupTokenDb(db, tokenHash, consumedAt)
}

export async function persistSetupDevice(
  room: VaultRoom,
  deviceId: string,
  now: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await upsertDevice(db, deviceId, now)
}

export async function persistRefreshToken(
  room: VaultRoom,
  tokenHash: string,
  deviceId: string,
  issuedAt: number,
  expiresAt: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await insertRefreshToken(db, tokenHash, deviceId, issuedAt, expiresAt)
}

export async function revokeRefreshToken(
  room: VaultRoom,
  tokenHash: string,
  revokedAt: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await updateRefreshTokenRevoked(db, tokenHash, revokedAt)
}

export async function persistDeviceRevocation(
  room: VaultRoom,
  deviceId: string,
  tokenVersion: number,
  revokedAt: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await updateDeviceRevoked(db, deviceId, tokenVersion, revokedAt)
}

export async function persistBlobMultipartUpload(
  room: VaultRoom,
  uploadId: string,
  sha256: Sha256Hex,
  size: number,
  createdAt: number,
  expiresAt: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) {
    await insertBlobMultipartUpload(db, uploadId, sha256, size, createdAt, expiresAt)
  }
}

export async function readBlobMultipartUpload(
  room: VaultRoom,
  uploadId: string,
): Promise<RuntimeBlobMultipartUploadRecord | undefined> {
  const db = getDb(room)
  if (db === undefined) return undefined
  const row = await getBlobMultipartUpload(db, uploadId)
  if (
    row === undefined ||
    !v.is(Sha256HexSchema, row.sha256) ||
    !v.is(NonNegIntSchema, row.size) ||
    !v.is(NonNegIntSchema, row.createdAt) ||
    !v.is(NonNegIntSchema, row.expiresAt)
  )
    return undefined
  return { sha256: row.sha256, size: row.size, createdAt: row.createdAt, expiresAt: row.expiresAt }
}

export async function readExpiredBlobMultipartUploads(
  room: VaultRoom,
  now: number,
  limit: number,
): Promise<readonly ExpiredBlobMultipartUpload[]> {
  const db = getDb(room)
  if (db === undefined) return []
  return getExpiredBlobMultipartUploads(db, now, limit)
}

export async function deleteBlobMultipartUpload(room: VaultRoom, uploadId: string): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await deleteBlobMultipartUploadRow(db, uploadId)
}

export async function persistBlobMultipartPart(
  room: VaultRoom,
  uploadId: string,
  partNumber: number,
  etag: string,
  size: number,
  sha256: Sha256Hex,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await upsertBlobMultipartPart(db, uploadId, partNumber, etag, size, sha256)
}

export async function readBlobMultipartParts(
  room: VaultRoom,
  uploadId: string,
): Promise<readonly RuntimeBlobMultipartPartRecord[]> {
  const db = getDb(room)
  if (db === undefined) return []
  const rows = await getBlobMultipartParts(db, uploadId)
  const parts: RuntimeBlobMultipartPartRecord[] = []
  for (const row of rows) {
    if (
      !v.is(PosIntSchema, row.partNumber) ||
      !v.is(NonNegIntSchema, row.size) ||
      !v.is(Sha256HexSchema, row.sha256)
    )
      continue
    parts.push({ partNumber: row.partNumber, etag: row.etag, size: row.size, sha256: row.sha256 })
  }
  return parts
}

export async function withSqlTransaction(
  room: VaultRoom,
  write: () => Promise<void>,
): Promise<void> {
  if (room.state.storage.sql === undefined) throw new Error('sql-unavailable')
  await room.state.storage.transaction(write)
}

export async function persistVaultId(room: VaultRoom, vaultId: VaultId): Promise<void> {
  if (room.vaultId === undefined) room.vaultId = vaultId
  if (room.vaultId !== vaultId) return
  await room.state.storage.put(VAULT_ID_STORAGE_KEY, vaultId)
}

export async function resolveVaultId(room: VaultRoom): Promise<VaultId | undefined> {
  if (room.vaultId !== undefined) return room.vaultId
  const storedVaultId = await room.state.storage.get(VAULT_ID_STORAGE_KEY)
  if (!v.is(VaultIdSchema, storedVaultId)) return undefined
  room.vaultId = storedVaultId
  return storedVaultId
}

export async function scheduleCheckpointAlarm(
  room: VaultRoom,
  scheduledTime: number,
): Promise<void> {
  if (
    room.state.storage.sql === undefined ||
    room.env.SNAPSHOT_BUCKET === undefined ||
    room.state.storage.setAlarm === undefined
  )
    return
  await room.state.storage.setAlarm(scheduledTime)
}
