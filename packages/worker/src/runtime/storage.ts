import {
  VaultIdSchema,
  type DocId,
  type MessageId,
  type VaultId,
  type ClientHello,
} from '@kuroflare/core'
import type { Kysely } from 'kysely'
import * as v from 'valibot'

import {
  getQuarantinedUpdates,
  getQuarantinedUpdateById,
  getQuarantinedUpdateBytes,
} from '../db/checkpointRepo'
import { createDb } from '../db/db'
import {
  getDevice,
  getAllDeviceYClientIds,
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
import {
  isValidYClientId,
  type DeviceRegistryEntry,
  type YClientId,
  type DeviceRefreshTokenEvidence,
} from '../devices'
import type { SetupTokenEntry } from '../devices/tokens'
import type { QuarantinedUpdateRecord } from '../quarantine'
import type { SyncRequestDocState } from '../sync/request'
import type { SyncUpdateDocClock, SyncUpdateDuplicateEvidence } from '../sync/update'
import { VAULT_ID_STORAGE_KEY } from './constants'
import { PosIntSchema, NonNegIntSchema, type RuntimeSnapshotPointerRecord } from './types'
import { docKey, quarantinedUpdateRecordFromSqlRow } from './utils'
import type { VaultRoom } from './vault-room'

export function getDb(room: VaultRoom): Kysely<Database> | undefined {
  const sql = room.state.storage.sql
  return sql === undefined ? undefined : createDb(sql)
}

export async function ensureSchema(room: VaultRoom): Promise<void> {
  if (room.schemaReady) return
  const sql = room.state.storage.sql
  const db = getDb(room)
  if (sql === undefined || db === undefined) return

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
  if (decision.action === 'apply-migrations') {
    const now = Date.now()
    for (const migration of decision.migrations) {
      await migration.migrate(db)
      await insertMigration(db, migration.version, now)
    }
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
  const durableSeq = row?.durableSeq
  return v.is(PosIntSchema, durableSeq) ? { durableSeq } : undefined
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
  return { latestSnapshotSeq, latestSnapshotKey }
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
  const yClientId = row?.yClientId
  const tokenVersion = row?.tokenVersion
  const revokedAt = row?.revokedAt ?? undefined
  if (!isValidYClientId(yClientId) || !v.is(PosIntSchema, tokenVersion)) return undefined
  return { deviceId, yClientId, tokenVersion, revokedAt }
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

export async function readUsedYClientIds(room: VaultRoom): Promise<ReadonlySet<YClientId>> {
  const db = getDb(room)
  const used = new Set<YClientId>()
  if (db === undefined) return used
  for (const row of await getAllDeviceYClientIds(db)) {
    if (isValidYClientId(row.yClientId)) used.add(row.yClientId)
  }
  return used
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
  yClientId: YClientId,
  now: number,
): Promise<void> {
  const db = getDb(room)
  if (db !== undefined) await upsertDevice(db, deviceId, yClientId, now)
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
