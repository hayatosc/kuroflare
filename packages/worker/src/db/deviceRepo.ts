import { type Kysely, sql } from 'kysely'
import type { Database } from './types'

export interface DeviceRow {
  readonly yClientId: number
  readonly tokenVersion: number
  readonly revokedAt: number | null
}

export interface RefreshTokenRow {
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
}

export async function getDevice(
  db: Kysely<Database>,
  deviceId: string,
): Promise<DeviceRow | undefined> {
  return db
    .selectFrom('devices')
    .select((eb) => [
      eb.ref('y_client_id').as('yClientId'),
      eb.ref('token_version').as('tokenVersion'),
      eb.ref('revoked_at').as('revokedAt'),
    ])
    .where('device_id', '=', deviceId)
    .executeTakeFirst()
}

export async function getAllDeviceYClientIds(
  db: Kysely<Database>,
): Promise<readonly { readonly yClientId: number }[]> {
  return db
    .selectFrom('devices')
    .select((eb) => eb.ref('y_client_id').as('yClientId'))
    .execute()
}

export async function upsertDevice(
  db: Kysely<Database>,
  deviceId: string,
  yClientId: number,
  now: number,
): Promise<void> {
  await db
    .insertInto('devices')
    .values({
      device_id: deviceId,
      y_client_id: yClientId,
      token_version: 1,
      created_at: now,
      last_seen_at: now,
    })
    .onConflict((oc) =>
      oc.column('device_id').doUpdateSet({
        last_seen_at: sql`excluded.last_seen_at`,
      }),
    )
    .execute()
}

export async function updateDeviceRevoked(
  db: Kysely<Database>,
  deviceId: string,
  tokenVersion: number,
  revokedAt: number,
): Promise<void> {
  await db
    .updateTable('devices')
    .set({
      token_version: tokenVersion,
      revoked_at: revokedAt,
      last_seen_at: revokedAt,
    })
    .where('device_id', '=', deviceId)
    .execute()
}

export async function getRefreshToken(
  db: Kysely<Database>,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  return db
    .selectFrom('device_refresh_tokens')
    .select((eb) => [
      eb.ref('issued_at').as('issuedAt'),
      eb.ref('expires_at').as('expiresAt'),
      eb.ref('revoked_at').as('revokedAt'),
    ])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst()
}

export async function insertRefreshToken(
  db: Kysely<Database>,
  tokenHash: string,
  deviceId: string,
  issuedAt: number,
  expiresAt: number,
): Promise<void> {
  await db
    .insertInto('device_refresh_tokens')
    .values({
      token_hash: tokenHash,
      device_id: deviceId,
      issued_at: issuedAt,
      expires_at: expiresAt,
    })
    .execute()
}

export async function updateRefreshTokenRevoked(
  db: Kysely<Database>,
  tokenHash: string,
  revokedAt: number,
): Promise<void> {
  await db
    .updateTable('device_refresh_tokens')
    .set({ revoked_at: revokedAt })
    .where('token_hash', '=', tokenHash)
    .execute()
}
